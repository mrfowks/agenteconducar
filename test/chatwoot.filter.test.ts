import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ChatwootDeduper,
  messageFilter,
} from "../src/webhooks/chatwoot";
import { buildMessageId, isHumanUserSender } from "../src/modules/chatwoot/mapper";
import { shouldRespondForBot } from "../src/modules/chatwoot/processor";

const OPTIONS = { accountId: 1, inboxId: 9, botSenderId: 777 };

function validPayload(overrides: Record<string, unknown> = {}) {
  return {
    event: "message_created",
    id: 100,
    content: "Hola",
    message_type: "incoming",
    private: false,
    content_type: null,
    sender: { id: 7, name: "Ana", type: "contact", phone_number: "+51999988777" },
    conversation: {
      id: 55,
      inbox_id: 9,
      status: "open",
      contact_inbox: { id: 3, contact_id: 42, inbox_id: 9, source_id: "51999988777" },
    },
    account: { id: 1 },
    inbox: { id: 9, channel_type: "Channel::WhatsApp" },
    ...overrides,
  };
}

test("E. payload entrante válido pasa el filtro", () => {
  const res = messageFilter(validPayload(), OPTIONS);
  assert.deepEqual(res, { process: true });
});

test("F. mensaje outgoing ignorado", () => {
  const res = messageFilter(validPayload({ message_type: "outgoing" }), OPTIONS);
  assert.deepEqual(res, { process: false, reason: "no_incoming" });
});

test("G. sender AgentBot / Captain::Assistant ignorado", () => {
  const agentBot = messageFilter(
    validPayload({ sender: { id: 1, type: "AgentBot" } }),
    OPTIONS,
  );
  assert.deepEqual(agentBot, { process: false, reason: "emisor_bot_no_humano" });

  const captain = messageFilter(
    validPayload({ sender: { id: 9, type: "Captain::Assistant" } }),
    OPTIONS,
  );
  assert.deepEqual(captain, { process: false, reason: "emisor_bot_no_humano" });
});

test("G2. sender con botSenderId (chatbot propio) ignorado", () => {
  const res = messageFilter(
    validPayload({ sender: { id: 777, name: "ConducarBot", type: "user" } }),
    OPTIONS,
  );
  assert.deepEqual(res, { process: false, reason: "bot_sender_id" });
});

test("H. inbox incorrecto ignorado", () => {
  const res = messageFilter(
    validPayload({ conversation: { id: 55, inbox_id: 999 } }),
    OPTIONS,
  );
  assert.deepEqual(res, { process: false, reason: "inbox_incorrecto" });
});

test("I. account incorrecto ignorado", () => {
  const res = messageFilter(validPayload({ account: { id: 2 } }), OPTIONS);
  assert.deepEqual(res, { process: false, reason: "account_incorrecto" });
});

test("F2. evento no message_created ignorado", () => {
  const res = messageFilter(validPayload({ event: "conversation_status_changed" }), OPTIONS);
  assert.deepEqual(res, { process: false, reason: "event_no_message_created" });
});

// J. Dedup: mismo messageId dos veces → la segunda se ignora.
// Se usa exactamente el MISMO deduper (con persist inyectado) y el MISMO id
// compuesto que usa el webhook real (buildMessageId + Message.id P2002).
// En producción el doble envío lo detecta la unicidad de Message.id (cw-...):
// aquí se simula con un store inyectado y una cache en memoria.
test("J. dedup: mismo messageId dos veces → segunda vez 'duplicate'", async () => {
  const persisted: string[] = [];
  const deduper = new ChatwootDeduper(async (key) => {
    persisted.push(key);
  });
  const payload = validPayload();
  const key = buildMessageId(1, 100);
  assert.equal(key, "cw-1-100");
  assert.equal(await deduper.insert(key, "51999988777", payload), "inserted");
  assert.equal(await deduper.insert(key, "51999988777", payload), "duplicate");
  assert.equal(persisted.length, 1);
});

