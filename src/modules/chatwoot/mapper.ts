import crypto from "crypto";
import { env } from "../../config/env";
import { prisma } from "../../db/client";
import { createContact, createConversation, searchContactByPhone } from "./client";
import { normalizePhone } from "../whatsapp/client";

// ─────────────────────────────────────────────────────────────
// Mapeo de payloads de Chatwoot ↔ dominio Conducar.
// Funciones puras (testeables) + persistencia del mapeo en Conversation.
// ─────────────────────────────────────────────────────────────

export interface ChatwootAttachment {
  id: number;
  file_type?: string;
  file_url?: string;
  data_url?: string;
  content_type?: string;
  file_size?: number;
  extension?: string;
}

export interface ChatwootMessagePayload {
  event?: string;
  id?: number;
  content?: string;
  message_type?: string;
  private?: boolean;
  source_id?: string | null;
  content_type?: string | null;
  content_attributes?: Record<string, unknown>;
  sender?: {
    id?: number;
    name?: string;
    type?: string;
    phone_number?: string;
  };
  conversation?: {
    id?: number;
    inbox_id?: number;
    status?: string;
    assignee_id?: number | null;
    contact_inbox?: { id?: number; contact_id?: number; inbox_id?: number; source_id?: string };
  };
  account?: { id?: number };
  inbox?: { id?: number; channel_type?: string };
  attachments?: ChatwootAttachment[];
}

export interface ExtractedPayload {
  /** null si no se pudo resolver teléfono (ver regla de transición BSUID). */
  phone: string | null;
  chatwootConversationId: number | null;
  chatwootContactId: number | null;
  chatwootInboxId: number | null;
  chatwootAccountId: number | null;
  sourceId: string | null;
  senderName: string | null;
  messageText: string;
  messageId: number | null;
  attachments: ChatwootAttachment[];
}

/**
 * ¿El raw se parece a un teléfono E.164 (7–15 dígitos, sin letras, sin 0 inicial)?
 * Se usa para tolerar la transición BSUID de Chatwoot (2026): si el source_id
 * ya no es un wa_id numérico, NO se trata como teléfono.
 */
export function looksLikePhone(raw: string): boolean {
  if (!raw || raw.length === 0) return false;
  if (/[a-zA-Z]/.test(raw)) return false;
  const digits = raw.replace(/[^\d]/g, "");
  if (digits.length < 7 || digits.length > 15) return false;
  if (!/^[1-9]/.test(digits)) return false;
  return true;
}

/**
 * Orden de fuentes para el teléfono (E.164):
 *   1. conversation.contact_inbox.source_id (wa_id en WhatsApp).
 *   2. sender.phone_number.
 *   3. null → log + mapeo por inbox_id+source_id (REQUIERE FASE POSTERIOR si
 *      la transición BSUID de 2026 cambia el formato).
 */
export function extractPhoneFromPayload(payload: ChatwootMessagePayload): string | null {
  const sourceId = payload.conversation?.contact_inbox?.source_id;
  if (typeof sourceId === "string" && looksLikePhone(sourceId)) {
    return normalizePhone(sourceId);
  }
  const senderPhone = payload.sender?.phone_number;
  if (typeof senderPhone === "string" && looksLikePhone(senderPhone)) {
    return normalizePhone(senderPhone);
  }
  return null;
}

/** Extrae TODA la información relevante de un payload message_created. */
export function extractFromPayload(payload: ChatwootMessagePayload): ExtractedPayload {
  return {
    phone: extractPhoneFromPayload(payload),
    chatwootConversationId: payload.conversation?.id ?? null,
    chatwootContactId: payload.conversation?.contact_inbox?.contact_id ?? null,
    chatwootInboxId: payload.conversation?.inbox_id ?? payload.inbox?.id ?? null,
    chatwootAccountId: payload.account?.id ?? null,
    sourceId: payload.conversation?.contact_inbox?.source_id ?? payload.source_id ?? null,
    senderName: payload.sender?.name ?? null,
    messageText: payload.content ?? "",
    messageId: payload.id ?? null,
    attachments: Array.isArray(payload.attachments) ? payload.attachments : [],
  };
}

/**
 * ¿El emisor es un HUMANO (operador/agente del panel de Chatwoot)?
 * AgentBot / Captain::Assistant NO son humanos. Un sender.type="user" con id
 * distinto al bot (CHATWOOT_BOT_SENDER_ID) es señal de que humano tomó el chat.
 */
export function isHumanUserSender(
  sender: { type?: string; id?: number } | undefined,
  botSenderId?: number,
): boolean {
  if (!sender) return false;
  if (sender.type === "user") {
    if (botSenderId && sender.id === botSenderId) return false;
    return true;
  }
  return false;
}

/**
 * Id compuesto persistente para dedup (columna Message.id).
 * El webhook y el processor usan el MISMO id: `cw-{accountId}-{messageId}`.
 */
