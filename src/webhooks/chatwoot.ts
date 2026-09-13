import { Router, Request, Response } from "express";
import { env } from "../config/env";
import { verifyChatwootSignature } from "../modules/chatwoot/signature";
import {
  buildMessageId,
  ChatwootMessagePayload,
  extractPhoneFromPayload,
  isHumanUserSender,
} from "../modules/chatwoot/mapper";
import { processIncomingMessage } from "../modules/chatwoot/processor";
import { muteBot, releaseBot } from "../modules/handoff/service";
import { prisma } from "../db/client";

// ─────────────────────────────────────────────────────────────
// Webhook de Chatwoot (inbox de WhatsApp).
// En producción Chatwoot es el orquestador y Conducar el cerebro:
//   WhatsApp → Meta → Chatwoot → Conducar → Chatwoot → Meta → WhatsApp.
// Si CHATWOOT_ENABLED=false este endpoint responde 404 sin procesar y el
// backend Meta actual (metaRouter) sigue activo intacto (rollback limpio).
// ─────────────────────────────────────────────────────────────

export type MessageFilterResult = { process: true } | { process: false; reason: string };

export interface ChatwootFilterOptions {
  accountId: number;
  inboxId: number;
  botSenderId?: number;
}

/**
 * Filtro puro del payload entrante. Anti-loop: se ignoran outgoing/private/
 * AgentBot/Captain::Assistant/bot sender id. Solo pasan mensajes entrantes de
 * un CONTACTO en la cuenta e inbox configurados.
 */
export function messageFilter(
  payload: ChatwootMessagePayload,
  options: ChatwootFilterOptions,
): MessageFilterResult {
  if (!payload || typeof payload !== "object") {
    return { process: false, reason: "payload_invalido" };
  }
  if (payload.event !== "message_created") {
    return { process: false, reason: "event_no_message_created" };
  }
  if (payload.message_type !== "incoming") {
    return { process: false, reason: "no_incoming" };
  }
  if (payload.private === true) {
    return { process: false, reason: "private" };
  }
  const sender = payload.sender;
  if (!sender) return { process: false, reason: "sin_sender" };
  // El propio bot (configurado en CHATWOOT_BOT_SENDER_ID) se ignora SIEMPRE,
  // incluso aunque su sender.type sea "user" (mensajes de salida generados por
  // integración) o "contact".
  if (options.botSenderId && sender.id === options.botSenderId) {
    return { process: false, reason: "bot_sender_id" };
  }
  if (sender.type === "user") return { process: false, reason: "emisor_usuario_panel" };
  if (sender.type === "AgentBot" || sender.type === "Captain::Assistant") {
    return { process: false, reason: "emisor_bot_no_humano" };
  }
  if (sender.type !== "contact") return { process: false, reason: "emisor_no_contacto" };
  if (payload.account?.id !== options.accountId) {
    return { process: false, reason: "account_incorrecto" };
  }
  if (payload.conversation?.inbox_id !== options.inboxId) {
    return { process: false, reason: "inbox_incorrecto" };
  }
  return { process: true };
}

/**
 * Chatwoot construye `changed_attributes` desde Rails `previous_changes` con el
 * patrón de ARRAY `[valor_anterior, valor_nuevo]`. Esta función acepta AMBOS
 * formatos (número directo o array) y devuelve el VALOR NUEVO (último elemento)
 * cuando es un número; null en otro caso (sin cambio, desasignación, etc.).
 */
export function resolveChangedValue(value: unknown): number | null {
  const last = Array.isArray(value) ? value[value.length - 1] : value;
  return typeof last === "number" ? last : null;
}

/**
 * Extrae el cambio de assignee del formato DOCUMENTADO de Chatwoot v4.17.1:
 * `changed_attributes` es un ARRAY de objetos por atributo:
 *   [{ "assignee_id": { "previous_value": X, "current_value": Y } }]
 * Devuelve `{ previous_value?, current_value? }` o `undefined` si no hay cambio
 * de assignee (p.ej. el array solo contiene otros atributos).
 *
 * Tolerancias legacy (se conservan sin romper el caso documentado):
 *   - `[{ assignee_id: 88 }]` (número directo) → `{ current_value: 88 }`.
 *   - `{ assignee_id: [previo, nuevo] }` (Record) → `{ current_value: último }`.
 */
