export type TimeStr = string; // "HH:MM"

export function toMinutes(t: TimeStr): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

export function minutesToTime(total: number): TimeStr {
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export function isTimeInWindow(t: TimeStr, start: TimeStr, end: TimeStr): boolean {
  return toMinutes(t) >= toMinutes(start) && toMinutes(t) < toMinutes(end);
}

export function parseDays(days: string): number[] {
  return days.split(",").map((d) => Number(d.trim()));
}

export function isDayAllowed(days: string, dayOfWeek: number): boolean {
  return parseDays(days).includes(dayOfWeek);
}

/**
 * Genera los horarios de inicio posibles de una actividad en un día.
 * Ej: 08:00-17:30 con 30 min -> [08:00, 08:30, ..., 17:00]
 */
export function generateStartTimes(start: TimeStr, end: TimeStr, durationMin: number): TimeStr[] {
  const result: TimeStr[] = [];
  let cursor = toMinutes(start);
  const endMin = toMinutes(end);
  while (cursor + durationMin <= endMin) {
    result.push(minutesToTime(cursor));
    cursor += durationMin;
  }
  return result;
}

export const WEEKDAY_NAMES = [
  "domingo",
  "lunes",
  "martes",
  "miércoles",
  "jueves",
  "viernes",
  "sábado",
];

export function weekdayName(date: Date): string {
  return WEEKDAY_NAMES[date.getDay()];
}

export function toLocalDateKey(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export function localDateTime(timezone: string): Date {
  return new Date(
    new Date().toLocaleString("en-US", { timeZone: timezone }),
  );
}

export function nowTime(timezone: string): TimeStr {
  const d = localDateTime(timezone);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function slotIsInFuture(
  date: Date,
  start: TimeStr,
  timezone: string,
  minAdvanceHours: number,
): boolean {
  const now = localDateTime(timezone);
  const slot = new Date(date);
  const [h, m] = start.split(":").map(Number);
  slot.setHours(h, m, 0, 0);
  const minAdvance = minAdvanceHours * 60 * 60 * 1000;
  return slot.getTime() >= now.getTime() + minAdvance;
}
