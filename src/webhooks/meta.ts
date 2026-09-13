import { Router, Request, Response } from "express";
import crypto from "crypto";
import { Prisma } from "@prisma/client";
import { env } from "../config/env";
import { isBotActive } from "../modules/handoff/service";
import {
  askVoucherConfirmation,
  handleVoucherReceived,
  hasPendingReservation,
  requestChange,
} from "../modules/booking/service";
import { detectEscalationTrigger } from "../modules/payments/service";
import { logIncoming, logOutgoing } from "../modules/messages/service";
import { downloadAndSaveMedia, sendText, markAsRead, normalizePhone } from "../modules/whatsapp/client";
import { runAgent } from "../agent/agent";
import { prisma } from "../db/client";

// ──────────────────────────────────────────────
// Helpers para logging estructurado
// ──────────────────────────────────────────────
type ErrorProvider = "OPENAI" | "PRISMA" | "META" | "UNKNOWN";

export function detectProvider(err: any): ErrorProvider {
  const name: string = err?.name ?? "";
  const message: string = err?.message ?? "";
  const code: string = String(err?.code ?? "");

  if (/OpenAI|APIError|RateLimitError|AuthenticationError/i.test(name)) return "OPENAI";
  if (/Prisma|PrismaClient/i.test(name) || /^P/.test(code)) return "PRISMA";
  if (/Meta API|graph\.facebook\.com/i.test(message)) return "META";
  return "UNKNOWN";
}

export function truncate(str: string | undefined, maxLen: number): string {
  if (!str) return "";
  return str.length > maxLen ? str.slice(0, maxLen) + "…" : str;
}

export function safeStack(err: any, maxLines = 3): string {
  const stack: string = err?.stack ?? "";
  if (!stack) return "";
  return stack.split("\n").slice(0, maxLines).join(" | ");
}

export const WELCOME_MESSAGE = `¡Hola! 🚗 Bienvenido al Circuito de Manejo Conducar Ventanilla.

¿En qué te puedo ayudar hoy? Escribe una opción o dinos directamente qué consulta tienes:

1️⃣ Alquiler de vehículo para examen práctico de manejo

2️⃣ Reserva de simulacro de examen de manejo

3️⃣ Reservar práctica de manejo

4️⃣ Información de paquetes todo incluido

5️⃣ Horarios de atención y presentación`;

export const metaRouter = Router();

// ──────────────────────────────────────────────
// GET  /webhook/meta  → verificación del webhook
// ──────────────────────────────────────────────
metaRouter.get(env.webhookPath, (req: Request, res: Response) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === env.meta.verifyToken) {
    console.log("[meta-webhook] Verificación exitosa");
    res.status(200).send(challenge);
    return;
  }

  console.warn("[meta-webhook] Verificación fallida", { mode, token });
  res.sendStatus(403);
});

// ──────────────────────────────────────────────
// POST /webhook/meta  → recepción de mensajes
// ──────────────────────────────────────────────
metaRouter.post(
  env.webhookPath,
  // express.raw permite obtener el buffer crudo para verificar HMAC-SHA256
  (req: Request, res: Response) => {
    // Verificar firma HMAC-SHA256
    const signature = req.headers["x-hub-signature-256"] as string | undefined;
    const rawBody = (req as any).rawBody as Buffer | undefined;

    if (signature && rawBody && env.meta.appSecret) {
      const expectedSig =
        "sha256=" + crypto.createHmac("sha256", env.meta.appSecret).update(rawBody).digest("hex");
      if (signature !== expectedSig) {
        console.warn("[meta-webhook] Firma HMAC inválida");
        res.sendStatus(403);
        return;
      }
    }

    // Respondemos 200 de inmediato para evitar reintentos de Meta.
    res.status(200).json({ received: true });

    const body = req.body ?? {};
    void processWebhookEvent(body).catch((err) => {
      console.error("[meta-webhook] error procesando evento:", err);
    });
  },
);

// ──────────────────────────────────────────────
// Procesamiento del evento
// ──────────────────────────────────────────────
interface MetaMessage {
  from: string;
  id: string;
  timestamp: string;
  type: string;
  text?: { body: string };
  image?: { id: string; mime_type: string; sha256: string; caption?: string };
  audio?: { id: string; mime_type: string };
  document?: { id: string; mime_type: string; filename: string; caption?: string };
  video?: { id: string; mime_type: string; sha256: string; caption?: string };
  sticker?: { id: string; mime_type: string; sha256: string };
  reaction?: { message_id: string; emoji: string };
}

