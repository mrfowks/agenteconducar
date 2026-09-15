import { test } from "node:test";
import assert from "node:assert/strict";
import { understandTurn } from "../src/agent/turn-understanding";
import { updateContext } from "../src/agent/context-updater";
import { resolveIntent } from "../src/agent/intent-resolver";
import { decide } from "../src/agent/conversation-decider";
import { generateResponse } from "../src/agent/response-generator";
import type { ConversationContext } from "../src/agent/conversation-context";

// ── Helper para crear contexto inicial ──────────────────────────

function makeContext(overrides: Partial<ConversationContext> = {}): ConversationContext {
  return {
    id: "test-conv-1",
    phone: "51917595954",
    chatwootContactId: 9,
    sourceId: "51917595954",
    activeIntent: null,
    goal: null,
    intentHistory: [],
    phase: "IDLE",
    turnCount: 0,
    lastUserMessage: "",
    lastAssistantQuestion: null,
    lastResponseHash: null,
    slots: {
      actividad: null, categoria: null, circuito: null,
      fecha: null, fechaOriginal: null, hora: null, horaOriginal: null,
      examen_fecha: null, paquete: null, experiencia: null, urgencia: null,
    },
    slotConfidence: {},
    slotSources: {},
    preferences: { prefersMorning: null, prefersAutomatic: null, prefersOfficialCircuit: null },
    constraints: { examDate: null, noSameDayAsExam: false, timeConstraints: [] },
    facts: [],
    negations: [],
    recommendations: [],
    lastRecommendationType: null,
    clarification: { count: 0, lastQuestion: null, reason: null },
    confirmation: { status: "none", summary: null, confirmedAt: null, rejectedAt: null },
    pendingAction: null,
    handoff: null,
    isNewUser: true,
    createdAt: new Date(),
    lastActivityAt: new Date(),
    expiresAt: null,
    ...overrides,
  };
}

// ── Helper para simular un turno completo ────────────────────────

function simulateTurn(text: string, ctx: ConversationContext) {
  const turn = understandTurn(text, ctx);
  const updatedCtx = updateContext(ctx, turn);
  const { activeIntent, goal } = resolveIntent(updatedCtx, turn);
  updatedCtx.activeIntent = activeIntent;
  updatedCtx.goal = goal;
  updatedCtx.lastUserMessage = text;
  const decision = decide(updatedCtx, turn);
  const response = generateResponse(decision, updatedCtx, turn);
  return { turn, updatedCtx, decision, response };
}

// ── CASO 1: Primer contacto con examen cercano ──────────────────

test("CASO 1. 'Quiero practicar porque mi examen es el sábado' → orientar, no interrogatorio", () => {
  const ctx = makeContext();
  const result = simulateTurn("Quiero practicar porque mi examen es el sábado y todavía no me siento seguro", ctx);

  // Debe detectar PRACTICA
  assert.equal(result.turn.detectedIntent, "PRACTICA");
  assert.equal(result.updatedCtx.activeIntent, "PRACTICA");

  // Debe guardar examen_fecha
  assert.equal(result.updatedCtx.slots.examen_fecha, "sábado");

  // NO debe preguntar por circuito directamente
  if (result.decision.action === "ASK_FOR_MISSING_INFO") {
    assert.notEqual(result.decision.targetSlot, "circuito");
  }

  // La respuesta NO debe ser "¿En qué circuito prefieres?"
  assert.ok(!result.response.includes("¿En qué circuito prefieres?"));
});

// ── CASO 2: Categoría después del primer contacto ───────────────

test("CASO 2. 'A1' con contexto de examen → orientar, no preguntar circuito", () => {
  const ctx = makeContext({
    activeIntent: "PRACTICA",
    turnCount: 1,
    slots: { ...makeContext().slots, examen_fecha: "sábado" },
    facts: [{ id: "f1", content: "Examen sábado", confidence: 0.9, timestamp: new Date(), slotMapping: "examen_fecha" }],
  });

  const result = simulateTurn("A1", ctx);

  // Debe extraer categoría
  assert.equal(result.updatedCtx.slots.categoria, "A1");

  // NO debe preguntar circuito automáticamente
  if (result.decision.action === "ASK_FOR_MISSING_INFO") {
    assert.notEqual(result.decision.targetSlot, "circuito");
  }

  // Debe aprovechar el contexto de examen
  assert.ok(result.updatedCtx.slots.examen_fecha === "sábado");
});

// ── CASO 3: Negación/restricción ────────────────────────────────

test("CASO 3. 'No quiero practicar el mismo día' → persistir restricción", () => {
  const ctx = makeContext({
    activeIntent: "PRACTICA",
    turnCount: 2,
    slots: { ...makeContext().slots, categoria: "A1", examen_fecha: "sábado" },
  });

  const result = simulateTurn("No quiero practicar el mismo día del examen", ctx);

  // Debe detectar negación
  assert.ok(result.turn.negations.length > 0);

  // Debe persistir la restricción
  assert.ok(result.updatedCtx.negations.length > 0);
  assert.equal(result.updatedCtx.negations[0].negatedSlot, "fecha");
});