export function extractAssigneeChange(
  changedAttributes: unknown,
): { previous_value?: unknown; current_value?: unknown } | undefined {
  const entries = Array.isArray(changedAttributes) ? changedAttributes : [changedAttributes];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const assigneeId = (entry as Record<string, unknown>).assignee_id;
    if (assigneeId === undefined) continue;
    return parseAssigneeChange(assigneeId);
  }
  return undefined;
}

function parseAssigneeChange(
  value: unknown,
): { previous_value?: unknown; current_value?: unknown } | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as { previous_value?: unknown; current_value?: unknown };
    if ("current_value" in obj) {
      return { previous_value: obj.previous_value, current_value: obj.current_value };
    }
    return undefined;
  }
  if (Array.isArray(value)) {
    // Legacy [previo, nuevo] → current_value = último elemento.
    return { previous_value: value[0], current_value: value[value.length - 1] };
  }
  if (typeof value === "number") {
    return { current_value: value };
  }
  return undefined;
}

export interface HandoffEventHandlers {
  muteBot: (phone: string) => Promise<void>;
  releaseBot: (phone: string) => Promise<void>;
}

/**
 * Procesa los eventos de CONVERSACIÓN de Chatwoot v4.17.1 con side-effects
 * inyectables (testeable sin HTTP ni BD):
 *   - conversation_status_changed: `status` a nivel RAÍZ. `resolved` →
 *     releaseBot; "open"/otros → NO se libera (solo log).
 *   - conversation_updated: `changed_attributes` como ARRAY.
 *     current_value numérico (humano asignado) → muteBot;
 *     current_value === null (desasignación) → releaseBot.
 * El teléfono sale de extractPhoneFromPayload (raíz: contact_inbox.source_id /
 * meta.sender.phone_number; anidados legacy).
 */
export async function handleConversationEvent(
  payload: ChatwootMessagePayload,
  handlers: HandoffEventHandlers,
): Promise<void> {
  if (payload.event === "conversation_status_changed") {
    const status = payload.status ?? payload.conversation?.status;
    if (status === "resolved") {
      const phone = extractPhoneFromPayload(payload);
      if (phone) {
        await handlers.releaseBot(phone);
        console.log(`[chatwoot-webhook] conversación resuelta → bot liberado (${phone})`);
      } else {
        console.warn("[chatwoot-webhook] conversación resuelta sin teléfono; no se libera el bot");
      }
      return;
    }
    console.log(
      `[chatwoot-webhook] conversation_status_changed status="${status ?? "desconocido"}"; no se libera el bot`,
    );
    return;
  }

  if (payload.event === "conversation_updated") {
    const change = extractAssigneeChange(payload.changed_attributes);
    const phone = extractPhoneFromPayload(payload);
    if (!phone) {
      console.warn("[chatwoot-webhook] conversation_updated sin teléfono; no mute ni release");
      return;
    }
    if (change !== undefined && typeof change.current_value === "number") {
      await handlers.muteBot(phone);
      console.log(`[chatwoot-webhook] assignee humano en conversation_updated → bot mudo (${phone})`);
      return;
    }
    if (change !== undefined && change.current_value === null) {
      await handlers.releaseBot(phone);
      console.log(`[chatwoot-webhook] desasignación en conversation_updated → bot liberado (${phone})`);
      return;
    }
    console.log("[chatwoot-webhook] conversation_updated sin cambio de assignee relevante; no mute ni release");
  }
}

