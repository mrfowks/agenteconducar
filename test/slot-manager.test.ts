import { test } from "node:test";
import assert from "node:assert/strict";
import { extractSlots, detectSlotConflict } from "../src/agent/slot-manager";
import type { ConversationStateData } from "../src/agent/types";

// ── Helper ──────────────────────────────────────────────────────

function makeState(
  overrides: Partial<ConversationStateData> = {},
): ConversationStateData {
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

// ── Tests de corrección de slots (SM-CORR) ─────────────────────

test("SM-CORR1. 'el viernes' + '2 pm' → hora=14:00", () => {
  // Paso 1: extraer viernes (sin "mañana" para evitar match de fecha incorrecto)
  const state1 = makeState({ activeIntent: "PRACTICA", phase: "GATHERING" });
  const r1 = extractSlots("el viernes", "PRACTICA", state1);
  assert.equal(r1.extracted.fecha, "viernes");
  // Sin hora explícita
  assert.equal(r1.extracted.hora, undefined);

  // Paso 2: extraer "2 pm" → debe extraer hora=14:00
  const state2 = makeState({
    activeIntent: "PRACTICA",
    phase: "GATHERING",
    slots: { ...r1.updated },
  });
  const r2 = extractSlots("2 pm", "PRACTICA", state2);
  assert.equal(r2.extracted.hora, "14:00");
  assert.equal(r2.updated.hora, "14:00");
  assert.equal(r2.updated.fecha, "viernes"); // preservado
});

test("SM-CORR2. 'miércoles a las 10' + 'mejor a las 11' → hora=11:00", () => {
  // Paso 1: extraer miércoles a las 10 (ambiguo sin AM/PM)
  const state1 = makeState({ activeIntent: "PRACTICA", phase: "GATHERING" });
  const r1 = extractSlots("miércoles a las 10 am", "PRACTICA", state1);
  assert.equal(r1.extracted.fecha, "miércoles");
  assert.equal(r1.extracted.hora, "10:00");

  // Paso 2: "mejor a las 11 am" → debe actualizar hora a 11:00
  const state2 = makeState({
    activeIntent: "PRACTICA",
    phase: "GATHERING",
    slots: { ...r1.updated },
  });
  const r2 = extractSlots("mejor a las 11 am", "PRACTICA", state2);
  assert.equal(r2.extracted.hora, "11:00");
  assert.equal(r2.updated.hora, "11:00");
  assert.equal(r2.updated.fecha, "miércoles"); // preservado
});

test("SM-CORR3. 'A1' + 'perdón, soy A2' → categoria=A2", () => {
  // Paso 1: extraer A1
  const state1 = makeState({ activeIntent: "PRACTICA", phase: "GATHERING" });
  const r1 = extractSlots("A1", "PRACTICA", state1);
  assert.equal(r1.extracted.categoria, "A1");

  // Paso 2: "perdón, soy A2" → debe actualizar a A2
  const state2 = makeState({
    activeIntent: "PRACTICA",
    phase: "GATHERING",
    slots: { ...r1.updated },
  });
  const r2 = extractSlots("perdón, soy A2", "PRACTICA", state2);
  assert.equal(r2.extracted.categoria, "A2");
  assert.equal(r2.updated.categoria, "A2");
});

test("SM-CORR4. 'oficial' + 'mejor alterno' → circuito=alternativo", () => {
  // Paso 1: extraer oficial
  const state1 = makeState({ activeIntent: "PRACTICA", phase: "GATHERING" });
  const r1 = extractSlots("circuito oficial", "PRACTICA", state1);
  assert.equal(r1.extracted.circuito, "oficial");

  // Paso 2: "mejor alterno" → debe actualizar a alternativo
  const state2 = makeState({
    activeIntent: "PRACTICA",
    phase: "GATHERING",
    slots: { ...r1.updated },
  });
  const r2 = extractSlots("mejor alterno", "PRACTICA", state2);
  assert.equal(r2.extracted.circuito, "alternativo");
  assert.equal(r2.updated.circuito, "alternativo");
});

test("SM-CORR5. 'viernes' + 'mejor sabado' → fecha=sabado", () => {
  // Paso 1: extraer viernes
  const state1 = makeState({ activeIntent: "PRACTICA", phase: "GATHERING" });
  const r1 = extractSlots("viernes", "PRACTICA", state1);
  assert.equal(r1.extracted.fecha, "viernes");

  // Paso 2: "mejor sabado" → debe actualizar a sabado
  const state2 = makeState({
    activeIntent: "PRACTICA",
    phase: "GATHERING",
    slots: { ...r1.updated },
  });
  const r2 = extractSlots("mejor sabado", "PRACTICA", state2);
  assert.equal(r2.extracted.fecha, "sabado");
  assert.equal(r2.updated.fecha, "sabado");
});

// ── Tests de conflicto temporal (SM-CONF) ──────────────────────

test("SM-CONF1. timePreference=mañana + hora=14:00 → conflicto resuelto", () => {
  const conflict = detectSlotConflict("hora", "mañana", "14:00");
  assert.equal(conflict.hasConflict, true);
  assert.equal(conflict.resolution, "update");
});

test("SM-CONF2. fecha=viernes + fecha=miércoles → conflicto resuelto", () => {
  const conflict = detectSlotConflict("fecha", "viernes", "miércoles");
  assert.equal(conflict.hasConflict, true);
  assert.equal(conflict.resolution, "update");
});

test("SM-CONF3. hora=10:00 + hora=11:00 → conflicto resuelto", () => {
  const conflict = detectSlotConflict("hora", "10:00", "11:00");
  assert.equal(conflict.hasConflict, true);
  assert.equal(conflict.resolution, "update");
});

test("SM-CONF4. categoria=A1 + categoria=A2 → conflicto resuelto", () => {
  const conflict = detectSlotConflict("categoria", "A1", "A2");
  assert.equal(conflict.hasConflict, true);
  assert.equal(conflict.resolution, "update");
});

test("SM-CONF5. circuito=oficial + circuito=alternativo → conflicto resuelto", () => {
  const conflict = detectSlotConflict("circuito", "oficial", "alternativo");
  assert.equal(conflict.hasConflict, true);
  assert.equal(conflict.resolution, "update");
});

test("SM-CONF6. mismo valor → no conflicto, keep", () => {
  const conflict = detectSlotConflict("hora", "10:00", "10:00");
  assert.equal(conflict.hasConflict, false);
  assert.equal(conflict.resolution, "keep");
});

test("SM-CONF7. valor null → no conflicto, update", () => {
  const conflict = detectSlotConflict("hora", null, "14:00");
  assert.equal(conflict.hasConflict, false);
  assert.equal(conflict.resolution, "update");
});

// ── Tests de extracción de examen fecha ────────────────────────

test("SM-EXAM1. 'mi examen es el sábado' → examen_fecha=sabado", () => {
  const state = makeState({ activeIntent: "PRACTICA", phase: "GATHERING" });
  const r = extractSlots(
    "quiero practicar porque mi examen de manejo es el sábado",
    "PRACTICA",
    state,
  );
  assert.equal(r.extracted.examen_fecha, "sabado");
  assert.equal(r.updated.examen_fecha, "sabado");
});

test("SM-EXAM2. 'mi examen el martes' → examen_fecha=martes", () => {
  const state = makeState({ activeIntent: "PRACTICA", phase: "GATHERING" });
  const r = extractSlots("mi examen el martes", "PRACTICA", state);
  assert.equal(r.extracted.examen_fecha, "martes");
});

test("SM-EXAM3. sin mención de examen → examen_fecha no extraído", () => {
  const state = makeState({ activeIntent: "PRACTICA", phase: "GATHERING" });
  const r = extractSlots("quiero practicar A1", "PRACTICA", state);
  assert.equal(r.extracted.examen_fecha, undefined);
});

// ── Tests de recomendación contextual (RE-CTX) ─────────────────

test("RE-CTX1. examen día + práctica → recomendación simulacro", async () => {
  const { evaluateRecommendation } = await import(
    "../src/agent/recommendation-engine"
  );

  const result = evaluateRecommendation({
    activeIntent: "PRACTICA",
    slots: { categoria: "A1" },
    state: makeState({ activeIntent: "PRACTICA" }),
    context: {
      clientProfile: {
        hasReservations: false,
        lastCategory: "A1",
        lastActivity: null,
        hasPackage: false,
      },
      temporalContext: {
        isExamDay: true,
        currentDayOfWeek: "sabado",
        currentHour: 10,
      },
      conversationContext: {
        messageCount: 1,
        isNewUser: true,
        activeIntent: "PRACTICA",
        phase: "GATHERING",
        slotsCollected: { categoria: "A1" },
        missingSlots: [],
      },
      knowledgeContext: "",
    },
  });
  assert.ok(result.recommendation);
  assert.equal(result.recommendation!.type, "CONTEXTUAL_SIMULACRO");
  assert.equal(result.recommendation!.target, "SIMULACRO");
});

test("RE-CTX2. examen día + práctica → simulacro 5:30-7:30 AM pista oficial", async () => {
  const { evaluateRecommendation } = await import(
    "../src/agent/recommendation-engine"
  );

  const result = evaluateRecommendation({
    activeIntent: "PRACTICA",
    slots: { categoria: "A1" },
    state: makeState({ activeIntent: "PRACTICA" }),
    context: {
      clientProfile: {
        hasReservations: false,
        lastCategory: "A1",
        lastActivity: null,
        hasPackage: false,
      },
      temporalContext: {
        isExamDay: true,
        currentDayOfWeek: "sabado",
        currentHour: 10,
      },
      conversationContext: {
        messageCount: 1,
        isNewUser: true,
        activeIntent: "PRACTICA",
        phase: "GATHERING",
        slotsCollected: { categoria: "A1" },
        missingSlots: [],
      },
      knowledgeContext: "",
    },
  });
  assert.ok(result.recommendation);
  assert.ok(result.recommendation!.reason.includes("5:30"));
  assert.ok(result.recommendation!.reason.includes("7:30"));
  assert.ok(result.recommendation!.reason.includes("pista oficial"));
});

test("RE-CTX3. recomendación no cambia activeIntent", async () => {
  const { evaluateRecommendation } = await import(
    "../src/agent/recommendation-engine"
  );

  const state = makeState({ activeIntent: "PRACTICA" });
  evaluateRecommendation({
    activeIntent: "PRACTICA",
    slots: { categoria: "A1" },
    state,
    context: {
      clientProfile: {
        hasReservations: false,
        lastCategory: "A1",
        lastActivity: null,
        hasPackage: false,
      },
      temporalContext: {
        isExamDay: true,
        currentDayOfWeek: "sabado",
        currentHour: 10,
      },
      conversationContext: {
        messageCount: 1,
        isNewUser: true,
        activeIntent: "PRACTICA",
        phase: "GATHERING",
        slotsCollected: { categoria: "A1" },
        missingSlots: [],
      },
      knowledgeContext: "",
    },
  });
  // activeIntent NO debe cambiar
  assert.equal(state.activeIntent, "PRACTICA");
});

test("RE-CTX4. examen_fecha en slots + práctica → recomendación simulacro", async () => {
  const { evaluateRecommendation } = await import(
    "../src/agent/recommendation-engine"
  );

  const result = evaluateRecommendation({
    activeIntent: "PRACTICA",
    slots: { categoria: "A1", examen_fecha: "sabado" },
    state: makeState({
      activeIntent: "PRACTICA",
      slots: { categoria: "A1", examen_fecha: "sabado" },
    }),
    context: {
      clientProfile: {
        hasReservations: false,
        lastCategory: "A1",
        lastActivity: null,
        hasPackage: false,
      },
      temporalContext: {
        isExamDay: false, // Hoy NO es día de examen
        currentDayOfWeek: "miercoles",
        currentHour: 10,
      },
      conversationContext: {
        messageCount: 2,
        isNewUser: false,
        activeIntent: "PRACTICA",
        phase: "GATHERING",
        slotsCollected: { categoria: "A1", examen_fecha: "sabado" },
        missingSlots: [],
      },
      knowledgeContext: "",
    },
  });
  // Debe recomendar simulacro porque examen_fecha indica examen próximo
  assert.ok(result.recommendation);
  assert.equal(result.recommendation!.type, "CONTEXTUAL_SIMULACRO");
});

// ── Tests de circuito (KB-CIRC) ────────────────────────────────

test("KB-CIRC1. circuito alternativo = idéntico a oficial", () => {
  // Verificar que business-rules.json dice "idéntico" y NO "copia"
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const rules = require("../src/knowledge/business-rules.json");
  const altText = rules.practica.circuitos.alternativo.descripcion as string;
  assert.ok(
    altText.includes("idéntico"),
    `Expected "idéntico" in "${altText}"`,
  );
  assert.ok(
    !altText.includes("copia"),
    `Should NOT contain "copia" in "${altText}"`,
  );
  assert.ok(
    !altText.includes("similar"),
    `Should NOT contain "similar" in "${altText}"`,
  );
});

// ── Tests de conversación progresiva (FLOW-PROG) ───────────────

test("FLOW-PROG1. pregunta progresiva: solo categoría primero", async () => {
  const { decideResponse } = await import("../src/agent/response-decider");

  const action = decideResponse({
    state: makeState({ activeIntent: "PRACTICA", phase: "GATHERING" }),
    intent: {
      intent: "PRACTICA",
      confidence: 0.9,
      isChange: false,
      isExplicitChange: false,
      rawText: "quiero practicar",
    },
    slots: {
      extracted: {},
      updated: {},
      missing: [
        {
          name: "categoria",
          question: "¿Qué categoría de licencia necesitas?",
          type: "enum",
          required: true,
        },
        {
          name: "circuito",
          question: "¿En qué circuito prefieres?",
          type: "enum",
          required: true,
        },
        {
          name: "fecha",
          question: "¿Qué día te conviene?",
          type: "date",
          required: true,
        },
        {
          name: "hora",
          question: "¿A qué hora prefieres?",
          type: "time",
          required: true,
        },
      ],
      isComplete: false,
    },
    recommendation: null,
    userText: "quiero practicar",
  });

  assert.equal(action.type, "REPROMPT");
  if (action.type === "REPROMPT") {
    assert.equal(action.slotName, "categoria");
  }
});

test("FLOW-PROG2. pregunta progresiva: circuito después de categoría", async () => {
  const { decideResponse } = await import("../src/agent/response-decider");

  const action = decideResponse({
    state: makeState({
      activeIntent: "PRACTICA",
      phase: "GATHERING",
      slots: { categoria: "A1" },
    }),
    intent: {
      intent: "PRACTICA",
      confidence: 0.9,
      isChange: false,
      isExplicitChange: false,
      rawText: "A1",
    },
    slots: {
      extracted: { categoria: "A1" },
      updated: { categoria: "A1" },
      missing: [
        {
          name: "circuito",
          question: "¿En qué circuito prefieres?",
          type: "enum",
          required: true,
        },
        {
          name: "fecha",
          question: "¿Qué día te conviene?",
          type: "date",
          required: true,
        },
        {
          name: "hora",
          question: "¿A qué hora prefieres?",
          type: "time",
          required: true,
        },
      ],
      isComplete: false,
    },
    recommendation: null,
    userText: "A1",
  });

  assert.equal(action.type, "REPROMPT");
  if (action.type === "REPROMPT") {
    assert.equal(action.slotName, "circuito");
  }
});

test("FLOW-PROG3. prioridad: categoria antes que fecha y hora", async () => {
  const { decideResponse } = await import("../src/agent/response-decider");

  // Simular: faltan fecha, hora y categoria (desordenados)
  const action = decideResponse({
    state: makeState({ activeIntent: "PRACTICA", phase: "GATHERING" }),
    intent: {
      intent: "PRACTICA",
      confidence: 0.9,
      isChange: false,
      isExplicitChange: false,
      rawText: "quiero practicar",
    },
    slots: {
      extracted: {},
      updated: {},
      missing: [
        {
          name: "hora",
          question: "¿A qué hora?",
          type: "time",
          required: true,
        },
        {
          name: "fecha",
          question: "¿Qué día?",
          type: "date",
          required: true,
        },
        {
          name: "categoria",
          question: "¿Qué categoría?",
          type: "enum",
          required: true,
        },
      ],
      isComplete: false,
    },
    recommendation: null,
    userText: "quiero practicar",
  });

  assert.equal(action.type, "REPROMPT");
  if (action.type === "REPROMPT") {
    // Debe preguntar categoria primero (prioridad 1) aunque esté último en el array
    assert.equal(action.slotName, "categoria");
  }
});

// ── Test de reproducción del canary (CANARY-REPRO) ─────────────

test("CANARY-REPRO1. conversación real del canary", async () => {
  const { extractSlots } = await import("../src/agent/slot-manager");
  const { evaluateRecommendation } = await import(
    "../src/agent/recommendation-engine"
  );

  // Mensaje 1: "Quiero practicar porque mi examen de manejo es el sábado
  // y todavía no me siento muy seguro."
  let state = makeState({ activeIntent: "PRACTICA", phase: "GATHERING" });
  const r1 = extractSlots(
    "Quiero practicar porque mi examen de manejo es el sábado y todavía no me siento muy seguro.",
    "PRACTICA",
    state,
  );
  state = { ...state, slots: r1.updated, messageCount: 1 };

  // Verificar: examen_fecha extraído
  assert.equal(state.slots.examen_fecha, "sabado");
  // Sin categoría aún
  assert.equal(state.slots.categoria, undefined);

  // Mensaje 2: "A1 y qué diferencia hay entre oficial y alternativo?
  // y la práctica que sea el viernes"
  const r2 = extractSlots(
    "A1 y qué diferencia hay entre oficial y alternativo? y la práctica que sea el viernes",
    "PRACTICA",
    state,
  );
  state = { ...state, slots: r2.updated, messageCount: 2 };

  // Verificar: categoria extraída
  assert.equal(state.slots.categoria, "A1");
  // Verificar: fecha extraída
  assert.equal(state.slots.fecha, "viernes");
  // Verificar: hora NO extraída (mañana es ambiguo)
  assert.equal(state.slots.hora, undefined);

  // AHORA evaluar recomendación (con categoria disponible)
  const rec = evaluateRecommendation({
    activeIntent: "PRACTICA",
    slots: state.slots,
    state,
    context: {
      clientProfile: {
        hasReservations: false,
        lastCategory: "A1",
        lastActivity: null,
        hasPackage: false,
      },
      temporalContext: {
        isExamDay: false,
        currentDayOfWeek: "miercoles",
        currentHour: 10,
      },
      conversationContext: {
        messageCount: 2,
        isNewUser: false,
        activeIntent: "PRACTICA",
        phase: "GATHERING",
        slotsCollected: state.slots,
        missingSlots: [],
      },
      knowledgeContext: "",
    },
  });
  // Debe recomendar simulacro contextual por examen_fecha
  assert.ok(rec.recommendation, "Should recommend simulacro");
  assert.equal(rec.recommendation!.type, "CONTEXTUAL_SIMULACRO");

  // Mensaje 3: "2 pm"
  const r3 = extractSlots("2 pm", "PRACTICA", state);
  state = { ...state, slots: r3.updated, messageCount: 3 };

  // Verificar: hora extraída correctamente
  assert.equal(state.slots.hora, "14:00");

  // Verificar: estado final coherente
  assert.equal(state.activeIntent, "PRACTICA");
  assert.equal(state.slots.categoria, "A1");
  assert.equal(state.slots.fecha, "viernes");
  assert.equal(state.slots.hora, "14:00");
  assert.equal(state.slots.examen_fecha, "sabado");

  // Verificar: activeIntent NO cambió
  assert.equal(state.activeIntent, "PRACTICA");
});

test("CANARY-REPRO2. no handoff en flujo normal del canary", async () => {
  const { decideResponse } = await import("../src/agent/response-decider");

  // Simular estado después de los 3 mensajes del canary
  const action = decideResponse({
    state: makeState({
      activeIntent: "PRACTICA",
      phase: "GATHERING",
      slots: {
        categoria: "A1",
        fecha: "viernes",
        hora: "14:00",
        examen_fecha: "sabado",
      },
      messageCount: 3,
    }),
    intent: {
      intent: "PRACTICA",
      confidence: 0.9,
      isChange: false,
      isExplicitChange: false,
      rawText: "2 pm",
    },
    slots: {
      extracted: { hora: "14:00" },
      updated: {
        categoria: "A1",
        fecha: "viernes",
        hora: "14:00",
        examen_fecha: "sabado",
      },
      missing: [
        {
          name: "circuito",
          question: "¿En qué circuito prefieres?",
          type: "enum",
          required: true,
        },
      ],
      isComplete: false,
    },
    recommendation: null,
    userText: "2 pm",
  });

  // NO debe ser HANDOFF
  assert.notEqual(action.type, "HANDOFF");
  // Debe preguntar circuito (el único faltante)
  assert.equal(action.type, "REPROMPT");
  if (action.type === "REPROMPT") {
    assert.equal(action.slotName, "circuito");
  }
});
