import { test } from "node:test";
import assert from "node:assert/strict";
import { buildResponse } from "../src/agent/response-builder";
import type { ConversationStateData } from "../src/agent/types";
import type { ResolvedContext } from "../src/agent/context-resolver";
import type { Recommendation } from "../src/agent/recommendation-engine";

// ── Helpers ─────────────────────────────────────────────────────

function makeState(overrides: Partial<ConversationStateData> = {}): ConversationStateData {
  return {
    chatwootConversationId: 1,
    phone: "51917595954",
    chatwootContactId: 9,
    sourceId: "51917595954",
    activeIntent: "PRACTICA",
    phase: "GATHERING",
    slots: {},
    repromptCount: 0,
    lastQuestionAsked: null,
    messageCount: 2,
    expiresAt: null,
    ...overrides,
  };
}

function makeContext(overrides: Partial<ResolvedContext> = {}): ResolvedContext {
  return {
    clientProfile: {
      hasReservations: false,
      lastCategory: "A1",
      lastActivity: null,
      hasPackage: false,
    },
    temporalContext: {
      isExamDay: false,
      currentDayOfWeek: "lunes",
      currentHour: 10,
    },
    conversationContext: {
      messageCount: 2,
      isNewUser: false,
      activeIntent: "PRACTICA",
      phase: "GATHERING",
      slotsCollected: {},
      missingSlots: [],
    },
    knowledgeContext: "",
    ...overrides,
  };
}

