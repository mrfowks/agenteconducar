import cron from "node-cron";
import { prisma } from "../db/client";
import { env } from "../config/env";
import { sendText } from "../modules/chatwoot/delivery";
import { logOutgoing } from "../modules/messages/service";
import { toLocalDateKey, weekdayName } from "../domain/calendar";

export function startReminders(): void {
  cron.schedule("*/5 * * * *", () => {
    runReminders().catch((err) => console.error("[jobs] error en recordatorios:", err));
  });
  console.log("⏰ Recordatorios automáticos activos (cada 5 min)");
}

async function runReminders(): Promise<void> {
  const now = new Date();
  const since = new Date(now.getTime() - 60 * 60 * 1000);

  const upcoming = await prisma.reservation.findMany({
    where: { status: "CONFIRMED", date: { gte: since } },
    include: { client: true, category: true },
  });

  for (const r of upcoming) {
    const [h, m] = r.startTime.split(":").map(Number);
    const scheduled = new Date(r.date);
    scheduled.setHours(h, m, 0, 0);

    const diffHours = (scheduled.getTime() - now.getTime()) / 3_600_000;
    if (diffHours < 0) continue;

    const circuit = r.circuit === "OFFICIAL" ? "circuito oficial" : "circuito alternativo";
    const servicio = r.activity === "SIMULACRO" ? "simulacro" : "práctica";

    if (!r.reminder24h && diffHours <= 24 && diffHours > 2) {
      const text =
        `⏰ Recordatorio: tu ${servicio} en Conducar es mañana ${weekdayName(new Date(r.date))} a las ${r.startTime} ` +
        `(categoría ${r.category.code}, ${circuit}). Llega con anticipación: la atención es por orden de llegada.`;
      await sendReminder(r.client.phone, text);
      await prisma.reservation.update({ where: { id: r.id }, data: { reminder24h: true } });
    }

    if (!r.reminder2h && diffHours <= 2) {
      const text =
        `🚗 Te esperamos en Conducar en 2 horas: ${servicio} de ${r.startTime} a ${r.endTime} ` +
        `(categoría ${r.category.code}, ${circuit}). ¡Nos vemos pronto!`;
      await sendReminder(r.client.phone, text);
      await prisma.reservation.update({ where: { id: r.id }, data: { reminder2h: true } });
    }
  }
}

/**
 * Envía un recordatorio con log claro ante fallo.
 * Nota: NO se implementan plantillas de Meta en esta fase; si Meta exige
 * plantilla para el mensaje (fuera de la ventana de 24 h de sesión), el error
 * se loguea como "pendiente de configuración de plantilla" sin romper el job.
 */
async function sendReminder(phone: string, text: string): Promise<void> {
  try {
    await sendText(phone, text);
    await logOutgoing(phone, text);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[jobs] recordatorio NO enviado a ${phone}. ` +
        (/(template|400|403)/i.test(message)
          ? "Puede requerir plantilla aprobada de Meta para mensajes fuera de sesión — pendiente de configuración de plantilla."
          : message),
    );
  }
}
