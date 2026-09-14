import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateGate, buildConfirmationSummary } from "../src/agent/confirmation-gate";

test("CG1. IDLE → GATHERING", () => {
  const result = evaluateGate({
    phase: "IDLE",
    slotsComplete: false,
    userText: "quiero practicar",
    hasRecommendation: false,
    hasPendingSideEffects: false,
  });
  assert.equal(result.nextPhase, "GATHERING");
  assert.equal(result.action, "WAIT");
  assert.equal(result.blocked, false);
});

test("CG2. GATHERING + slots incompletos → GATHERING", () => {
  const result = evaluateGate({
    phase: "GATHERING",
    slotsComplete: false,
    userText: "A1",
    hasRecommendation: false,
    hasPendingSideEffects: false,
  });
  assert.equal(result.nextPhase, "GATHERING");
  assert.equal(result.action, "WAIT");
});

test("CG3. GATHERING + slots completos → CONFIRMING", () => {
  const result = evaluateGate({
    phase: "GATHERING",
    slotsComplete: true,
    userText: "a las 10",
    hasRecommendation: false,
    hasPendingSideEffects: false,
  });
  assert.equal(result.nextPhase, "CONFIRMING");
  assert.equal(result.action, "ASK_CONFIRM");
});

test("CG4. CONFIRMING + 'sí' → EXECUTING", () => {
  const result = evaluateGate({
    phase: "CONFIRMING",
    slotsComplete: true,
    userText: "sí",
    hasRecommendation: false,
    hasPendingSideEffects: false,
  });
  assert.equal(result.nextPhase, "EXECUTING");
  assert.equal(result.action, "EXECUTE");
});

test("CG5. CONFIRMING + 'correcto' → EXECUTING", () => {
  const result = evaluateGate({
    phase: "CONFIRMING",
    slotsComplete: true,
    userText: "correcto",
    hasRecommendation: false,
    hasPendingSideEffects: false,
  });
  assert.equal(result.nextPhase, "EXECUTING");
  assert.equal(result.action, "EXECUTE");
});

test("CG6. CONFIRMING + 'dale' → EXECUTING", () => {
  const result = evaluateGate({
    phase: "CONFIRMING",
    slotsComplete: true,
    userText: "dale",
    hasRecommendation: false,
    hasPendingSideEffects: false,
  });
  assert.equal(result.nextPhase, "EXECUTING");
  assert.equal(result.action, "EXECUTE");
});

test("CG7. CONFIRMING + rechazo → GATHERING", () => {
  const result = evaluateGate({
    phase: "CONFIRMING",
    slotsComplete: true,
    userText: "no",
    hasRecommendation: false,
    hasPendingSideEffects: false,
  });
  assert.equal(result.nextPhase, "GATHERING");
  assert.equal(result.action, "MODIFY");
});

test("CG8. CONFIRMING + modificación → GATHERING", () => {
  const result = evaluateGate({
    phase: "CONFIRMING",
    slotsComplete: true,
    userText: "mejor a las 11",
    hasRecommendation: false,
    hasPendingSideEffects: false,
  });
  assert.equal(result.nextPhase, "GATHERING");
  assert.equal(result.action, "MODIFY");
});

test("CG9. EXECUTING → POST_ACTION", () => {
  const result = evaluateGate({
    phase: "EXECUTING",
    slotsComplete: true,
    userText: "",
    hasRecommendation: false,
    hasPendingSideEffects: false,
  });
  assert.equal(result.nextPhase, "POST_ACTION");
  assert.equal(result.action, "POST_ACTION_REVIEW");
});

test("CG10. POST_ACTION + modificación → GATHERING", () => {
  const result = evaluateGate({
    phase: "POST_ACTION",
    slotsComplete: true,
    userText: "quiero cambiar la hora",
    hasRecommendation: false,
    hasPendingSideEffects: false,
  });
  assert.equal(result.nextPhase, "GATHERING");
  assert.equal(result.action, "MODIFY");
});

