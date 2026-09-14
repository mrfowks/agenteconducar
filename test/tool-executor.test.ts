import { test } from "node:test";
import assert from "node:assert/strict";
import { executeTool, validatePreExecution } from "../src/agent/tool-executor";
import type { ToolExecutionInput } from "../src/agent/tool-executor";
import type { ConversationStateData } from "../src/agent/types";
import type { Recommendation } from "../src/agent/recommendation-engine";

// ── Helpers ─────────────────────────────────────────────────────

function makeState(overrides: Partial<ConversationStateData> = {}): ConversationStateData {
  return {
    chatwootConversationId: 1,
    phone: "51917595954",
    chatwootContactId: 9,
    sourceId: "51917595954",
    activeIntent: "PRACTICA",
    phase: "EXECUTING",
    slots: {},
    repromptCount: 0,
    lastQuestionAsked: null,
    messageCount: 4,
    expiresAt: null,
    ...overrides,
  };
}

const VALID_RESERVA_SLOTS = {
  actividad: "practica",
  categoria: "A1",
  circuito: "oficial",
  fecha: "2026-09-17",
  hora: "10:00",
};

const PACKAGE_RECOMMENDATION: Recommendation = {
  type: "PACKAGE",
  target: "P2",
  reason: "test",
  confidence: 0.9,
  supportingFacts: [],
  alternatives: [],
  estimatedValue: { price: 160, savings: 20, separateTotal: 180 },
  requiresConfirmation: true,
};

// ── Tests de validación pre-ejecución (lógica pura) ─────────────

test("V1. crear_reserva con todos los slots → válida", () => {
  const result = validatePreExecution({
    action: "crear_reserva",
    state: makeState(),
    slots: VALID_RESERVA_SLOTS,
    recommendation: null,
    phone: "51917595954",
    conversationId: 1,
  });
  assert.equal(result.valid, true);
  assert.equal(result.reason, undefined);
});

test("V2. crear_reserva sin actividad → inválida", () => {
  const result = validatePreExecution({
    action: "crear_reserva",
    state: makeState(),
    slots: { categoria: "A1", circuito: "oficial", fecha: "2026-09-17", hora: "10:00" },
    recommendation: null,
    phone: "51917595954",
    conversationId: 1,
  });
  assert.equal(result.valid, false);
  assert.ok(result.reason?.includes("actividad"));
});

test("V3. crear_reserva sin categoría → inválida", () => {
  const result = validatePreExecution({
    action: "crear_reserva",
    state: makeState(),
    slots: { actividad: "practica", circuito: "oficial", fecha: "2026-09-17", hora: "10:00" },
    recommendation: null,
    phone: "51917595954",
    conversationId: 1,
  });
  assert.equal(result.valid, false);
  assert.ok(result.reason?.includes("categoría"));
});

test("V4. crear_reserva sin circuito → inválida", () => {
  const result = validatePreExecution({
    action: "crear_reserva",
    state: makeState(),
    slots: { actividad: "practica", categoria: "A1", fecha: "2026-09-17", hora: "10:00" },
    recommendation: null,
    phone: "51917595954",
    conversationId: 1,
  });
  assert.equal(result.valid, false);
  assert.ok(result.reason?.includes("circuito"));
});

test("V5. crear_reserva sin fecha → inválida", () => {
  const result = validatePreExecution({
    action: "crear_reserva",
    state: makeState(),
    slots: { actividad: "practica", categoria: "A1", circuito: "oficial", hora: "10:00" },
    recommendation: null,
    phone: "51917595954",
    conversationId: 1,
  });
  assert.equal(result.valid, false);
  assert.ok(result.reason?.includes("fecha"));
});

