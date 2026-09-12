import { TicketReason, TicketStatus, ValidationAction } from "@prisma/client";
import { prisma } from "../../db/client";
import { sendText } from "../whatsapp/client";
import { releaseBot } from "../handoff/service";

async function record(action: ValidationAction, phone: string, opts: { note?: string; ticketId?: number; reservationId?: number } = {}) {
  await prisma.validationRecord.create({
    data: {
      action,
      phone,
      note: opts.note,
      ticketId: opts.ticketId,
      reservationId: opts.reservationId,
    },
  });
}

export interface CreateTicketInput {
  phone: string;
  reason: TicketReason;
  summary: string;
  context: unknown;
  reservationId?: number;
}

export async function createTicket(input: CreateTicketInput) {
  const ticket = await prisma.ticket.create({
    data: {
      phone: input.phone,
      reason: input.reason,
      summary: input.summary,
      context: input.context as object,
      reservationId: input.reservationId,
    },
    include: { reservation: { include: { category: true } } },
  });
  return ticket;
}

export async function listTickets(status?: TicketStatus) {
  return prisma.ticket.findMany({
    where: status ? { status } : undefined,
    orderBy: { createdAt: "desc" },
    include: { reservation: { include: { category: true } } },
  });
}

export async function getTicket(id: number) {
  return prisma.ticket.findUnique({
    where: { id },
    include: {
      reservation: { include: { category: true } },
    },
  });
}

export async function closeTicket(id: number, note?: string) {
  const ticket = await prisma.ticket.update({
    where: { id },
    data: { status: "CLOSED", closedNote: note, closedAt: new Date() },
  });
  await record("CLOSE", ticket.phone, { note, ticketId: id, reservationId: ticket.reservationId ?? undefined });
  await releaseBot(ticket.phone);
  return ticket;
}

/** Confirma la reserva vinculada al ticket y libera la conversación. */
export async function confirmReservationFromTicket(ticketId: number, note?: string) {
  const ticket = await getTicket(ticketId);
  if (!ticket) throw new Error("Ticket no encontrado");
  if (ticket.reservationId) {
    await prisma.reservation.update({
      where: { id: ticket.reservationId },
      data: { status: "CONFIRMED", updatedAt: new Date() },
    });
  }
  await record("CONFIRM", ticket.phone, { note, ticketId, reservationId: ticket.reservationId ?? undefined });
  await closeTicket(ticketId, note);
  await sendText(
    ticket.phone,
    `✅ Hola, tu reserva en Conducar fue confirmada. Te esperamos el día indicado. Llega con anticipación, la atención es por orden de llegada. ${note ? `Nota del asesor: ${note}` : ""}`,
  );
  return ticket;
}

/** Cancela la reserva vinculada al ticket y libera la conversación. */
export async function cancelReservationFromTicket(ticketId: number, note?: string) {
  const ticket = await getTicket(ticketId);
  if (!ticket) throw new Error("Ticket no encontrado");
  if (ticket.reservationId) {
    await prisma.reservation.update({
      where: { id: ticket.reservationId },
      data: { status: "CANCELLED", updatedAt: new Date() },
    });
  }
  await record("CANCEL", ticket.phone, { note, ticketId, reservationId: ticket.reservationId ?? undefined });
  await closeTicket(ticketId, note);
  await sendText(
    ticket.phone,
    `📋 Tu reserva en Conducar fue cancelada. ${note ? `Motivo: ${note}` : ""} Si necesitas reprogramar, respóndenos por este canal.`,
  );
  return ticket;
}

/** El asesor responde directamente al usuario por WhatsApp. */
export async function replyToUser(ticketId: number, text: string) {
  const ticket = await getTicket(ticketId);
  if (!ticket) throw new Error("Ticket no encontrado");
  await prisma.message.create({
    data: { id: crypto.randomUUID(), phone: ticket.phone, direction: "OUT", caption: text },
  });
  await record("REPLY", ticket.phone, { note: text.slice(0, 200), ticketId });
  await sendText(ticket.phone, text);
  return ticket;
}
