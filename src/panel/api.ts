import { Router, Request, Response, NextFunction } from "express";
import { ComplaintType } from "@prisma/client";
import { env } from "../config/env";
import {
  cancelReservationFromTicket,
  closeTicket,
  confirmReservationFromTicket,
  getTicket,
  listTickets,
  replyToUser,
} from "../modules/tickets/service";
import { prisma } from "../db/client";

export const panelRouter = Router();

function isAuthed(req: Request): boolean {
  const header = req.headers.authorization ?? "";
  if (header.startsWith("Bearer ")) {
    return header.slice(7) === env.admin.token;
  }
  if (header.startsWith("Basic ")) {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf-8");
    const [u, p] = decoded.split(":");
    return u === env.admin.username && p === env.admin.password;
  }
  return false;
}

function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!isAuthed(req)) {
    res.status(401).json({ error: "No autorizado" });
    return;
  }
  next();
}

panelRouter.post("/api/login", (req: Request, res: Response) => {
  if (!isAuthed(req)) {
    res.status(401).json({ error: "Credenciales inválidas" });
    return;
  }
  res.json({ token: env.admin.token });
});

panelRouter.get("/api/stats", requireAuth, async (_req: Request, res: Response) => {
  const [pending, open, closed] = await Promise.all([
    prisma.ticket.count({ where: { status: "PENDING" } }),
    prisma.ticket.count({ where: { status: "OPEN" } }),
    prisma.ticket.count({ where: { status: "CLOSED" } }),
  ]);
  res.json({ pending, open, closed });
});

panelRouter.get("/api/tickets", requireAuth, async (req: Request, res: Response) => {
  const status = (req.query.status as string | undefined) as any;
  const tickets = await listTickets(status);
  res.json(tickets);
});

panelRouter.get("/api/tickets/:id", requireAuth, async (req: Request, res: Response) => {
  const ticket = await getTicket(Number(req.params.id));
  if (!ticket) {
    res.status(404).json({ error: "Ticket no encontrado" });
    return;
  }
  res.json(ticket);
});

panelRouter.get("/api/messages/:phone", requireAuth, async (req: Request, res: Response) => {
  const phone = req.params.phone;
  const messages = await prisma.message.findMany({
    where: { phone },
    orderBy: { createdAt: "asc" },
    take: 200,
  });
  res.json(messages);
});

panelRouter.get("/api/conversations", requireAuth, async (_req: Request, res: Response) => {
  const messages = await prisma.message.findMany({
    orderBy: { createdAt: "asc" },
    take: 5000,
  });

  const byPhone = new Map<string, { count: number; last?: { text: string | null; direction: string; createdAt: Date } }>();
  for (const m of messages) {
    const entry = byPhone.get(m.phone) ?? { count: 0 };
    entry.count += 1;
    entry.last = { text: m.text, direction: m.direction, createdAt: m.createdAt };
    byPhone.set(m.phone, entry);
  }

  const phones = [...byPhone.keys()];
  const clients = await prisma.client.findMany({ where: { phone: { in: phones } } });
  const clientName = new Map(clients.map((c) => [c.phone, c.name]));

  const tickets = await prisma.ticket.findMany({
    where: { phone: { in: phones }, status: { in: ["PENDING", "OPEN"] } },
    orderBy: { createdAt: "asc" },
    include: { reservation: { include: { category: true } } },
  });
  const ticketByPhone = new Map<string, (typeof tickets)[number]>();
  for (const t of tickets) {
    if (!ticketByPhone.has(t.phone)) ticketByPhone.set(t.phone, t);
  }

  const conversations = phones
    .map((phone) => {
      const data = byPhone.get(phone)!;
      return {
        phone,
        name: clientName.get(phone) || null,
        messageCount: data.count,
        last: data.last ? { text: data.last.text, direction: data.last.direction, createdAt: data.last.createdAt } : null,
        ticket: ticketByPhone.get(phone)
          ? {
              id: ticketByPhone.get(phone)!.id,
              reason: ticketByPhone.get(phone)!.reason,
              status: ticketByPhone.get(phone)!.status,
              summary: ticketByPhone.get(phone)!.summary,
              reservation: ticketByPhone.get(phone)!.reservation
                ? {
                    id: ticketByPhone.get(phone)!.reservation!.id,
                    category: ticketByPhone.get(phone)!.reservation!.category.code,
                    activity: ticketByPhone.get(phone)!.reservation!.activity,
                    circuit: ticketByPhone.get(phone)!.reservation!.circuit,
                    date: ticketByPhone.get(phone)!.reservation!.date,
                    startTime: ticketByPhone.get(phone)!.reservation!.startTime,
                    endTime: ticketByPhone.get(phone)!.reservation!.endTime,
                    price: ticketByPhone.get(phone)!.reservation!.price,
                    status: ticketByPhone.get(phone)!.reservation!.status,
                  }
                : null,
            }
          : null,
      };
    })
    .sort((a, b) => new Date(b.last?.createdAt ?? 0).getTime() - new Date(a.last?.createdAt ?? 0).getTime());

  res.json(conversations);
});