/**
 * ¿Un `message_created` de Chatwoot implica que un USUARIO HUMANO tomó el chat
 * (handoff → muteBot)?
 *
 * PROTECCIÓN ANTI-SELF-MUTE: los mensajes que el BOT genera vía la API de
 * Chatwoot llegan como `message_type="outgoing"` con `sender.type="user"`
 * (el token de API de Conducar suele pertenecer a un usuario tipo "user").
 * Un mensaje así NUNCA debe mutear al bot, con o sin CHATWOOT_BOT_SENDER_ID
 * (ese id es solo un backstop adicional). Por eso los filtros de cliente
 * (incoming, no private, account/inbox) se evalúan ANTES que el sender.
 *   - outgoing + sender.user → false (jamás mutea al bot).
 *   - incoming + sender.user → true (humano respondiendo → handoff).
 *   - private=true → false (notas internas).
 */
export function shouldMuteOnMessage(
  payload: ChatwootMessagePayload,
  options: ChatwootFilterOptions,
): boolean {
  if (!payload || typeof payload !== "object") return false;
  if (payload.event !== "message_created") return false;
  if (payload.message_type !== "incoming") return false;
  if (payload.private === true) return false;
  // Mismo criterio de cuenta/inbox que messageFilter: solo se evalúa handoff
  // si el mensaje pertenece a la cuenta e inbox configurados.
  if (payload.account?.id !== options.accountId) return false;
  if (payload.conversation?.inbox_id !== options.inboxId) return false;
  return isHumanUserSender(payload.sender, options.botSenderId);
}

/**
 * Deduplicación persistente ANTES de responder 200: inserta el Message con id
 * compuesto cw-{accountId}-{messageId}. P2002 / cache en memoria → "duplicate".
 * El persist se puede inyectar para tests.
 */
export class ChatwootDeduper {
  private seen = new Set<string>();

  constructor(
    private persist: (
      key: string,
      phone: string,
      payload: ChatwootMessagePayload,
    ) => Promise<void>,
  ) {}

  async insert(
    key: string,
    phone: string,
    payload: ChatwootMessagePayload,
  ): Promise<"inserted" | "duplicate"> {
    if (this.seen.has(key)) return "duplicate";
    this.seen.add(key);
    try {
      await this.persist(key, phone, payload);
      return "inserted";
    } catch (err) {
      if ((err as { code?: string })?.code === "P2002") return "duplicate";
      // Falla real (no duplicado): liberar la cache y relanzar.
      this.seen.delete(key);
      throw err;
    }
  }

  reset(): void {
    this.seen.clear();
  }
}

export function createDefaultDeduper(): ChatwootDeduper {
  return new ChatwootDeduper(async (key, phone, payload) => {
    await prisma.message.create({
      data: {
        id: key,
        phone,
        direction: "IN",
        caption: payload.content ?? undefined,
        mediaType: payload.content_type ?? undefined,
      },
    });
  });
}

// Serialización del procesamiento por teléfono (evita carreras en el agente).
const phoneLocks = new Map<string, Promise<void>>();
function enqueueForPhone(phone: string, task: () => Promise<void>): void {
  const prev = phoneLocks.get(phone) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(task);
  phoneLocks.set(
    phone,
    next.then(
      () => {},
      (err) => console.error(`[chatwoot-webhook] error en cola de ${phone}:`, err),
    ),
  );
}

export const chatwootRouter = Router();
const deduper = createDefaultDeduper();