interface MetaWebhookPayload {
  object: string;
  entry: {
    id: string;
    time: number;
    changes: {
      value: {
        messaging_product: string;
        metadata: { display_phone_number: string; phone_number_id: string };
        contacts?: { profile: { name: string }; wa_id: string }[];
        messages?: MetaMessage[];
        statuses?: { id: string; status: string; timestamp: string; recipient_id: string }[];
      };
      field: string;
    }[];
  }[];
}

async function processWebhookEvent(body: MetaWebhookPayload): Promise<void> {
  if (body.object !== "whatsapp_business_account") return;

  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== "messages") continue;

      const value = change.value;
      const messages = value.messages ?? [];

      for (const msg of messages) {
        await processMessage(msg, value.contacts);
      }
    }
  }
}

async function processMessage(
  msg: MetaMessage,
  contacts?: { profile: { name: string }; wa_id: string }[],
): Promise<void> {
  // Verificar que el mensaje tenga un remitente válido
  if (!msg.from) {
    console.log("[meta-webhook] Mensaje sin remitente, ignorando:", msg.type);
    return;
  }

  const phone = normalizePhone(msg.from);
  const messageId = msg.id;

  // Manejo de imágenes entrantes — procesar antes que el agente
  if (msg.type === "image") {
    console.log(`[meta-flow] MEDIA_IN_START messageId=${messageId} phone=${phone} type=image`);

    console.log(
      `[meta-flow] MEDIA_IN_META_METADATA messageId=${messageId} phone=${phone}`,
    );

    console.log(
      `[meta-flow] MEDIA_IN_DOWNLOAD_START messageId=${messageId} phone=${phone}`,
    );
    if (!msg.image) {
      console.log("[meta-flow] No image data, skipping...");
      return;
    }
    const {
      mediaIdInterno,
      metaMediaId,
      mimeType,
      fileSize,
      storagePath,
    } = await downloadAndSaveMedia(msg.image.id);
    console.log(
      `[meta-flow] MEDIA_IN_DOWNLOAD_SUCCESS messageId=${messageId} phone=${phone}`,
    );
    console.log(
      `[meta-flow] MEDIA_IN_STORAGE_SUCCESS messageId=${messageId} phone=${phone}`,
    );

    // Guardar Message con nuevos campos en la BD
    try {
      await prisma.message.create({
        data: {
          id: messageId, // Use the WhatsApp message ID as the Prisma ID
          phone,
          mediaId: mediaIdInterno,
          metaMediaId,
          mimeType,
          fileSize,
          storagePath,
          caption: msg.image.caption ?? undefined,
          mediaType: "image",
          direction: "IN",
        },
      });
    } catch (err) {
      // Meta reintenta el mismo webhook ante timeouts/errores de red; si el mensaje ya fue
      // insertado con este id, la violación de unicidad no debe convertirse en un 500 ni
      // reprocesar el mensaje. Cualquier otro error sí se relanza.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        console.log(
          `[meta-flow] MEDIA_IN_DUPLICATE messageId=${messageId} phone=${phone} — webhook reintentado por Meta, mensaje ya procesado; se omite.`,
        );
        return;
      }
      throw err;
    }
    console.log(
      `[meta-flow] MEDIA_IN_DB_SUCCESS messageId=${messageId} phone=${phone}`,
    );

    // Log incoming con caption y mediaType="image"
    await logIncoming(messageId, phone, msg.image.caption ?? undefined, "image");

    // Si hay pending reservation y el mensaje parece comprobante, llamar a handleVoucherReceived
    if (await hasPendingReservation(phone)) {
      const lastOut = await prisma.message.findFirst({
        where: { phone, direction: "OUT" },
        orderBy: { createdAt: "desc" },
      });
      const lastOutText = lastOut?.caption ?? "";
      const pareceComprobante =
        lastOutText.includes("comprobante") ||
        lastOutText.includes("¿Este es el comprobante");

      if (pareceComprobante) {
        await handleVoucherReceived(phone, storagePath, messageId);
      }
    }

