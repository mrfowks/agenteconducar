import { Activity, Circuit, ScheduleRule } from "@prisma/client";
import { prisma } from "../../db/client";
import { env } from "../../config/env";
import {
  formatCustomerTime,
  generateStartTimes,
  isDayAllowed,
  minutesToTime,
  nowTime,
  slotIsInFuture,
  toLocalDateKey,
  toMinutes,
  weekdayName,
  WEEKDAY_NAMES,
} from "../../domain/calendar";

export type ActivityCode = "PRACTICE" | "SIMULACRO" | "EXAM";

const ACTIVITY_LABEL: Record<string, string> = {
  PRACTICE: "práctica",
  SIMULACRO: "simulacro",
  EXAM: "examen oficial",
};

const CIRCUIT_LABEL: Record<string, string> = {
  OFFICIAL: "circuito oficial",
  ALTERNATIVE: "circuito alternativo",
};

export interface SlotAvailability {
  slot: string;
  capacityLeft: number;
}

export function formatActivity(a: string): string {
  return ACTIVITY_LABEL[a] ?? a;
}

export function formatCircuit(c: string): string {
  return CIRCUIT_LABEL[c] ?? c;
}

/** Reglas activas para una fecha + circuito (según día de semana). */
export async function getActiveRules(date: Date, circuit?: string): Promise<ScheduleRule[]> {
  const day = date.getDay();
  const rules = await prisma.scheduleRule.findMany({
    orderBy: { order: "asc" },
  });
  return rules.filter(
    (r) => isDayAllowed(r.days, day) && (!circuit || r.circuit === circuit),
  );
}

/** Indica qué actividades se pueden hacer en un día/circuito (para responder sin inventar). */
export async function getActivitiesForDate(date: Date): Promise<string> {
  const rules = await getActiveRules(date);
  if (rules.length === 0) {
    return `El ${weekdayName(date)} no hay actividades registradas.`;
  }
  const lines = rules.map((r) => {
    const duration = r.activity === "SIMULACRO" ? 20 : r.activity === "PRACTICE" ? 30 : null;
    const dur = duration ? ` (${duration} min)` : "";
    return `• ${r.name}${dur}: ${formatCustomerTime(r.start)}–${formatCustomerTime(r.end)} en ${formatCircuit(r.circuit)}.`;
  });
  return `El ${weekdayName(date)} se atiende:\n${lines.join("\n")}`;
}

/** Agenda semanal resumida (texto oficial, sin inventar). */
export async function getAgendaSummary(): Promise<string> {
  const rules = await prisma.scheduleRule.findMany({ orderBy: { order: "asc" } });
  const lines = rules.map((r) => {
    const days = r.days
      .split(",")
      .map((d) => WEEKDAY_NAMES[Number(d)])
      .join(", ");
    return `• ${r.name}: ${days} de ${formatCustomerTime(r.start)} a ${formatCustomerTime(r.end)} (${formatCircuit(r.circuit)}).`;
  });
  return `Horarios de atención de Conducar (todos los días, incluye domingos y feriados):\n${lines.join("\n")}`;
}

/**
 * Calcula disponibilidad real para una fecha/circuito/actividad.
 * La capacidad (instructor + vehículo) por bloque es configurable.
 */
export async function getAvailableSlots(
  date: Date,
  circuit: string,
  activity: ActivityCode,
  durationMin: number,
): Promise<SlotAvailability[]> {
  const rules = await getActiveRules(date, circuit);
  const rule = rules.find((r) => r.activity === activity);
  if (!rule) {
    return [];
  }

  const starts = generateStartTimes(rule.start, rule.end, durationMin);
  const dateKey = toLocalDateKey(date, env.business.timezone);

  const existing = await prisma.reservation.findMany({
    where: {
      circuit: circuit as Circuit,
      activity: activity as Activity,
      status: { notIn: ["CANCELLED", "COMPLETED"] },
      date: date,
    },
  });

  const occupiedByStart = new Map<string, number>();
  for (const res of existing) {
    if (toLocalDateKey(new Date(res.date), env.business.timezone) !== dateKey) continue;
    const key = res.startTime;
    occupiedByStart.set(key, (occupiedByStart.get(key) ?? 0) + 1);
  }

  const nowT = nowTime(env.business.timezone);
  const capacity = env.business.capacityPerBlock;

  return starts
    .filter((s) => {
      if (toLocalDateKey(new Date(), env.business.timezone) === dateKey && s <= nowT) {
        return false;
      }
      return slotIsInFuture(date, s, env.business.timezone, env.business.minAdvanceHours);
    })
    .map((s) => {
      const used = occupiedByStart.get(s) ?? 0;
      return { slot: s, capacityLeft: Math.max(0, capacity - used) };
    })
    .filter((s) => s.capacityLeft > 0);
}

/** Lista de fechas válidas para reservar según actividad/circuito (hoy + próximos 14 días). */
export async function getNextValidDates(
  circuit: string,
  activity: ActivityCode,
  days = 14,
): Promise<Date[]> {
  const dates: Date[] = [];
  const tz = env.business.timezone;
  const now = new Date();
  for (let i = 0; i <= days; i++) {
    const candidate = new Date(now);
    candidate.setDate(candidate.getDate() + i);
    const rules = await getActiveRules(candidate, circuit);
    const has = rules.some((r) => r.activity === activity);
    if (has) {
      // Verificar que haya al menos 1 slot disponible
      const durationMin = activity === "SIMULACRO" ? 20 : 30;
      const slots = await getAvailableSlots(candidate, circuit, activity, durationMin);
      if (slots.length > 0) dates.push(candidate);
    }
  }
  return dates;
}

/** Resumen de horario legible para un rango de fechas disponibles. */
export function formatSlots(slots: SlotAvailability[]): string {
  return slots.map((s) => formatCustomerTime(s.slot)).join(", ");
}

export function minutesLabel(min: number): string {
  return minutesToTime(min);
}

export { toMinutes };