// ── CASO 4: Pregunta directa ────────────────────────────────────

test("CASO 4. '¿Qué circuito tienen?' → responder primero, no slot", () => {
  const ctx = makeContext({ activeIntent: "PRACTICA", turnCount: 1 });

  const result = simulateTurn("¿Qué circuito tienen?", ctx);

  // Debe ser ANSWER, no ASK_FOR_MISSING_INFO
  assert.equal(result.decision.action, "ANSWER");

  // La respuesta debe explicar los circuitos
  assert.ok(result.response.includes("oficial"));
  assert.ok(result.response.includes("alternativo"));
});

// ── CASO 5: Corrección de intención ─────────────────────────────

test("CASO 5. 'No, me refería a simulacro' → corregir intención", () => {
  const ctx = makeContext({
    activeIntent: "PRACTICA",
    turnCount: 2,
    slots: { ...makeContext().slots, categoria: "A1" },
  });

  const result = simulateTurn("No, me refería a simulacro", ctx);

  // Debe corregir la intención
  assert.equal(result.updatedCtx.activeIntent, "SIMULACRO");

  // Debe preservar la categoría
  assert.equal(result.updatedCtx.slots.categoria, "A1");
});

// ── CASO 6: Cambio explícito de intención ───────────────────────

test("CASO 6. 'Ya practiqué, solo quiero alquilar el carro' → ALQUILER_EXAMEN", () => {
  const ctx = makeContext({
    activeIntent: "PRACTICA",
    turnCount: 3,
    slots: { ...makeContext().slots, categoria: "A1" },
  });

  const result = simulateTurn("Ya practiqué, solo quiero alquilar el carro para mi examen", ctx);

  // Debe cambiar a ALQUILER_EXAMEN
  assert.equal(result.updatedCtx.activeIntent, "ALQUILER_EXAMEN");
});

// ── CASO 7: Intención ambigua → CLARIFY ─────────────────────────

test("CASO 7. 'Quiero hacerlo' → CLARIFY", () => {
  const ctx = makeContext();
  const result = simulateTurn("Quiero hacerlo", ctx);

  // Debe pedir aclaración
  assert.equal(result.decision.action, "CLARIFY");
});

// ── CASO 8: Pregunta directa de precio → ANSWER ─────────────────

test("CASO 8. '¿Cuánto cuesta el simulacro?' → ANSWER", () => {
  const ctx = makeContext();
  const result = simulateTurn("¿Cuánto cuesta el simulacro?", ctx);

  assert.equal(result.decision.action, "ANSWER");
});

// ── CASO 9: Pregunta de horarios → ANSWER ───────────────────────

test("CASO 9. '¿Atienden mañana?' → ANSWER", () => {
  const ctx = makeContext();
  const result = simulateTurn("¿Atienden mañana?", ctx);

  assert.equal(result.decision.action, "ANSWER");
});

// ── CASO 10: Recomendación rechazada no se repite ────────────────

test("CASO 10. recomendación rechazada no se repite", () => {
  const ctx = makeContext({
    activeIntent: "PRACTICA",
    turnCount: 3,
    recommendations: [{
      id: "r1", type: "CONTEXTUAL_SIMULACRO", target: "SIMULACRO",
      reason: "test", timestamp: new Date(), status: "rejected",
    }],
  });

  const result = simulateTurn("A1", ctx);

  // No debe volver a ofrecer CONTEXTUAL_SIMULACRO
  if (result.decision.recommendation) {
    assert.notEqual(result.decision.recommendation.type, "CONTEXTUAL_SIMULACRO");
  }
});

// ── CASO 11: Multi-turno: práctica → categoría → circuito ────────

test("CASO 11. flujo completo: práctica → A1 → oficial → viernes 3pm", () => {
  let ctx = makeContext();

  // Turno 1
  const r1 = simulateTurn("Quiero practicar porque mi examen es el sábado", ctx);
  ctx = r1.updatedCtx;
  assert.equal(ctx.activeIntent, "PRACTICA");
  assert.equal(ctx.slots.examen_fecha, "sábado");

  // Turno 2
  const r2 = simulateTurn("A1", ctx);
  ctx = r2.updatedCtx;
  assert.equal(ctx.slots.categoria, "A1");

  // Turno 3
  const r3 = simulateTurn("oficial el viernes a las 3 pm", ctx);
  ctx = r3.updatedCtx;
  assert.equal(ctx.slots.circuito, "oficial");
  assert.equal(ctx.slots.fecha, "viernes");
  assert.equal(ctx.slots.hora, "15:00");
});

// ── CASO 12: Preferencia de mañana ──────────────────────────────