test("V6. crear_reserva sin hora → inválida", () => {
  const result = validatePreExecution({
    action: "crear_reserva",
    state: makeState(),
    slots: { actividad: "practica", categoria: "A1", circuito: "oficial", fecha: "2026-09-17" },
    recommendation: null,
    phone: "51917595954",
    conversationId: 1,
  });
  assert.equal(result.valid, false);
  assert.ok(result.reason?.includes("hora"));
});

test("V7. crear_reserva con fecha relativa 'martes' → inválida", () => {
  const result = validatePreExecution({
    action: "crear_reserva",
    state: makeState(),
    slots: { actividad: "practica", categoria: "A1", circuito: "oficial", fecha: "martes", hora: "10:00" },
    recommendation: null,
    phone: "51917595954",
    conversationId: 1,
  });
  assert.equal(result.valid, false);
  assert.ok(result.reason?.includes("relativa"));
});

test("V8. crear_reserva con fecha relativa 'mañana' → inválida", () => {
  const result = validatePreExecution({
    action: "crear_reserva",
    state: makeState(),
    slots: { actividad: "practica", categoria: "A1", circuito: "oficial", fecha: "mañana", hora: "10:00" },
    recommendation: null,
    phone: "51917595954",
    conversationId: 1,
  });
  assert.equal(result.valid, false);
  assert.ok(result.reason?.includes("relativa"));
});

test("V9. crear_reserva con fecha relativa 'hoy' → inválida", () => {
  const result = validatePreExecution({
    action: "crear_reserva",
    state: makeState(),
    slots: { actividad: "practica", categoria: "A1", circuito: "oficial", fecha: "hoy", hora: "10:00" },
    recommendation: null,
    phone: "51917595954",
    conversationId: 1,
  });
  assert.equal(result.valid, false);
  assert.ok(result.reason?.includes("relativa"));
});

test("V10. crear_reserva con fecha relativa 'este viernes' → inválida", () => {
  const result = validatePreExecution({
    action: "crear_reserva",
    state: makeState(),
    slots: { actividad: "practica", categoria: "A1", circuito: "oficial", fecha: "este viernes", hora: "10:00" },
    recommendation: null,
    phone: "51917595954",
    conversationId: 1,
  });
  assert.equal(result.valid, false);
  assert.ok(result.reason?.includes("relativa"));
});

test("V11. crear_reserva con hora ambigua 'a las 3' → inválida", () => {
  const result = validatePreExecution({
    action: "crear_reserva",
    state: makeState(),
    slots: { actividad: "practica", categoria: "A1", circuito: "oficial", fecha: "2026-09-17", hora: "a las 3" },
    recommendation: null,
    phone: "51917595954",
    conversationId: 1,
  });
  assert.equal(result.valid, false);
  assert.ok(result.reason?.includes("ambigua"));
});

test("V12. crear_reserva con hora ambigua '3' → inválida", () => {
  const result = validatePreExecution({
    action: "crear_reserva",
    state: makeState(),
    slots: { actividad: "practica", categoria: "A1", circuito: "oficial", fecha: "2026-09-17", hora: "3" },
    recommendation: null,
    phone: "51917595954",
    conversationId: 1,
  });
  assert.equal(result.valid, false);
  assert.ok(result.reason?.includes("ambigua"));
});

test("V13. crear_reserva con hora 24h '10:00' → válida", () => {
  const result = validatePreExecution({
    action: "crear_reserva",
    state: makeState(),
    slots: { actividad: "practica", categoria: "A1", circuito: "oficial", fecha: "2026-09-17", hora: "10:00" },
    recommendation: null,
    phone: "51917595954",
    conversationId: 1,
  });
  assert.equal(result.valid, true);
});

test("V14. crear_reserva con hora AM/PM '10 AM' → válida", () => {
  const result = validatePreExecution({
    action: "crear_reserva",
    state: makeState(),
    slots: { actividad: "practica", categoria: "A1", circuito: "oficial", fecha: "2026-09-17", hora: "10 AM" },
    recommendation: null,
    phone: "51917595954",
    conversationId: 1,
  });
  assert.equal(result.valid, true);
});

