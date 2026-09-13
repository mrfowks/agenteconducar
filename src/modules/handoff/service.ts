import { ConversationStatus } from "@prisma/client";
import { prisma } from "../../db/client";

export async function getConversation(phone: string) {
  return prisma.conversation.upsert({
    where: { phone },
    update: {},
    create: { phone },
  });
}

export async function isBotActive(phone: string): Promise<boolean> {
  const conv = await prisma.conversation.findUnique({ where: { phone } });
  return !conv || conv.status === "BOT";
}

export async function setConversationStatus(
  phone: string,
  status: ConversationStatus,
): Promise<void> {
  await prisma.conversation.upsert({
    where: { phone },
    update: { status },
    create: { phone, status },
  });
}

export async function muteBot(phone: string): Promise<void> {
  await setConversationStatus(phone, "HUMAN");
}

export async function releaseBot(phone: string): Promise<void> {
  await setConversationStatus(phone, "BOT");
}

/**
 * Handoff completo: silencia el bot localmente Y asigna la conversación
 * a un agente humano en Chatwoot (si está configurado y el conversationId está disponible).
 */
export async function handoffToHuman(
  phone: string,
  chatwootConversationId?: number | null,
  assigneeId?: number | null,
): Promise<void> {
  // 1. Silenciar bot localmente
  await muteBot(phone);

  // 2. Asignar en Chatwoot si hay datos disponibles
  if (chatwootConversationId && assigneeId) {
    try {
      const { assignConversation } = await import("../chatwoot/client");
      await assignConversation(chatwootConversationId, assigneeId);
      console.log(
        `[handoff] conversación ${chatwootConversationId} asignada a agente ${assigneeId} en Chatwoot`,
      );
    } catch (err) {
      console.error(
        `[handoff] error asignando conversación ${chatwootConversationId} a agente ${assigneeId}:`,
        err instanceof Error ? err.message : err,
      );
      // No lanzar: el mute local ya se hizo, el bot sigue silenciado
    }
  } else {
    console.log(
      `[handoff] mute local aplicado (sin assignment en Chatwoot: convId=${chatwootConversationId}, assigneeId=${assigneeId})`,
    );
  }
}
