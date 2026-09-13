import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildAttachmentFilename,
  buildMessageId,
  buildStoragePath,
  extractFromPayload,
  extractPhoneFromPayload,
  mimeToExtension,
} from "../src/modules/chatwoot/mapper";
import { dataUrlToBuffer } from "../src/modules/chatwoot/processor";
import { sniffMimeType } from "../src/modules/chatwoot/delivery";

test("L. imagen entrante: extractFromPayload con attachments + storagePath correcto", () => {
  const payload = {
    event: "message_created",
    id: 1234,
    content: "Aquí va mi comprobante",
    message_type: "incoming",
    sender: { id: 7, name: "Ana", type: "contact", phone_number: "+51999988777" },
    conversation: {
      id: 55,
      inbox_id: 9,
      contact_inbox: { id: 3, contact_id: 42, inbox_id: 9, source_id: "51999988777" },
    },
    account: { id: 1 },
    attachments: [
      {
        id: 900,
        file_type: "image",
        file_url: "https://chatwoot.example.com/rails/active_storage/...jpeg",
        content_type: "image/jpeg",
        file_size: 12345,
        extension: "jpeg",
      },
    ],
  };

  const extracted = extractFromPayload(payload as any);
  assert.equal(extracted.phone, "51999988777");
  assert.equal(extracted.chatwootConversationId, 55);
  assert.equal(extracted.chatwootContactId, 42);
  assert.equal(extracted.chatwootAccountId, 1);
  assert.equal(extracted.messageText, "Aquí va mi comprobante");
  assert.equal(extracted.attachments.length, 1);
  assert.equal(extracted.attachments[0].file_url, "https://chatwoot.example.com/rails/active_storage/...jpeg");

  // Naming de archivo: /data/uploads/<timestamp>_<uuid>.ext
  const storagePath = buildStoragePath("image/jpeg", "jpeg");
  assert.match(storagePath, /^\/data\/uploads\/\d{13}_[0-9a-f-]{36}\.jpg$/);
});

test("L2. buildAttachmentFilename obedece el patrón <ts>_<uuid>.<ext> con valores inyectados", () => {
  const name = buildAttachmentFilename("image/png", "png", { now: 1726000000000, uuid: "11111111-2222-3333-4444-555555555555" });
  assert.equal(name, "1726000000000_11111111-2222-3333-4444-555555555555.png");
});

test("L3. mimeToExtension: MIME conocido, extensión de respaldo y fallback .bin", () => {
  assert.equal(mimeToExtension("image/png"), ".png");
  assert.equal(mimeToExtension("application/pdf"), ".pdf");
  assert.equal(mimeToExtension("application/octet-stream", "jpeg"), ".jpeg"); // ext real gana
  assert.equal(mimeToExtension("application/octet-stream"), ".bin");
  assert.equal(mimeToExtension("image/jpeg", "JPG"), ".jpg"); // mime gana sobre ext
});

test("L4. extractFromPayload: source_id no numérico (BSUID) cae a sender.phone_number", () => {
  const payload = {
    event: "message_created",
    id: 1,
    content: "x",
    message_type: "incoming",
    sender: { id: 7, type: "contact", phone_number: "51999888777" },
    conversation: {
      id: 1,
      inbox_id: 9,
      contact_inbox: { id: 3, contact_id: 42, inbox_id: 9, source_id: "bsuid-abcdef-123" },
    },
    account: { id: 1 },
  };
  const phone = extractPhoneFromPayload(payload as any);
  assert.equal(phone, "51999888777");
});

test("L5. sin teléfono resoluble → null (mapeo BSUID pendiente)", () => {
  const payload = {
    event: "message_created",
    id: 1,
    content: "x",
    message_type: "incoming",
    sender: { id: 7, type: "contact" },
    conversation: {
      id: 1,
      inbox_id: 9,
      contact_inbox: { id: 3, contact_id: 42, inbox_id: 9, source_id: "no-phone-id" },
    },
    account: { id: 1 },
  };
  assert.equal(extractPhoneFromPayload(payload as any), null);
});

test("L6. buildMessageId compone la clave cw-{accountId}-{messageId}", () => {
  assert.equal(buildMessageId(1, 1234), "cw-1-1234");
  assert.equal(buildMessageId(null, 5), "cw-0-5");
  assert.equal(buildMessageId(1, null), "cw-1-0");
});

test("L7. dataUrlToBuffer decodifica base64 y data_url UTF-8", () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
  const b64 = jpeg.toString("base64");
  const parsed = dataUrlToBuffer(`data:image/jpeg;base64,${b64}`);
  assert.equal(parsed.mimeType, "image/jpeg");
  assert.deepEqual(parsed.buffer, jpeg);
  const plain = dataUrlToBuffer("data:text/plain,Hola");
  assert.equal(plain.buffer.toString("utf8"), "Hola");
});

test("L8. sniffMimeType detecta JPEG/PNG/GIF/WebP/PDF", () => {
  assert.equal(sniffMimeType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00])), "image/jpeg");
  assert.equal(sniffMimeType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d])), "image/png");
  assert.equal(sniffMimeType(Buffer.from([0x47, 0x49, 0x46, 0x38])), "image/gif");
  assert.equal(sniffMimeType(Buffer.from([0x52, 0x49, 0x46, 0x46])), "image/webp");
  assert.equal(sniffMimeType(Buffer.from([0x25, 0x50, 0x44, 0x46])), "application/pdf");
  assert.equal(sniffMimeType(Buffer.from([0x00, 0x01, 0x02, 0x03])), "application/octet-stream");
});

// ── B1: extractPhoneFromPayload con fuentes a nivel raíz (v4.17.1) ─────────

test("L9. extractPhoneFromPayload: contact_inbox.source_id a nivel raíz (eventos de conversación)", () => {
  const payload = {
    event: "conversation_status_changed",
    status: "resolved",
    contact_inbox: { id: 3, contact_id: 42, inbox_id: 9, source_id: "+51999988777" },
    conversation: { id: 55 },
    account: { id: 1 },
  };
  assert.equal(extractPhoneFromPayload(payload as any), "51999988777");
});

test("L10. extractPhoneFromPayload: meta.sender.phone_number a nivel raíz (eventos de conversación)", () => {
  const payload = {
    event: "conversation_updated",
    changed_attributes: [{ assignee_id: { previous_value: null, current_value: 88 } }],
    meta: { sender: { id: 7, name: "Ana", type: "contact", phone_number: "+51999988777" } },
    conversation: { id: 55 },
    account: { id: 1 },
  };
  assert.equal(extractPhoneFromPayload(payload as any), "51999988777");
});

test("L11. extractPhoneFromPayload: source_id raíz no numérico (BSUID) cae a meta.sender.phone_number", () => {
  const payload = {
    event: "conversation_status_changed",
    status: "open",
    contact_inbox: { id: 3, contact_id: 42, inbox_id: 9, source_id: "bsuid-abcdef-123" },
    meta: { sender: { id: 7, type: "contact", phone_number: "51999888777" } },
    conversation: { id: 55 },
  };
  assert.equal(extractPhoneFromPayload(payload as any), "51999888777");
});