import { prisma } from "../../db/client";

export async function logIncoming(webhookId: string, phone: string, caption?: string, mediaType?: string): Promise<boolean> {
  try {
    // PRIMERO: Verificar si el mensaje ya existe (para evitar duplicados
    // cuando el handler de imagen ya lo guardó)
    const existing = await prisma.message.findFirst({
      where: { id: webhookId, phone },
    });
    if (existing) {
      console.log("[messages] mensaje duplicado (ya insertado por handler de imagen), ignored:");
      return false;
    }

    // NO existía, proceder con el create
    await prisma.message.create({
      data: { id: webhookId, phone, direction: "IN", caption, mediaType },
    });
    return true;
  } catch (e) {
    console.warn("[messages] no se pudo registrar mensaje entrante:", e instanceof Error ? e.message : e);
    return false;
  }
}

export async function logOutgoing(phone: string, caption?: string, source?: string) {
  await prisma.message.create({
    data: { id: crypto.randomUUID(), phone, direction: "OUT", caption, source: source ?? "AI" },
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
    .map((m) => `${m.direction === "IN" ? "Usuario" : "Conducar"}: ${m.caption ?? (m.mediaType ? `<${m.mediaType}>` : `[archivo]`)}`)
}