test("CG11. HANDOFF desde cualquier fase", () => {
  const phases = ["IDLE", "GATHERING", "CONFIRMING", "POST_ACTION"] as const;
  for (const phase of phases) {
    const result = evaluateGate({
      phase,
      slotsComplete: false,
      userText: "asesor",
      hasRecommendation: false,
      hasPendingSideEffects: false,
    });
    assert.equal(result.nextPhase, "HANDOFF");
    assert.equal(result.action, "EXECUTE");
    assert.equal(result.blocked, false);
  }
});

test("CG12. HANDOFF phase → bloqueado", () => {
  const result = evaluateGate({
    phase: "HANDOFF",
    slotsComplete: false,
    userText: "hola",
    hasRecommendation: false,
    hasPendingSideEffects: false,
  });
  assert.equal(result.nextPhase, "HANDOFF");
  assert.equal(result.blocked, true);
});

test("CG13. buildConfirmationSummary incluye slots", () => {
  const summary = buildConfirmationSummary({
    actividad: "practica",
    categoria: "A1",
    circuito: "oficial",
    fecha: "martes",
    hora: "10:00",
  });
  assert.ok(summary.includes("practica"));
  assert.ok(summary.includes("A1"));
  assert.ok(summary.includes("oficial"));
  assert.ok(summary.includes("martes"));
  assert.ok(summary.includes("10:00"));
  assert.ok(summary.includes("¿Es correcto?"));
});

test("CG14. buildConfirmationSummary con recomendación", () => {
  const summary = buildConfirmationSummary(
    { categoria: "A1" },
    { target: "P2", reason: "Ahorro de S/20" },
  );
  assert.ok(summary.includes("P2"));
  assert.ok(summary.includes("A1"));
});

test("CG15. CONFIRMING + 'está bien' → EXECUTING", () => {
  const result = evaluateGate({
    phase: "CONFIRMING",
    slotsComplete: true,
    userText: "está bien",
    hasRecommendation: false,
    hasPendingSideEffects: false,
  });
  assert.equal(result.nextPhase, "EXECUTING");
  assert.equal(result.action, "EXECUTE");
});

test("CG16. CONFIRMING + 'espera' → GATHERING", () => {
  const result = evaluateGate({
    phase: "CONFIRMING",
    slotsComplete: true,
    userText: "espera",
    hasRecommendation: false,
    hasPendingSideEffects: false,
  });
  assert.equal(result.nextPhase, "GATHERING");
  assert.equal(result.action, "MODIFY");
});

test("CG17. CONFIRMING + texto ambiguo → mantener CONFIRMING", () => {
  const result = evaluateGate({
    phase: "CONFIRMING",
    slotsComplete: true,
    userText: "¿y cuánto cuesta?",
    hasRecommendation: false,
    hasPendingSideEffects: false,
  });
  assert.equal(result.nextPhase, "CONFIRMING");
  assert.equal(result.action, "ASK_CONFIRM");
});

test("CG18. GATHERING + 'asesor' → HANDOFF", () => {
  const result = evaluateGate({
    phase: "GATHERING",
    slotsComplete: false,
    userText: "quiero hablar con un asesor",
    hasRecommendation: false,
    hasPendingSideEffects: false,
  });
  assert.equal(result.nextPhase, "HANDOFF");
  assert.equal(result.action, "EXECUTE");
});

test("CG19. POST_ACTION sin modificación → mantener POST_ACTION", () => {
  const result = evaluateGate({
    phase: "POST_ACTION",
    slotsComplete: true,
    userText: "gracias",
    hasRecommendation: false,
    hasPendingSideEffects: false,
  });
  assert.equal(result.nextPhase, "POST_ACTION");
  assert.equal(result.action, "WAIT");
});

