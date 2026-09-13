import fs from "fs";
import path from "path";
import { env } from "../../config/env";
import { prisma } from "../../db/client";
import { runAgent } from "../../agent/agent";
import {
  askVoucherConfirmation,
  handleVoucherReceived,
  hasPendingReservation,
  requestChange,
} from "../booking/service";
import { detectEscalationTrigger } from "../payments/service";
import { logIncoming, logOutgoing } from "../messages/service";
import { isBotActive } from "../handoff/service";
import {
  buildMessageId,
  buildStoragePath,
  ChatwootAttachment,
  ChatwootMessagePayload,
  extractFromPayload,
  isHumanUserSender,
  TRUSTED_MIME_ALLOWLIST,
  upsertMapping,
} from "./mapper";
import { downloadAttachment } from "./client";
import * as delivery from "./delivery";

// Reutilizamos constantes/helpers ya existentes de meta.ts (NO se duplican).
import { WELCOME_MESSAGE, detectProvider, safeStack, truncate } from "../../webhooks/meta";

const FALLBACK_MESSAGE =
  "Estoy presentando un problema técnico. Un asesor humano te atenderá en breve.";

type Stage = "RUN_AGENT" | "SEND_TEXT" | "LOG_OUTGOING" | "UNKNOWN";

/**
 * Decisión pura del guard de handoff: si el mensaje es de un humano (usuario
 * del panel) el bot NO debe responder, esté o no activo.
 */
export function shouldRespondForBot(
  botActive: boolean,
  sender: { type?: string; id?: number } | undefined,
  botSenderId?: number,
): boolean {
  if (isHumanUserSender(sender, botSenderId)) return false;
  return botActive;
}

function actLikeHuman(work: () => Promise<void>): Promise<void> {
  const minDelayMs = 2000 + Math.floor(Math.random() * 3000);
  const started = Date.now();
  return work().then(async () => {
    const elapsed = Date.now() - started;
    if (elapsed < minDelayMs) {
      await new Promise((r) => setTimeout(r, minDelayMs - elapsed));
    }
  });
}

/** Parsea un data_url (`data:<mime>[;base64],<data>`) a Buffer. */
export function dataUrlToBuffer(
  dataUrl: string,
): { buffer: Buffer; mimeType?: string } {
  const match = /^data:([^;,]*)?(;base64)?,(.*)$/s.exec(dataUrl);
  if (!match) return { buffer: Buffer.from(dataUrl, "base64") };
  const [, mimeType, base64Tag, data] = match;
  return {
    buffer: base64Tag === ";base64" ? Buffer.from(data, "base64") : Buffer.from(data, "utf8"),
    mimeType: mimeType || undefined,
  };
}

// ── Adjuntos (Chatwoot v4.17.1) ──────────────────────────────

/** Tamaño máximo de un adjunto descargado: 10 MB. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export interface ResolvedAttachment {
  buffer: Buffer;
  mimeType: string;
}

export interface ResolveAttachmentDeps {
  /** Inyectable para tests; por defecto el cliente real. */
  downloadAttachment?: (
    fileUrl: string,
    options?: { timeoutMs?: number; maxBytes?: number },
  ) => Promise<{ buffer: Buffer; mimeType: string }>;
}

function enforceAttachmentLimit(attachmentId: number, buffer: Buffer): Buffer {
  if (buffer.length > MAX_ATTACHMENT_BYTES) {
    throw new Error(
      `adjunto ${attachmentId} excede el límite de MAX_ATTACHMENT_BYTES (${MAX_ATTACHMENT_BYTES} bytes; recibidos ${buffer.length}): se rechaza de forma segura`,
    );
  }
  return buffer;
}

/**
 * Resolución VACÍO-AWARE de la URL del adjunto: si `file_url` es string NO vacío
 * (tras trim) se usa; si no, `data_url` si es string NO vacío; si no, `undefined`.
 * Sin esto, un `file_url: ""` anulaba un `data_url` válido.
 */
