import { Activity, Circuit, ComplaintType, TicketReason } from "@prisma/client";
import { env } from "../config/env";
import { getAgendaSummary, getAvailableSlots, getActivitiesForDate, formatSlots, getNextValidDates, getActiveRules } from "../modules/calendar/service";
import { generateStartTimes, nowTime } from "../domain/calendar";
import { createReservation, formatMyReservations, listMyReservations, requestChange } from "../modules/booking/service";
import { PAYMENT_METHODS_INFO } from "../modules/payments/service";
import { sendImage } from "../modules/chatwoot/delivery";
import { logOutgoing } from "../modules/messages/service";
import { prisma } from "../db/client";
import { toLocalDateKey, weekdayName } from "../domain/calendar";

export type ToolExecutor = (phone: string, args: Record<string, unknown>) => Promise<unknown>;

function normalizeCircuit(v: string): Circuit {
  const s = v.toLowerCase().replace(/[áàâ]/g, "a");
  if (s.includes("altern")) return "ALTERNATIVE";
  return "OFFICIAL";
}

function normalizeActivity(v: string): Activity {
  const s = v.toLowerCase().replace(/[áàâ]/g, "a");
  if (s.includes("simul")) return "SIMULACRO";
  return "PRACTICE";
}

function normalizeDate(v: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(v.trim());
  if (!match) throw new Error(`Fecha inválida: ${v}. Usa el formato AAAA-MM-DD.`);
  const [, y, m, d] = match;
  return new Date(Number(y), Number(m) - 1, Number(d));
}