panelRouter.post("/api/conversations/:phone/reply", requireAuth, async (req: Request, res: Response) => {
  const text = String(req.body?.text ?? "").trim();
  if (!text) {
    res.status(400).json({ error: "El mensaje no puede estar vacío" });
    return;
  }
  try {
    const { sendText } = await import("../modules/whatsapp/client");
    const { logOutgoing } = await import("../modules/messages/service");
    await sendText(req.params.phone, text);
    await logOutgoing(req.params.phone, text);
    await prisma.validationRecord.create({
      data: { action: "REPLY", phone: req.params.phone, note: text.slice(0, 200) },
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: "No se pudo enviar por WhatsApp: " + (err instanceof Error ? err.message : "Error") });
  }
});

panelRouter.post("/api/tickets/:id/open", requireAuth, async (req: Request, res: Response) => {
  const ticket = await prisma.ticket.update({
    where: { id: Number(req.params.id) },
    data: { status: "OPEN" },
  });
  res.json(ticket);
});

panelRouter.post("/api/tickets/:id/confirm", requireAuth, async (req: Request, res: Response) => {
  try {
    const ticket = await confirmReservationFromTicket(Number(req.params.id), req.body?.note);
    res.json({ ok: true, ticket });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : "Error" });
  }
});

panelRouter.post("/api/tickets/:id/cancel", requireAuth, async (req: Request, res: Response) => {
  try {
    const ticket = await cancelReservationFromTicket(Number(req.params.id), req.body?.note);
    res.json({ ok: true, ticket });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : "Error" });
  }
});

panelRouter.post("/api/tickets/:id/reply", requireAuth, async (req: Request, res: Response) => {
  const text = String(req.body?.text ?? "").trim();
  if (!text) {
    res.status(400).json({ error: "El mensaje no puede estar vacío" });
    return;
  }
  const ticket = await replyToUser(Number(req.params.id), text);
  res.json({ ok: true, ticket });
});

panelRouter.post("/api/tickets/:id/close", requireAuth, async (req: Request, res: Response) => {
  const ticket = await closeTicket(Number(req.params.id), req.body?.note);
  res.json({ ok: true, ticket });
});

panelRouter.get("/api/validations", requireAuth, async (req: Request, res: Response) => {
  const limit = Math.min(Number(req.query.limit ?? 100), 500);
  const records = await prisma.validationRecord.findMany({
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  res.json(records);
});

panelRouter.get("/api/complaints", requireAuth, async (req: Request, res: Response) => {
  const status = (req.query.status as string | undefined) ?? undefined;
  const complaints = await prisma.complaint.findMany({
    where: status ? { status: status as any } : undefined,
    orderBy: { createdAt: "desc" },
    include: { ticket: true },
  });
  res.json(complaints);
});

panelRouter.post("/api/complaints", requireAuth, async (req: Request, res: Response) => {
  const phone = String(req.body?.phone ?? "").trim();
  const description = String(req.body?.description ?? "").trim();
  if (!phone || !description) {
    res.status(400).json({ error: "Faltan el teléfono y la descripción del reclamo" });
    return;
  }
  const typeRaw = String(req.body?.type ?? "reclamo").toLowerCase();
  const type: ComplaintType = typeRaw.includes("queja")
    ? "QUEJA"
    : typeRaw.includes("sugerencia")
      ? "SUGERENCIA"
      : "RECLAMO";
  const complaint = await prisma.complaint.create({
    data: {
      phone,
      type,
      description,
      expectedSolution: req.body?.expectedSolution ? String(req.body.expectedSolution) : null,
      status: "PENDING",
    },
  });
  res.json({ ok: true, complaint });
});

panelRouter.post("/api/complaints/:id/resolve", requireAuth, async (req: Request, res: Response) => {
  const complaint = await prisma.complaint.update({
    where: { id: Number(req.params.id) },
    data: { status: "RESOLVED", resolutionNote: req.body?.note ?? null, closedAt: new Date() },
  });
  await prisma.validationRecord.create({
    data: { action: "RESOLVE", phone: complaint.phone, note: req.body?.note ?? null, ticketId: complaint.ticketId ?? undefined },
  });
  res.json({ ok: true, complaint });
});

panelRouter.post("/api/complaints/:id/close", requireAuth, async (req: Request, res: Response) => {
  const complaint = await prisma.complaint.update({
    where: { id: Number(req.params.id) },
    data: { status: "CLOSED", resolutionNote: req.body?.note ?? undefined, closedAt: new Date() },
  });
  await prisma.validationRecord.create({
    data: { action: "CLOSE", phone: complaint.phone, note: req.body?.note ?? null, ticketId: complaint.ticketId ?? undefined },
  });
  res.json({ ok: true, complaint });
});