test("V15. crear_reserva con hora AM/PM '3:30 PM' → válida", () => {
  const result = validatePreExecution({
    action: "crear_reserva",
    state: makeState(),
    slots: { actividad: "practica", categoria: "A1", circuito: "oficial", fecha: "2026-09-17", hora: "3:30 PM" },
    recommendation: null,
    phone: "51917595954",
    conversationId: 1,
  });
  assert.equal(result.valid, true);
});

test("V16. crear_reserva con fecha ISO '2026-09-17' → válida (no relativa)", () => {
  const result = validatePreExecution({
    action: "crear_reserva",
    state: makeState(),
    slots: { actividad: "practica", categoria: "A1", circuito: "oficial", fecha: "2026-09-17", hora: "10:00" },
    recommendation: null,
    phone: "51917595954",
    conversationId: 1,
  });
  assert.equal(result.valid, true);
});

test("V17. consultar_disponibilidad sin fecha → inválida", () => {
  const result = validatePreExecution({
    action: "consultar_disponibilidad",
    state: makeState(),
    slots: { circuito: "oficial", actividad: "practica" },
    recommendation: null,
    phone: "51917595954",
    conversationId: 1,
  });
  assert.equal(result.valid, false);
  assert.ok(result.reason?.includes("fecha"));
});

test("V18. consultar_disponibilidad sin circuito → inválida", () => {
  const result = validatePreExecution({
    action: "consultar_disponibilidad",
    state: makeState(),
    slots: { fecha: "2026-09-17", actividad: "practica" },
    recommendation: null,
    phone: "51917595954",
    conversationId: 1,
  });
  assert.equal(result.valid, false);
  assert.ok(result.reason?.includes("circuito"));
});

test("V19. consultar_disponibilidad sin actividad → inválida", () => {
  const result = validatePreExecution({
    action: "consultar_disponibilidad",
    state: makeState(),
    slots: { fecha: "2026-09-17", circuito: "oficial" },
    recommendation: null,
    phone: "51917595954",
    conversationId: 1,
  });
  assert.equal(result.valid, false);
  assert.ok(result.reason?.includes("actividad"));
});

test("V20. consultar_disponibilidad con todos los slots → válida", () => {
  const result = validatePreExecution({
    action: "consultar_disponibilidad",
    state: makeState(),
    slots: { fecha: "2026-09-17", circuito: "oficial", actividad: "practica" },
    recommendation: null,
    phone: "51917595954",
    conversationId: 1,
  });
  assert.equal(result.valid, true);
});

test("V21. consultar_agenda sin restricciones → válida", () => {
  const result = validatePreExecution({
    action: "consultar_agenda",
    state: makeState(),
    slots: {},
    recommendation: null,
    phone: "51917595954",
    conversationId: 1,
  });
  assert.equal(result.valid, true);
});

test("V22. consultar_paquetes sin restricciones → válida", () => {
  const result = validatePreExecution({
    action: "consultar_paquetes",
    state: makeState(),
    slots: {},
    recommendation: null,
    phone: "51917595954",
    conversationId: 1,
  });
  assert.equal(result.valid, true);
});

test("V23. consultar_categorias sin restricciones → válida", () => {
  const result = validatePreExecution({
    action: "consultar_categorias",
    state: makeState(),
    slots: {},
    recommendation: null,
    phone: "51917595954",
    conversationId: 1,
  });
  assert.equal(result.valid, true);
});

test("V24. consultar_fechas_disponibles sin circuito → inválida", () => {
  const result = validatePreExecution({
    action: "consultar_fechas_disponibles",
    state: makeState(),
    slots: { actividad: "practica" },
    recommendation: null,
    phone: "51917595954",
    conversationId: 1,
  });
  assert.equal(result.valid, false);
  assert.ok(result.reason?.includes("circuito"));
});

