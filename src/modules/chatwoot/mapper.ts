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

/**
 * `changed_attributes` REAL de Chatwoot v4.17.1: es un ARRAY de objetos por
 * atributo (`[{ "assignee_id": { "previous_value": X, "current_value": Y } }]`).
 * Se tolera también el formato Record (legacy) de versiones anteriores.
 */
export type ChatwootChangedAttributes =
  | Array<Record<string, unknown>>
  | Record<string, unknown>;

export interface ChatwootMessagePayload {
  event?: string;
  id?: number;
  content?: string;
  message_type?: string;
  private?: boolean;
  source_id?: string | null;
  content_type?: string | null;
  content_attributes?: Record<string, unknown>;
  /** `status` a nivel raíz en eventos de conversación (v4.17.1). */
  status?: string;
  /** ARRAY (o Record legacy) con los atributos cambiados vs. Chatwoot. */
  changed_attributes?: ChatwootChangedAttributes;
  /** `contact_inbox` a nivel raíz en eventos de conversación (v4.17.1). */
  contact_inbox?: { id?: number; contact_id?: number; inbox_id?: number; source_id?: string };
  /** `meta` a nivel raíz en eventos de conversación (v4.17.1). */
  meta?: {
    sender?: {
      id?: number;
      name?: string;
      type?: string;
      phone_number?: string;
    };
    assignee?: { id?: number; name?: string };
  };
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
 *   1. conversation.contact_inbox.source_id (wa_id en WhatsApp) — message_created.
 *   2. contact_inbox.source_id a nivel raíz — eventos de conversación (v4.17.1).
 *   3. sender.phone_number — message_created.
 *   4. meta.sender.phone_number a nivel raíz — eventos de conversación (v4.17.1).
 *   5. null → log + mapeo por inbox_id+source_id (REQUIERE FASE POSTERIOR si
 *      la transición BSUID de 2026 cambia el formato).
 */
export function extractPhoneFromPayload(payload: ChatwootMessagePayload): string | null {
  const nestedSourceId = payload.conversation?.contact_inbox?.source_id;
  if (typeof nestedSourceId === "string" && looksLikePhone(nestedSourceId)) {
    return normalizePhone(nestedSourceId);
  }
  const rootSourceId = payload.contact_inbox?.source_id;
  if (typeof rootSourceId === "string" && looksLikePhone(rootSourceId)) {
    return normalizePhone(rootSourceId);
  }
  const senderPhone = payload.sender?.phone_number;
  if (typeof senderPhone === "string" && looksLikePhone(senderPhone)) {
    return normalizePhone(senderPhone);
  }
  const metaPhone = payload.meta?.sender?.phone_number;
  if (typeof metaPhone === "string" && looksLikePhone(metaPhone)) {
    return normalizePhone(metaPhone);
  }
  return null;
}

/** Identidad del contacto en Chatwoot, independiente del teléfono. */
export interface ContactIdentity {
  contactId: number | null;
  conversationId: number | null;
  sourceId: string | null;
  phone: string | null;
}

/**
 * Resuelve la identidad del contacto en Chatwoot de forma independiente al teléfono.
 * Un contacto válido puede existir sin teléfono (ej. BSUID, contactos sin wa_id).
 */
export function resolveContactIdentity(payload: ChatwootMessagePayload): ContactIdentity {
  return {
    contactId:
      payload.conversation?.contact_inbox?.contact_id ??
      payload.contact_inbox?.contact_id ??
      null,
    conversationId: payload.conversation?.id ?? null,
    sourceId:
      payload.conversation?.contact_inbox?.source_id ??
      payload.contact_inbox?.source_id ??
      payload.source_id ??
      null,
    phone: extractPhoneFromPayload(payload),
  };
}

/**
 * ¿El payload tiene evidencia fuerte de que el emisor es un Contacto válido de Chatwoot?
 * NO requiere teléfono: un contacto puede existir sin wa_id (BSUID, contactos sin número).
 *
 * Evidencia fuerte (cualquiera de estas):
 * 1. contact_inbox.contact_id existe (Contact creado en Chatwoot)
 * 2. sender.phone_number existe (teléfono disponible)
 * 3. source_id parece teléfono (wa_id numérico)
 * 4. sender.id es un número positivo (Contact ID válido)
 */
export function hasContactEvidence(payload: ChatwootMessagePayload): boolean {
  // 1. contact_inbox con contact_id = evidencia fuerte
  if (payload.conversation?.contact_inbox?.contact_id) return true;
  if (payload.contact_inbox?.contact_id) return true;
  // 2. sender.phone_number = evidencia de teléfono
  if (payload.sender?.phone_number) return true;
  // 3. source_id que parece teléfono
  const sourceId =
    payload.conversation?.contact_inbox?.source_id ?? payload.contact_inbox?.source_id;
  if (sourceId && looksLikePhone(sourceId)) return true;
  // 4. sender.id como Contact ID válido (payload real: SENDER_ID_OBJECT=9)
  if (typeof payload.sender?.id === "number" && payload.sender.id > 0) return true;
  return false;
}

/** Extrae TODA la información relevante de un payload message_created. */
export function extractFromPayload(payload: ChatwootMessagePayload): ExtractedPayload {
  const identity = resolveContactIdentity(payload);
  return {
    phone: identity.phone,
    chatwootConversationId: identity.conversationId,
    chatwootContactId: identity.contactId,
    chatwootInboxId: payload.conversation?.inbox_id ?? payload.inbox?.id ?? null,
    chatwootAccountId: payload.account?.id ?? null,
    sourceId: identity.sourceId,
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

/**
 * Allowlist de MIME CONFIABLES para servir/almacenar tal cual (F6): el
 * content-type del servidor remoto fuera de esta lista NO se acepta sin sniff.
 * Compartida entre processor (almacenado) y panel (Content-Disposition inline).
 */
export const TRUSTED_MIME_ALLOWLIST: ReadonlySet<string> = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "application/pdf",
]);

/** MIME → extensión (usa la extensión del adjunto como respaldo). */
export function mimeToExtension(mimeType: string, fallbackExt?: string | null): string {
  const normalized = (mimeType ?? "").toLowerCase();
  // El fallback SIEMPRE se sanea: solo extensiones alfanuméricas 1-16 chars
  // (F5). Cualquier otra (p.ej. path traversal "../../x") NO se concatena.
  const rawExt = fallbackExt ? String(fallbackExt).replace(/^\./, "") : "";
  const fallback = /^[A-Za-z0-9]{1,16}$/.test(rawExt) ? `.${rawExt}` : "";
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