function makeRecommendation(overrides: Partial<Recommendation> = {}): Recommendation {
  return {
    type: "PACKAGE",
    target: "P2",
    reason: "test reason",
    confidence: 0.9,
    supportingFacts: [],
    alternatives: [],
    estimatedValue: { price: 160, savings: 20, separateTotal: 180 },
    requiresConfirmation: true,
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────

test("RB1. respuesta RESPOND directa", () => {
  const result = buildResponse({
    action: { type: "RESPOND", content: "Los horarios son de 8 AM a 5:30 PM." },
    state: makeState(),
    context: makeContext(),
    recommendation: null,
  });
  assert.ok(result.text.includes("8 AM"));
  assert.equal(result.includeRecommendation, false);
});

test("RB2. respuesta ASK_MISSING_SLOT", () => {
  const result = buildResponse({
    action: { type: "REPROMPT", question: "¿Qué categoría de licencia necesitas?", slotName: "categoria" },
    state: makeState(),
    context: makeContext(),
    recommendation: null,
  });
  assert.ok(result.text.includes("categoría"));
});

test("RB3. recomendación P2 con ahorro", () => {
  const result = buildResponse({
    action: { type: "RECOMMEND", recommendation: makeRecommendation() },
    state: makeState(),
    context: makeContext(),
    recommendation: makeRecommendation(),
  });
  assert.ok(result.text.includes("S/160"));
  assert.ok(result.text.includes("S/20"));
  assert.equal(result.includeRecommendation, true);
  assert.equal(result.salesFollowUp, true);
});

test("RB4. recomendación P1", () => {
  const result = buildResponse({
    action: { type: "RECOMMEND", recommendation: makeRecommendation({ target: "P1", estimatedValue: { price: 680, savings: null, separateTotal: null } }) },
    state: makeState(),
    context: makeContext(),
    recommendation: makeRecommendation({ target: "P1", estimatedValue: { price: 680, savings: null, separateTotal: null } }),
  });
  assert.ok(result.text.includes("S/680"));
  assert.ok(result.text.includes("reservar"));
});

test("RB5. simulacro individual", () => {
  const result = buildResponse({
    action: { type: "RECOMMEND", recommendation: makeRecommendation({ type: "SERVICE", target: "SIMULACRO", estimatedValue: { price: 60, savings: null, separateTotal: null } }) },
    state: makeState(),
    context: makeContext(),
    recommendation: makeRecommendation({ type: "SERVICE", target: "SIMULACRO", estimatedValue: { price: 60, savings: null, separateTotal: null } }),
  });
  assert.ok(result.text.includes("S/60"));
  assert.ok(result.text.includes("20 minutos"));
  assert.ok(result.text.includes("5:30 AM"));
});

test("RB6. confirmación con resumen", () => {
  const result = buildResponse({
    action: { type: "CONFIRM", summary: "Categoría: A1\nCircuito: oficial\nFecha: martes\nHora: 10:00\n\n¿Es correcto?" },
    state: makeState(),
    context: makeContext(),
    recommendation: null,
  });
  assert.ok(result.text.includes("A1"));
  assert.ok(result.text.includes("¿Es correcto?"));
});

test("RB7. éxito de herramienta crear_reserva", () => {
  const result = buildResponse({
    action: { type: "EXECUTE_TOOL", tool: "crear_reserva", args: {} },
    state: makeState({ phase: "EXECUTING" }),
    context: makeContext(),
    recommendation: null,
    toolResult: { status: "SUCCESS", tool: "crear_reserva", result: { id: 123 } },
  });
  assert.ok(result.text.includes("reserva"));
  assert.ok(result.text.includes("QR"));
  assert.ok(result.text.includes("Yape"));
});

test("RB8. fallo de herramienta TECHNICAL_ERROR", () => {
  const result = buildResponse({
    action: { type: "EXECUTE_TOOL", tool: "crear_reserva", args: {} },
    state: makeState({ phase: "EXECUTING" }),
    context: makeContext(),
    recommendation: null,
    toolResult: { status: "TECHNICAL_ERROR", tool: "crear_reserva", result: null, error: "timeout" },
  });
  assert.ok(result.text.includes("problema técnico"));
  assert.ok(result.text.includes("asesor"));
});

test("RB9. handoff", () => {
  const result = buildResponse({
    action: { type: "HANDOFF", reason: "Usuario solicitó asesor" },
    state: makeState({ slots: { categoria: "A1", fecha: "martes" } }),
    context: makeContext(),
    recommendation: null,
  });
  assert.ok(result.text.includes("asesor especializado"));
  assert.ok(result.text.includes("A1"));
  assert.ok(result.text.includes("martes"));
});

test("RB10. objeción de precio (RESPOND)", () => {
  const result = buildResponse({
    action: { type: "RESPOND", content: "Entiendo tu preocupación. El valor incluye..." },
    state: makeState(),
    context: makeContext(),
    recommendation: null,
  });
  assert.ok(result.text.includes("preocupación"));
});

test("RB11. recomendación no cambia intención", () => {
  const state = makeState({ activeIntent: "PRACTICA" });
  buildResponse({
    action: { type: "RECOMMEND", recommendation: makeRecommendation() },
    state,
    context: makeContext(),
    recommendation: makeRecommendation(),
  });
  assert.equal(state.activeIntent, "PRACTICA"); // No cambió
});

test("RB12. comprobante pendiente (NO_AVAILABILITY en contexto pago)", () => {
  const result = buildResponse({
    action: { type: "EXECUTE_TOOL", tool: "consultar_disponibilidad", args: {} },
    state: makeState(),
    context: makeContext(),
    recommendation: null,
    toolResult: { status: "NO_AVAILABILITY", tool: "consultar_disponibilidad", result: null },
  });
  assert.ok(result.text.includes("no hay disponibilidad"));
  assert.ok(result.text.includes("otro día"));
});

test("RB13. validation error", () => {
  const result = buildResponse({
    action: { type: "EXECUTE_TOOL", tool: "crear_reserva", args: {} },
    state: makeState(),
    context: makeContext(),
    recommendation: null,
    toolResult: { status: "VALIDATION_ERROR", tool: "crear_reserva", result: null, error: "Falta circuito" },
  });
  assert.ok(result.text.includes("Falta circuito"));
});

test("RB15. vehicle recommendation", () => {
  const result = buildResponse({
    action: { type: "RECOMMEND", recommendation: makeRecommendation({ type: "VEHICLE", target: "Kia Picanto 2026 automático", reason: "Para A1 recomendamos automático." }) },
    state: makeState(),
    context: makeContext(),
    recommendation: makeRecommendation({ type: "VEHICLE", target: "Kia Picanto 2026 automático", reason: "Para A1 recomendamos automático." }),
  });
  assert.ok(result.text.includes("Kia Picanto"));
  assert.ok(result.text.includes("automático"));
});

test("RB16. contextual simulacro recommendation", () => {
  const result = buildResponse({
    action: { type: "RECOMMEND", recommendation: makeRecommendation({ type: "CONTEXTUAL_SIMULACRO", target: "SIMULACRO", reason: "Dado que tu examen es pronto, el simulacro te permite practicar en la pista oficial.", estimatedValue: { price: 60, savings: null, separateTotal: null } }) },
    state: makeState(),
    context: makeContext(),
    recommendation: makeRecommendation({ type: "CONTEXTUAL_SIMULACRO", target: "SIMULACRO", reason: "Dado que tu examen es pronto, el simulacro te permite practicar en la pista oficial.", estimatedValue: { price: 60, savings: null, separateTotal: null } }),
  });
  assert.ok(result.text.includes("examen"));
  assert.ok(result.text.includes("S/60"));
  assert.ok(result.text.includes("5:30 AM"));
});

test("RB17. ASK_CLARIFICATION con opciones", () => {
  const result = buildResponse({
    action: { type: "ASK_CLARIFICATION", options: ["práctica de manejo", "simulacro de examen", "paquetes", "horarios"] },
    state: makeState(),
    context: makeContext(),
    recommendation: null,
  });
  assert.ok(result.text.includes("práctica de manejo"));
  assert.ok(result.text.includes("simulacro"));
  assert.ok(result.text.includes("paquetes"));
  assert.equal(result.includeRecommendation, false);
  assert.equal(result.salesFollowUp, false);
});

test("RB18. BUSINESS_ERROR con mensaje", () => {
  const result = buildResponse({
    action: { type: "EXECUTE_TOOL", tool: "crear_reserva", args: {} },
    state: makeState({ phase: "EXECUTING" }),
    context: makeContext(),
    recommendation: null,
    toolResult: { status: "BUSINESS_ERROR", tool: "crear_reserva", result: null, error: "Horario ya ocupado" },
  });
  assert.ok(result.text.includes("Horario ya ocupado"));
  assert.ok(result.text.includes("asesor"));
});