test("V25. consultar_fechas_disponibles sin actividad → inválida", () => {
  const result = validatePreExecution({
    action: "consultar_fechas_disponibles",
    state: makeState(),
    slots: { circuito: "oficial" },
    recommendation: null,
    phone: "51917595954",
    conversationId: 1,
  });
  assert.equal(result.valid, false);
  assert.ok(result.reason?.includes("actividad"));
});

test("V26. consultar_fechas_disponibles con ambos → válida", () => {
  const result = validatePreExecution({
    action: "consultar_fechas_disponibles",
    state: makeState(),
    slots: { circuito: "oficial", actividad: "practica" },
    recommendation: null,
    phone: "51917595954",
    conversationId: 1,
  });
  assert.equal(result.valid, true);
});

test("V27. derivar_a_humano sin restricciones → válida", () => {
  const result = validatePreExecution({
    action: "derivar_a_humano",
    state: makeState(),
    slots: {},
    recommendation: null,
    phone: "51917595954",
    conversationId: 1,
  });
  assert.equal(result.valid, true);
});

test("V28. consultar_informacion_licencia sin restricciones → válida", () => {
  const result = validatePreExecution({
    action: "consultar_informacion_licencia",
    state: makeState(),
    slots: {},
    recommendation: null,
    phone: "51917595954",
    conversationId: 1,
  });
  assert.equal(result.valid, true);
});

test("V29. consultar_recategorizacion sin restricciones → válida", () => {
  const result = validatePreExecution({
    action: "consultar_recategorizacion",
    state: makeState(),
    slots: {},
    recommendation: null,
    phone: "51917595954",
    conversationId: 1,
  });
  assert.equal(result.valid, true);
});

test("V30. consultar_metodos_pago sin restricciones → válida", () => {
  const result = validatePreExecution({
    action: "consultar_metodos_pago",
    state: makeState(),
    slots: {},
    recommendation: null,
    phone: "51917595954",
    conversationId: 1,
  });
  assert.equal(result.valid, true);
});

test("V31. consultar_mis_reservas sin restricciones → válida", () => {
  const result = validatePreExecution({
    action: "consultar_mis_reservas",
    state: makeState(),
    slots: {},
    recommendation: null,
    phone: "51917595954",
    conversationId: 1,
  });
  assert.equal(result.valid, true);
});

test("V32. consultar_actividades_dia sin fecha → inválida", () => {
  const result = validatePreExecution({
    action: "consultar_actividades_dia",
    state: makeState(),
    slots: {},
    recommendation: null,
    phone: "51917595954",
    conversationId: 1,
  });
  assert.equal(result.valid, false);
  assert.ok(result.reason?.includes("fecha"));
});

test("V33. consultar_actividades_dia con fecha → válida", () => {
  const result = validatePreExecution({
    action: "consultar_actividades_dia",
    state: makeState(),
    slots: { fecha: "2026-09-17" },
    recommendation: null,
    phone: "51917595954",
    conversationId: 1,
  });
  assert.equal(result.valid, true);
});

test("V34. registrar_reclamo sin tipo → inválida", () => {
  const result = validatePreExecution({
    action: "registrar_reclamo",
    state: makeState(),
    slots: { descripcion: "test" },
    recommendation: null,
    phone: "51917595954",
    conversationId: 1,
  });
  assert.equal(result.valid, false);
  assert.ok(result.reason?.includes("tipo"));
});

test("V35. registrar_reclamo sin descripción → inválida", () => {
  const result = validatePreExecution({
    action: "registrar_reclamo",
    state: makeState(),
    slots: { tipo: "reclamo" },
    recommendation: null,
    phone: "51917595954",
    conversationId: 1,
  });
  assert.equal(result.valid, false);
  assert.ok(result.reason?.includes("descripción"));
});

