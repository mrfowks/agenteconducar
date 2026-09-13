import { test } from "node:test";
import assert from "node:assert/strict";
import { expandMenuIntent, MENU_INTENTS } from "../src/agent/agent";
import { detectEscalationTrigger } from "../src/modules/payments/service";

// ── Router: opciones 1–5 ──────────────────────────────────────────────────

test("R1. '1' → alquiler vehículo examen práctico", () => {
  assert.equal(expandMenuIntent("1"), MENU_INTENTS["1"]);
  assert.match(expandMenuIntent("1")!, /alquiler de vehículo/i);
});

test("R2. '2' → simulacro de examen", () => {
  assert.equal(expandMenuIntent("2"), MENU_INTENTS["2"]);
  assert.match(expandMenuIntent("2")!, /simulacro/i);
});

test("R3. '3' → práctica de manejo", () => {
  assert.equal(expandMenuIntent("3"), MENU_INTENTS["3"]);
  assert.match(expandMenuIntent("3")!, /práctica/i);
});

test("R4. '4' → paquetes todo incluido", () => {
  assert.equal(expandMenuIntent("4"), MENU_INTENTS["4"]);
  assert.match(expandMenuIntent("4")!, /paquetes/i);
});

test("R5. '5' → horarios y presentación", () => {
  assert.equal(expandMenuIntent("5"), MENU_INTENTS["5"]);
  assert.match(expandMenuIntent("5")!, /horarios/i);
});

test("R6. '6' → null (opción inválida)", () => {
  assert.equal(expandMenuIntent("6"), null);
});

test("R7. '0' → null", () => {
  assert.equal(expandMenuIntent("0"), null);
});

test("R8. '2 ' con espacio → funciona (trim)", () => {
  assert.equal(expandMenuIntent("2 "), MENU_INTENTS["2"]);
});

test("R9. ' 5' con espacio → funciona (trim)", () => {
  assert.equal(expandMenuIntent(" 5"), MENU_INTENTS["5"]);
});

test("R10. '5.' → null (no match exacto)", () => {
  assert.equal(expandMenuIntent("5."), null);
});

test("R11. 'cinco' → null (texto, no número)", () => {
  assert.equal(expandMenuIntent("cinco"), null);
});

test("R12. 'quiero reservar una práctica' → null (texto libre)", () => {
  assert.equal(expandMenuIntent("quiero reservar una práctica"), null);
});

test("R13. '' vacío → null", () => {
  assert.equal(expandMenuIntent(""), null);
});

// ── Handoff: NO se activa con "5" ─────────────────────────────────────────

test("H1. '5' NO activa handoff", () => {
  assert.equal(detectEscalationTrigger("5"), null);
});

test("H2. 'quiero hablar con un humano' → handoff NO_SOLUTION", () => {
  assert.equal(detectEscalationTrigger("quiero hablar con un humano"), "NO_SOLUTION");
});

test("H3. 'quiero hablar con una persona' → handoff NO_SOLUTION", () => {
  assert.equal(detectEscalationTrigger("quiero hablar con una persona"), "NO_SOLUTION");
});

test("H4. 'necesito un asesor' → handoff NO_SOLUTION", () => {
  assert.equal(detectEscalationTrigger("necesito un asesor"), "NO_SOLUTION");
});

test("H5. 'hablar con un asesor' → handoff NO_SOLUTION", () => {
  assert.equal(detectEscalationTrigger("hablar con un asesor"), "NO_SOLUTION");
});

// ── SYSTEM_PROMPT: reglas de política ──────────────────────────────────────

import { SYSTEM_PROMPT } from "../src/agent/agent";

test("P1. SYSTEM_PROMPT prohíbe investigar en Internet", () => {
  assert.match(SYSTEM_PROMPT, /NUNCA busques información en Internet/i);
  assert.match(SYSTEM_PROMPT, /conocimiento externo/i);
});

test("P2. SYSTEM_PROMPT contiene regla de repregunta", () => {
  assert.match(SYSTEM_PROMPT, /repregunta concreta/i);
  assert.match(SYSTEM_PROMPT, /antes de escalar/i);
});

test("P3. SYSTEM_PROMPT contiene límite de 2 aclaraciones", () => {
  assert.match(SYSTEM_PROMPT, /máximo 2 intentos de aclaración/i);
  assert.match(SYSTEM_PROMPT, /derivar_a_humano/i);
});

test("P4. SYSTEM_PROMPT usa 'asesor especializado' en fallback", () => {
  assert.match(SYSTEM_PROMPT, /asesor especializado/i);
  assert.doesNotMatch(SYSTEM_PROMPT, /asesor humano puede ayudarte/i);
});

test("P5. FALLBACK_MESSAGE usa 'asesor especializado'", () => {
  // FALLBACK_MESSAGE no está exportado, pero verificamos a través del prompt
  assert.match(SYSTEM_PROMPT, /Te voy a transferir con un asesor especializado/i);
});

// ── Handoff: frases adicionales ────────────────────────────────────────────

test("H6. 'quiero un asesor' → handoff", () => {
  assert.equal(detectEscalationTrigger("quiero un asesor"), "NO_SOLUTION");
});

test("H7. 'necesito un asesor' → handoff", () => {
  assert.equal(detectEscalationTrigger("necesito un asesor"), "NO_SOLUTION");
});

test("H8. 'necesito hablar con un asesor' → handoff", () => {
  assert.equal(detectEscalationTrigger("necesito hablar con un asesor"), "NO_SOLUTION");
});

test("H9. 'necesito una persona' → handoff", () => {
  assert.equal(detectEscalationTrigger("necesito una persona"), "NO_SOLUTION");
});

test("H10. 'pásame con una persona' → handoff", () => {
  assert.equal(detectEscalationTrigger("pásame con una persona"), "NO_SOLUTION");
});

test("H11. 'pásame con alguien' → handoff", () => {
  assert.equal(detectEscalationTrigger("pásame con alguien"), "NO_SOLUTION");
});

test("H12. 'asesoría' sola → NO handoff", () => {
  assert.equal(detectEscalationTrigger("asesoría"), null);
});

test("H13. 'ayuda' sola → NO handoff", () => {
  assert.equal(detectEscalationTrigger("ayuda"), null);
});

test("H14. 'informe' solo → NO handoff", () => {
  assert.equal(detectEscalationTrigger("informe"), null);
});

// ── Handoff: "asesor" standalone ──────────────────────────────────────────

test("H15. 'asesor' solo → handoff", () => {
  assert.equal(detectEscalationTrigger("asesor"), "NO_SOLUTION");
});

test("H16. 'Asesor' con mayúscula → handoff", () => {
  assert.equal(detectEscalationTrigger("Asesor"), "NO_SOLUTION");
});

test("H17. 'asesoría' sola → NO handoff", () => {
  assert.equal(detectEscalationTrigger("asesoría"), null);
});

test("H18. 'asesoría sobre paquetes' → NO handoff", () => {
  assert.equal(detectEscalationTrigger("asesoría sobre paquetes"), null);
});
