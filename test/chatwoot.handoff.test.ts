import { test } from "node:test";
import assert from "node:assert/strict";
import {
  messageFilter,
  resolveChangedValue,
  shouldMuteOnMessage,
  ChatwootFilterOptions,
} from "../src/webhooks/chatwoot";
import { shouldRespondForBot } from "../src/modules/chatwoot/processor";

const OPTIONS: ChatwootFilterOptions = { accountId: 1, inboxId: 9 };

function humanMessage(overrides: Record<string, unknown> = {}) {
  return {
    event: "message_created",
    id: 1000,
    content: "¿Sigues ahí?",
    message_type: "incoming",
    private: false,
    sender: { id: 88, name: "Operador", type: "user" },
    conversation: {
      id: 55,
      inbox_id: 9,
      status: "open",
      contact_inbox: { id: 3, contact_id: 42, inbox_id: 9, source_id: "+51999988777" },
    },
    account: { id: 1 },
    inbox: { id: 9, channel_type: "Channel::WhatsApp" },
    ...overrides,
  };
}

// ── CORRECCIÓN 1: anti-self-mute del bot ──────────────────────────────────

// PRE-CORRECCIÓN este escenario fallaba: el handler de "humano" corría antes de
// los filtros y muteaba al bot cuando su propio reply outgoing (sender.type="user",
// token de API tipo "user") generaba message_created outgoing. POST-CORRECCIÓN
// se exige incoming/no-private/account/inbox ANTES de evaluar el sender.
test("R1. outgoing del propio bot (sender.user) NUNCA mutea, incluso sin CHATWOOT_BOT_SENDER_ID", () => {
  const botReply = humanMessage({
    message_type: "outgoing",
    sender: { id: 88, name: "Conducar (API)", type: "user" },
  });
  assert.equal(
    shouldMuteOnMessage(botReply, OPTIONS),
    false,
    "el reply outgoing del bot no puede mutear al bot",
  );
  // Además el mensaje no pasa el filtro de procesamiento (no_incoming).
  assert.deepEqual(messageFilter(botReply, OPTIONS), {
    process: false,
    reason: "no_incoming",
  });
});

test("R1b. tras su propio reply outgoing, el bot SIGUE respondiendo al siguiente incoming (no quedó mudo)", () => {
  const botReply = humanMessage({
    message_type: "outgoing",
    sender: { id: 88, name: "Conducar (API)", type: "user" },
  });
  // muteBot NO se ejecutó → el bot sigue activo.
  assert.equal(shouldMuteOnMessage(botReply, OPTIONS), false);
  const botActive = true;
  const nextIncoming = { id: 7, type: "contact" };
  assert.equal(shouldRespondForBot(botActive, nextIncoming, undefined), true);
});

test("R1c. con CHATWOOT_BOT_SENDER_ID configurado, el id actúa de backstop adicional", () => {
  const opts: ChatwootFilterOptions = { accountId: 1, inboxId: 9, botSenderId: 88 };
  const botReply = humanMessage({
    message_type: "outgoing",
    sender: { id: 88, name: "Conducar (API)", type: "user" },
  });
  assert.equal(shouldMuteOnMessage(botReply, opts), false);
});

test("R2. incoming + sender.user (humano) → sí activa handoff (mute) cuando corresponde", () => {
  const opts: ChatwootFilterOptions = { accountId: 1, inboxId: 9, botSenderId: 777 };
  assert.equal(
    shouldMuteOnMessage(humanMessage({ sender: { id: 88, type: "user" } }), opts),
    true,
  );
  // El propio bot (id == botSenderId) no es humano.
  assert.equal(
    shouldMuteOnMessage(humanMessage({ sender: { id: 777, type: "user" } }), opts),
    false,
  );
});

test("R3. private=true → NUNCA mutea al bot (notas internas del panel)", () => {
  const opts: ChatwootFilterOptions = { accountId: 1, inboxId: 9, botSenderId: 777 };
  assert.equal(shouldMuteOnMessage(humanMessage({ private: true }), opts), false);
  assert.equal(
    shouldMuteOnMessage(humanMessage({ private: true, message_type: "outgoing" }), opts),
    false,
  );
});

test("R4. account/inbox incorrectos → sin handoff (filtros de cliente ANTES del sender)", () => {
  assert.equal(shouldMuteOnMessage(humanMessage({ account: { id: 2 } }), OPTIONS), false);
  assert.equal(
    shouldMuteOnMessage(humanMessage({ conversation: { id: 55, inbox_id: 999, contact_inbox: { id: 3, contact_id: 42, inbox_id: 999, source_id: "+51999988777" } } }), OPTIONS),
    false,
  );
});

test("R5. solo message_created puede disparar mute por mensaje", () => {
  assert.equal(shouldMuteOnMessage(humanMessage({ event: "message_updated" }), OPTIONS), false);
});

// ── CORRECCIÓN 2: assignee_id en changed_attributes ────────────────────────

test("R6. assignee_id como NUMBER → valor nuevo directo (decisión correcta)", () => {
  assert.equal(resolveChangedValue(42), 42);
});

test("R7. assignee_id como ARRAY [previo, nuevo] → se toma el ÚLTIMO (valor nuevo)", () => {
  // asignación: nil → 42
  assert.equal(resolveChangedValue([null, 42]), 42);
  assert.equal(resolveChangedValue([5, 42]), 42);
  // desasignación: nuevo null → null (NO mutea)
  assert.equal(resolveChangedValue([42, null]), null);
  // re-asignación al mismo: dicta 42 (misma semántica que number directo)
  assert.equal(resolveChangedValue([42, 42]), 42);
});

test("R8. assignee_id ausente o no numérico → null (NO mutea)", () => {
  assert.equal(resolveChangedValue(undefined), null);
  assert.equal(resolveChangedValue("42"), null);
  assert.equal(resolveChangedValue([null, "42"]), null);
});