test("J2. P2002 (persistencia real) devuelve duplicate sin relanzar", async () => {
  const deduper = new ChatwootDeduper(async () => {
    const err = new Error("unique constraint") as Error & { code?: string };
    err.code = "P2002";
    throw err;
  });
  const payload = validPayload();
  const key = buildMessageId(1, 101);
  assert.equal(await deduper.insert(key, "51999988777", payload), "duplicate");
});

test("J3. fallo NO-P2002 relanza y libera la cache", async () => {
  const deduper = new ChatwootDeduper(async () => {
    throw new Error("db caída");
  });
  const payload = validPayload();
  const key = buildMessageId(1, 102);
  await assert.rejects(() => deduper.insert(key, "51999988777", payload));
  // cache liberada → el siguiente intento vuelve a persistir (intentará de nuevo)
  await assert.rejects(() => deduper.insert(key, "51999988777", payload));
});

// K. Handoff: mensaje posterior de humano (user del panel) → el bot NO responde.
test("K. humano (user) posterior → bot no responde", () => {
  const humanSender = { id: 88, type: "user" };
  assert.equal(isHumanUserSender(humanSender, undefined), true);
  // bot activo pero emisor humano → no debe responder.
  assert.equal(shouldRespondForBot(true, humanSender, undefined), false);
  // bot mudo + humano → tampoco.
  assert.equal(shouldRespondForBot(false, humanSender, undefined), false);
  // bot activo + contacto normal → responde.
  assert.equal(shouldRespondForBot(true, { id: 7, type: "contact" }, undefined), true);
  // el propio bot (botSenderId) no es humano: con bot activo responde...
  assert.equal(shouldRespondForBot(true, { id: 777, type: "user" }, 777), true);
  // ...y con bot mudo no responde (lo decide el guard, no el sender).
  assert.equal(shouldRespondForBot(false, { id: 777, type: "user" }, 777), false);
});

test("K2. AgentBot no es humano (no debe mute-bot)", () => {
  assert.equal(isHumanUserSender({ id: 1, type: "AgentBot" }, undefined), false);
  assert.equal(isHumanUserSender({ id: 9, type: "Captain::Assistant" }, undefined), false);
  assert.equal(isHumanUserSender({ id: 88, type: "user" }, 88), false); // es el propio bot
});

// ── emisor_no_contacto: sender.type ausente/null con evidencia válida ──

test("E2. sender.type undefined + source_id válido → procesa", () => {
  const res = messageFilter(
    validPayload({ sender: { id: 123, phone_number: "+51917595954" } }),
    OPTIONS,
  );
  assert.deepEqual(res, { process: true });
});

test("E3. sender.type null + source_id válido → procesa", () => {
  const res = messageFilter(
    validPayload({ sender: { id: 123, type: null, phone_number: "+51917595954" } }),
    OPTIONS,
  );
  assert.deepEqual(res, { process: true });
});

test("E4. sender.type undefined sin evidencia de contacto → rechaza", () => {
  const res = messageFilter(
    validPayload({
      sender: {},
      conversation: { id: 55, inbox_id: 9, contact_inbox: { id: 3, inbox_id: 9, source_id: "bsuid-abc-123" } },
    }),
    OPTIONS,
  );
  assert.deepEqual(res, { process: false, reason: "emisor_no_contacto" });
});

test("E5. sender.type null sin evidencia de contacto → rechaza", () => {
  const res = messageFilter(
    validPayload({
      sender: { type: null },
      conversation: { id: 55, inbox_id: 9, contact_inbox: { id: 3, inbox_id: 9 } },
    }),
    OPTIONS,
  );
  assert.deepEqual(res, { process: false, reason: "emisor_no_contacto" });
});

test("E6. sender.type 'system' desconocido sin evidencia → rechaza", () => {
  const res = messageFilter(
    validPayload({ sender: { id: 99, type: "system" } }),
    OPTIONS,
  );
  assert.deepEqual(res, { process: false, reason: "emisor_no_contacto" });
});

