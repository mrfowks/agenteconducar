import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractAssigneeChange,
  handleConversationEvent,
  messageFilter,
  resolveChangedValue,
  shouldMuteOnMessage,
  ChatwootFilterOptions,
} from "../src/webhooks/chatwoot";
import { ChatwootMessagePayload } from "../src/modules/chatwoot/mapper";
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

// ── B1: conversation_status_changed con `status` a nivel RAÍZ (v4.17.1) ────

function conversationEventHandlers() {
  const muted: string[] = [];
  const released: string[] = [];
  return {
    muted,
    released,
    handlers: {
      muteBot: async (phone: string) => {
        muted.push(phone);
      },
      releaseBot: async (phone: string) => {
        released.push(phone);
      },
    },
  };
}

test("HC1. conversation_status_changed con status raíz 'resolved' → releaseBot con el teléfono (contact_inbox raíz)", async () => {
  const { muted, released, handlers } = conversationEventHandlers();
  await handleConversationEvent(
    {
      event: "conversation_status_changed",
      status: "resolved",
      contact_inbox: { id: 3, contact_id: 42, inbox_id: 9, source_id: "51999988777" },
      conversation: { id: 55 },
    } as ChatwootMessagePayload,
    handlers,
  );
  assert.deepEqual(released, ["51999988777"]);
  assert.deepEqual(muted, []);
});

test("HC2. conversation_status_changed con status raíz 'open' → NO releaseBot", async () => {
  const { released, handlers } = conversationEventHandlers();
  await handleConversationEvent(
    {
      event: "conversation_status_changed",
      status: "open",
      contact_inbox: { id: 3, contact_id: 42, inbox_id: 9, source_id: "51999988777" },
      conversation: { id: 55 },
    } as ChatwootMessagePayload,
    handlers,
  );
  assert.deepEqual(released, []);
});

test("HC3. conversation_status_changed 'resolved' con teléfono vía meta.sender.phone_number (raíz) → releaseBot", async () => {
  const { muted, released, handlers } = conversationEventHandlers();
  await handleConversationEvent(
    {
      event: "conversation_status_changed",
      status: "resolved",
      meta: { sender: { id: 7, name: "Ana", type: "contact", phone_number: "+51999988777" } },
      conversation: { id: 55 },
    } as ChatwootMessagePayload,
    handlers,
  );
  assert.deepEqual(released, ["51999988777"]);
  assert.deepEqual(muted, []);
});

test("HC4. conversation_status_changed 'resolved' sin teléfono → sin error y sin release", async () => {
  const { released, handlers } = conversationEventHandlers();
  await handleConversationEvent(
    { event: "conversation_status_changed", status: "resolved", conversation: { id: 55 } } as ChatwootMessagePayload,
    handlers,
  );
  assert.deepEqual(released, []);
});

test("HC5. tolerancia: conversation.status anidado 'resolved' también libera (primaria: raíz)", async () => {
  const { released, handlers } = conversationEventHandlers();
  await handleConversationEvent(
    {
      event: "conversation_status_changed",
      contact_inbox: { id: 3, contact_id: 42, inbox_id: 9, source_id: "51999988777" },
      conversation: { id: 55, status: "resolved" },
    } as ChatwootMessagePayload,
    handlers,
  );
  assert.deepEqual(released, ["51999988777"]);
});

// ── B2: conversation_updated con changed_attributes como ARRAY (v4.17.1) ────

test("HC6. conversation_updated con ARRAY documentado [{assignee_id:{previous_value:null,current_value:88}}] → muteBot", async () => {
  const { muted, released, handlers } = conversationEventHandlers();
  await handleConversationEvent(
    {
      event: "conversation_updated",
      changed_attributes: [{ assignee_id: { previous_value: null, current_value: 88 } }],
      contact_inbox: { id: 3, contact_id: 42, inbox_id: 9, source_id: "51999988777" },
    } as ChatwootMessagePayload,
    handlers,
  );
  assert.deepEqual(muted, ["51999988777"]);
  assert.deepEqual(released, []);
});