test("CG20. EXECUTING con side effects pendientes → POST_ACTION", () => {
  const result = evaluateGate({
    phase: "EXECUTING",
    slotsComplete: true,
    userText: "",
    hasRecommendation: false,
    hasPendingSideEffects: true,
  });
  assert.equal(result.nextPhase, "POST_ACTION");
  assert.equal(result.action, "POST_ACTION_REVIEW");
});

// ── Tests adicionales de cobertura ──────────────────────────────

test("CG21. CONFIRMING + 'hazlo' → EXECUTING", () => {
  const result = evaluateGate({
    phase: "CONFIRMING",
    slotsComplete: true,
    userText: "hazlo",
    hasRecommendation: false,
    hasPendingSideEffects: false,
  });
  assert.equal(result.nextPhase, "EXECUTING");
  assert.equal(result.action, "EXECUTE");
});

test("CG22. CONFIRMING + 'confirmado' → EXECUTING", () => {
  const result = evaluateGate({
    phase: "CONFIRMING",
    slotsComplete: true,
    userText: "confirmado",
    hasRecommendation: false,
    hasPendingSideEffects: false,
  });
  assert.equal(result.nextPhase, "EXECUTING");
  assert.equal(result.action, "EXECUTE");
});

test("CG23. CONFIRMING + 'nah' → GATHERING", () => {
  const result = evaluateGate({
    phase: "CONFIRMING",
    slotsComplete: true,
    userText: "nah",
    hasRecommendation: false,
    hasPendingSideEffects: false,
  });
  assert.equal(result.nextPhase, "GATHERING");
  assert.equal(result.action, "MODIFY");
});

test("CG24. CONFIRMING + 'otro circuito' → GATHERING", () => {
  const result = evaluateGate({
    phase: "CONFIRMING",
    slotsComplete: true,
    userText: "otro circuito",
    hasRecommendation: false,
    hasPendingSideEffects: false,
  });
  assert.equal(result.nextPhase, "GATHERING");
  assert.equal(result.action, "MODIFY");
});

test("CG25. CONFIRMING + 'a las 8' → GATHERING (modificación con hora)", () => {
  const result = evaluateGate({
    phase: "CONFIRMING",
    slotsComplete: true,
    userText: "a las 8",
    hasRecommendation: false,
    hasPendingSideEffects: false,
  });
  assert.equal(result.nextPhase, "GATHERING");
  assert.equal(result.action, "MODIFY");
});

test("CG26. HANDOFF + 'pásame con alguien' → HANDOFF", () => {
  const result = evaluateGate({
    phase: "GATHERING",
    slotsComplete: false,
    userText: "pásame con alguien",
    hasRecommendation: false,
    hasPendingSideEffects: false,
  });
  assert.equal(result.nextPhase, "HANDOFF");
  assert.equal(result.action, "EXECUTE");
  assert.equal(result.blocked, false);
});

test("CG27. buildConfirmationSummary sin slots → fallback", () => {
  const summary = buildConfirmationSummary({});
  assert.ok(summary.includes("¿Confirmas estos datos?"));
});

test("CG28. buildConfirmationSummary con recomendación null", () => {
  const summary = buildConfirmationSummary(
    { actividad: "practica" },
    null,
  );
  assert.ok(summary.includes("practica"));
  assert.ok(!summary.includes("Recomendación"));
  assert.ok(summary.includes("¿Es correcto?"));
});

test("CG29. CONFIRMING + 'para nada' → GATHERING", () => {
  const result = evaluateGate({
    phase: "CONFIRMING",
    slotsComplete: true,
    userText: "para nada",
    hasRecommendation: false,
    hasPendingSideEffects: false,
  });
  assert.equal(result.nextPhase, "GATHERING");
  assert.equal(result.action, "MODIFY");
});

test("CG30. IDLE + handoff → HANDOFF", () => {
  const result = evaluateGate({
    phase: "IDLE",
    slotsComplete: false,
    userText: "hablar con un humano",
    hasRecommendation: false,
    hasPendingSideEffects: false,
  });
  assert.equal(result.nextPhase, "HANDOFF");
  assert.equal(result.action, "EXECUTE");
});