test("E7. sender.type 'Contact' (capital C) → rechaza", () => {
  const res = messageFilter(
    validPayload({ sender: { id: 7, type: "Contact", phone_number: "+51999988777" } }),
    OPTIONS,
  );
  assert.deepEqual(res, { process: false, reason: "emisor_no_contacto" });
});

test("G3. sender.type 'user' explícito → emisor_usuario_panel", () => {
  const res = messageFilter(
    validPayload({ sender: { id: 88, type: "user", name: "Mary" } }),
    OPTIONS,
  );
  assert.deepEqual(res, { process: false, reason: "emisor_usuario_panel" });
});

test("E8. payload realista v4.17.1 sin sender.type → procesa", () => {
  // Payload exacto del caso real de producción
  const payload = {
    event: "message_created",
    id: 17,
    content: "Hola",
    message_type: "incoming",
    private: false,
    sender: {
      id: 123,
      phone_number: "+51917595954",
    },
    conversation: {
      id: 55,
      inbox_id: 9,
      contact_inbox: {
        contact_id: 42,
        source_id: "51917595954",
      },
    },
    account: { id: 1 },
  };
  const res = messageFilter(payload, OPTIONS);
  assert.deepEqual(res, { process: true });
});

test("E9. sender.type undefined + sender.phone_number → procesa", () => {
  // Sin source_id, solo phone_number en sender
  const res = messageFilter(
    validPayload({
      sender: { id: 123, phone_number: "51917595954" },
      conversation: { id: 55, inbox_id: 9, contact_inbox: { id: 3, contact_id: 42, inbox_id: 9 } },
    }),
    OPTIONS,
  );
  assert.deepEqual(res, { process: true });
});

// ── Contactos sin teléfono (evidencia real de producción) ──────────────────

test("E10. sender.type undefined + sender.id válido (Contact sin teléfono) → procesa", () => {
  // Reproduce el caso real: SENDER_OBJECT_TYPE=contact, SENDER_ID_OBJECT=9,
  // SENDER_PHONE=None, MESSAGE_CONTACT_INBOX=vacío
  const res = messageFilter(
    validPayload({
      sender: { id: 9 },
      conversation: { id: 9, inbox_id: 9 },
    }),
    OPTIONS,
  );
  assert.deepEqual(res, { process: true });
});

test("E11. sender.type null + sender.id válido → procesa", () => {
  const res = messageFilter(
    validPayload({
      sender: { id: 9, type: null },
      conversation: { id: 9, inbox_id: 9 },
    }),
    OPTIONS,
  );
  assert.deepEqual(res, { process: true });
});

test("E12. sender.type undefined + contact_inbox.contact_id → procesa", () => {
  const res = messageFilter(
    validPayload({
      sender: { id: 9 },
      conversation: {
        id: 9,
        inbox_id: 9,
        contact_inbox: { contact_id: 42, inbox_id: 9 },
      },
    }),
    OPTIONS,
  );
  assert.deepEqual(res, { process: true });
});

test("E13. sender.type undefined + source_id BSUID → NO procesa (sin evidencia)", () => {
  // BSUID no parece teléfono y no hay contact_id ni sender.id
  const res = messageFilter(
    validPayload({
      sender: {},
      conversation: {
        id: 9,
        inbox_id: 9,
        contact_inbox: { source_id: "bsuid-abc-123", inbox_id: 9 },
      },
    }),
    OPTIONS,
  );
  assert.deepEqual(res, { process: false, reason: "emisor_no_contacto" });
});

test("E14. sender.type undefined + source_id BSUID + sender.id → procesa", () => {
  // BSUID + sender.id válido = evidencia fuerte
  const res = messageFilter(
    validPayload({
      sender: { id: 9 },
      conversation: {
        id: 9,
        inbox_id: 9,
        contact_inbox: { source_id: "bsuid-abc-123", inbox_id: 9 },
      },
    }),
    OPTIONS,
  );
  assert.deepEqual(res, { process: true });
});

test("E-PRIVATE. private=true → rechazado", () => {
  const res = messageFilter(
    validPayload({ private: true }),
    OPTIONS,
  );
  assert.deepEqual(res, { process: false, reason: "private" });
});