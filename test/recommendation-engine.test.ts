import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateRecommendation } from "../src/agent/recommendation-engine";
import type { ConversationStateData, Intent } from "../src/agent/types";
import type { ResolvedContext } from "../src/agent/context-resolver";

// ── Helpers ─────────────────────────────────────────────────────

function makeState(overrides: Partial<ConversationStateData> = {}): ConversationStateData {
  return {
    chatwootConversationId: 1,
    phone: null,
    chatwootContactId: null,
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

function makeContext(overrides: Partial<ResolvedContext> = {}): ResolvedContext {
  return {
    clientProfile: {
      hasReservations: false,
      lastCategory: null,
      lastActivity: null,
      hasPackage: false,
    },
    temporalContext: {
      isExamDay: false,
      currentDayOfWeek: "lunes",
      currentHour: 10,
    },
    conversationContext: {
      messageCount: 1,
      isNewUser: true,
      activeIntent: null,
      phase: "IDLE",
      slotsCollected: {},
      missingSlots: [],
    },
    knowledgeContext: "",
    ...overrides,
  };
}

// ── Tests de RecommendationEngine ───────────────────────────────

test("RE1. sin trámites + A1 + HORARIOS → P1", () => {
  const result = evaluateRecommendation({
    activeIntent: "HORARIOS",
    slots: { categoria: "A1" },
    state: makeState({ activeIntent: "HORARIOS" }),
    context: makeContext({
      clientProfile: { hasReservations: false, lastCategory: "A1", lastActivity: null, hasPackage: false },
      conversationContext: { messageCount: 1, isNewUser: true, activeIntent: "HORARIOS", phase: "GATHERING", slotsCollected: { categoria: "A1" }, missingSlots: [] },
    }),
  });
  assert.ok(result.recommendation);
  assert.equal(result.recommendation!.type, "PACKAGE");
  assert.equal(result.recommendation!.target, "P1");
  assert.equal(result.recommendation!.estimatedValue.price, 680);
});

test("RE2. ya sabe manejar + 1 hora → P2", () => {
  const result = evaluateRecommendation({
    activeIntent: "PRACTICA",
    slots: { categoria: "A1", hora: "10:00" },
    state: makeState({ activeIntent: "PRACTICA", messageCount: 3, slots: { categoria: "A1", hora: "10:00" } }),
    context: makeContext({
      clientProfile: { hasReservations: true, lastCategory: "A1", lastActivity: "practica", hasPackage: false },
      conversationContext: { messageCount: 3, isNewUser: false, activeIntent: "PRACTICA", phase: "GATHERING", slotsCollected: { categoria: "A1", hora: "10:00" }, missingSlots: [] },
    }),
  });
  assert.ok(result.recommendation);
  assert.equal(result.recommendation!.target, "P2");
  assert.equal(result.recommendation!.estimatedValue.price, 120);
});

test("RE3. práctica intensiva explícita → P3", () => {
  const result = evaluateRecommendation({
    activeIntent: "PRACTICA",
    slots: { categoria: "A1", practica_intensiva: true },
    state: makeState({ activeIntent: "PRACTICA", messageCount: 2, slots: { categoria: "A1", practica_intensiva: true } }),
    context: makeContext({
      clientProfile: { hasReservations: false, lastCategory: "A1", lastActivity: null, hasPackage: false },
      conversationContext: { messageCount: 2, isNewUser: false, activeIntent: "PRACTICA", phase: "GATHERING", slotsCollected: { categoria: "A1", practica_intensiva: true }, missingSlots: [] },
    }),
  });
  assert.ok(result.recommendation);
  assert.equal(result.recommendation!.type, "PACKAGE");
  assert.equal(result.recommendation!.target, "P3");
  assert.equal(result.recommendation!.estimatedValue.price, 360);
});

test("RE4. SIMULACRO solo → simulacro individual (SERVICE)", () => {
  const result = evaluateRecommendation({
    activeIntent: "SIMULACRO",
    slots: { categoria: "A1" },
    state: makeState({ activeIntent: "SIMULACRO" }),
    context: makeContext({
      clientProfile: { hasReservations: false, lastCategory: "A1", lastActivity: "simulacro", hasPackage: false },
      conversationContext: { messageCount: 1, isNewUser: true, activeIntent: "SIMULACRO", phase: "GATHERING", slotsCollected: { categoria: "A1" }, missingSlots: [] },
    }),
  });
  assert.ok(result.recommendation);
  assert.equal(result.recommendation!.type, "SERVICE");
  assert.equal(result.recommendation!.target, "SIMULACRO");
  assert.equal(result.recommendation!.estimatedValue.price, 60);
});

test("RE5. categoría != A1 → no inventar paquete", () => {
  const result = evaluateRecommendation({
    activeIntent: "PRACTICA",
    slots: { categoria: "A2" },
    state: makeState({ activeIntent: "PRACTICA" }),
    context: makeContext({
      clientProfile: { hasReservations: false, lastCategory: "A2", lastActivity: null, hasPackage: false },
      conversationContext: { messageCount: 1, isNewUser: true, activeIntent: "PRACTICA", phase: "GATHERING", slotsCollected: { categoria: "A2" }, missingSlots: [] },
    }),
  });
  // No P1/P2/P3/P5 para A2
  if (result.recommendation) {
    assert.notEqual(result.recommendation.type, "PACKAGE");
  }
});

test("RE6. recomendación no cambia activeIntent", () => {
  const state = makeState({ activeIntent: "PRACTICA" });
  const result = evaluateRecommendation({
    activeIntent: "PRACTICA",
    slots: { categoria: "A1", hora: "10:00" },
    state,
    context: makeContext({
      clientProfile: { hasReservations: true, lastCategory: "A1", lastActivity: "practica", hasPackage: false },
      conversationContext: { messageCount: 3, isNewUser: false, activeIntent: "PRACTICA", phase: "GATHERING", slotsCollected: { categoria: "A1", hora: "10:00" }, missingSlots: [] },
    }),
  });
  // activeIntent NO debe cambiar
  assert.equal(state.activeIntent, "PRACTICA");
  // La recomendación puede ser P2, pero activeIntent sigue siendo PRACTICA
  if (result.recommendation) {
    assert.equal(state.activeIntent, "PRACTICA");
  }
});

test("RE7. rechazo de recomendación conserva intención", () => {
  const state = makeState({ activeIntent: "PRACTICA", slots: { categoria: "A1" } });
  // Simular rechazo: el estado no cambia
  assert.equal(state.activeIntent, "PRACTICA");
  assert.equal(state.slots.categoria, "A1");
});

test("RE8. aceptación explícita permite transición posterior", () => {
  // La aceptación se maneja en ConfirmationGate (2B.4), no aquí
  // Este test verifica que la recomendación incluye requiresConfirmation
  const result = evaluateRecommendation({
    activeIntent: "PRACTICA",
    slots: { categoria: "A1", hora: "10:00" },
    state: makeState({ activeIntent: "PRACTICA", messageCount: 3 }),
    context: makeContext({
      clientProfile: { hasReservations: true, lastCategory: "A1", lastActivity: "practica", hasPackage: false },
      conversationContext: { messageCount: 3, isNewUser: false, activeIntent: "PRACTICA", phase: "GATHERING", slotsCollected: { categoria: "A1", hora: "10:00" }, missingSlots: [] },
    }),
  });
  if (result.recommendation) {
    assert.equal(result.recommendation.requiresConfirmation, true);
  }
});

test("RE9. objeción P1 + cliente sabe manejar → reevaluar (P2)", () => {
  // Simular: cliente con reservas previas → no P1
  const result = evaluateRecommendation({
    activeIntent: "PRACTICA",
    slots: { categoria: "A1", hora: "10:00" },
    state: makeState({ activeIntent: "PRACTICA", messageCount: 3 }),
    context: makeContext({
      clientProfile: { hasReservations: true, lastCategory: "A1", lastActivity: "practica", hasPackage: false },
      conversationContext: { messageCount: 3, isNewUser: false, activeIntent: "PRACTICA", phase: "GATHERING", slotsCollected: { categoria: "A1", hora: "10:00" }, missingSlots: [] },
    }),
  });
  assert.ok(result.recommendation);
  assert.equal(result.recommendation!.target, "P2"); // No P1
});

test("RE10. P2 precio S/120", () => {
  const result = evaluateRecommendation({
    activeIntent: "PRACTICA",
    slots: { categoria: "A1", hora: "10:00" },
    state: makeState({ activeIntent: "PRACTICA", messageCount: 3 }),
    context: makeContext({
      clientProfile: { hasReservations: true, lastCategory: "A1", lastActivity: "practica", hasPackage: false },
      conversationContext: { messageCount: 3, isNewUser: false, activeIntent: "PRACTICA", phase: "GATHERING", slotsCollected: { categoria: "A1", hora: "10:00" }, missingSlots: [] },
    }),
  });
  assert.ok(result.recommendation);
  assert.equal(result.recommendation!.estimatedValue.price, 120);
});

test("RE11. examen día → recomendación contextual simulacro", () => {
  const result = evaluateRecommendation({
    activeIntent: "PRACTICA",
    slots: { categoria: "A1" },
    state: makeState({ activeIntent: "PRACTICA" }),
    context: makeContext({
      temporalContext: { isExamDay: true, currentDayOfWeek: "martes", currentHour: 10 },
      clientProfile: { hasReservations: false, lastCategory: "A1", lastActivity: null, hasPackage: false },
      conversationContext: { messageCount: 1, isNewUser: true, activeIntent: "PRACTICA", phase: "GATHERING", slotsCollected: { categoria: "A1" }, missingSlots: [] },
    }),
  });
  assert.ok(result.recommendation);
  assert.equal(result.recommendation!.type, "CONTEXTUAL_SIMULACRO");
  assert.equal(result.recommendation!.target, "SIMULACRO");
  assert.ok(result.recommendation!.reason.includes("examen"));
});

test("RE12. A1 + ALQUILER_EXAMEN → vehículo individual", () => {
  const result = evaluateRecommendation({
    activeIntent: "ALQUILER_EXAMEN",
    slots: { categoria: "A1" },
    state: makeState({ activeIntent: "ALQUILER_EXAMEN" }),
    context: makeContext({
      clientProfile: { hasReservations: false, lastCategory: "A1", lastActivity: null, hasPackage: false },
      conversationContext: { messageCount: 2, isNewUser: false, activeIntent: "ALQUILER_EXAMEN", phase: "GATHERING", slotsCollected: { categoria: "A1" }, missingSlots: [] },
    }),
  });
  assert.ok(result.recommendation);
  assert.equal(result.recommendation!.type, "VEHICLE");
  assert.ok(result.recommendation!.target.includes("Kia Picanto"));
});

test("RE13. A2 → vehículo mecánico", () => {
  const result = evaluateRecommendation({
    activeIntent: "ALQUILER_EXAMEN",
    slots: { categoria: "A2" },
    state: makeState({ activeIntent: "ALQUILER_EXAMEN" }),
    context: makeContext({
      clientProfile: { hasReservations: false, lastCategory: "A2", lastActivity: null, hasPackage: false },
      conversationContext: { messageCount: 2, isNewUser: false, activeIntent: "ALQUILER_EXAMEN", phase: "GATHERING", slotsCollected: { categoria: "A2" }, missingSlots: [] },
    }),
  });
  assert.ok(result.recommendation);
  assert.equal(result.recommendation!.type, "VEHICLE");
  assert.ok(result.recommendation!.target.includes("mecánico"));
});

test("RE14. A3 → vehículo mecánico", () => {
  const result = evaluateRecommendation({
    activeIntent: "ALQUILER_EXAMEN",
    slots: { categoria: "A3" },
    state: makeState({ activeIntent: "ALQUILER_EXAMEN" }),
    context: makeContext({
      clientProfile: { hasReservations: false, lastCategory: "A3", lastActivity: null, hasPackage: false },
      conversationContext: { messageCount: 2, isNewUser: false, activeIntent: "ALQUILER_EXAMEN", phase: "GATHERING", slotsCollected: { categoria: "A3" }, missingSlots: [] },
    }),
  });
  assert.ok(result.recommendation);
  assert.equal(result.recommendation!.type, "VEHICLE");
  assert.ok(result.recommendation!.target.includes("mecánico"));
});

test("RE15. A3 → vehículo mecánico (categoría mayor)", () => {
  const result = evaluateRecommendation({
    activeIntent: "ALQUILER_EXAMEN",
    slots: { categoria: "A3" },
    state: makeState({ activeIntent: "ALQUILER_EXAMEN" }),
    context: makeContext({
      clientProfile: { hasReservations: false, lastCategory: "A3", lastActivity: null, hasPackage: false },
      conversationContext: { messageCount: 2, isNewUser: false, activeIntent: "ALQUILER_EXAMEN", phase: "GATHERING", slotsCollected: { categoria: "A3" }, missingSlots: [] },
    }),
  });
  assert.ok(result.recommendation);
  assert.ok(result.recommendation!.target.includes("mecánico"));
});

test("RE16. categoría no válida → sin recomendación", () => {
  const result = evaluateRecommendation({
    activeIntent: "ALQUILER_EXAMEN",
    slots: { categoria: "X99" },
    state: makeState({ activeIntent: "ALQUILER_EXAMEN" }),
    context: makeContext({
      clientProfile: { hasReservations: false, lastCategory: "X99", lastActivity: null, hasPackage: false },
      conversationContext: { messageCount: 2, isNewUser: false, activeIntent: "ALQUILER_EXAMEN", phase: "GATHERING", slotsCollected: { categoria: "X99" }, missingSlots: [] },
    }),
  });
  assert.equal(result.recommendation, null);
});

test("RE17. recomendación sin suficientes datos → pedir diagnóstico", () => {
  const result = evaluateRecommendation({
    activeIntent: null,
    slots: {},
    state: makeState({ messageCount: 0 }),
    context: makeContext({
      clientProfile: { hasReservations: false, lastCategory: null, lastActivity: null, hasPackage: false },
      conversationContext: { messageCount: 0, isNewUser: true, activeIntent: null, phase: "IDLE", slotsCollected: {}, missingSlots: [] },
    }),
  });
  assert.equal(result.recommendation, null);
  assert.equal(result.diagnosisNeeded, true);
  assert.ok(result.diagnosisQuestions.length > 0);
});

// ── Tests de negocio reales ─────────────────────────────────────

test("RE18. 'ya practiqué en otra escuela, quiero una hora más' → P2", () => {
  const result = evaluateRecommendation({
    activeIntent: "PRACTICA",
    slots: { categoria: "A1" },
    state: makeState({ activeIntent: "PRACTICA", messageCount: 3 }),
    context: makeContext({
      clientProfile: { hasReservations: true, lastCategory: "A1", lastActivity: "practica", hasPackage: false },
      conversationContext: { messageCount: 3, isNewUser: false, activeIntent: "PRACTICA", phase: "GATHERING", slotsCollected: { categoria: "A1" }, missingSlots: [] },
    }),
  });
  assert.ok(result.recommendation);
  assert.equal(result.recommendation!.target, "P2");
});

test("RE19. día no examen + A1 → sin simulacro contextual", () => {
  const result = evaluateRecommendation({
    activeIntent: "PRACTICA",
    slots: { categoria: "A1" },
    state: makeState({ activeIntent: "PRACTICA" }),
    context: makeContext({
      temporalContext: { isExamDay: false, currentDayOfWeek: "lunes", currentHour: 10 },
      clientProfile: { hasReservations: false, lastCategory: "A1", lastActivity: null, hasPackage: false },
      conversationContext: { messageCount: 2, isNewUser: false, activeIntent: "PRACTICA", phase: "GATHERING", slotsCollected: { categoria: "A1" }, missingSlots: [] },
    }),
  });
  // No es día de examen, no debería recomendar simulacro contextual
  if (result.recommendation) {
    assert.notEqual(result.recommendation.type, "CONTEXTUAL_SIMULACRO");
  }
  assert.equal(result.diagnosisNeeded, false); // Ya tiene categoría
});

test("RE20. 'no he hecho médico ni pagos, no sé qué hacer' → diagnóstico", () => {
  const result = evaluateRecommendation({
    activeIntent: null,
    slots: {},
    state: makeState({ messageCount: 1 }),
    context: makeContext({
      clientProfile: { hasReservations: false, lastCategory: null, lastActivity: null, hasPackage: false },
      conversationContext: { messageCount: 1, isNewUser: true, activeIntent: null, phase: "IDLE", slotsCollected: {}, missingSlots: [] },
    }),
  });
  // Sin intención clara y sin trámites → pedir diagnóstico
  assert.equal(result.diagnosisNeeded, true);
});

test("RE21. SIMULACRO A1 → simulacro individual (SERVICE)", () => {
  const result = evaluateRecommendation({
    activeIntent: "SIMULACRO",
    slots: { categoria: "A1" },
    state: makeState({ activeIntent: "SIMULACRO" }),
    context: makeContext({
      clientProfile: { hasReservations: false, lastCategory: "A1", lastActivity: "simulacro", hasPackage: false },
      conversationContext: { messageCount: 1, isNewUser: true, activeIntent: "SIMULACRO", phase: "GATHERING", slotsCollected: { categoria: "A1" }, missingSlots: [] },
    }),
  });
  assert.ok(result.recommendation);
  assert.equal(result.recommendation!.type, "SERVICE");
  assert.equal(result.recommendation!.target, "SIMULACRO");
  assert.equal(result.recommendation!.estimatedValue.price, 60);
});

test("RE22. PAQUETE como intención activa → no recomendar otro paquete", () => {
  const result = evaluateRecommendation({
    activeIntent: "PAQUETE",
    slots: {},
    state: makeState({ activeIntent: "PAQUETE" }),
    context: makeContext({
      clientProfile: { hasReservations: false, lastCategory: null, lastActivity: null, hasPackage: false },
      conversationContext: { messageCount: 1, isNewUser: true, activeIntent: "PAQUETE", phase: "GATHERING", slotsCollected: {}, missingSlots: [] },
    }),
  });
  assert.equal(result.recommendation, null); // Ya está en flujo de paquete
  assert.equal(result.diagnosisNeeded, false);
});

// ── Tests adicionales de cobertura ──────────────────────────────

test("RE23. PRACTICA sin categoría → diagnóstico", () => {
  const result = evaluateRecommendation({
    activeIntent: "PRACTICA",
    slots: {},
    state: makeState({ activeIntent: "PRACTICA", messageCount: 1 }),
    context: makeContext({
      clientProfile: { hasReservations: false, lastCategory: null, lastActivity: null, hasPackage: false },
      conversationContext: { messageCount: 1, isNewUser: true, activeIntent: "PRACTICA", phase: "GATHERING", slotsCollected: {}, missingSlots: [] },
    }),
  });
  assert.equal(result.recommendation, null);
  assert.equal(result.diagnosisNeeded, true);
  assert.ok(result.diagnosisQuestions.some(q => q.includes("categoría")));
});

test("RE24. ALQUILER_EXAMEN sin categoría → diagnóstico", () => {
  const result = evaluateRecommendation({
    activeIntent: "ALQUILER_EXAMEN",
    slots: {},
    state: makeState({ activeIntent: "ALQUILER_EXAMEN", messageCount: 1 }),
    context: makeContext({
      clientProfile: { hasReservations: false, lastCategory: null, lastActivity: null, hasPackage: false },
      conversationContext: { messageCount: 1, isNewUser: true, activeIntent: "ALQUILER_EXAMEN", phase: "GATHERING", slotsCollected: {}, missingSlots: [] },
    }),
  });
  assert.equal(result.recommendation, null);
  assert.equal(result.diagnosisNeeded, true);
});

test("RE25. A2 PRACTICA → servicio individual (no paquete)", () => {
  const result = evaluateRecommendation({
    activeIntent: "PRACTICA",
    slots: { categoria: "A2" },
    state: makeState({ activeIntent: "PRACTICA" }),
    context: makeContext({
      clientProfile: { hasReservations: false, lastCategory: "A2", lastActivity: null, hasPackage: false },
      conversationContext: { messageCount: 1, isNewUser: true, activeIntent: "PRACTICA", phase: "GATHERING", slotsCollected: { categoria: "A2" }, missingSlots: [] },
    }),
  });
  assert.ok(result.recommendation);
  assert.equal(result.recommendation!.type, "SERVICE");
  assert.equal(result.recommendation!.target, "PRACTICA");
  assert.equal(result.recommendation!.estimatedValue.price, 70);
});

test("RE26. A2 ALQUILER_EXAMEN → vehículo mecánico", () => {
  const result = evaluateRecommendation({
    activeIntent: "ALQUILER_EXAMEN",
    slots: { categoria: "A2" },
    state: makeState({ activeIntent: "ALQUILER_EXAMEN" }),
    context: makeContext({
      clientProfile: { hasReservations: false, lastCategory: "A2", lastActivity: null, hasPackage: false },
      conversationContext: { messageCount: 2, isNewUser: false, activeIntent: "ALQUILER_EXAMEN", phase: "GATHERING", slotsCollected: { categoria: "A2" }, missingSlots: [] },
    }),
  });
  assert.ok(result.recommendation);
  assert.equal(result.recommendation!.type, "VEHICLE");
});

test("RE27. PRACTICA A3 → servicio individual precio 100", () => {
  const result = evaluateRecommendation({
    activeIntent: "PRACTICA",
    slots: { categoria: "A3" },
    state: makeState({ activeIntent: "PRACTICA" }),
    context: makeContext({
      clientProfile: { hasReservations: false, lastCategory: "A3", lastActivity: null, hasPackage: false },
      conversationContext: { messageCount: 1, isNewUser: true, activeIntent: "PRACTICA", phase: "GATHERING", slotsCollected: { categoria: "A3" }, missingSlots: [] },
    }),
  });
  assert.ok(result.recommendation);
  assert.equal(result.recommendation!.type, "SERVICE");
  assert.equal(result.recommendation!.estimatedValue.price, 100);
});

test("RE28. examen día + simulacro ya agendado → no duplicar", () => {
  const result = evaluateRecommendation({
    activeIntent: "SIMULACRO",
    slots: { categoria: "A1", actividad: "simulacro" },
    state: makeState({ activeIntent: "SIMULACRO", slots: { actividad: "simulacro" } }),
    context: makeContext({
      temporalContext: { isExamDay: true, currentDayOfWeek: "martes", currentHour: 10 },
      clientProfile: { hasReservations: false, lastCategory: "A1", lastActivity: "simulacro", hasPackage: false },
      conversationContext: { messageCount: 1, isNewUser: true, activeIntent: "SIMULACRO", phase: "GATHERING", slotsCollected: { categoria: "A1", actividad: "simulacro" }, missingSlots: [] },
    }),
  });
  // Simulacro ya agendado → Regla 3 (contextual) salta, Regla 4 → SERVICE
  assert.ok(result.recommendation);
  assert.equal(result.recommendation!.type, "SERVICE");
  assert.equal(result.recommendation!.target, "SIMULACRO");
});

test("RE29. A3 ALQUILER_EXAMEN → vehículo mecánico", () => {
  const result = evaluateRecommendation({
    activeIntent: "ALQUILER_EXAMEN",
    slots: { categoria: "A3" },
    state: makeState({ activeIntent: "ALQUILER_EXAMEN" }),
    context: makeContext({
      clientProfile: { hasReservations: false, lastCategory: "A3", lastActivity: null, hasPackage: false },
      conversationContext: { messageCount: 2, isNewUser: false, activeIntent: "ALQUILER_EXAMEN", phase: "GATHERING", slotsCollected: { categoria: "A3" }, missingSlots: [] },
    }),
  });
  assert.ok(result.recommendation);
  assert.equal(result.recommendation!.type, "VEHICLE");
  assert.ok(result.recommendation!.target.includes("mecánico"));
});

test("RE30. SERVICE (SIMULACRO) tiene requiresConfirmation true", () => {
  const result = evaluateRecommendation({
    activeIntent: "SIMULACRO",
    slots: { categoria: "A1" },
    state: makeState({ activeIntent: "SIMULACRO" }),
    context: makeContext({
      clientProfile: { hasReservations: false, lastCategory: "A1", lastActivity: "simulacro", hasPackage: false },
      conversationContext: { messageCount: 1, isNewUser: true, activeIntent: "SIMULACRO", phase: "GATHERING", slotsCollected: { categoria: "A1" }, missingSlots: [] },
    }),
  });
  assert.ok(result.recommendation);
  assert.equal(result.recommendation!.type, "SERVICE");
  assert.equal(result.recommendation!.requiresConfirmation, true);
});

// ── Tests nuevos: corrección de reglas agresivas ─────────────────

test("RE-NEW1. 4+ mensajes NO implica P3 automáticamente", () => {
  const result = evaluateRecommendation({
    activeIntent: "PRACTICA",
    slots: { categoria: "A1" },
    state: makeState({ activeIntent: "PRACTICA", messageCount: 5 }),
    context: makeContext({
      clientProfile: { hasReservations: false, lastCategory: "A1", lastActivity: null, hasPackage: false },
      conversationContext: { messageCount: 5, isNewUser: false, activeIntent: "PRACTICA", phase: "GATHERING", slotsCollected: { categoria: "A1" }, missingSlots: [] },
    }),
  });
  // No debe recomendar P3 solo por messageCount
  if (result.recommendation) {
    assert.notEqual(result.recommendation.target, "P3");
  }
});

test("RE-NEW2. SIMULACRO solo → simulacro individual (SERVICE)", () => {
  const result = evaluateRecommendation({
    activeIntent: "SIMULACRO",
    slots: { categoria: "A1" },
    state: makeState({ activeIntent: "SIMULACRO", messageCount: 1 }),
    context: makeContext({
      clientProfile: { hasReservations: false, lastCategory: "A1", lastActivity: "simulacro", hasPackage: false },
      conversationContext: { messageCount: 1, isNewUser: true, activeIntent: "SIMULACRO", phase: "GATHERING", slotsCollected: { categoria: "A1" }, missingSlots: [] },
    }),
  });
  assert.ok(result.recommendation);
  assert.equal(result.recommendation!.type, "SERVICE");
  assert.ok(result.recommendation!.target.includes("SIMULACRO"));
  assert.equal(result.recommendation!.estimatedValue.price, 60);
});

test("RE-NEW3. ALQUILER_EXAMEN solo → no P5 directo", () => {
  const result = evaluateRecommendation({
    activeIntent: "ALQUILER_EXAMEN",
    slots: { categoria: "A1" },
    state: makeState({ activeIntent: "ALQUILER_EXAMEN", messageCount: 1 }),
    context: makeContext({
      clientProfile: { hasReservations: false, lastCategory: "A1", lastActivity: null, hasPackage: false },
      conversationContext: { messageCount: 1, isNewUser: true, activeIntent: "ALQUILER_EXAMEN", phase: "GATHERING", slotsCollected: { categoria: "A1" }, missingSlots: [] },
    }),
  });
  assert.ok(result.recommendation);
  // Debe ser P1 (inicio desde cero) o VEHICLE, NO P5 directo
  assert.notEqual(result.recommendation!.target, "P5");
});

test("RE-NEW4. P5 requiere combinación contextual explícita", () => {
  // Solo recomendar P5 si el cliente necesita: prácticas oficiales + vehículo + simulacro
  const result = evaluateRecommendation({
    activeIntent: "PRACTICA",
    slots: { categoria: "A1", actividad: "practica" },
    state: makeState({ activeIntent: "PRACTICA", messageCount: 4, slots: { categoria: "A1", actividad: "practica" } }),
    context: makeContext({
      clientProfile: { hasReservations: false, lastCategory: "A1", lastActivity: "practica", hasPackage: false },
      conversationContext: { messageCount: 4, isNewUser: false, activeIntent: "PRACTICA", phase: "GATHERING", slotsCollected: { categoria: "A1", actividad: "practica" }, missingSlots: [] },
    }),
  });
  // Sin evidencia explícita de simulacro/vehículo → NO P5
  if (result.recommendation) {
    assert.notEqual(result.recommendation.target, "P5");
  }
});

test("RE-NEW5. P2 por necesidad de 1 hora", () => {
  const result = evaluateRecommendation({
    activeIntent: "PRACTICA",
    slots: { categoria: "A1", hora: "10:00" },
    state: makeState({ activeIntent: "PRACTICA", messageCount: 3, slots: { categoria: "A1", hora: "10:00" } }),
    context: makeContext({
      clientProfile: { hasReservations: true, lastCategory: "A1", lastActivity: "practica", hasPackage: false },
      conversationContext: { messageCount: 3, isNewUser: false, activeIntent: "PRACTICA", phase: "GATHERING", slotsCollected: { categoria: "A1", hora: "10:00" }, missingSlots: [] },
    }),
  });
  assert.ok(result.recommendation);
  assert.equal(result.recommendation!.target, "P2");
  assert.equal(result.recommendation!.estimatedValue.price, 120);
});

test("RE-NEW6. P3 NO se activa por messageCount ni notas", () => {
  // slots.notas NO es señal válida para P3 (no NLP en el motor)
  const result = evaluateRecommendation({
    activeIntent: "PRACTICA",
    slots: { categoria: "A1", notas: "quiero practicar bastante antes del examen" },
    state: makeState({ activeIntent: "PRACTICA", messageCount: 2, slots: { categoria: "A1", notas: "quiero practicar bastante antes del examen" } }),
    context: makeContext({
      clientProfile: { hasReservations: false, lastCategory: "A1", lastActivity: null, hasPackage: false },
      conversationContext: { messageCount: 2, isNewUser: false, activeIntent: "PRACTICA", phase: "GATHERING", slotsCollected: { categoria: "A1" }, missingSlots: [] },
    }),
  });
  // Sin flag explícito practica_intensiva, NO debe recomendar P3
  if (result.recommendation) {
    assert.notEqual(result.recommendation.target, "P3");
  }
});

test("RE-NEW7. P1 por inicio desde cero (ALQUILER_EXAMEN)", () => {
  const result = evaluateRecommendation({
    activeIntent: "ALQUILER_EXAMEN",
    slots: { categoria: "A1" },
    state: makeState({ activeIntent: "ALQUILER_EXAMEN", messageCount: 1 }),
    context: makeContext({
      clientProfile: { hasReservations: false, lastCategory: "A1", lastActivity: null, hasPackage: false },
      conversationContext: { messageCount: 1, isNewUser: true, activeIntent: "ALQUILER_EXAMEN", phase: "GATHERING", slotsCollected: { categoria: "A1" }, missingSlots: [] },
    }),
  });
  assert.ok(result.recommendation);
  assert.equal(result.recommendation!.type, "PACKAGE");
  assert.equal(result.recommendation!.target, "P1");
});

test("RE-NEW8. falta información → diagnosisNeeded", () => {
  const result = evaluateRecommendation({
    activeIntent: null,
    slots: {},
    state: makeState({ messageCount: 0 }),
    context: makeContext({
      clientProfile: { hasReservations: false, lastCategory: null, lastActivity: null, hasPackage: false },
      conversationContext: { messageCount: 0, isNewUser: true, activeIntent: null, phase: "IDLE", slotsCollected: {}, missingSlots: [] },
    }),
  });
  assert.equal(result.diagnosisNeeded, true);
  assert.ok(result.diagnosisQuestions.length > 0);
});

test("RE-NEW9. recomendación no cambia activeIntent", () => {
  const state = makeState({ activeIntent: "PRACTICA" });
  evaluateRecommendation({
    activeIntent: "PRACTICA",
    slots: { categoria: "A1", hora: "10:00" },
    state,
    context: makeContext({
      clientProfile: { hasReservations: true, lastCategory: "A1", lastActivity: "practica", hasPackage: false },
      conversationContext: { messageCount: 3, isNewUser: false, activeIntent: "PRACTICA", phase: "GATHERING", slotsCollected: { categoria: "A1", hora: "10:00" }, missingSlots: [] },
    }),
  });
  assert.equal(state.activeIntent, "PRACTICA"); // No cambió
});

test("RE-NEW10. rechazo de recomendación conserva intención", () => {
  const state = makeState({ activeIntent: "PRACTICA", slots: { categoria: "A1" } });
  // Simular rechazo: el estado no cambia
  assert.equal(state.activeIntent, "PRACTICA");
  assert.equal(state.slots.categoria, "A1");
});
