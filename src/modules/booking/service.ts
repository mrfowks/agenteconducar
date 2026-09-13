import { Activity, Circuit, ReservationStatus, TicketReason } from "@prisma/client";
import { prisma } from "../../db/client";
import { env } from "../../config/env";
import { toLocalDateKey, weekdayName } from "../../domain/calendar";
import { formatCircuit, getAvailableSlots } from "../calendar/service";
import { muteBot } from "../handoff/service";
import { getContext, logOutgoing } from "../messages/service";
import { sendImage, sendText } from "../chatwoot/delivery";
import { createTicket } from "../tickets/service";

export interface CreateReservationInput {
  phone: string;
  categoryCode: string;
  circuit: Circuit;
  activity: Activity;
  date: Date;
  startTime: string;
  durationMin: number;
  packageCode?: string;
}

const DURATION_BY_ACTIVITY: Record<Activity, number> = {
  PRACTICE: 30,
  SIMULACRO: 20,
  EXAM: 30,
};

export async function createReservation(input: CreateReservationInput) {
  const category = await prisma.category.findUnique({ where: { code: input.categoryCode } });
  if (!category) {
    throw new Error(`La categoría ${input.categoryCode} no existe.`);
  }

  let pkg = null;
  if (input.packageCode) {
    pkg = await prisma.package.findUnique({ where: { code: input.packageCode } });
    if (!pkg) {
      throw new Error(`El paquete ${input.packageCode} no existe.`);
    }
  }

  const durationMin = input.durationMin ?? DURATION_BY_ACTIVITY[input.activity];
  if (durationMin !== 20 && durationMin !== 30 && durationMin !== 45) {
    throw new Error("Duración no válida. Solo 20, 30 o 45 minutos.");
  }
  if (durationMin === 45 && input.circuit === "OFFICIAL") {
    throw new Error("Las prácticas de 45 minutos solo se brindan en el circuito alternativo (paquetes promocionales).");
  }

  // La primera sesión de un paquete debe corresponder a una práctica incluida (circuito + duración).
  if (pkg && input.activity === "PRACTICE") {
    const itemCircuit = input.circuit === "OFFICIAL" ? "circuito oficial" : "circuito alternativo";
    const included = (pkg.items as string[]).some((it) => {
      const s = it.toLowerCase().replace(/[áàâ]/g, "a");
      return (
        s.includes("practic") &&
        s.includes(itemCircuit) &&
        s.includes(`${durationMin} minutos`)
      );
    });
    if (!included) {
      throw new Error(
        `El paquete ${pkg.code} no incluye práctica de ${durationMin} min en el ${formatCircuit(input.circuit)}. Revisa su contenido con consultar_paquetes antes de ofrecer el circuito o la duración.`,
      );
    }
  }

  if (await hasPendingReservation(input.phone)) {
    throw new Error(
      "Ya tienes una reserva pendiente de pago o comprobante en revisión. Termina el pago de esa reserva antes de agendar otra.",
    );
  }

  const available = await getAvailableSlots(input.date, input.circuit, input.activity, durationMin);
  if (!available.some((s) => s.slot === input.startTime)) {
    throw new Error(
      `El horario de las ${input.startTime} no está disponible en el ${formatCircuit(input.circuit)} para esa fecha.`,
    );
  }

  let client = await prisma.client.findUnique({ where: { phone: input.phone } });
  if (!client) {
    client = await prisma.client.create({ data: { phone: input.phone } });
  }

  const endTime = addMinutes(input.startTime, durationMin);
  const price = pkg ? pkg.price : category.price;

  const reservation = await prisma.reservation.create({
    data: {
      clientId: client.id,
      categoryId: category.id,
      activity: input.activity,
      circuit: input.circuit,
      date: input.date,
      startTime: input.startTime,
      endTime,
      durationMin,
      price,
      status: "PENDING_PAYMENT",
      packageId: pkg?.id,
    },
  });

  await sendPaymentInstructions(input.phone, reservation);

  return reservation;
}