export function buildMessageId(accountId: number | null | undefined, messageId: number | null | undefined): string {
  return `cw-${accountId ?? 0}-${messageId ?? 0}`;
}

const MIME_EXT_MAP: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "application/pdf": ".pdf",
  "audio/ogg": ".ogg",
  "audio/mpeg": ".mp3",
  "text/plain": ".txt",
  "application/octet-stream": ".bin",
};

/** MIME → extensión (usa la extensión del adjunto como respaldo). */
export function mimeToExtension(mimeType: string, fallbackExt?: string | null): string {
  const normalized = (mimeType ?? "").toLowerCase();
  const fallback = fallbackExt ? `.${String(fallbackExt).replace(/^\./, "")}` : "";
  // application/octet-stream: mejor usar la extensión real del adjunto si viene.
  if (normalized === "application/octet-stream") return fallback || ".bin";
  const byMime = MIME_EXT_MAP[normalized];
  return byMime || fallback || ".bin";
}

/**
 * Genera el nombre de archivo para /data/uploads con el mismo naming que
 * downloadAndSaveMedia de Meta: `<timestamp>_<uuid>.ext`.
 */
export function buildAttachmentFilename(
  mimeType: string,
  fallbackExt?: string | null,
  options: { now?: number; uuid?: string } = {},
): string {
  const now = options.now ?? Date.now();
  const uuid = options.uuid ?? crypto.randomUUID();
  return `${now}_${uuid}${mimeToExtension(mimeType, fallbackExt)}`;
}

/** Ruta completa de almacenamiento (función pura, testeable). */
export function buildStoragePath(mimeType: string, fallbackExt?: string | null): string {
  return `/data/uploads/${buildAttachmentFilename(mimeType, fallbackExt)}`;
}

// ── Persistencia del mapeo ──────────────────────────────────

export interface UpsertMappingInput {
  phone: string;
  chatwootConversationId?: number | null;
  chatwootContactId?: number | null;
  chatwootInboxId?: number | null;
  chatwootAccountId?: number | null;
  chatwootSourceId?: string | null;
}

/** Graba/actualiza el mapeo Chatwoot en la fila Conversation del teléfono. */
export async function upsertMapping(input: UpsertMappingInput): Promise<void> {
  await prisma.conversation.upsert({
    where: { phone: input.phone },
    update: {
      chatwootConversationId: input.chatwootConversationId ?? undefined,
      chatwootContactId: input.chatwootContactId ?? undefined,
      chatwootInboxId: input.chatwootInboxId ?? undefined,
      chatwootAccountId: input.chatwootAccountId ?? undefined,
      chatwootSourceId: input.chatwootSourceId ?? undefined,
    },
    create: {
      phone: input.phone,
      chatwootConversationId: input.chatwootConversationId ?? undefined,
      chatwootContactId: input.chatwootContactId ?? undefined,
      chatwootInboxId: input.chatwootInboxId ?? undefined,
      chatwootAccountId: input.chatwootAccountId ?? undefined,
      chatwootSourceId: input.chatwootSourceId ?? undefined,
    },
  });
}

/**
 * Resuelve (o crea) la conversación de Chatwoot para un teléfono.
 * 1. Mapping en BD → devolver.
 * 2. searchContact (búsqueda primero; el upsert "crear o devolver" NO está
 *    documentado → RIEGO conocido).
 * 3. createContact si no existe. 4. createConversation. 5. Persistir mapping.
 */
export async function getOrCreateConversation(
  phone: string,
  name?: string,
): Promise<{ conversationId: number; contactId: number }> {
  const existing = await prisma.conversation.findUnique({ where: { phone } });
  if (existing?.chatwootConversationId && existing.chatwootContactId) {
    return {
      conversationId: existing.chatwootConversationId,
      contactId: existing.chatwootContactId,
    };
  }

  const contacts = await searchContactByPhone(phone);
  const match = contacts.find((c) => normalizePhone(c.phone_number ?? "") === phone) ?? contacts[0];
  let contactId = match?.id;
  let contact = match;

  if (!contactId) {
    contact = await createContact({
      name: name ?? phone,
      phoneNumber: phone,
      inboxId: env.chatwoot.inboxId,
    });
    contactId = contact.id;
  }

  const sourceId = contact?.contact_inboxes?.find((ci) => ci.source_id)?.source_id ?? phone;
  const conversation = await createConversation({
    sourceId,
    inboxId: env.chatwoot.inboxId,
    contactId,
  });

  await upsertMapping({
    phone,
    chatwootConversationId: conversation.id,
    chatwootContactId: contactId,
    chatwootInboxId: env.chatwoot.inboxId,
    chatwootAccountId: env.chatwoot.accountId,
    chatwootSourceId: sourceId,
  });

  return { conversationId: conversation.id, contactId };
}