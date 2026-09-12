import { env } from "../../config/env";
import { prisma } from "../../db/client";
import { downloadAttachment, sendMediaMessage, sendTextMessage } from "./client";
import { buildAttachmentFilename, getOrCreateConversation } from "./mapper";
import {
  sendImage as metaSendImage,
  sendImageByMetaId,
  sendText as metaSendText,
  uploadImage,
} from "../whatsapp/client";

// ─────────────────────────────────────────────────────────────
// Capa de entrega COMPATIBLE con los llamadores actuales:
//   sendText(phone, text, cwConversationId?)
//   sendImage(phone, mediaUrl|buffer, caption?)
//
// - CHATWOOT_ENABLED=true  → envía por la API de Chatwoot.
// - CHATWOOT_ENABLED=false → delega al cliente Meta existente (rollback limpio,
//   sin duplicar su lógica).
// NO se elimina ni modifica el cliente Meta (whatsapp/client.ts).
// ─────────────────────────────────────────────────────────────

const RECENT_SEND_WINDOW_MS = 30_000;

/** Detecta el MIME desde los primeros bytes del buffer (útil para Buffer sin metadata). */
export function sniffMimeType(buffer: Buffer): string {
  if (!buffer || buffer.length < 4) return "application/octet-stream";
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return "image/png";
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) return "image/gif";
  if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46) return "image/webp";
  if (buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46) return "application/pdf";
  return "application/octet-stream";
}

/**
 * Guard anti-duplicado: si ya se registró un Message OUT con el MISMO caption
 * para este teléfono en los últimos 30 s, se omite el envío. Solo se aplica en
 * el camino Chatwoot (los reintentos de webhook podrían duplicar salidas).
 */
async function wasRecentlySent(phone: string, caption: string): Promise<boolean> {
  if (!caption) return false;
  const since = new Date(Date.now() - RECENT_SEND_WINDOW_MS);
  const last = await prisma.message.findFirst({
    where: { phone, direction: "OUT", caption, createdAt: { gte: since } },
    orderBy: { createdAt: "desc" },
  });
  if (last) {
    console.log(
      `[chatwoot-delivery] envío duplicado omitido: mismo phone+caption en ≤30 s (phone=${phone})`,
    );
    return true;
  }
  return false;
}

/**
 * Envía un mensaje de texto. En modo Chatwoot, cwConversationId (si viene) evita
 * la resolución/creación de conversación. Los errores se loguean y se relanzan
 * para que los llamadores conserven su manejo (panel, QR, fallback del agente).
 */
export async function sendText(
  phone: string,
  text: string,
  cwConversationId?: number,
): Promise<void> {
  if (env.chatwoot.enabled) {
    try {
      if (await wasRecentlySent(phone, text)) return;
      const conversationId =
        cwConversationId ?? (await getOrCreateConversation(phone)).conversationId;
      await sendTextMessage(conversationId, text);
    } catch (err) {
      console.error(
        `[chatwoot-delivery] error enviando texto a ${phone} por Chatwoot:`,
        err instanceof Error ? err.message : err,
      );
      throw err;
    }
    return;
  }

  // Rollback: backend Meta actual tal cual.
  await metaSendText(phone, text);
}

async function resolveMedia(
  media: string | Buffer,
): Promise<{ buffer: Buffer; mimeType: string; filename: string }> {
  if (Buffer.isBuffer(media)) {
    const mimeType = sniffMimeType(media);
    const filename = buildAttachmentFilename(mimeType);
    return { buffer: media, mimeType, filename };
  }
  const res = await fetch(media, { signal: AbortSignal.timeout(env.chatwoot.timeoutMs) });
  if (!res.ok) {
    throw new Error(`No se pudo descargar la imagen para Chatwoot (${media}): HTTP ${res.status}`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  const mimeType = res.headers.get("content-type") ?? sniffMimeType(buffer);
  const filename = buildAttachmentFilename(mimeType);
  return { buffer, mimeType, filename };
}

/**
 * Envía una imagen/media. `media` puede ser una URL o un Buffer.
 * En modo Meta (rollback): URL → sendImage(url); Buffer → uploadImage + sendImageByMetaId
 * (se reutiliza el cliente Meta existente, no se duplica su lógica).
 */
export async function sendImage(
  phone: string,
  media: string | Buffer,
  caption?: string,
): Promise<void> {
  if (env.chatwoot.enabled) {
    try {
      const captionForCheck = caption ?? "";
      if (await wasRecentlySent(phone, captionForCheck)) return;
      const { conversationId } = await getOrCreateConversation(phone);
      const { buffer, mimeType, filename } = await resolveMedia(media);
      await sendMediaMessage(conversationId, { buffer, filename, mimeType, caption });
    } catch (err) {
      console.error(
        `[chatwoot-delivery] error enviando imagen a ${phone} por Chatwoot:`,
        err instanceof Error ? err.message : err,
      );
      throw err;
    }
    return;
  }

  // Rollback: backend Meta actual.
  if (Buffer.isBuffer(media)) {
    const mimeType = sniffMimeType(media);
    const filename = buildAttachmentFilename(mimeType);
    const { metaMediaId } = await uploadImage(media, filename, mimeType);
    await sendImageByMetaId(phone, metaMediaId, caption);
    return;
  }
  await metaSendImage(phone, media, caption ?? "");
}

/** Re-export para facilitar la descarga puntual de adjuntos (procesador). */
export { downloadAttachment };