function addMinutes(time: string, minutes: number): string {
  const [h, m] = time.split(":").map(Number);
  const total = h * 60 + m + minutes;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

export async function sendPaymentInstructions(phone: string, reservation: any) {
  const category = await prisma.category.findUnique({ where: { id: reservation.categoryId } });
  const dateKey = toLocalDateKey(new Date(reservation.date), env.business.timezone);
  const activityLabel = reservation.activity === "SIMULACRO" ? "simulacro" : "práctica";
  const price = reservation.price ?? category?.price;
  const packageNote = reservation.packageId
    ? `\n• Esta reserva corresponde a un paquete promocional: el QR cubre el total del paquete y un asesor coordinará contigo las demás sesiones.`
    : "";

  const text =
    `📅 Solicitud de reserva registrada:\n` +
    `• Servicio: ${activityLabel} categoría ${category?.code}\n` +
    `• Circuito: ${formatCircuit(reservation.circuit)}\n` +
    `• Fecha: ${weekdayName(new Date(reservation.date))} ${dateKey}\n` +
    `• Hora: ${reservation.startTime}–${reservation.endTime} (${reservation.durationMin} min)\n` +
    `• Precio: ${env.business.currency} ${price}${packageNote}\n\n` +
    `Para confirmar tu reserva debes realizar el pago previo. Escanea el código QR y paga por Yape o Plin, luego envíanos el comprobante por este chat.`;

  await sendText(phone, text);
  await logOutgoing(phone, text);

  if (env.qrImageUrl) {
    const caption = `QR de pago Conducar (${env.business.currency} ${price}). Paga por Yape o Plin y envíanos el comprobante.`;
    await sendImage(phone, env.qrImageUrl, caption);
    await logOutgoing(phone, `[imagen QR] ${caption}`);
  }
}

/**
 * Maneja la recibpción del comprobante de pago (voucher) enviado por el usuario.
 * Actualiza el estado de la reserva a AWAITING_VOUCHER y almacena la ruta persistente
 * al archivo en el volume Docker `/data/uploads/`, en lugar de usar el media_id de Meta
 * que expira. Esto asegura que la reserva quede asociada al archivo persistente.
 *
 * @param phone - Número de teléfono del cliente
 * @param storagePath - Ruta al archivo persistente en el almacenamiento Docker
 * @param webhookId - ID del webhook de Meta que disparó este evento
 */
export async function handleVoucherReceived(
  phone: string,
  storagePath: string, // Ruta al archivo persistente (no media_id de Meta)
  webhookId: string,
) {
  const client = await prisma.client.findUnique({ where: { phone } });
  const reservation = client
    ? await prisma.reservation.findFirst({
        where: {
          clientId: client.id,
          status: { in: ["PENDING_PAYMENT", "AWAITING_VOUCHER"] },
        },
        orderBy: { createdAt: "desc" },
        include: { category: true },
      })
    : null;

  if (!reservation) {
    const text =
      "No tenemos una reserva pendiente de pago registrada para tu número. Si deseas reservar, dime la categoría, el circuito y el día.";
    await sendText(phone, text);
    await logOutgoing(phone, text);
    return;
  }

  if (reservation.status === "AWAITING_VOUCHER") {
    const text =
      "Ya recibimos tu comprobante de pago y está en revisión por un asesor. En breve te confirmamos tu reserva. 🙏";
    await sendText(phone, text);
    await logOutgoing(phone, text);
    return;
  }

  await prisma.reservation.update({
    where: { id: reservation.id },
    data: { status: "AWAITING_VOUCHER", voucherPath: storagePath },
  });

  const context = await getContext(phone);
  await createTicket({
    phone,
    reason: "PAYMENT",
    summary: `Validar comprobante de pago para reserva de ${reservation.category.code} (${formatCircuit(reservation.circuit)}) el ${toLocalDateKey(new Date(reservation.date), env.business.timezone)} a las ${reservation.startTime}.`,
    context,
    reservationId: reservation.id,
  });
  await muteBot(phone);

  const text =
    "📩 Recibimos tu comprobante de pago. Un asesor lo validará y te confirmará tu reserva en breve. ¡Gracias por elegir Conducar!";
  await sendText(phone, text);
  await logOutgoing(phone, text);
}

/** Cancelación o reprogramación: siempre se deriva a un asesor humano. */
export async function requestChange(phone: string, reason: TicketReason, summary: string) {
  const context = await getContext(phone);
  await createTicket({
    phone,
    reason,
    summary,
    context,
    reservationId: undefined,
  });
  await muteBot(phone);

  const text =
    "Entendido. Te voy a transferir con un asesor especializado para ayudarte con este caso. En breve te contactamos.";
  await sendText(phone, text);
  await logOutgoing(phone, text);
}

export async function listMyReservations(phone: string) {
  const client = await prisma.client.findUnique({ where: { phone } });
  if (!client) return [];
  return prisma.reservation.findMany({
    where: { clientId: client.id },
    orderBy: { date: "desc" },
    include: { category: true },
    take: 10,
  });
}

export function formatMyReservations(reservations: any[]): string {
  if (reservations.length === 0) return "No tienes reservas registradas.";
  const statusLabel: Record<string, string> = {
    PENDING_PAYMENT: "pendiente de pago",
    AWAITING_VOUCHER: "comprobante en revisión",
    PENDING_HUMAN: "en revisión por asesor",
    CONFIRMED: "confirmada",
    CANCELLED: "cancelada",
    COMPLETED: "completada",
    NO_SHOW: "no asistió",
  };
  const lines = reservations.map((r) => {
    const dateKey = toLocalDateKey(new Date(r.date), env.business.timezone);
    return (
      `• #${r.id} | ${r.category.code} ${r.activity === "SIMULACRO" ? "simulacro" : "práctica"} | ` +
      `${formatCircuit(r.circuit)} | ${dateKey} ${r.startTime} | ${statusLabel[r.status]}`
    );
  });
  return `Tus reservas:\n${lines.join("\n")}`;
}

/** ¿Existe una reserva pendiente de pago o comprobante en revisión? */
export async function hasPendingReservation(phone: string): Promise<boolean> {
  const client = await prisma.client.findUnique({ where: { phone } });
  if (!client) return false;
  const found = await prisma.reservation.findFirst({
    where: {
      clientId: client.id,
      status: { in: ["PENDING_PAYMENT", "AWAITING_VOUCHER"] },
    },
    select: { id: true },
  });
  return Boolean(found);
}

/** Pide al usuario confirmar que la imagen enviada es su comprobante de pago. */
export async function askVoucherConfirmation(phone: string) {
  const text =
    "📩 ¿Este es el comprobante de tu pago (Yape/Plin)? Responde *sí* para que un asesor lo valide. Si es otra cosa, dime en qué te puedo ayudar.";
  await sendText(phone, text);
  await logOutgoing(phone, text);
}