export function pickAttachmentUrl(attachment: ChatwootAttachment): string | undefined {
  if (typeof attachment.file_url === "string" && attachment.file_url.trim().length > 0) {
    return attachment.file_url;
  }
  if (typeof attachment.data_url === "string" && attachment.data_url.trim().length > 0) {
    return attachment.data_url;
  }
  return undefined;
}

/**
 * Resuelve un adjunto a `{ buffer, mimeType }`:
 *   1. `pickAttachmentUrl` (file_url/data_url vacío-aware) que es una URL
 *      http(s) REAL (Active Storage en Chatwoot v4.17.1, redirect 301, posible
 *      auth vía `api_access_token`) → descarga con `downloadAttachment` (que ya
 *      aplica el tope de tamaño por stream + hardening SSRF) y `enforceAttachmentLimit`
 *      como defensa extra.
 *   2. `data:` URI → `dataUrlToBuffer` (compatibilidad legacy).
 *   3. Cualquier otro formato → warning + `Buffer.alloc(0)` (rechazo seguro,
 *      NUNCA bytes basura).
 */
export async function resolveAttachment(
  attachment: ChatwootAttachment,
  deps: ResolveAttachmentDeps = {},
): Promise<ResolvedAttachment> {
  const doDownload = deps.downloadAttachment ?? downloadAttachment;
  const url = pickAttachmentUrl(attachment);

  if (typeof url === "string" && /^https?:\/\//i.test(url)) {
    const dl = await doDownload(url, { timeoutMs: env.chatwoot.timeoutMs });
    return { buffer: enforceAttachmentLimit(attachment.id, dl.buffer), mimeType: dl.mimeType };
  }

  if (typeof url === "string" && url.startsWith("data:")) {
    const parsed = dataUrlToBuffer(url);
    return {
      buffer: enforceAttachmentLimit(attachment.id, parsed.buffer),
      mimeType: parsed.mimeType ?? attachment.content_type ?? "application/octet-stream",
    };
  }

  console.warn(
    `[chatwoot-proc] adjunto ${attachment.id} sin file_url/data_url http(s) ni data: válida; se omite (rechazo seguro, sin bytes basura)`,
  );
  return { buffer: Buffer.alloc(0), mimeType: "application/octet-stream" };
}

/**
 * MIME efectivo para almacenar (F6): el `content-type` del servidor remoto NO se
 * acepta tal cual salvo que esté en la allowlist confiable
 * (TRUSTED_MIME_ALLOWLIST: image/jpeg|png|gif|webp, application/pdf). Cualquier
 * otro valor cae a `sniffMimeType(buffer)` (detección por primeros bytes,
 * delivery.ts); si el sniff no reconoce → application/octet-stream (se sirve
 * como descarga, nunca como inline).
 */
export function resolveStoredMimeType(dlMimeType: string, buffer: Buffer): string {
  if (dlMimeType && TRUSTED_MIME_ALLOWLIST.has(dlMimeType)) return dlMimeType;
  return delivery.sniffMimeType(buffer);
}

/**
 * Procesa un evento message_created entrante de Chatwoot (contacto).
 * Reutiliza la lógica existente (logIncoming, handoff, booking, pagos, runAgent,
 * fallback) adaptada al payload de Chatwoot. NO duplica la lógica del agente.
 */