// ── Tests de handoff contextual vs explícito ────────────────────

test("CG31. 'asesoría' → NO handoff (contexto, no solicitud)", () => {
  const result = evaluateGate({
    phase: "GATHERING",
    slotsComplete: false,
    userText: "asesoría sobre paquetes",
    hasRecommendation: false,
    hasPendingSideEffects: false,
  });
  assert.notEqual(result.nextPhase, "HANDOFF");
});

test("CG32. '¿Qué función tiene el asesor?' → NO handoff (mención contextual)", () => {
  const result = evaluateGate({
    phase: "GATHERING",
    slotsComplete: false,
    userText: "¿Qué función tiene el asesor?",
    hasRecommendation: false,
    hasPendingSideEffects: false,
  });
  assert.notEqual(result.nextPhase, "HANDOFF");
});

test("CG33. 'atienden 3 personas por día' → NO handoff (mención contextual)", () => {
  const result = evaluateGate({
    phase: "GATHERING",
    slotsComplete: false,
    userText: "atienden 3 personas por día",
    hasRecommendation: false,
    hasPendingSideEffects: false,
  });
  assert.notEqual(result.nextPhase, "HANDOFF");
});

test("CG34. 'quiero hablar con un asesor' → SÍ handoff (solicitud explícita)", () => {
  const result = evaluateGate({
    phase: "GATHERING",
    slotsComplete: false,
    userText: "quiero hablar con un asesor",
    hasRecommendation: false,
    hasPendingSideEffects: false,
  });
  assert.equal(result.nextPhase, "HANDOFF");
});

test("CG35. 'necesito una persona' → SÍ handoff (solicitud explícita)", () => {
  const result = evaluateGate({
    phase: "GATHERING",
    slotsComplete: false,
    userText: "necesito una persona",
    hasRecommendation: false,
    hasPendingSideEffects: false,
  });
  assert.equal(result.nextPhase, "HANDOFF");
});

// ── Tests de contexto: "sí" fuera de CONFIRMING ─────────────────

test("CG36. 'sí' en GATHERING → NO execute (solo CONFIRMING ejecuta)", () => {
  const result = evaluateGate({
    phase: "GATHERING",
    slotsComplete: false,
    userText: "sí",
    hasRecommendation: false,
    hasPendingSideEffects: false,
  });
  assert.notEqual(result.action, "EXECUTE");
  assert.equal(result.nextPhase, "GATHERING");
});

test("CG37. 'sí' en IDLE → NO execute", () => {
  const result = evaluateGate({
    phase: "IDLE",
    slotsComplete: false,
    userText: "sí",
    hasRecommendation: false,
    hasPendingSideEffects: false,
  });
  assert.notEqual(result.action, "EXECUTE");
});

// ── Test de objeción de precio ───────────────────────────────────

test("CG38. 'está caro' en CONFIRMING → mantiene CONFIRMING, no ejecuta", () => {
  const result = evaluateGate({
    phase: "CONFIRMING",
    slotsComplete: true,
    userText: "está caro",
    hasRecommendation: false,
    hasPendingSideEffects: false,
  });
  assert.equal(result.nextPhase, "CONFIRMING");
  assert.notEqual(result.action, "EXECUTE");
});

// ── Test de handoff conserva contexto ────────────────────────────

test("CG39. handoff desde CONFIRMING → HANDOFF phase, slots se conservan", () => {
  // El gate solo cambia la fase; la conservación de datos se maneja en el router
  const result = evaluateGate({
    phase: "CONFIRMING",
    slotsComplete: true,
    userText: "asesor",
    hasRecommendation: false,
    hasPendingSideEffects: false,
  });
  assert.equal(result.nextPhase, "HANDOFF");
  assert.equal(result.action, "EXECUTE");
  assert.equal(result.blocked, false);
  // Nota: la conservación de slots se verifica en conversation-router tests
});