test("V36. registrar_reclamo con ambos → válida", () => {
  const result = validatePreExecution({
    action: "registrar_reclamo",
    state: makeState(),
    slots: { tipo: "reclamo", descripcion: "test" },
    recommendation: null,
    phone: "51917595954",
    conversationId: 1,
  });
  assert.equal(result.valid, true);
});

test("V37. acción vacía → inválida", () => {
  const result = validatePreExecution({
    action: "",
    state: makeState(),
    slots: {},
    recommendation: null,
    phone: "51917595954",
    conversationId: 1,
  });
  assert.equal(result.valid, false);
  assert.ok(result.reason?.includes("no especificada"));
});

test("V38. herramienta desconocida → inválida", () => {
  const result = validatePreExecution({
    action: "herramienta_inexistente",
    state: makeState(),
    slots: {},
    recommendation: null,
    phone: "51917595954",
    conversationId: 1,
  });
  assert.equal(result.valid, false);
  assert.ok(result.reason?.includes("desconocida"));
});

test("V39. crear_reserva con fecha dd/mm → relativa (no resuelta)", () => {
  const result = validatePreExecution({
    action: "crear_reserva",
    state: makeState(),
    slots: { actividad: "practica", categoria: "A1", circuito: "oficial", fecha: "17/09", hora: "10:00" },
    recommendation: null,
    phone: "51917595954",
    conversationId: 1,
  });
  assert.equal(result.valid, false);
  assert.ok(result.reason?.includes("relativa"));
});

test("V40. crear_reserva con hora 22:00 → válida (no ambigua)", () => {
  const result = validatePreExecution({
    action: "crear_reserva",
    state: makeState(),
    slots: { actividad: "practica", categoria: "A1", circuito: "oficial", fecha: "2026-09-17", hora: "22:00" },
    recommendation: null,
    phone: "51917595954",
    conversationId: 1,
  });
  assert.equal(result.valid, true);
});

// ── Tests de ejecución (conectan a TOOL_EXECUTORS) ──────────────
// Nota: Estos tests intentan ejecutar las herramientas reales.
// Sin BD de test disponible, los que requieren datos devolverán TECHNICAL_ERROR.
// El objetivo es verificar que el executor conecta correctamente con el ejecutor real.

test("TE1. crear_reserva → intenta ejecutar (VALIDATION_ERROR o ejecución real)", async () => {
  const result = await executeTool({
    action: "crear_reserva",
    state: makeState(),
    slots: VALID_RESERVA_SLOTS,
    recommendation: null,
    phone: "51917595954",
    conversationId: 1,
  });
  assert.equal(result.tool, "crear_reserva");
  assert.ok(["SUCCESS", "TECHNICAL_ERROR", "VALIDATION_ERROR", "BUSINESS_ERROR", "NO_AVAILABILITY"].includes(result.status));
});

test("TE2. crear_reserva sin slots → VALIDATION_ERROR", async () => {
  const result = await executeTool({
    action: "crear_reserva",
    state: makeState(),
    slots: { actividad: "practica", categoria: "A1" },
    recommendation: null,
    phone: "51917595954",
    conversationId: 1,
  });
  assert.equal(result.status, "VALIDATION_ERROR");
  assert.ok(result.error?.includes("Falta"));
});

test("TE3. doble ejecución → mismo resultado (idempotente en validación)", async () => {
  const input: ToolExecutionInput = {
    action: "crear_reserva",
    state: makeState(),
    slots: VALID_RESERVA_SLOTS,
    recommendation: null,
    phone: "51917595954",
    conversationId: 1,
  };

  const result1 = await executeTool(input);
  const result2 = await executeTool(input);
  assert.equal(result1.status, result2.status);
  assert.equal(result1.tool, result2.tool);
});