chatwootRouter.post("/", async (req: Request, res: Response) => {
  // 1. Si la integración está deshabilitada: 404 sin procesar (rollback).
  if (!env.chatwoot.enabled) {
    console.warn(
      "[chatwoot-webhook] Chatwoot deshabilitado (CHATWOOT_ENABLED=false); 404, no se procesa.",
    );
    res.status(404).json({ error: "Chatwoot deshabilitado" });
    return;
  }

  // 2. Verificar firma X-Chatwoot-Signature (HMAC-SHA256 + timestamp anti-replay).
  const rawBody = (req as any).rawBody as Buffer | undefined;
  const signature = req.headers["x-chatwoot-signature"] as string | undefined;
  const timestamp = req.headers["x-chatwoot-timestamp"] as string | undefined;

  const valid = rawBody
    ? verifyChatwootSignature(rawBody, { signature, timestamp }, env.chatwoot.webhookSecret)
    : false;

  if (!valid) {
    console.warn(
      "[chatwoot-webhook] firma inválida o faltante; rechazando (401).",
      { hasSignature: Boolean(signature), hasTimestamp: Boolean(timestamp) },
    );
    res.status(401).json({ error: "Firma inválida" });
    return;
  }

  const payload = (req.body ?? {}) as ChatwootMessagePayload;

  // 3. Eventos de estado / handoff sin procesar el agente.
  // Estructura REAL de Chatwoot v4.17.1: `status` a nivel raíz (NO
  // conversation.status) y `changed_attributes` como ARRAY
  // `[{ assignee_id: { previous_value, current_value } }]`. El teléfono vive en
  // `contact_inbox.source_id` y `meta.sender.phone_number` (raíz).
  //   - resolved → releaseBot; "open"/otros → NO se libera.
  //   - assignee humano (current_value numérico) → muteBot.
  //   - desasignación (current_value null) → releaseBot.
  if (
    payload.event === "conversation_status_changed" ||
    payload.event === "conversation_updated"
  ) {
    await handleConversationEvent(payload, { muteBot, releaseBot });
    res.status(200).json({ ok: true });
    return;
  }

  // Opciones de filtro usadas tanto para handoff como para el anti-loop.
  const filterOptions: ChatwootFilterOptions = {
    accountId: env.chatwoot.accountId,
    inboxId: env.chatwoot.inboxId,
    botSenderId: env.chatwoot.botSenderId,
  };

  // message_created de un usuario humano del panel → muteBot (handoff).
  // ANTI-SELF-MUTE: este check corre DESPUÉS de los filtros de cliente
  // (incoming, no private, account/inbox) que aplica shouldMuteOnMessage. Un
  // mensaje OUTGOING del propio bot (sender.type="user") NUNCA llega aquí y el
  // bot jamás se mutea a sí mismo, incluso sin CHATWOOT_BOT_SENDER_ID.
  if (payload.event === "message_created" && shouldMuteOnMessage(payload, filterOptions)) {
    const phone = extractPhoneFromPayload(payload);
    if (phone) {
      await muteBot(phone);
      console.log(`[chatwoot-webhook] mensaje de humano (user) → bot mudo (${phone})`);
    }
    res.status(200).json({ ok: true, ignored: "human_message" });
    return;
  }

  // 4. Filtros anti-loop.
  const filter = messageFilter(payload, filterOptions);
  if (!filter.process) {
    console.log(
      `[chatwoot-webhook] evento ignorado (${filter.reason}) messageId=${payload.id ?? "-"} event=${payload.event ?? "-"}`,
    );
    res.status(200).json({ ok: true, ignored: filter.reason });
    return;
  }

  // 5. Teléfono resoluble; si no, 200 sin reprocesar (mapeo BSUID pendiente).
  const phone = extractPhoneFromPayload(payload);
  if (!phone) {
    console.warn(
      `[chatwoot-webhook] mensaje sin teléfono resoluble messageId=${payload.id}; 200 sin reprocesar (REQUIERE FASE POSTERIOR: mapeo por inbox_id+source_id para BSUID)`,
    );
    res.status(200).json({ ok: true, ignored: "sin_telefono" });
    return;
  }

  // 6. Dedup persistente ANTES del 200.
  const dedupKey = buildMessageId(payload.account?.id, payload.id);
  let dedup: "inserted" | "duplicate";
  try {
    dedup = await deduper.insert(dedupKey, phone, payload);
  } catch (err) {
    console.error(
      "[chatwoot-webhook] error al registrar dedup:",
      err instanceof Error ? err.message : err,
    );
    res.status(500).json({ error: "error interno al registrar mensaje" });
    return;
  }

  if (dedup === "duplicate") {
    console.log(`[chatwoot-webhook] duplicado (${dedupKey}) → 200 sin reprocesar`);
    res.status(200).json({ ok: true, duplicate: true });
    return;
  }

  // 7. Responder 200 y procesar en segundo plano (serializado por teléfono).
  res.status(200).json({ ok: true, received: true });
  enqueueForPhone(phone, () => processIncomingMessage(payload));
});