console.log(`[meta-flow] MEDIA_IN_END messageId=${messageId} phone=${phone}`);

    return;
  }

  // Marcar como leído de inmediato
  await markAsRead(messageId);

  // Registrar nombre del contacto si viene
  const contactName = contacts?.find((c) => c.wa_id === msg.from)?.profile?.name;
  if (contactName) {
    await prisma.client.upsert({
      where: { phone },
      update: { name: contactName },
      create: { phone, name: contactName },
    });
  }

  // Determinar contenido según tipo de mensaje
  let text = "";
  let mediaType: string | undefined;

  switch (msg.type) {
    case "text":
      text = msg.text?.body ?? "";
      break;
    case "image":
      mediaType = "image";
      break;
    case "audio":
      mediaType = "audio";
      break;
    case "document":
      mediaType = "document";
      break;
    case "video":
      mediaType = "video";
      break;
    case "sticker":
      // Los stickers no son relevantes para el flujo; ignorar
      return;
    case "reaction":
      // Las reacciones no son relevantes para el flujo; ignorar
      return;
    default:
      console.log(`[meta-webhook] Tipo de mensaje no manejado: ${msg.type}`);
      return;
  }

  // Registrar mensaje entrante (dedupe por id)
  const inserted = await logIncoming(messageId, phone, text || undefined, mediaType);
  if (!inserted) return; // duplicado

  const isNewUser = (await prisma.message.count({ where: { phone } })) === 1;

  // Guard: si hay un asesor humano atendiendo, el agente está MUDO.
  const botActive = await isBotActive(phone);
  if (!botActive) {
    console.log(`[handoff] conversación de ${phone} en manos humanas; agente silenciado.`);
    return;
  }

  // Helper: retardo mínimo humano + typing indicator
  const actLikeHuman = async (work: () => Promise<void>) => {
    const minDelayMs = 2000 + Math.floor(Math.random() * 3000);
    const started = Date.now();
    await work();
    const elapsed = Date.now() - started;
    if (elapsed < minDelayMs) {
      await new Promise((r) => setTimeout(r, minDelayMs - elapsed));
    }
  };

  // IMAGEN: puede ser un comprobante de pago.
  if (msg.type === "image") {
    await actLikeHuman(async () => {
      // Primero descargar y guardar el media
      if (!msg.image) {
        console.log("[meta-flow] No image data, skipping...");
        return;
      }
      const {
        mediaIdInterno,
        metaMediaId,
        mimeType,
        fileSize,
        storagePath,
      } = await downloadAndSaveMedia(msg.image.id);

      const lastOut = await prisma.message.findFirst({
        where: { phone, direction: "OUT" },
        orderBy: { createdAt: "desc" },
      });
      const lastOutText = lastOut?.caption ?? "";
      const enFlujoPago =
        lastOutText.includes("comprobante") || lastOutText.includes("¿Este es el comprobante");

      if (enFlujoPago || !(await hasPendingReservation(phone))) {
        await handleVoucherReceived(phone, storagePath, messageId);
      } else {
        await askVoucherConfirmation(phone);
      }
    });
    return;
  }

  if (!text.trim()) return;

  // Confirmación de comprobante: el usuario respondió "sí" a la pregunta de confirmación.
  const lastOut = await prisma.message.findFirst({
    where: { phone, direction: "OUT" },
    orderBy: { createdAt: "desc" },
  });
  const preguntamosComprobante = (lastOut?.caption ?? "").includes("¿Este es el comprobante");
  if (
    preguntamosComprobante &&
    /^(s[ií]|s[ií]\s+(es|ese|esa)|confirmo|claro|dale|adelante|ok|correcto)\b/i.test(text.trim())
  ) {
    await actLikeHuman(async () => {
      const lastImage = await prisma.message.findFirst({
        where: { phone, direction: "IN", mediaType: "image" },
        orderBy: { createdAt: "desc" },
      });
      if (lastImage?.caption) {
        await handleVoucherReceived(phone, lastImage.caption, `conf-${messageId}`);
      } else {
        const msg = "¿Podrías reenviarme la captura de tu comprobante (Yape/Plin)? 📩";
        await sendText(phone, msg);
        await logOutgoing(phone, msg);
      }
    });
    return;
  }

  // Triggers deterministas: siempre a un asesor humano.
  const trigger = detectEscalationTrigger(text);
  if (trigger) {
    await actLikeHuman(async () => {
      await requestChange(phone, trigger, text.slice(0, 500));
    });
    return;
  }

  // Agente conversacional (ChatGPT + herramientas ancladas a BD).
  // 1. INICIO DEL FLUJO
  console.log(
    `[meta-flow] START messageId=${messageId} phone=${phone} type=${msg.type} textLen=${text.length} isNew=${isNewUser}`,
  );

  let currentStage: "RUN_AGENT" | "SEND_TEXT" | "LOG_OUTGOING" | "UNKNOWN" = "UNKNOWN";

  try {
    const startedAt = Date.now();
    const minDelayMs = 2000 + Math.floor(Math.random() * 3000);

    // 2. ANTES DE runAgent
    currentStage = "RUN_AGENT";
    console.log(`[meta-flow] RUN_AGENT_START messageId=${messageId} phone=${phone}`);

    const reply = await runAgent(phone, text, isNewUser, messageId);

    // 3. DESPUÉS DE runAgent EXITOSO
    console.log(`[meta-flow] RUN_AGENT_SUCCESS messageId=${messageId} replyLen=${reply.length}`);

    const elapsed = Date.now() - startedAt;
    if (elapsed < minDelayMs) {
      await new Promise((r) => setTimeout(r, minDelayMs - elapsed));
    }
    const finalReply = isNewUser ? `${WELCOME_MESSAGE}\n\n${reply}` : reply;

    // 5. ANTES DE sendText
    currentStage = "SEND_TEXT";
    console.log(
      `[meta-flow] SEND_TEXT_START messageId=${messageId} phone=${phone} replyLen=${finalReply.length}`,
    );

    await sendText(phone, finalReply);

    // 6. DESPUÉS DE sendText EXITOSO
    console.log(`[meta-flow] SEND_TEXT_SUCCESS messageId=${messageId} phone=${phone}`);

    // 8. ANTES DE logOutgoing
    currentStage = "LOG_OUTGOING";
    console.log(`[meta-flow] LOG_OUTGOING_START messageId=${messageId} phone=${phone}`);

    await logOutgoing(phone, finalReply);

    // 9. DESPUÉS DE logOutgoing EXITOSO
    console.log(`[meta-flow] LOG_OUTGOING_SUCCESS messageId=${messageId}`);
  } catch (err: any) {
    const provider = detectProvider(err);
    const errStack = safeStack(err);

    // 4/7/10. ERROR SEGÚN ETAPA
    if (currentStage === "RUN_AGENT") {
      console.error(
        `[meta-flow] RUN_AGENT_ERROR messageId=${messageId} phone=${phone} provider=${provider} errorName=${err?.name} errorMessage=${truncate(err?.message, 300)} errorCode=${err?.code} errorStatus=${err?.status} stack=${errStack}`,
      );
    } else if (currentStage === "SEND_TEXT") {
      console.error(
        `[meta-flow] SEND_TEXT_ERROR messageId=${messageId} phone=${phone} provider=${provider} errorName=${err?.name} errorMessage=${truncate(err?.message, 300)} errorCode=${err?.code} errorStatus=${err?.status} stack=${errStack}`,
      );
    } else if (currentStage === "LOG_OUTGOING") {
      console.error(
        `[meta-flow] LOG_OUTGOING_ERROR messageId=${messageId} phone=${phone} provider=${provider} errorName=${err?.name} errorMessage=${truncate(err?.message, 300)} errorCode=${err?.code} stack=${errStack}`,
      );
    }

    // 11. FALLBACK TRIGGERED
    console.error(
      `[meta-flow] FALLBACK_TRIGGERED messageId=${messageId} phone=${phone} failedStage=${currentStage} provider=${provider} errorName=${err?.name} errorMessage=${truncate(err?.message, 300)} errorCode=${err?.code} errorStatus=${err?.status} stack=${errStack}`,
    );

    const fallback =
      "Estoy presentando un problema técnico. Un asesor humano te atenderá en breve.";
    try {
      await sendText(phone, fallback);
      await logOutgoing(phone, fallback, "FALLBACK");
    } catch {
      /* sin red */
    }
  }
}