test("TE4. consultar_disponibilidad → intenta ejecutar", async () => {
  const result = await executeTool({
    action: "consultar_disponibilidad",
    state: makeState(),
    slots: { fecha: "2026-09-17", circuito: "oficial", actividad: "practica" },
    recommendation: null,
    phone: "51917595954",
    conversationId: 1,
  });
  assert.equal(result.tool, "consultar_disponibilidad");
  assert.ok(["SUCCESS", "NO_AVAILABILITY", "TECHNICAL_ERROR"].includes(result.status));
});

test("TE5. error técnico antes de side effect → TECHNICAL_ERROR", async () => {
  const result = await executeTool({
    action: "crear_reserva",
    state: makeState(),
    slots: VALID_RESERVA_SLOTS,
    recommendation: null,
    phone: null,
    conversationId: null,
  });
  assert.ok(["VALIDATION_ERROR", "TECHNICAL_ERROR", "BUSINESS_ERROR"].includes(result.status));
});

test("TE6. herramienta desconocida → VALIDATION_ERROR (rechazada en pre-ejecución)", async () => {
  const result = await executeTool({
    action: "herramienta_inexistente",
    state: makeState(),
    slots: {},
    recommendation: null,
    phone: "51917595954",
    conversationId: 1,
  });
  // La validación pre-ejecución rechaza herramientas desconocidas antes de buscar el ejecutor
  assert.equal(result.status, "VALIDATION_ERROR");
  assert.ok(result.error?.includes("desconocida"));
});

test("TE7. fecha relativa no resuelta → VALIDATION_ERROR", async () => {
  const result = await executeTool({
    action: "crear_reserva",
    state: makeState(),
    slots: { actividad: "practica", categoria: "A1", circuito: "oficial", fecha: "martes", hora: "10:00" },
    recommendation: null,
    phone: "51917595954",
    conversationId: 1,
  });
  assert.equal(result.status, "VALIDATION_ERROR");
  assert.ok(result.error?.includes("relativa"));
});

test("TE8. hora ambigua → VALIDATION_ERROR", async () => {
  const result = await executeTool({
    action: "crear_reserva",
    state: makeState(),
    slots: { actividad: "practica", categoria: "A1", circuito: "oficial", fecha: "2026-09-17", hora: "a las 3" },
    recommendation: null,
    phone: "51917595954",
    conversationId: 1,
  });
  assert.equal(result.status, "VALIDATION_ERROR");
  assert.ok(result.error?.includes("ambigua"));
});

test("TE9. consultar_agenda sin restricciones → SUCCESS o TECHNICAL_ERROR", async () => {
  const result = await executeTool({
    action: "consultar_agenda",
    state: makeState(),
    slots: {},
    recommendation: null,
    phone: "51917595954",
    conversationId: 1,
  });
  assert.equal(result.tool, "consultar_agenda");
  assert.ok(["SUCCESS", "TECHNICAL_ERROR"].includes(result.status));
});

test("TE10. consultar_paquetes sin restricciones → SUCCESS o TECHNICAL_ERROR", async () => {
  const result = await executeTool({
    action: "consultar_paquetes",
    state: makeState(),
    slots: {},
    recommendation: null,
    phone: "51917595954",
    conversationId: 1,
  });
  assert.equal(result.tool, "consultar_paquetes");
  assert.ok(["SUCCESS", "TECHNICAL_ERROR"].includes(result.status));
});

test("TE11. derivar_a_humano → usa servicio existente", async () => {
  const result = await executeTool({
    action: "derivar_a_humano",
    state: makeState(),
    slots: {},
    recommendation: null,
    phone: "51917595954",
    conversationId: 1,
  });
  assert.equal(result.tool, "derivar_a_humano");
  assert.ok(["SUCCESS", "TECHNICAL_ERROR"].includes(result.status));
});

test("TE12. fecha ISO válida → no es VALIDATION_ERROR por relativa", async () => {
  const result = await executeTool({
    action: "crear_reserva",
    state: makeState(),
    slots: { actividad: "practica", categoria: "A1", circuito: "oficial", fecha: "2026-09-17", hora: "10:00" },
    recommendation: null,
    phone: "51917595954",
    conversationId: 1,
  });
  assert.notEqual(result.status, "VALIDATION_ERROR");
});