test("HC7. extractAssigneeChange: formato ARRAY documentado + tolerancias legacy", () => {
  // formato documentado: [{ "assignee_id": { "previous_value": X, "current_value": Y } }]
  assert.deepEqual(
    extractAssigneeChange([{ assignee_id: { previous_value: null, current_value: 88 } }]),
    { previous_value: null, current_value: 88 },
  );
  // desasignación documentada
  assert.deepEqual(
    extractAssigneeChange([{ assignee_id: { previous_value: 88, current_value: null } }]),
    { previous_value: 88, current_value: null },
  );
  // tolerancia: assignee_id numérico directo en el array
  assert.deepEqual(extractAssigneeChange([{ assignee_id: 88 }]), { current_value: 88 });
  // tolerancia: Record legacy { assignee_id: [previo, nuevo] } → último
  assert.deepEqual(extractAssigneeChange({ assignee_id: [null, 42] }), {
    previous_value: null,
    current_value: 42,
  });
  // sin assignee en el array → undefined
  assert.equal(
    extractAssigneeChange([{ status: { previous_value: "open", current_value: "resolved" } }]),
    undefined,
  );
  assert.equal(extractAssigneeChange([]), undefined);
  assert.equal(extractAssigneeChange(undefined), undefined);
});

test("HC8. conversation_updated con assignee_id numérico directo [{assignee_id:88}] → muteBot (tolerancia)", async () => {
  const { muted, released, handlers } = conversationEventHandlers();
  await handleConversationEvent(
    {
      event: "conversation_updated",
      changed_attributes: [{ assignee_id: 88 }],
      contact_inbox: { id: 3, contact_id: 42, inbox_id: 9, source_id: "51999988777" },
    } as ChatwootMessagePayload,
    handlers,
  );
  assert.deepEqual(muted, ["51999988777"]);
  assert.deepEqual(released, []);
});

test("HC9. conversation_updated con current_value:null (desasignación) → releaseBot", async () => {
  const { muted, released, handlers } = conversationEventHandlers();
  await handleConversationEvent(
    {
      event: "conversation_updated",
      changed_attributes: [{ assignee_id: { previous_value: 88, current_value: null } }],
      contact_inbox: { id: 3, contact_id: 42, inbox_id: 9, source_id: "51999988777" },
    } as ChatwootMessagePayload,
    handlers,
  );
  assert.deepEqual(released, ["51999988777"]);
  assert.deepEqual(muted, []);
});

test("HC10. changed_attributes sin assignee_id → NI mute NI release", async () => {
  const { muted, released, handlers } = conversationEventHandlers();
  await handleConversationEvent(
    {
      event: "conversation_updated",
      changed_attributes: [{ status: { previous_value: "open", current_value: "resolved" } }],
      contact_inbox: { id: 3, contact_id: 42, inbox_id: 9, source_id: "51999988777" },
    } as ChatwootMessagePayload,
    handlers,
  );
  assert.deepEqual(muted, []);
  assert.deepEqual(released, []);
});

test("HC11. humano asignado → muteBot invocado y el bot queda mudo (no responde)", async () => {
  let botActive = true;
  await handleConversationEvent(
    {
      event: "conversation_updated",
      changed_attributes: [{ assignee_id: { previous_value: null, current_value: 88 } }],
      contact_inbox: { id: 3, contact_id: 42, inbox_id: 9, source_id: "51999988777" },
    } as ChatwootMessagePayload,
    {
      muteBot: async () => {
        botActive = false;
      },
      releaseBot: async () => {},
    },
  );
  assert.equal(botActive, false, "muteBot dejó la conversación en manos humanas (bot mudo)");
  // Comportamiento central: con el bot mudo, aunque un contacto normal escriba, NO responde.
  assert.equal(shouldRespondForBot(botActive, { id: 7, type: "contact" }, undefined), false);
});