export async function processIncomingMessage(payload: ChatwootMessagePayload): Promise<void> {
  const extracted = extractFromPayload(payload);
  const phone = extracted.phone;

  if (!phone) {
    console.warn(
      "[chatwoot-proc] no se pudo resolver teléfono (source_id no E.164 y sin sender.phone_number). " +
        "Mapeo por inbox_id+source_id pendiente — REQUIERE FASE POSTERIOR (transición BSUID).",
      { messageId: extracted.messageId, inboxId: extracted.chatwootInboxId, sourceId: extracted.sourceId },
    );
    return;
  }

  const dedupId = buildMessageId(extracted.chatwootAccountId, extracted.messageId);
  const cwConversationId = extracted.chatwootConversationId ?? undefined;

  console.log(
    `[chatwoot-flow] START messageId=${extracted.messageId} dedupId=${dedupId} phone=${phone} attachments=${extracted.attachments.length}`,
  );

  // 1. Persistir mapeo Chatwoot ↔ teléfono (para envíos futuros de salida).
  try {
    await upsertMapping({
      phone,
      chatwootConversationId: extracted.chatwootConversationId,
      chatwootContactId: extracted.chatwootContactId,
      chatwootInboxId: extracted.chatwootInboxId,
      chatwootAccountId: extracted.chatwootAccountId,
      chatwootSourceId: extracted.sourceId,
    });
  } catch (err) {
    console.warn(
      `[chatwoot-flow] no se pudo persistir mapping de ${phone}:`,
      err instanceof Error ? err.message : err,
    );
  }

  // 2. Registrar nombre del contacto si viene.
  if (extracted.senderName) {
    await prisma.client.upsert({
      where: { phone },
      update: { name: extracted.senderName },
      create: { phone, name: extracted.senderName },
    });
  }

  // 3. Adjuntos: descargar + guardar con el naming `<timestamp>_<uuid>.ext`.
  let firstAttachment: {
    storagePath: string;
    mimeType: string;
    fileSize: number;
  } | null = null;

  if (extracted.attachments.length > 0) {
    const attachment = extracted.attachments[0];
    try {
      const { buffer, mimeType: dlMimeType } = await resolveAttachment(attachment);
      if (buffer.length === 0) {
        console.warn(
          `[chatwoot-proc] adjunto ${attachment.id} rechazado de forma segura (formato inválido/vacío); se omite (messageId=${extracted.messageId})`,
        );
      } else {
        // sniffMimeType como fallback si la descarga no dio content-type
        // específico (application/octet-stream) — cadena ya probada:
        // mimeToExtension + buildAttachmentFilename + buildStoragePath.
        const mimeType = resolveStoredMimeType(dlMimeType, buffer);
        const storagePath = buildStoragePath(mimeType, attachment.extension);
        fs.mkdirSync(path.dirname(storagePath), { recursive: true });
        fs.writeFileSync(storagePath, buffer);
        firstAttachment = { storagePath, mimeType, fileSize: buffer.length };
        console.log(`[chatwoot-flow] MEDIA_IN_STORAGE_SUCCESS messageId=${extracted.messageId} phone=${phone} path=${storagePath}`);
      }
    } catch (err) {
      console.error(
        `[chatwoot-proc] error descargando adjunto ${attachment.id} (messageId=${extracted.messageId}):`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  const mediaType = firstAttachment
    ? firstAttachment.mimeType.startsWith("image/")
      ? "image"
      : firstAttachment.mimeType
    : undefined;

  // 4. logIncoming con id compuesto. El webhook ya deduplicó; este es un safety
  // net (duplicado posible solo si processor se invoca por otra vía).
  const logged = await logIncoming(
    dedupId,
    phone,
    extracted.messageText || undefined,
    mediaType,
  );
  if (!logged) {
    console.log(
      `[chatwoot-proc] mensaje ${dedupId} ya registrado (webhook dedup); se continúa el procesamiento.`,
    );
  }

  // Completar columnas de media en la fila Message si hay adjunto guardado.
  if (firstAttachment) {
    try {
      await prisma.message.update({
        where: { id: dedupId },
        data: {
          mediaId: `cw_${extracted.chatwootAccountId}_${extracted.messageId}`,
          mimeType: firstAttachment.mimeType,
          fileSize: firstAttachment.fileSize,
          storagePath: firstAttachment.storagePath,
          mediaType: mediaType ?? firstAttachment.mimeType,
        },
      });
    } catch (err) {
      console.warn(
        `[chatwoot-proc] no se pudo completar media de ${dedupId}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  // 5. Guard de handoff: si hay un asesor humano atendiendo, el bot está mudo.
  const botActive = await isBotActive(phone);
  if (!shouldRespondForBot(botActive, payload.sender, env.chatwoot.botSenderId)) {
    console.log(`[handoff] conversación de ${phone} en manos humanas; agente silenciado.`);
    return;
  }

  // 6. IMAGEN entrante → flujo de comprobante de pago (reutiliza booking/service).
  if (firstAttachment && mediaType === "image") {
    await actLikeHuman(async () => {
      const lastOut = await prisma.message.findFirst({
        where: { phone, direction: "OUT" },
        orderBy: { createdAt: "desc" },
      });
      const lastOutText = lastOut?.caption ?? "";
      const enFlujoPago =
        lastOutText.includes("comprobante") || lastOutText.includes("¿Este es el comprobante");

      if (enFlujoPago || !(await hasPendingReservation(phone))) {
        await handleVoucherReceived(phone, firstAttachment!.storagePath, dedupId);
      } else {
        await askVoucherConfirmation(phone);
      }
    });
    console.log(`[chatwoot-flow] MEDIA_IN_END messageId=${extracted.messageId} phone=${phone}`);
    return;
  }

  const text = extracted.messageText.trim();
  if (!text) {
    console.log(`[chatwoot-flow] SKIP mensaje sin texto messageId=${extracted.messageId}`);
    return;
  }

  // 7. Confirmación de comprobante: el usuario respondió "sí" a la pregunta.
  const lastOut = await prisma.message.findFirst({
    where: { phone, direction: "OUT" },
    orderBy: { createdAt: "desc" },
  });
  const preguntamosComprobante = (lastOut?.caption ?? "").includes("¿Este es el comprobante");
  if (
    preguntamosComprobante &&
    /^(s[ií]|s[ií]\s+(es|ese|esa)|confirmo|claro|dale|adelante|ok|correcto)\b/i.test(text)
  ) {
    await actLikeHuman(async () => {
      const lastImage = await prisma.message.findFirst({
        where: { phone, direction: "IN", mediaType: "image" },
        orderBy: { createdAt: "desc" },
      });
      if (lastImage?.storagePath) {
        await handleVoucherReceived(phone, lastImage.storagePath, `conf-${dedupId}`);
      } else {
        const msg = "¿Podrías reenviarme la captura de tu comprobante (Yape/Plin)? 📩";
        await delivery.sendText(phone, msg, cwConversationId);
        await logOutgoing(phone, msg);
      }
    });
    return;
  }

  // 8. Triggers deterministas → asesor humano.
  const trigger = detectEscalationTrigger(text);
  if (trigger) {
    await actLikeHuman(async () => {
      await requestChange(phone, trigger, text.slice(0, 500));
    });
    return;
  }

  // 9. Agente conversacional (mismo runAgent que el flujo Meta).
  const isNewUser = (await prisma.message.count({ where: { phone } })) === 1;

  let currentStage: Stage = "UNKNOWN";
  try {
    console.log(
      `[chatwoot-flow] RUN_AGENT_START messageId=${extracted.messageId} phone=${phone} textLen=${text.length} isNew=${isNewUser}`,
    );
    currentStage = "RUN_AGENT";
    const reply = await runAgent(phone, text, isNewUser, dedupId);
    await actLikeHuman(async () => {}); // retardo mínimo humano

    const finalReply = isNewUser ? `${WELCOME_MESSAGE}\n\n${reply}` : reply;

    currentStage = "SEND_TEXT";
    await delivery.sendText(phone, finalReply, cwConversationId);

    currentStage = "LOG_OUTGOING";
    await logOutgoing(phone, finalReply);

    console.log(
      `[chatwoot-flow] DONE messageId=${extracted.messageId} phone=${phone} replyLen=${finalReply.length}`,
    );
  } catch (err: unknown) {
    const provider = detectProvider(err);
    console.error(
      `[chatwoot-flow] FALLBACK_TRIGGERED messageId=${extracted.messageId} phone=${phone} failedStage=${currentStage} provider=${provider} errorName=${(err as Error)?.name} errorMessage=${truncate((err as Error)?.message, 300)} stack=${safeStack(err)}`,
    );
    try {
      await delivery.sendText(phone, FALLBACK_MESSAGE, cwConversationId);
      await logOutgoing(phone, FALLBACK_MESSAGE, "FALLBACK");
    } catch {
      /* sin red */
    }
  }
}