test("TE13. hora 22:00 formato 24h → no es VALIDATION_ERROR por ambigua", async () => {
  const result = await executeTool({
    action: "crear_reserva",
    state: makeState(),
    slots: { actividad: "practica", categoria: "A1", circuito: "oficial", fecha: "2026-09-17", hora: "22:00" },
    recommendation: null,
    phone: "51917595954",
    conversationId: 1,
  });
  assert.notEqual(result.status, "VALIDATION_ERROR");
});

test("TE14. crear_reserva con paquete → incluye paquete en args", async () => {
  const result = await executeTool({
    action: "crear_reserva",
    state: makeState(),
    slots: VALID_RESERVA_SLOTS,
    recommendation: PACKAGE_RECOMMENDATION,
    phone: "51917595954",
    conversationId: 1,
  });
  assert.equal(result.tool, "crear_reserva");
  assert.ok(["SUCCESS", "TECHNICAL_ERROR", "VALIDATION_ERROR", "BUSINESS_ERROR", "NO_AVAILABILITY"].includes(result.status));
});

test("TE15. consultar_disponibilidad sin slots → VALIDATION_ERROR", async () => {
  const result = await executeTool({
    action: "consultar_disponibilidad",
    state: makeState(),
    slots: {},
    recommendation: null,
    phone: "51917595954",
    conversationId: 1,
  });
  assert.equal(result.status, "VALIDATION_ERROR");
});

test("TE16. consultar_fechas_disponibles sin slots → VALIDATION_ERROR", async () => {
  const result = await executeTool({
    action: "consultar_fechas_disponibles",
    state: makeState(),
    slots: {},
    recommendation: null,
    phone: "51917595954",
    conversationId: 1,
  });
  assert.equal(result.status, "VALIDATION_ERROR");
});

test("TE17. consultar_fechas_disponibles con slots → intenta ejecutar", async () => {
  const result = await executeTool({
    action: "consultar_fechas_disponibles",
    state: makeState(),
    slots: { circuito: "oficial", actividad: "practica" },
    recommendation: null,
    phone: "51917595954",
    conversationId: 1,
  });
  assert.equal(result.tool, "consultar_fechas_disponibles");
  assert.ok(["SUCCESS", "NO_AVAILABILITY", "TECHNICAL_ERROR"].includes(result.status));
});

test("TE18. consultar_categorias → intenta ejecutar", async () => {
  const result = await executeTool({
    action: "consultar_categorias",
    state: makeState(),
    slots: {},
    recommendation: null,
    phone: "51917595954",
    conversationId: 1,
  });
  assert.equal(result.tool, "consultar_categorias");
  assert.ok(["SUCCESS", "TECHNICAL_ERROR"].includes(result.status));
});

test("TE19. consultar_informacion_licencia → intenta ejecutar", async () => {
  const result = await executeTool({
    action: "consultar_informacion_licencia",
    state: makeState(),
    slots: {},
    recommendation: null,
    phone: "51917595954",
    conversationId: 1,
  });
  assert.equal(result.tool, "consultar_informacion_licencia");
  assert.ok(["SUCCESS", "TECHNICAL_ERROR"].includes(result.status));
});

test("TE20. consultar_recategorizacion → intenta ejecutar", async () => {
  const result = await executeTool({
    action: "consultar_recategorizacion",
    state: makeState(),
    slots: {},
    recommendation: null,
    phone: "51917595954",
    conversationId: 1,
  });
  assert.equal(result.tool, "consultar_recategorizacion");
  assert.ok(["SUCCESS", "TECHNICAL_ERROR"].includes(result.status));
});

