import { prisma } from "../../db/client";

export async function logIncoming(webhookId: string, phone: string, text?: string, mediaType?: string): Promise<boolean> {
  try {
    await prisma.message.create({
      data: { id: webhookId, phone, direction: "IN", text, mediaType },
    });
    return true;
  } catch (e) {
    // Mensaje duplicado (id ya existente) u otro error de log: no debe romper el flujo
    console.warn("[messages] no se pudo registrar mensaje entrante:", e instanceof Error ? e.message : e);
    return false;
  }
}

export async function logOutgoing(phone: string, text?: string) {
  await prisma.message.create({
    data: { id: crypto.randomUUID(), phone, direction: "OUT", text },
  });
}

export async function getContext(phone: string, limit = 20) {
  const messages = await prisma.message.findMany({
    where: { phone },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  return messages
    .reverse()
    .map((m) => `${m.direction === "IN" ? "Usuario" : "Conducar"}: ${m.text ?? `[${m.mediaType ?? "archivo"}]`}`);
}
