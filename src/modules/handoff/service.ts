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