test("CASO 12. 'por la mañana' → preferencia detectada", () => {
  const ctx = makeContext({ activeIntent: "PRACTICA" });
  const result = simulateTurn("quiero por la mañana", ctx);

  // Debe detectar preferencia
  assert.equal(result.updatedCtx.preferences.prefersMorning, true);
});

// ── CASO 13: Experiencia previa ──────────────────────────────────

test("CASO 13. 'ya practiqué antes' → experiencia detectada", () => {
  const ctx = makeContext({ activeIntent: "PRACTICA" });
  const result = simulateTurn("ya practiqué antes", ctx);

  assert.ok(result.turn.facts.length > 0);
});

// ── CASO 14: Respuesta a pregunta anterior ───────────────────────

test("CASO 14. 'A1' responde a pregunta de categoría", () => {
  const ctx = makeContext({
    activeIntent: "PRACTICA",
    lastAssistantQuestion: "¿Qué categoría de licencia necesitas?",
  });

  const result = simulateTurn("A1", ctx);
  assert.equal(result.turn.answersPreviousQuestion, true);
  assert.equal(result.turn.answeredSlot, "categoria");
});

// ── CASO 15: Handoff explícito ───────────────────────────────────

test("CASO 15. 'hablar con un asesor' → HANDOFF", () => {
  const ctx = makeContext();
  const result = simulateTurn("quiero hablar con un asesor", ctx);

  assert.equal(result.decision.action, "HANDOFF");
});

// ── CASO 16: No repetir pregunta ─────────────────────────────────

test("CASO 16. no repetir pregunta ya hecha", () => {
  const ctx = makeContext({
    activeIntent: "PRACTICA",
    lastAssistantQuestion: "¿Qué categoría de licencia necesitas?",
    slots: { ...makeContext().slots, categoria: "A1" },
  });

  const result = simulateTurn("A1", ctx);

  // No debe volver a preguntar categoría
  if (result.decision.action === "ASK_FOR_MISSING_INFO") {
    assert.notEqual(result.decision.targetSlot, "categoria");
  }
});

// ── CASO 17: Simulacro individual (no P5) ────────────────────────

test("CASO 17. 'solo quiero hacer el simulacro' → SIMULACRO individual", () => {
  const ctx = makeContext();
  const result = simulateTurn("solo quiero hacer el simulacro", ctx);

  assert.equal(result.updatedCtx.activeIntent, "SIMULACRO");
});

// ── CASO 18: Restricción temporal ────────────────────────────────

test("CASO 18. 'no el mismo día del examen' → restricción persistida", () => {
  const ctx = makeContext({
    activeIntent: "PRACTICA",
    slots: { ...makeContext().slots, examen_fecha: "sábado" },
  });

  const result = simulateTurn("no quiero practicar el mismo día del examen", ctx);

  assert.ok(result.updatedCtx.negations.length > 0);
  assert.equal(result.updatedCtx.negations[0].negatedSlot, "fecha");
});

// ── CASO 19: Confirmación y ejecución ────────────────────────────

test("CASO 19. 'sí, correcto' → EXECUTE", () => {
  const ctx = makeContext({
    activeIntent: "PRACTICA",
    confirmation: { status: "pending", summary: "Práctica A1 oficial viernes 15:00", confirmedAt: null, rejectedAt: null },
  });

  const result = simulateTurn("sí, correcto", ctx);

  assert.equal(result.decision.action, "EXECUTE");
});

// ── CASO 20: 3 aclaraciones → HANDOFF ───────────────────────────

test("CASO 20. 3 aclaraciones → HANDOFF", () => {
  const ctx = makeContext({
    clarification: { count: 3, lastQuestion: "¿Qué necesitas?", reason: "ambiguous_intent" },
  });

  const result = simulateTurn("no sé", ctx);

  assert.equal(result.decision.action, "HANDOFF");
});

// ── CASO 21: Contexto se preserva entre turnos ───────────────────

test("CASO 21. contexto se preserva entre turnos", () => {
  let ctx = makeContext();
  
  // Turno 1: dar categoría
  const r1 = simulateTurn("Quiero practicar A1", ctx);
  ctx = r1.updatedCtx;
  assert.equal(ctx.slots.categoria, "A1");
  
  // Turno 2: pregunta sobre circuito
  const r2 = simulateTurn("¿Qué circuitos hay?", ctx);
  ctx = r2.updatedCtx;
  
  // Categoría debe persistir
  assert.equal(ctx.slots.categoria, "A1");
});

// ── CASO 22: Recomendación contextual de simulacro ───────────────

test("CASO 22. examen cercano → recomendación simulacro contextual", () => {
  const ctx = makeContext({
    activeIntent: "PRACTICA",
    turnCount: 2,
    slots: { ...makeContext().slots, categoria: "A1", examen_fecha: "sábado" },
  });

  const result = simulateTurn("A1", ctx);

  // Debe ofrecer simulacro contextual
  if (result.decision.recommendation) {
    assert.equal(result.decision.recommendation.type, "CONTEXTUAL_SIMULACRO");
  }
});
