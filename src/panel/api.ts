import { ComplaintType } from "@prisma/client";
import { env } from "../config/env";
import multer from "multer";
import crypto from "crypto";
import { Router, Request, Response, NextFunction } from "express";
import {
  cancelReservationFromTicket,
  closeTicket,
  confirmReservationFromTicket,
  getTicket,
  listTickets,
  replyToUser,
} from "../modules/tickets/service";
import { sendImage as deliverySendImage } from "../modules/chatwoot/delivery";
import { prisma } from "../db/client";

export const panelRouter = Router();

function isAuthed(req: Request): boolean {
  const header = req.headers["authorization"] ?? "";
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

  const byPhone = new Map<string, { count: number; last?: { caption: string | null; direction: string; createdAt: Date; mediaType: string | null } }>();
  for (const m of messages) {
    const entry = byPhone.get(m.phone) ?? { count: 0 };
entry.count += 1;
      entry.last = { caption: m.caption, direction: m.direction, createdAt: m.createdAt, mediaType: m.mediaType };
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
        last: data.last ? { caption: data.last.caption, direction: data.last.direction, createdAt: data.last.createdAt, mediaType: data.last.mediaType } : null,
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
    const { sendText } = await import("../modules/chatwoot/delivery");
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

/**
 * Endpoint para servir archivos locales guardados en /data/uploads/ usando el mediaId interno de la aplicación.
 * El panel usa esto para recuperar imágenes, audio y documentos asociados a los mensajes.
 *
 * Flujo:
 * 1. Validar autenticación (requireAuth)
 * 2. Buscar en la BD Message por mediaId (ID interno, no de Meta)
 * 3. Si no existe el mensaje, retornar 404
 * 4. Si el mensaje no tiene storagePath (mensaje antiguo sin archivo persistido), retornar 404 informativo
 * 5. Leer el archivo desde Message.storagePath (los archivos se guardan como <timestamp>_<uuid>.ext,
 *    ver downloadAndSaveMedia en src/modules/whatsapp/client.ts)
 * 6. Si no existe el archivo, retornar 404 (sin fallback a Meta)
 * 7. Devolver el archivo con Content-Type y Cache-Control adecuados
 */
panelRouter.get("/api/media/:mediaId", requireAuth, async (req: Request, res: Response) => {
  try {
    // 2. Buscar en la BD Message por mediaId (ID interno generado por la app, no el de Meta)
    const message = await prisma.message.findFirst({
      where: { mediaId: req.params.mediaId },
    });

    if (!message) {
      res.status(404).json({ error: "Mensaje no encontrado" });
      return;
    }

    // 4. Usar Message.storagePath: el mediaId interno (p. ej. img_<ts>_<rand>) NO coincide con el
    // nombre del archivo (<timestamp>_<uuid>.ext), por lo que reconstruir la ruta a partir del
    // mediaId no es viable. Los mensajes antiguos sin storagePath no tienen archivo localizable.
    if (!message.storagePath) {
      res.status(404).json({ error: "Mensaje sin archivo almacenado (storagePath no registrado)" });
      return;
    }

    // 5. Determinar el mimeType almacenado en la BD para el Content-Type
    const mimeType = message.mimeType ?? "application/octet-stream";

    // 5b. Leer el archivo desde storagePath usando fs nativo
    const filePath = message.storagePath;
    const fs = require("fs");

    // Verificar que el archivo existe
    if (!fs.existsSync(filePath)) {
      res.status(404).json({ error: "Archivo local no encontrado" });
      return;
    }

    // Leer el archivo binario
    const buffer = fs.readFileSync(filePath);

    // 6. Devolver el archivo con los encabezados apropiados
    res.setHeader("Content-Type", mimeType);
    res.setHeader("Cache-Control", "public, max-age=86400"); // 24 horas
    res.setHeader("Content-Disposition", `inline; filename="${require("path").basename(filePath)}"`);
    res.send(buffer);
  } catch (err) {
    console.error("[panel] Error sirviendo media:", err);
    res.status(500).json({ error: "Error interno al servir el archivo" });
  }
});
 
panelRouter.post("/api/upload-image", requireAuth, async (req: Request, res: Response) => {
  const phone = String(req.body?.phone ?? "").trim();
  const caption = String(req.body?.caption ?? "").trim();

  if (!phone) {
    res.status(400).json({ error: "Falta el teléfono" });
    return;
  }

  // Configurar multer para recibir un solo archivo en memoria
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB máximo
  });

  upload.single("image")(req as any, res as any, async (err: any) => {
    if (err instanceof multer.MulterError) {
      if (err.code === "LIMIT_FILE_SIZE") {
        res.status(400).json({ error: "El archivo excede el límite de 5MB" });
        return;
      }
      if (err.code === "LIMIT_UNEXPECTED_FILE") {
        res.status(400).json({ error: "Campo de archivo inesperado" });
        return;
      }
      res.status(400).json({ error: err.message });
      return;
    }
    if (err) {
      res.status(400).json({ error: err.message });
      return;
    }

    // Validar MIME type
    const allowedTypes = ["image/jpeg", "image/png", "image/webp"];
    const file = (req as any).file;
    if (!file || !allowedTypes.includes(file.mimetype)) {
      res.status(400).json({ error: "Tipo MIME no permitido, solo JPEG, PNG, WebP" });
      return;
    }

    const originalname = file.originalname;
    // Generar nombre seguro
    const path = require("path");
    const storageFilename = `${Date.now()}_${crypto.randomUUID()}${path.extname(originalname)}`;
    const storagePath = `/data/uploads/${storageFilename}`;

    // Guardar archivo en /data/uploads/
    const fs = require("fs");
    const directory = path.dirname(storagePath);
    if (!fs.existsSync(directory)) {
      fs.mkdirSync(directory, { recursive: true });
    }
    fs.writeFileSync(storagePath, file.buffer);

    // Enviar por la capa de entrega (Chatwoot si está habilitado; Meta si no).
    await deliverySendImage(phone, file.buffer, caption);

    // Guardar log de salida
    const { logOutgoing } = await import("../modules/messages/service");
    await logOutgoing(phone, caption || originalname);

    res.json({ ok: true, storagePath });
  });
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