export const TOOL_DEFINITIONS = [
  {
    type: "function" as const,
    function: {
      name: "consultar_disponibilidad",
      description:
        "Consulta los horarios disponibles para una práctica o simulacro en una fecha y circuito determinados.",
      parameters: {
        type: "object",
        properties: {
          fecha: { type: "string", description: "Fecha en formato AAAA-MM-DD" },
          circuito: { type: "string", enum: ["oficial", "alternativo"] },
          actividad: { type: "string", enum: ["practica", "simulacro"] },
          duracion_min: {
            type: "number",
            description: "Duración en minutos (30 para práctica, 20 para simulacro). Opcional.",
          },
        },
        required: ["fecha", "circuito", "actividad"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "consultar_actividades_dia",
      description: "Qué actividades hay en Conducar para una fecha dada (qué se puede hacer ese día).",
      parameters: {
        type: "object",
        properties: {
          fecha: { type: "string", description: "Fecha en formato AAAA-MM-DD" },
        },
        required: ["fecha"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "consultar_fechas_disponibles",
      description:
        "Lista las fechas reales disponibles en los próximos 14 días para práctica o simulacro según el circuito. Usar para proponer días de reserva y NUNCA inventar fechas.",
      parameters: {
        type: "object",
        properties: {
          circuito: { type: "string", enum: ["oficial", "alternativo"] },
          actividad: { type: "string", enum: ["practica", "simulacro"] },
        },
        required: ["circuito", "actividad"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "consultar_categorias",
      description: "Lista las categorías de licencia con su vehículo y precio oficial.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "consultar_paquetes",
      description:
        "Lista los paquetes promocionales con precio y contenido. Envía el afiche del paquete al usuario como apoyo visual.",
      parameters: {
        type: "object",
        properties: {
          codigo: {
            type: "string",
            description:
              "Código del paquete a consultar (P1, P2, P3, P4 o P5). Opcional: si no se envía, lista todos.",
          },
        },
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "consultar_agenda",
      description: "Horarios de atención semanales de Conducar.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "consultar_informacion_licencia",
      description: "Requisitos oficiales para obtener la licencia A1 por primera vez.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "consultar_recategorizacion",
      description: "Información general sobre procesos de recategorización.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "consultar_metodos_pago",
      description: "Métodos de pago aceptados por Conducar y cómo funciona el pago previo.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "consultar_mis_reservas",
      description: "Lista las reservas registradas del usuario.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "crear_reserva",
      description:
        "Registra una reserva de práctica o simulacro y envía las instrucciones de pago (QR) al usuario. Requiere categoria, circuito, actividad, fecha y hora de inicio. Si el usuario compra un paquete promocional, pasa tambien el codigo del paquete (ej. P1): el QR cubre el total del paquete y el pago confirma la compra del paquete.",
      parameters: {
        type: "object",
        properties: {
          categoria: { type: "string", description: "Código de categoría: A1, A2 o A3" },
          circuito: { type: "string", enum: ["oficial", "alternativo"] },
          actividad: { type: "string", enum: ["practica", "simulacro"] },
          fecha: { type: "string", description: "Fecha en formato AAAA-MM-DD" },
          hora_inicio: { type: "string", description: "Hora de inicio en formato HH:MM (24h)" },
          duracion_min: {
            type: "number",
            description:
              "Duración en minutos. Opcional: 30 para práctica, 20 para simulacro, 45 para práctica de paquete en circuito alternativo.",
          },
          paquete: {
            type: "string",
            description:
              "Código del paquete promocional si el usuario lo compra (P1, P2, P3, P4 o P5). Opcional.",
          },
        },
        required: ["categoria", "circuito", "actividad", "fecha", "hora_inicio"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "derivar_a_humano",
      description:
        "Deriva la conversación a un asesor humano. Usar cuando no se puede resolver, el usuario quiere pagar online, quiere cancelar o reprogramar, no asistió, o tiene una duda particular de trámite/recategorización que las herramientas no cubren.",
      parameters: {
        type: "object",
        properties: {
          motivo: {
            type: "string",
            enum: [
              "sin_solucion",
              "pago_online",
              "tramite",
              "recategorizacion",
              "cancelar",
              "reprogramar",
              "no_asistio",
              "cambio_mayor_valor",
              "otro",
            ],
          },
          detalle: { type: "string", description: "Resumen breve de lo que el usuario necesita" },
        },
        required: ["motivo", "detalle"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "registrar_reclamo",
      description:
        "Registra una queja, reclamo o sugerencia del cliente en el sistema. Usar cuando el usuario expresa descontento, malestar o deja un reclamo sobre el servicio.",
      parameters: {
        type: "object",
        properties: {
          tipo: { type: "string", enum: ["queja", "reclamo", "sugerencia"] },
          descripcion: { type: "string", description: "Explicación detallada del reclamo, queja o sugerencia" },
          solucion_esperada: { type: "string", description: "Qué espera el cliente como solución. Opcional." },
        },
        required: ["tipo", "descripcion"],
      },
    },
  },
];

function mapReason(motivo: string): TicketReason {
  switch (motivo) {
    case "pago_online":
    case "tramite":
      return "PAYMENT";
    case "recategorizacion":
      return "RECATEGORIZATION";
    case "cancelar":
      return "CANCEL";
    case "reprogramar":
      return "REPROGRAM";
    case "no_asistio":
      return "NO_SHOW";
    case "cambio_mayor_valor":
      return "UPGRADE";
    case "sin_solucion":
    default:
      return "NO_SOLUTION";
  }
}

const LICENSE_INFO = `Para obtener la licencia A1 por primera vez debes cumplir antes de rendir el examen práctico en Conducar:
• Aprobar el examen médico.
• Aprobar el examen de reglas.
• Contar con los vouchers de pago del examen de manejo y de la expedición de licencia.
Sin estos requisitos no podrás rendir el examen práctico.`;

const RECATEGORIZATION_INFO = `Conducar brinda información general sobre procesos de recategorización de licencia. Ante dudas sobre requisitos, documentación o tu situación particular, un asesor humano te atenderá.`;

export const TOOL_EXECUTORS: Record<string, ToolExecutor> = {
  async consultar_disponibilidad(_, args) {
    const circuito = normalizeCircuit(String(args.circuito));
    const actividad = normalizeActivity(String(args.actividad));
    const fecha = normalizeDate(String(args.fecha));
    const duracionMin = Number(args.duracion_min ?? (actividad === "SIMULACRO" ? 20 : 30));
    if (duracionMin === 45 && circuito === "OFFICIAL") {
      return { disponible: false, mensaje: "Las prácticas de 45 minutos solo se brindan en el circuito alternativo (paquetes promocionales)." };
    }
    const slots = await getAvailableSlots(fecha, circuito, actividad, duracionMin);
    if (slots.length === 0) {
      const rules = await getActiveRules(fecha, circuito);
      const rule = rules.find((r) => r.activity === actividad);
      let razon = "";
      if (!rule) {
        razon = `No se realizan ${actividad === "SIMULACRO" ? "simulacros" : "prácticas"} en el circuito ${circuito === "OFFICIAL" ? "oficial" : "alternativo"} ese día.`;
      } else {
        const allStarts = generateStartTimes(rule.start, rule.end, duracionMin);
        const nowT = nowTime(env.business.timezone);
        const isToday = toLocalDateKey(new Date(), env.business.timezone) === toLocalDateKey(fecha, env.business.timezone);
        if (isToday && allStarts.every((s) => s <= nowT)) {
          razon = "Todos los horarios de hoy ya pasaron.";
        } else {
          razon = "Todos los horarios están ocupados.";
        }
      }
      return { disponible: false, mensaje: razon };
    }
    return {
      disponible: true,
      fecha: toLocalDateKey(fecha, env.business.timezone),
      circuito,
      actividad,
      horarios: formatSlots(slots),
    };
  },

  async consultar_actividades_dia(_, args) {
    const fecha = normalizeDate(String(args.fecha));
    return { fecha: toLocalDateKey(fecha, env.business.timezone), informacion: await getActivitiesForDate(fecha) };
  },

  async consultar_categorias() {
    const cats = await prisma.category.findMany({ orderBy: { order: "asc" } });
    return cats.map((c) => ({
      codigo: c.code,
      vehiculo: c.vehicle,
      precio: `${env.business.currency} ${c.price}`,
      duracion_min: c.durationMin,
    }));
  },

  async consultar_paquetes(phone, args) {
    const filtro = args.codigo ? String(args.codigo).toUpperCase().trim() : null;
    const pkgs = await prisma.package.findMany({ orderBy: { code: "asc" } });
    const seleccion = filtro ? pkgs.filter((p) => p.code.toUpperCase() === filtro) : pkgs;
    if (filtro && seleccion.length === 0) {
      return { encontrado: false, mensaje: `El paquete ${filtro} no existe. Los disponibles son P1, P2, P3, P4 y P5.` };
    }
    for (const p of seleccion) {
      const num = (p.code.match(/\d+/) ?? [""])[0];
      if (!num) continue;
      try {
        await sendImage(phone, `${env.baseUrl}/paquete${num}.png`, `${p.name} – ${env.business.currency} ${p.price} 💰`);
        await logOutgoing(phone, `[flyer ${p.code}]`);
      } catch {
        /* si la imagen no está disponible, seguimos con el texto */
      }
    }
    return seleccion.map((p) => ({
      codigo: p.code,
      nombre: p.name,
      precio: `${env.business.currency} ${p.price}`,
      incluye: p.items,
    }));
  },

  async consultar_agenda() {
    return { informacion: await getAgendaSummary() };
  },

  async consultar_fechas_disponibles(_, args) {
    const circuito = normalizeCircuit(String(args.circuito));
    const actividad = normalizeActivity(String(args.actividad));
    const dates = await getNextValidDates(circuito, actividad);
    if (dates.length === 0) {
      return { disponible: false, mensaje: "No hay fechas disponibles en los próximos 14 días para esta actividad y circuito." };
    }
    return {
      disponible: true,
      circuito,
      actividad,
      fechas: dates.map((d) => `${toLocalDateKey(d, env.business.timezone)} (${weekdayName(d)})`),
    };
  },

  async consultar_informacion_licencia() {
    return { informacion: LICENSE_INFO };
  },

  async consultar_recategorizacion() {
    return { informacion: RECATEGORIZATION_INFO };
  },

  async consultar_metodos_pago() {
    return { informacion: PAYMENT_METHODS_INFO };
  },

  async consultar_mis_reservas(phone) {
    return { reservas: formatMyReservations(await listMyReservations(phone)) };
  },

  async crear_reserva(phone, args) {
    const circuito = normalizeCircuit(String(args.circuito));
    const actividad = normalizeActivity(String(args.actividad));
    const fecha = normalizeDate(String(args.fecha));
    const startTime = String(args.hora_inicio);
    const duracionMin = Number(args.duracion_min ?? (actividad === "SIMULACRO" ? 20 : 30));

    const reservation = await createReservation({
      phone,
      categoryCode: String(args.categoria).toUpperCase(),
      circuit: circuito,
      activity: actividad,
      date: fecha,
      startTime,
      durationMin: duracionMin,
      packageCode: args.paquete ? String(args.paquete).toUpperCase().trim() : undefined,
    });
    return {
      creada: true,
      reserva_id: reservation.id,
      estado: "PENDIENTE_PAGO",
      mensaje: `Reserva #${reservation.id} REGISTRADA como PENDIENTE DE PAGO (NO confirmada). Se enviaron las instrucciones de pago (QR) al usuario. La reserva solo se confirma cuando el asesor valide el comprobante de pago. Comunícalo así al usuario: su reserva quedó registrada y debe pagar el QR y enviar el comprobante para confirmarla.`,
      fecha: toLocalDateKey(fecha, env.business.timezone),
      dia: weekdayName(fecha),
      hora: startTime,
      circuito,
      actividad,
    };
  },

  async derivar_a_humano(phone, args) {
    const motivo = String(args.motivo ?? "otro");
    const detalle = String(args.detalle ?? "");
    await requestChange(phone, mapReason(motivo), detalle || "El usuario requiere atención de un asesor.");
    return { derivado: true, mensaje: "La conversación fue derivada a un asesor humano." };
  },

  async registrar_reclamo(phone, args) {
    const tipoRaw = String(args.tipo ?? "reclamo").toLowerCase();
    const tipo: ComplaintType = tipoRaw.includes("queja")
      ? "QUEJA"
      : tipoRaw.includes("sugerencia")
        ? "SUGERENCIA"
        : "RECLAMO";
    const descripcion = String(args.descripcion ?? "");
    const solucionEsperada = args.solucion_esperada ? String(args.solucion_esperada) : null;
    const complaint = await prisma.complaint.create({
      data: { phone, type: tipo, description: descripcion, expectedSolution: solucionEsperada },
    });
    return {
      registrado: true,
      reclamo_id: complaint.id,
      mensaje: `Reclamo #${complaint.id} registrado correctamente. El área de atención lo revisará y dará respuesta.`,
    };
  },
};
