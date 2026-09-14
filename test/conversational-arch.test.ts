import { test } from "node:test";
import assert from "node:assert/strict";
import { detectIntent, resolveAlias } from "../src/agent/intent-engine";
import { extractSlots } from "../src/agent/slot-manager";
import { decideResponse } from "../src/agent/response-decider";
import { createKnowledgeBase } from "../src/agent/knowledge-base";
import type { ConversationStateData } from "../src/agent/types";

// ── Helpers ─────────────────────────────────────────────────────

function makeState(overrides: Partial<ConversationStateData> = {}): ConversationStateData {
  return {
    chatwootConversationId: 1,
    phone: null,
    chatwootContactId: 9,
    sourceId: null,
    activeIntent: null,
    phase: "IDLE",
    slots: {},
    repromptCount: 0,
    lastQuestionAsked: null,
    messageCount: 0,
    expiresAt: null,
    ...overrides,
  };
}

// ── Intent Engine ────────────────────────────────────────────────

test("IE1. 'cita' → RESERVA (alias)", () => {
  const result = detectIntent("quiero una cita", null);
  assert.equal(result.intent, "RESERVA");
  assert.ok(result.confidence > 0.5);
});

test("IE2. 'alquilar vehículo para examen' → ALQUILER_EXAMEN", () => {
  const result = detectIntent("quiero alquilar un vehículo para mi examen", null);
  assert.equal(result.intent, "ALQUILER_EXAMEN");
});

test("IE3. 'simulacro' → SIMULACRO", () => {
  const result = detectIntent("necesito un simulacro", null);
  assert.equal(result.intent, "SIMULACRO");
});

test("IE4. 'practicar' → PRACTICA", () => {
  const result = detectIntent("quiero practicar manejo", null);
  assert.equal(result.intent, "PRACTICA");
});

test("IE5. 'paquetes' → PAQUETE", () => {
  const result = detectIntent("información de paquetes", null);
  assert.equal(result.intent, "PAQUETE");
});

test("IE6. 'horarios' → HORARIOS", () => {
  const result = detectIntent("cuáles son los horarios", null);
  assert.equal(result.intent, "HORARIOS");
});

test("IE7. 'asesor' → HANDOFF", () => {
  const result = detectIntent("asesor", null);
  assert.equal(result.intent, "HANDOFF");
});

test("IE8. 'examen de reglas' → HANDOFF (no se hace en Conducar)", () => {
  const result = detectIntent("quiero información del examen de reglas", null);
  assert.equal(result.intent, "HANDOFF");
});

test("IE9. 'cambio de idea, quiero simulacro' → SIMULACRO con isExplicitChange", () => {
  const result = detectIntent("cambio de idea, quiero un simulacro", "PRACTICA");
  assert.equal(result.intent, "SIMULACRO");
  assert.equal(result.isChange, true);
  assert.equal(result.isExplicitChange, true);
});

test("IE10. resolveAlias('cita') → RESERVA", () => {
  assert.equal(resolveAlias("cita"), "RESERVA");
});

test("IE11. resolveAlias('xyz') → null", () => {
  assert.equal(resolveAlias("xyz"), null);
});

// ── Slot Manager ─────────────────────────────────────────────────

test("SM1. Extraer categoría 'A1' del texto", () => {
  const state = makeState({ activeIntent: "RESERVA", slots: {} });
  const result = extractSlots("quiero práctica A1", "RESERVA", state);
  assert.equal(result.extracted.categoria, "A1");
  assert.equal(result.updated.categoria, "A1");
});

test("SM2. Extraer circuito 'oficial'", () => {
  const state = makeState({ activeIntent: "RESERVA", slots: {} });
  const result = extractSlots("en el circuito oficial", "RESERVA", state);
  assert.equal(result.extracted.circuito, "oficial");
});

test("SM3. Extraer actividad 'practica'", () => {
  const state = makeState({ activeIntent: "RESERVA", slots: {} });
  const result = extractSlots("quiero una práctica", "RESERVA", state);
  assert.equal(result.extracted.actividad, "practica");
});

test("SM4. Extraer múltiples datos 'A1 y martes'", () => {
  const state = makeState({ activeIntent: "RESERVA", slots: {} });
  const result = extractSlots("quiero A1 el martes", "RESERVA", state);
  assert.equal(result.extracted.categoria, "A1");
  assert.ok(result.extracted.fecha);
});

test("SM5. No sobrescribir slot existente", () => {
  const state = makeState({ activeIntent: "RESERVA", slots: { categoria: "A2A" } });
  const result = extractSlots("práctica A1", "RESERVA", state);
  assert.equal(result.updated.categoria, "A2A"); // No se sobrescribe
});

test("SM6. Identificar slots faltantes", () => {
  const state = makeState({ activeIntent: "RESERVA", slots: { actividad: "practica", categoria: "A1" } });
  const result = extractSlots("el martes", "RESERVA", state);
  assert.ok(result.missing.length > 0);
  assert.equal(result.isComplete, false);
});

