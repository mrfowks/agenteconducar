import { Router, Request, Response } from "express";
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
import { sendPresence, sendText } from "../modules/whatsapp/client";
import { normalizePhone } from "../modules/whatsapp/client";
import { runAgent } from "../agent/agent";
import { prisma } from "../db/client";

export const evolutionRouter = Router();

const WELCOME_MESSAGE = `¡Hola! 🚗 Bienvenido al Circuito de Manejo Conducar Ventanilla.

¿En qué te puedo ayudar hoy? Escribe una opción o dinos directamente qué consulta tienes:

1️⃣ Reserva de simulacro de examen de manejo

2️⃣ Reservar práctica de manejo

3️⃣ Información de paquetes todo incluido

4️⃣ Horarios de atención

5️⃣ Hablar con un asesor especializado`;

evolutionRouter.post(env.webhookPath, (req: Request, res: Response) => {
  const apiKey = (req.headers.apikey as string) || (req.headers["x-api-key"] as string) || "";
  const validKeys = [env.evolution.apiKey, env.evolution.instanceToken].filter(Boolean);
  if (!validKeys.includes(apiKey)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  // Respondemos 200 de inmediato y procesamos en background (evita reintentos duplicados).
  res.status(200).json({ received: true });

  const body = req.body ?? {};
  void processWebhookEvent(body).catch((err) => {
    console.error("[webhook] error procesando evento:", err);
  });
});

async function processWebhookEvent(body: any): Promise<void> {
  const event = body.event ?? "";
  if (event !== "MESSAGES_UPSERT" && event !== "messages.upsert") {
    return;
  }
  const data = body.data ?? {};
  const key = data.key ?? {};
  if (key.fromMe) return;

  const remoteJid: string = key.remoteJid ?? "";
  if (!remoteJid || remoteJid.includes("@g.us")) return;

  const phone = normalizePhone(remoteJid);
  const messageId: string = key.id ?? `in-${Date.now()}`;

  const conversation = data.message?.conversation;
  const extended = data.message?.extendedTextMessage?.text;
  const text = conversation || extended || "";
  const imageMessage = data.message?.imageMessage;

  // Registramos para auditoría + dedupe de webhooks duplicados.
  // Para imágenes guardamos la URL como texto (permite recuperarla luego de confirmar el comprobante).
  const inserted = await logIncoming(
    messageId,
    phone,
    imageMessage ? (imageMessage.url ?? "") : text || undefined,
    imageMessage ? "image" : undefined,
  );
  if (!inserted) return; // duplicado

  if (data.pushName) {
    await prisma.client.upsert({
      where: { phone },
      update: { name: data.pushName },
      create: { phone, name: data.pushName },
    });
  }

  const isNewUser = (await prisma.message.count({ where: { phone } })) === 1;

  // Guard: si hay un asesor humano atendiendo, el agente está MUDO.
  const botActive = await isBotActive(phone);
  if (!botActive) {
    console.log(`[handoff] conversación de ${phone} en manos humanas; agente silenciado.`);
    return;
  }

  // Presencia "escribiendo…" + retardo mínimo humano para cualquier respuesta directa.
  const actLikeHuman = async (work: () => Promise<void>) => {
    const minDelayMs = 2000 + Math.floor(Math.random() * 3000);
    try {
      await sendPresence(phone, "composing", minDelayMs);
    } catch {
      /* sin indicador de escritura: no debe romper el flujo */
    }
    const started = Date.now();
    await work();
    const elapsed = Date.now() - started;
    if (elapsed < minDelayMs) {
      await new Promise((r) => setTimeout(r, minDelayMs - elapsed));
    }
  };

  // IMAGEN: puede ser un comprobante de pago.
  if (imageMessage) {
    const mediaUrl = imageMessage.url ?? "";
    await actLikeHuman(async () => {
      const lastOut = await prisma.message.findFirst({
        where: { phone, direction: "OUT" },
        orderBy: { createdAt: "desc" },
      });
      const lastOutText = lastOut?.text ?? "";
      const enFlujoPago =
        lastOutText.includes("comprobante") || lastOutText.includes("¿Este es el comprobante");

      if (enFlujoPago || !(await hasPendingReservation(phone))) {
        // Venía de instrucciones de pago (o no hay reserva pendiente): procesar.
        await handleVoucherReceived(phone, mediaUrl, messageId);
      } else {
        // Imagen espontánea con reserva pendiente: pedir confirmación antes de validarla.
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
  const preguntamosComprobante = (lastOut?.text ?? "").includes("¿Este es el comprobante");
  if (
    preguntamosComprobante &&
    /^(s[ií]|s[ií]\s+(es|ese|esa)|confirmo|claro|dale|adelante|ok|correcto)\b/i.test(text.trim())
  ) {
    await actLikeHuman(async () => {
      const lastImage = await prisma.message.findFirst({
        where: { phone, direction: "IN", mediaType: "image" },
        orderBy: { createdAt: "desc" },
      });
      if (lastImage?.text) {
        await handleVoucherReceived(phone, lastImage.text, `conf-${messageId}`);
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
  try {
    const startedAt = Date.now();
    const minDelayMs = 2000 + Math.floor(Math.random() * 3000);
    try {
      await sendPresence(phone, "composing", minDelayMs);
    } catch {
      /* sin indicador de escritura: no debe romper el flujo */
    }

    const reply = await runAgent(phone, text, isNewUser);
    const elapsed = Date.now() - startedAt;
    if (elapsed < minDelayMs) {
      await new Promise((r) => setTimeout(r, minDelayMs - elapsed));
    }
    const finalReply = isNewUser ? `${WELCOME_MESSAGE}\n\n${reply}` : reply;
    await sendText(phone, finalReply);
    await logOutgoing(phone, finalReply);
  } catch (err) {
    console.error("[webhook] error del agente:", err);
    const fallback =
      "Estoy presentando un problema técnico. Un asesor humano te atenderá en breve.";
    try {
      await sendText(phone, fallback);
      await logOutgoing(phone, fallback);
    } catch {
      /* sin red */
    }
  }
}