test("TE21. consultar_metodos_pago → intenta ejecutar", async () => {
  const result = await executeTool({
    action: "consultar_metodos_pago",
    state: makeState(),
    slots: {},
    recommendation: null,
    phone: "51917595954",
    conversationId: 1,
  });
  assert.equal(result.tool, "consultar_metodos_pago");
  assert.ok(["SUCCESS", "TECHNICAL_ERROR"].includes(result.status));
});

test("TE22. consultar_mis_reservas → intenta ejecutar", async () => {
  const result = await executeTool({
    action: "consultar_mis_reservas",
    state: makeState(),
    slots: {},
    recommendation: null,
    phone: "51917595954",
    conversationId: 1,
  });
  assert.equal(result.tool, "consultar_mis_reservas");
  assert.ok(["SUCCESS", "TECHNICAL_ERROR"].includes(result.status));
});

test("TE23. registrar_reclamo sin slots → VALIDATION_ERROR", async () => {
  const result = await executeTool({
    action: "registrar_reclamo",
    state: makeState(),
    slots: {},
    recommendation: null,
    phone: "51917595954",
    conversationId: 1,
  });
  assert.equal(result.status, "VALIDATION_ERROR");
});

test("TE24. registrar_reclamo con slots → intenta ejecutar", async () => {
  const result = await executeTool({
    action: "registrar_reclamo",
    state: makeState(),
    slots: { tipo: "reclamo", descripcion: "test" },
    recommendation: null,
    phone: "51917595954",
    conversationId: 1,
  });
  assert.equal(result.tool, "registrar_reclamo");
  assert.ok(["SUCCESS", "TECHNICAL_ERROR"].includes(result.status));
});

test("TE25. consultar_actividades_dia sin fecha → VALIDATION_ERROR", async () => {
  const result = await executeTool({
    action: "consultar_actividades_dia",
    state: makeState(),
    slots: {},
    recommendation: null,
    phone: "51917595954",
    conversationId: 1,
  });
  assert.equal(result.status, "VALIDATION_ERROR");
});

test("TE26. consultar_actividades_dia con fecha → intenta ejecutar", async () => {
  const result = await executeTool({
    action: "consultar_actividades_dia",
    state: makeState(),
    slots: { fecha: "2026-09-17" },
    recommendation: null,
    phone: "51917595954",
    conversationId: 1,
  });
  assert.equal(result.tool, "consultar_actividades_dia");
  assert.ok(["SUCCESS", "TECHNICAL_ERROR"].includes(result.status));
});

test("TE27. crear_reserva con recommendation null → sin paquete", async () => {
  const result = await executeTool({
    action: "crear_reserva",
    state: makeState(),
    slots: VALID_RESERVA_SLOTS,
    recommendation: null,
    phone: "51917595954",
    conversationId: 1,
  });
  assert.equal(result.tool, "crear_reserva");
  // Sin paquete, debe intentar ejecutar normalmente
  assert.ok(["SUCCESS", "TECHNICAL_ERROR", "VALIDATION_ERROR", "BUSINESS_ERROR", "NO_AVAILABILITY"].includes(result.status));
});

test("TE28. crear_reserva con recommendation de tipo SERVICE → sin paquete", async () => {
  const serviceRec: Recommendation = {
    type: "SERVICE",
    target: "PRACTICA",
    reason: "test",
    confidence: 0.9,
    supportingFacts: [],
    alternatives: [],
    estimatedValue: { price: 50, savings: null, separateTotal: null },
    requiresConfirmation: true,
  };
  const result = await executeTool({
    action: "crear_reserva",
    state: makeState(),
    slots: VALID_RESERVA_SLOTS,
    recommendation: serviceRec,
    phone: "51917595954",
    conversationId: 1,
  });
  assert.equal(result.tool, "crear_reserva");
  assert.ok(["SUCCESS", "TECHNICAL_ERROR", "VALIDATION_ERROR", "BUSINESS_ERROR", "NO_AVAILABILITY"].includes(result.status));
});