test("SM7. Todos los slots completos", () => {
  const state = makeState({
    activeIntent: "RESERVA",
    slots: { actividad: "practica", categoria: "A1", circuito: "oficial", fecha: "martes", hora: "10:00" },
  });
  const result = extractSlots("", "RESERVA", state);
  assert.equal(result.isComplete, true);
  assert.equal(result.missing.length, 0);
});

test("SM8. Extraer 'simulacro' como actividad", () => {
  const state = makeState({ activeIntent: "RESERVA", slots: {} });
  const result = extractSlots("quiero un simulacro", "RESERVA", state);
  assert.equal(result.extracted.actividad, "simulacro");
});

// ── Response Decider ─────────────────────────────────────────────

test("RD1. Handoff explícito", () => {
  const state = makeState();
  const intent = { intent: "HANDOFF" as const, confidence: 0.9, isChange: false, isExplicitChange: false, rawText: "asesor" };
  const slots = { extracted: {}, updated: {}, missing: [], isComplete: true };
  const result = decideResponse(state, intent, slots, "asesor");
  assert.equal(result.type, "HANDOFF");
});

test("RD2. Máximo 2 repreguntas → handoff", () => {
  const state = makeState({ repromptCount: 2 });
  const intent = { intent: "RESERVA" as const, confidence: 0.9, isChange: false, isExplicitChange: false, rawText: "reserva" };
  const slots = { extracted: {}, updated: {}, missing: [{ name: "categoria", question: "¿Categoría?", type: "enum" as const, required: true }], isComplete: false };
  const result = decideResponse(state, intent, slots, "reserva");
  assert.equal(result.type, "HANDOFF");
});

test("RD3. Slot faltante → repregunta", () => {
  const state = makeState({ activeIntent: "RESERVA", phase: "GATHERING" });
  const intent = { intent: "RESERVA" as const, confidence: 0.9, isChange: false, isExplicitChange: false, rawText: "práctica" };
  const slots = { extracted: {}, updated: {}, missing: [{ name: "categoria", question: "¿Categoría?", type: "enum" as const, required: true }], isComplete: false };
  const result = decideResponse(state, intent, slots, "práctica");
  assert.equal(result.type, "REPROMPT");
  if (result.type === "REPROMPT") {
    assert.equal(result.slotName, "categoria");
  }
});

test("RD4. Slots completos → confirmar", () => {
  const state = makeState({ activeIntent: "RESERVA", phase: "GATHERING", slots: { actividad: "practica", categoria: "A1", circuito: "oficial", fecha: "martes", hora: "10:00" } });
  const intent = { intent: "RESERVA" as const, confidence: 0.9, isChange: false, isExplicitChange: false, rawText: "" };
  const slots = { extracted: {}, updated: state.slots, missing: [], isComplete: true };
  const result = decideResponse(state, intent, slots, "");
  assert.equal(result.type, "CONFIRM");
});

test("RD5. Confirmación → ejecutar", () => {
  const state = makeState({ activeIntent: "RESERVA", phase: "CONFIRMING", slots: { actividad: "practica", categoria: "A1" } });
  const intent = { intent: "RESERVA" as const, confidence: 0.9, isChange: false, isExplicitChange: false, rawText: "sí" };
  const slots = { extracted: {}, updated: state.slots, missing: [], isComplete: true };
  const result = decideResponse(state, intent, slots, "sí");
  assert.equal(result.type, "EXECUTE_TOOL");
});

test("RD6. Consulta ambigua → aclaración", () => {
  const state = makeState();
  const intent = { intent: "OTROS" as const, confidence: 0.3, isChange: false, isExplicitChange: false, rawText: "ayuda" };
  const slots = { extracted: {}, updated: {}, missing: [], isComplete: true };
  const result = decideResponse(state, intent, slots, "ayuda");
  assert.equal(result.type, "ASK_CLARIFICATION");
});

// ── Knowledge Base ────────────────────────────────────────────────

test("KB1. getPrecio A1 → 60", () => {
  const kb = createKnowledgeBase();
  assert.equal(kb.getPrecio("A1"), 60);
});

test("KB2. getPrecio X99 → null", () => {
  const kb = createKnowledgeBase();
  assert.equal(kb.getPrecio("X99"), null);
});

test("KB3. getContextForIntent RESERVA incluye precios", () => {
  const kb = createKnowledgeBase();
  const ctx = kb.getContextForIntent("RESERVA");
  assert.ok(ctx.includes("A1 S/60"));
  assert.ok(ctx.includes("examen de reglas NO se realiza"));
});

test("KB4. getContextForIntent HORARIOS incluye horarios", () => {
  const kb = createKnowledgeBase();
  const ctx = kb.getContextForIntent("HORARIOS");
  assert.ok(ctx.includes("08:00"));
  assert.ok(ctx.includes("17:30"));
});

test("KB5. getHorarios devuelve string con todos los horarios", () => {
  const kb = createKnowledgeBase();
  const horarios = kb.getHorarios();
  assert.ok(horarios.includes("Práctica oficial"));
  assert.ok(horarios.includes("Simulacro oficial"));
});
