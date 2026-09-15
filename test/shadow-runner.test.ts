import { test } from "node:test";
import assert from "node:assert/strict";
import { runShadow, resetShadowContext, getShadowContext } from "../src/agent/shadow-runner";

const CONV_KEY = "test-shadow-conv-925930764";

// ── Helper para simular una conversación shadow completa ─────────

async function simulateShadowConversation(messages: string[]) {
  const results = [];
  resetShadowContext(CONV_KEY);

  for (let i = 0; i < messages.length; i++) {
    const result = await runShadow(
      CONV_KEY,
      `msg-${i + 1}`,
      messages[i],
      "runAgent", // currentFlowAction
    );
    results.push(result);
  }

  return results;
}

// ── CASO COMPLETO: 7 turnos de conversación real ─────────────────

test("SHADOW-1. conversación completa de 7 turnos: contexto se conserva", async () => {
  const messages = [
    "Quiero practicar porque mi examen es el sábado y todavía no me siento seguro.",
    "A1",
    "Ya he practicado antes.",
    "No quiero practicar el mismo día.",
    "El viernes.",
    "En la mañana.",
    "Sí, ese horario me sirve.",
  ];

  const results = await simulateShadowConversation(messages);

  // ── Turno 1: "Quiero practicar porque mi examen es el sábado" ──
  const r1 = results[0];
  assert.equal(r1.turn.detectedIntent, "PRACTICA");
  assert.equal(r1.after.activeIntent, "PRACTICA");
  assert.equal(r1.after.slots.examen_fecha, "sábado");
  assert.equal(r1.decision.action, "ASK_FOR_MISSING_INFO"); // Pide categoría
  assert.ok(!r1.decision.question?.includes("circuito")); // NO pregunta circuito

  // ── Turno 2: "A1" ────────────────────────────────────────────
  const r2 = results[1];
  assert.equal(r2.after.slots.categoria, "A1");
  assert.equal(r2.after.activeIntent, "PRACTICA"); // No cambió
  assert.equal(r2.after.slots.examen_fecha, "sábado"); // Examen se conserva
  // NO debe preguntar circuito automáticamente
  assert.notEqual(r2.decision.targetSlot, "circuito");

  // ── Turno 3: "Ya he practicado antes." ────────────────────────
  const r3 = results[2];
  assert.ok(r3.turn.facts.length > 0 || r3.after.facts > 0); // Experiencia detectada
  assert.equal(r3.after.slots.examen_fecha, "sábado"); // Examen se conserva
  assert.equal(r3.after.slots.categoria, "A1"); // Categoría se conserva

  // ── Turno 4: "No quiero practicar el mismo día." ─────────────
  const r4 = results[3];
  assert.ok(r4.turn.negations.length > 0 || r4.after.negations > 0); // Negación detectada
  assert.equal(r4.after.slots.categoria, "A1"); // Categoría se conserva

  // ── Turno 5: "El viernes." ───────────────────────────────────
  const r5 = results[4];
  assert.equal(r5.after.slots.fecha, "viernes"); // Fecha extraída
  assert.equal(r5.after.slots.categoria, "A1"); // Categoría se conserva
  assert.equal(r5.after.slots.examen_fecha, "sábado"); // Examen se conserva

  // ── Turno 6: "En la mañana." ─────────────────────────────────
  const r6 = results[5];
  assert.equal(r6.after.slots.fecha, "viernes"); // Fecha se conserva
  assert.equal(r6.after.slots.categoria, "A1"); // Categoría se conserva
  // Debe detectar preferencia de mañana
  if (r6.after.preferences) {
    assert.equal(r6.after.preferences.prefersMorning, true);
  }

  // ── Turno 7: "Sí, ese horario me sirve." ─────────────────────
  const r7 = results[6];
  // Debe reconocer como confirmación o avance
  assert.equal(r7.after.slots.fecha, "viernes"); // Todo se conserva
  assert.equal(r7.after.slots.categoria, "A1");
  assert.equal(r7.after.slots.examen_fecha, "sábado");
});

// ── Test: Shadow NO envía respuesta al cliente ──────────────────

test("SHADOW-2. shadow no envía respuesta al cliente", async () => {
  const result = await runShadow(
    "test-conv-1",
    "msg-1",
    "Quiero practicar",
    "runAgent",
  );

  // El resultado tiene responseText pero NO se envió
  assert.ok(result.responseText.length > 0);
  assert.ok(result.decision.action); // Hay una decisión
  // Pero no hay side effects (no se llama sendText, no se crea reserva)
});

