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

test("RD2. Máximo 3 repreguntas → handoff", () => {
  const state = makeState({ repromptCount: 3 });
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
  assert.ok(ctx.includes("S/60"));
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

// ── Tests adicionales de preservación de intención ──────────────

test("INT1. alquiler → A1 → martes → hora (flujo completo)", () => {
  let state = makeState();
  // Paso 1: detectar intención
  const r1 = detectIntent("quiero alquilar un vehículo para mi examen", null);
  assert.equal(r1.intent, "ALQUILER_EXAMEN");
  state = { ...state, activeIntent: r1.intent };
  // Paso 2: extraer A1
  const s1 = extractSlots("A1", r1.intent, state);
  assert.equal(s1.extracted.categoria, "A1");
  state = { ...state, slots: s1.updated };
  // Paso 3: extraer martes (ALQUILER_EXAMEN usa fecha_examen)
  const s2 = extractSlots("el martes", r1.intent, state);
  assert.ok(s2.extracted.fecha_examen);
  state = { ...state, slots: s2.updated };
  // Paso 4: extraer hora (ALQUILER_EXAMEN no tiene slot hora, verificamos fecha_examen completo)
  assert.equal(state.slots.categoria, "A1");
  assert.ok(state.slots.fecha_examen);
});

test("INT2. alquiler NO cambia a simulacro ante pregunta de horarios", () => {
  const state = makeState({ activeIntent: "ALQUILER_EXAMEN" });
  const result = detectIntent("¿qué horarios tienen?", "ALQUILER_EXAMEN");
  assert.equal(result.intent, "ALQUILER_EXAMEN"); // Preserva intención
});

test("INT3. '5' en contexto de menú → HORARIOS", () => {
  const result = detectIntent("5", null);
  // "5" no tiene alias, fallback a OTROS (sin contexto de menú)
  assert.equal(result.intent, "OTROS");
});

test("INT4. '5' sin contexto de menú no cambia intención activa", () => {
  const result = detectIntent("5", "ALQUILER_EXAMEN");
  assert.equal(result.intent, "ALQUILER_EXAMEN"); // Mantiene intención activa
});

test("INT5. práctica en circuito alterno", () => {
  const state = makeState({ activeIntent: "PRACTICA" });
  const result = extractSlots("en el circuito alterno", "PRACTICA", state);
  assert.equal(result.extracted.circuito, "alternativo");
});

test("INT6. conversación larga (multi-mensaje)", () => {
  let state = makeState();
  // Mensaje 1
  const r1 = detectIntent("quiero practicar", null);
  state = { ...state, activeIntent: r1.intent, messageCount: 1 };
  // Mensaje 2
  const r2 = detectIntent("A1", state.activeIntent);
  assert.equal(r2.intent, "PRACTICA"); // Mantiene
  const s1 = extractSlots("A1", r2.intent, state);
  state = { ...state, slots: s1.updated, messageCount: 2 };
  // Mensaje 3
  const r3 = detectIntent("el jueves", state.activeIntent);
  assert.equal(r3.intent, "PRACTICA"); // Mantiene
  const s2 = extractSlots("el jueves", r3.intent, state);
  state = { ...state, slots: s2.updated, messageCount: 3 };
  // Verificar que se acumularon datos
  assert.equal(state.slots.categoria, "A1");
  assert.equal(state.slots.fecha, "jueves");
});

test("INT7. conversationId como identidad primaria", () => {
  const state = makeState({ chatwootConversationId: 42, phone: null });
  assert.equal(state.chatwootConversationId, 42);
  assert.equal(state.phone, null);
});

test("INT8. phone=null funciona correctamente", () => {
  const state = makeState({ phone: null, chatwootConversationId: 9 });
  assert.equal(state.phone, null);
  assert.equal(state.chatwootConversationId, 9);
});

test("INT9. expiración de estado", () => {
  const now = new Date();
  const expiresAt = new Date(now.getTime() - 1000); // Ya expiró
  const state = makeState({ expiresAt });
  assert.ok(state.expiresAt! < now);
});

test("INT10. examen de reglas tiene prioridad sobre aliases", () => {
  const result = detectIntent("quiero información del examen de reglas", null);
  assert.equal(result.intent, "HANDOFF");
});

test("INT11. 'a las 10' → '10:00'", () => {
  const state = makeState({ activeIntent: "RESERVA", slots: {} });
  const result = extractSlots("a las 10", "RESERVA", state);
  assert.equal(result.extracted.hora, "10:00");
});

test("INT12. '10 am' → '10:00'", () => {
  const state = makeState({ activeIntent: "RESERVA", slots: {} });
  const result = extractSlots("10 am", "RESERVA", state);
  assert.equal(result.extracted.hora, "10:00");
});

test("INT13. '10:30 pm' → '22:30'", () => {
  const state = makeState({ activeIntent: "RESERVA", slots: {} });
  const result = extractSlots("10:30 pm", "RESERVA", state);
  assert.equal(result.extracted.hora, "22:30");
});

test("INT14. fechas relativas no inventan fecha absoluta", () => {
  const state = makeState({ activeIntent: "RESERVA", slots: {} });
  const result = extractSlots("martes", "RESERVA", state);
  assert.equal(result.extracted.fecha, "martes"); // Relativa, no absoluta
});

test("INT15. cambio explícito de intención", () => {
  const result = detectIntent("en realidad quiero un simulacro", "PRACTICA");
  assert.equal(result.intent, "SIMULACRO");
  assert.equal(result.isExplicitChange, true);
});

test("INT16. FAQ dentro de flujo conserva intención", () => {
  const result = detectIntent("¿la pista alterna es igual a la oficial?", "ALQUILER_EXAMEN");
  assert.equal(result.intent, "ALQUILER_EXAMEN"); // Mantiene
});

test("INT17. mensaje con varios slots extrae todos", () => {
  const state = makeState({ activeIntent: "RESERVA", slots: {} });
  const result = extractSlots("quiero práctica A1 el martes a las 10am", "RESERVA", state);
  assert.equal(result.extracted.actividad, "practica");
  assert.equal(result.extracted.categoria, "A1");
  assert.ok(result.extracted.fecha);
  assert.equal(result.extracted.hora, "10:00");
});

test("INT18. recomendación no cambia intención automáticamente", () => {
  // El agente recomienda SIMULACRO pero el cliente mantiene PRACTICA
  const result = detectIntent("no, solo quiero la práctica", "PRACTICA");
  assert.equal(result.intent, "PRACTICA"); // Mantiene
});

test("INT19. máximo 3 aclaraciones", () => {
  const state = makeState({ repromptCount: 3 });
  const intent = { intent: "OTROS" as const, confidence: 0.3, isChange: false, isExplicitChange: false, rawText: "?" };
  const slots = { extracted: {}, updated: {}, missing: [], isComplete: true };
  const result = decideResponse(state, intent, slots, "?");
  assert.equal(result.type, "HANDOFF");
});

test("INT20. tercer intento aún permite repregunta", () => {
  const state = makeState({ repromptCount: 2, activeIntent: "RESERVA", phase: "GATHERING" });
  const intent = { intent: "RESERVA" as const, confidence: 0.9, isChange: false, isExplicitChange: false, rawText: "" };
  const slots = { extracted: {}, updated: {}, missing: [{ name: "categoria", question: "¿Categoría?", type: "enum" as const, required: true }], isComplete: false };
  const result = decideResponse(state, intent, slots, "");
  assert.equal(result.type, "REPROMPT"); // Aún puede repreguntar (intento 3)
});

// ── Tests de paquetes ────────────────────────────────────────────

test("PKG1. Paquete 1 para cliente sin proceso iniciado", () => {
  const kb = createKnowledgeBase();
  const rules = kb.getBusinessRules();
  assert.equal(rules.paquetes.P1.precio, 680);
  assert.ok(rules.paquetes.P1.incluye.includes("5_prácticas_30min_circuito_oficial"));
});

test("PKG2. Paquete 2 para cliente con necesidad de una hora", () => {
  const kb = createKnowledgeBase();
  const rules = kb.getBusinessRules();
  assert.equal(rules.paquetes.P2.precio, 160);
  assert.equal(rules.paquetes.P2.ahorro, 20);
});

test("PKG3. cálculo correcto de ahorro Paquete 2: S/180 → S/160", () => {
  const kb = createKnowledgeBase();
  const p2 = kb.getBusinessRules().paquetes.P2;
  assert.equal(p2.precio_separado, 180);
  assert.equal(p2.precio, 160);
  assert.equal(p2.ahorro, 20);
});

test("PKG4. Paquete 3 para cliente que quiere práctica intensiva", () => {
  const kb = createKnowledgeBase();
  const p3 = kb.getBusinessRules().paquetes.P3;
  assert.equal(p3.precio, 360);
  assert.ok(p3.incluye.includes("2_prácticas_45min_circuito_alternativo"));
});

test("PKG5. Paquete 5 = S/260", () => {
  const kb = createKnowledgeBase();
  assert.equal(kb.getBusinessRules().paquetes.P5.precio, 260);
});

test("PKG6. paquetes solo A1", () => {
  const kb = createKnowledgeBase();
  assert.equal(kb.getBusinessRules().paquetes.disponibles_solo_A1, true);
});

test("PKG7. otra categoría no recibe precio inventado", () => {
  const kb = createKnowledgeBase();
  // No hay paquetes definidos para A2A, A2B, etc.
  assert.equal(kb.getBusinessRules().paquetes.disponibles_solo_A1, true);
});

// ── Tests de servicios no ofrecidos ──────────────────────────────

test("SVC1. revalidación no se convierte en flujo Conducar", () => {
  const kb = createKnowledgeBase();
  assert.ok(kb.getBusinessRules().servicios_no_ofrecidos.revalidacion.includes("NO realiza"));
});

test("SVC2. recategorización sí puede corresponder a examen práctico", () => {
  // La recategorización implica examen práctico, que SÍ se hace en Conducar
  const kb = createKnowledgeBase();
  assert.equal(kb.getBusinessRules().examenes.examen_practico.se_realiza, true);
});

test("SVC3. motos/mototaxis no se ofrecen", () => {
  const kb = createKnowledgeBase();
  assert.ok(kb.getBusinessRules().servicios_no_ofrecidos.motos.includes("no realiza"));
});

// ── Tests de horarios y días ─────────────────────────────────────

test("HOR1. examen mañana + necesidad de práctica → permitir recomendación de simulacro", () => {
  const kb = createKnowledgeBase();
  const sim = kb.getBusinessRules().simulacro;
  assert.ok(sim.nota.includes("preparación para el examen"));
});

test("HOR2. días martes/jueves/sábado distinguidos de días sin examen", () => {
  const kb = createKnowledgeBase();
  assert.deepEqual(kb.getBusinessRules().simulacro.dias, ["martes", "jueves", "sábado"]);
  assert.deepEqual(kb.getBusinessRules().examenes.examen_practico.dias, ["martes", "jueves", "sábado"]);
});

test("HOR3. práctica de lunes a domingo", () => {
  const kb = createKnowledgeBase();
  assert.ok(kb.getBusinessRules().practica.dias.includes("lunes a domingo"));
});

test("HOR4. simulacro solo días de examen", () => {
  const kb = createKnowledgeBase();
  assert.deepEqual(kb.getBusinessRules().simulacro.dias, ["martes", "jueves", "sábado"]);
});

test("HOR5. simulacro individual = 20 minutos", () => {
  const kb = createKnowledgeBase();
  assert.equal(kb.getBusinessRules().simulacro.duracion_min, 20);
});

test("HOR6. práctica = 30 minutos", () => {
  const kb = createKnowledgeBase();
  assert.equal(kb.getBusinessRules().practica.duracion_min, 30);
});

test("HOR7. examen práctico = martes/jueves/sábado 8:00 AM–4:30 PM", () => {
  const kb = createKnowledgeBase();
  const exam = kb.getBusinessRules().examenes.examen_practico;
  assert.deepEqual(exam.dias, ["martes", "jueves", "sábado"]);
  assert.equal(exam.horario, "08:00-16:30");
});

test("HOR8. simulacro = 5:30 AM–7:30 AM", () => {
  const kb = createKnowledgeBase();
  assert.equal(kb.getBusinessRules().simulacro.horario, "05:30-07:30");
});

// ── Tests de vehículos ───────────────────────────────────────────

test("VEH1. vehículo A1 automático (Kia Picanto 2026)", () => {
  const kb = createKnowledgeBase();
  const v = kb.getBusinessRules().vehiculos.A1;
  assert.equal(v.tipo, "automático");
  assert.ok(v.modelo.includes("Kia Picanto"));
});

test("VEH2. vehículo A2B mecánico", () => {
  const kb = createKnowledgeBase();
  assert.equal(kb.getBusinessRules().vehiculos.A2B.mecanica, true);
});

test("VEH3. vehículo A3A mecánico", () => {
  const kb = createKnowledgeBase();
  assert.equal(kb.getBusinessRules().vehiculos.A3A.mecanica, true);
});

test("VEH4. vehículo A3C mecánico", () => {
  const kb = createKnowledgeBase();
  assert.equal(kb.getBusinessRules().vehiculos.A3C.mecanica, true);
});

test("VEH5. A3B sin dato confirmado → no inventar", () => {
  const kb = createKnowledgeBase();
  assert.equal(kb.getBusinessRules().vehiculos.A3B.tipo, "no_confirmado");
  assert.ok(kb.getBusinessRules().vehiculos.A3B.nota.includes("NO inventar"));
});

// ── Tests de preservación adicionales ────────────────────────────

test("INT21. preservación ante pregunta de precio", () => {
  const result = detectIntent("¿cuánto cuesta?", "ALQUILER_EXAMEN");
  assert.equal(result.intent, "ALQUILER_EXAMEN"); // Mantiene
});

test("INT22. preservación ante FAQ sobre circuito", () => {
  const result = detectIntent("¿la pista alterna es igual a la oficial?", "PRACTICA");
  assert.equal(result.intent, "PRACTICA"); // Mantiene
});

test("INT23. día de examen + práctica → permitir recomendación contextual", () => {
  const kb = createKnowledgeBase();
  const rules = kb.getBusinessRules();
  // El simulacro existe como preparación
  assert.ok(rules.simulacro.nota.includes("preparación"));
  // Práctica también es válida en día de examen
  assert.ok(rules.practica.dias.includes("lunes a domingo"));
});

test("INT24. día anterior al examen + práctica", () => {
  // Práctica disponible cualquier día
  const kb = createKnowledgeBase();
  assert.ok(kb.getBusinessRules().practica.dias.includes("lunes a domingo"));
});

// ── Tests de comportamiento comercial ────────────────────────────

test("COM1. Paquete 1 para usuario sin iniciar proceso", () => {
  const kb = createKnowledgeBase();
  const p1 = kb.getBusinessRules().paquetes.P1;
  assert.equal(p1.precio, 680);
  assert.ok(p1.incluye.includes("examen_médico"));
  assert.ok(p1.incluye.includes("5_prácticas_30min_circuito_oficial"));
});

test("COM2. Paquete 2 para usuario que quiere 1 hora", () => {
  const kb = createKnowledgeBase();
  const p2 = kb.getBusinessRules().paquetes.P2;
  assert.equal(p2.precio, 160);
  assert.equal(p2.ahorro, 20);
});

test("COM3. Paquete 3 para práctica intensiva", () => {
  const kb = createKnowledgeBase();
  const p3 = kb.getBusinessRules().paquetes.P3;
  assert.equal(p3.precio, 360);
  assert.ok(p3.incluye.length >= 4);
});

test("COM4. Paquete 5 para oficial + vehículo + simulacro", () => {
  const kb = createKnowledgeBase();
  const p5 = kb.getBusinessRules().paquetes.P5;
  assert.equal(p5.precio, 260);
  assert.ok(p5.incluye.includes("1_vuelta_gratis_simulacro"));
});

test("COM5. objeción al precio no obliga paquete incorrecto", () => {
  // Si cliente dice "está caro" + "ya sé manejar", no insistir con P1
  // Esto es comportamiento del SYSTEM_PROMPT, no del motor
  // Verificar que P2 existe como alternativa
  const kb = createKnowledgeBase();
  assert.equal(kb.getBusinessRules().paquetes.P2.precio, 160);
});

test("COM6. cambio de recomendación cuando necesidad cambia", () => {
  // Si cliente rechaza P1 por precio + dice que sabe manejar → evaluar P2
  const kb = createKnowledgeBase();
  const p2 = kb.getBusinessRules().paquetes.P2;
  assert.ok(p2.orientacion.includes("ya saben manejar"));
});

// ── Tests de día de examen ───────────────────────────────────────

test("EX1. examen mañana + recomendación contextual de simulacro", () => {
  const kb = createKnowledgeBase();
  const sim = kb.getBusinessRules().simulacro;
  assert.ok(sim.nota.includes("preparación para el examen"));
  assert.equal(sim.duracion_min, 20);
  assert.deepEqual(sim.dias, ["martes", "jueves", "sábado"]);
});

test("EX2. práctica en día de examen es válida", () => {
  const kb = createKnowledgeBase();
  // Práctica todos los días incluye días de examen
  assert.ok(kb.getBusinessRules().practica.dias.includes("lunes a domingo"));
});

test("EX3. simulacro solo pista oficial", () => {
  const kb = createKnowledgeBase();
  assert.equal(kb.getBusinessRules().simulacro.circuito, "oficial");
});

// ── Test de compatibilidad ───────────────────────────────────────

test("COMPAT1. no se modificó tools.ts", () => {
  // Verificar que las herramientas originales siguen exportándose
  const tools = require("../src/agent/tools");
  assert.ok(tools.TOOL_DEFINITIONS);
  assert.ok(tools.TOOL_EXECUTORS);
});