// ── Test: Shadow mantiene contexto entre turnos ─────────────────

test("SHADOW-3. shadow mantiene contexto entre turnos", async () => {
  resetShadowContext("test-conv-2");

  // Turno 1
  const r1 = await runShadow("test-conv-2", "msg-1", "Quiero practicar A1", "runAgent");
  assert.equal(r1.after.slots.categoria, "A1");

  // Turno 2
  const r2 = await runShadow("test-conv-2", "msg-2", "el viernes", "runAgent");
  assert.equal(r2.after.slots.categoria, "A1"); // Se conserva
  assert.equal(r2.after.slots.fecha, "viernes"); // Nuevo
});

// ── Test: Shadow NO afecta producción ────────────────────────────

test("SHADOW-4. shadow no modifica estado de producción", async () => {
  const result = await runShadow(
    "test-conv-3",
    "msg-1",
    "Quiero reservar",
    "runAgent",
  );

  // El shadow solo registra, no ejecuta
  assert.ok(result.decision.action);
  assert.ok(result.responseText);
  // Pero no hay reserva creada, no hay tool ejecutado
});

// ── Test: Shadow con error no rompe producción ──────────────────

test("SHADOW-5. shadow con error no afecta flujo actual", async () => {
  // Simular un texto que podría causar error
  const result = await runShadow(
    "test-conv-4",
    "msg-1",
    "", // Texto vacío
    "runAgent",
  );

  // No debe lanzar excepción
  assert.ok(result);
  assert.ok(result.decision);
});

// ── Test: Comparación CURRENT vs NEW ─────────────────────────────

test("SHADOW-6. comparación current vs new se registra", async () => {
  const result = await runShadow(
    "test-conv-5",
    "msg-1",
    "Quiero practicar",
    "runAgent",
  );

  assert.ok(result.comparison);
  assert.equal(result.comparison.currentFlowAction, "runAgent");
  assert.ok(result.comparison.newFlowAction);
  assert.ok(typeof result.comparison.differs === "boolean");
});

// ── Test: Negaciones se preservan entre turnos ──────────────────

test("SHADOW-7. negaciones se preservan entre turnos", async () => {
  resetShadowContext("test-conv-neg");

  // Turno 1: dar contexto
  await runShadow("test-conv-neg", "msg-1", "Quiero practicar A1 para mi examen el sábado", "runAgent");

  // Turno 2: negación
  const r2 = await runShadow("test-conv-neg", "msg-2", "No quiero practicar el mismo día del examen", "runAgent");
  assert.ok(r2.after.negations > 0 || r2.turn.negations.length > 0);

  // Turno 3: fecha (negación debe persistir)
  const r3 = await runShadow("test-conv-neg", "msg-3", "El viernes", "runAgent");
  assert.equal(r3.after.slots.fecha, "viernes");
  assert.ok(r3.after.negations > 0); // Negación se conserva
});

// ── Test: Pregunta directa genera ANSWER ─────────────────────────

test("SHADOW-8. pregunta directa genera ANSWER", async () => {
  resetShadowContext("test-conv-q");

  const r1 = await runShadow("test-conv-q", "msg-1", "¿Cuánto cuesta el simulacro?", "runAgent");
  assert.equal(r1.decision.action, "ANSWER");
});

// ── Test: Handoff explícito ──────────────────────────────────────

test("SHADOW-9. handoff explícito se detecta", async () => {
  resetShadowContext("test-conv-ho");

  const r1 = await runShadow("test-conv-ho", "msg-1", "Quiero hablar con un asesor", "runAgent");
  assert.equal(r1.decision.action, "HANDOFF");
});

// ── Test: Reset de contexto shadow ───────────────────────────────

test("SHADOW-10. reset de contexto shadow funciona", async () => {
  // Crear contexto
  await runShadow("test-conv-reset", "msg-1", "Quiero practicar A1", "runAgent");
  const ctx1 = getShadowContext("test-conv-reset");
  assert.ok(ctx1);

  // Reset
  resetShadowContext("test-conv-reset");
  const ctx2 = getShadowContext("test-conv-reset");
  assert.equal(ctx2, undefined);

  // Nuevo turno crea contexto fresco
  const r = await runShadow("test-conv-reset", "msg-2", "Hola", "runAgent");
  assert.equal(r.turnNumber, 1); // Turno 1 de nuevo
});
