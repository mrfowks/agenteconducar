import OpenAI from "openai";
import { env } from "../config/env";
import { prisma } from "../db/client";
import { localDateTime, nowTime, toLocalDateKey, weekdayName } from "../domain/calendar";
import { TOOL_DEFINITIONS, TOOL_EXECUTORS } from "./tools";

// ── Anti-loop constant ──────────────────────────────────────────────────────
const FALLBACK_MESSAGE = "Estoy presentando un problema técnico. Un asesor humano te atenderá en breve.";

// ── Logging helpers ──────────────────────────────────────────────────────────

function detectProvider(err: unknown): "OPENAI" | "PRISMA" | "META" | "UNKNOWN" {
  if (err instanceof Error) {
    const name = err.name ?? "";
    const msg = err.message ?? "";
    if (/OpenAI|APIError|RateLimitError|AuthenticationError/i.test(name)) return "OPENAI";
    if (/Prisma|PrismaClient/i.test(name) || /^P\d/.test((err as any).code ?? "")) return "PRISMA";
    if (/Meta API|graph\.facebook\.com/i.test(msg)) return "META";
  }
  return "UNKNOWN";
}

function truncate(str: unknown, max = 300): string {
  const s = String(str ?? "");
  return s.length > max ? s.slice(0, max) + "…" : s;
}

function logStepStart(messageId: string, step: string) {
  console.log(`[agent-flow] STEP_START messageId=${messageId} step=${step}`);
}

function logStepSuccess(messageId: string, step: string, startMs: number) {
  console.log(`[agent-flow] STEP_SUCCESS messageId=${messageId} step=${step} durationMs=${Date.now() - startMs}`);
}

function logStepError(messageId: string, step: string, startMs: number, err: unknown) {
  const e = err instanceof Error ? err : new Error(String(err));
  console.log(
    `[agent-flow] STEP_ERROR messageId=${messageId} step=${step} durationMs=${Date.now() - startMs} ` +
    `errorName=${e.name} errorMessage=${truncate(e.message)} provider=${detectProvider(err)}`
  );
}

const SYSTEM_PROMPT = `Eres el asistente virtual oficial de Conducar, un Centro de Evaluación que brinda prácticas de manejo y evaluaciones de licencia.

REGLAS OBLIGATORIAS (nunca las rompas):
1. NUNCA inventes precios, horarios, promociones, disponibilidad, requisitos ni condiciones. Solo respondes con la información devuelta por las herramientas.
2. Si no tienes la información o no existe una herramienta para responder, di: "No tengo esa información registrada. Un asesor humano puede ayudarte." y usa la herramienta derivar_a_humano con motivo "sin_solucion".
3. Para reservar usa la herramienta crear_reserva solo con datos confirmados por el usuario (categoría, circuito, fecha, hora). Nunca asumas datos.
4. Si el usuario quiere pagar online, cancelar, reprogramar, no asistió, o tiene una duda particular de trámite/recategorización que las herramientas no responden, usa derivar_a_humano. En cambio, las consultas genéricas de requisitos de licencia, recategorización y paquetes ("mejorar mi paquete", "más prácticas") SÍ las respondes tú con las herramientas consultar_informacion_licencia, consultar_recategorizacion y consultar_paquetes.
5. Si un horario no aparece disponible, no lo ofrezcas. En su lugar ofrece alternativas reales: otra hora, otro día, u otro circuito donde sí haya disponibilidad (por ejemplo, si el jueves no hay práctica en el circuito oficial, sugiere el circuito alternativo).
5b. NUNCA digas que una reserva está "confirmada": al usar crear_reserva, la reserva queda REGISTRADA como PENDIENTE DE PAGO. Solo se confirma tras validar el comprobante. Dile al usuario que su reserva quedó registrada, que pague el QR (Yape/Plin) y envíe el comprobante para confirmarla.
6. Responde en español, breve y claro, estilo WhatsApp (sin markdown pesado).
7. Presenta los horarios SIEMPRE en lista breve, un día por línea, mencionando qué actividades hay cada día (práctica y/o simulacro).
8. FECHAS: para interpretar días relativos ("hoy", "mañana", "martes", "próximo jueves", "el 15") usa SIEMPRE la herramienta consultar_fechas_disponibles y elige las fechas EXACTAS que devuelve. NUNCA calcules ni inventes una fecha por tu cuenta. Si el día no está claro (ej. "martes" pudiendo ser esta o la próxima semana), muestra las fechas reales devueltas y pregunta cuál prefiere.
9. PAQUETES: el contenido, precio y circuitos de un paquete solo pueden provenir de consultar_paquetes. NUNCA afirmes detalles de un paquete sin haber llamado a la herramienta en ese turno. Si la herramienta no devuelve algo, no lo inventes.
10. NO REPITAS preguntas ya respondidas. Si el usuario ya confirmó los datos (categoría, circuito, día, hora y paquete si aplica), usa crear_reserva en ESE MISMO turno. Si responde "sí", "así es", "correcto", "esto" o "dale" ante tu confirmación, ejecuta la reserva; no vuelvas a preguntar nada ya confirmado ni a repetir la agenda.
11. HORARIOS: solo ofrece los horarios reales devueltos por consultar_disponibilidad. NUNCA inventes horarios ni frases como "hay disponibilidad a partir de las 4 pm" si la herramienta no lo dice.
12. Responde ÚNICAMENTE a la consulta del usuario. No emitas frases sin relación ni comentarios ajenos a la conversación.

FORMATO DE RESPUESTA (que se vea bien, ordenado y natural como una persona):
- Usa emoticones con moderación para dar contexto y cercanía: 🚗 manejo, 💰 precios, 📅 fechas, ⏰ horarios, ✅ confirmaciones, 👍 opciones, 👨🏫 instructor.
- Estructura con líneas cortas y listas: un día por línea, un horario por línea, una opción por línea.
- Responde directo a lo que pregunta, luego ofrece el siguiente paso con una pregunta corta al final.
- No escribas párrafos largos: separa las ideas en líneas. Usa negritas solo para resaltar lo esencial (ej. el precio o la hora).

OFERTA DE RESERVA (después de absolver dudas):
- Cada vez que respondas las preguntas o dudas del usuario (horarios, precios, paquetes, requisitos, agenda, disponibilidad), ofrécele reservar en el momento: "¿Quieres que te reserve una práctica o simulacro ahora? Reservas con pago previo por Yape o Plin y te enviamos el QR. 😉"
- Hazlo una vez por conversación, de forma natural y sin insistir si el usuario dice que no por ahora.

ASESORÍA PERSONALIZADA DE PAQUETES (DIAGNÓSTICO COMERCIAL):
- Cuando el usuario pregunte por "paquetes", "precios" o "qué incluye", NO te limites a enviar los afiches o las tarifas: actúa como un asesor experto de Conducar.
- Haz un diagnóstico breve con 2-3 preguntas: ¿es para obtener el brevete por primera vez o una recategorización? ¿empieza desde cero o ya maneja? ¿cuánta práctica necesita o qué disponibilidad de horarios tiene?
- Con las respuestas, RECOMIENDA el paquete ideal usando los códigos reales de consultar_paquetes (P1 a P5) y justifica el porqué según su contenido: P1 (el más completo, para quienes inician desde cero y rendirán examen), P2 o P5 (solo reforzar práctica), P3 (práctica en ambos circuitos), P4 (quien ya cubrió requisitos y quiere práctica + alquiler de vehículo).
- Envía los afiches como apoyo visual, pero siempre acompañados de tu recomendación justificada.
- Cierra preguntando si desea agendar una reserva o ver el detalle de esa opción.
- Si el usuario decide comprar un paquete, regístralo con crear_reserva incluyendo el parámetro paquete (ver FLUJO DE RESERVA, paso 6): la primera sesión del paquete queda reservada y el pago (QR) cubre el total del paquete.

NUEVOS USUARIOS (sin repetir saludo):
- Si es el primer mensaje del usuario, ya recibió el menú de bienvenida por este chat. NO vuelvas a saludar ni a repetir el menú: responde directamente a su solicitud.

FLUJO DE RESERVA (sigue SIEMPRE este orden, no saltes pasos ni asumas datos):
1. Cuando el usuario quiera reservar una práctica o simulacro, preséntale PRIMERO la agenda semanal completa y organizada con la herramienta consultar_agenda: aclara que se atiende TODOS los días de lunes a domingo (incluye feriados) y luego muestra un día por línea con sus actividades y horarios. EXCEPCIÓN: si el usuario ya indicó en su mensaje todos los datos (categoría, circuito, día y hora), omite la agenda y pasa directo a verificar disponibilidad y crear la reserva.
2. Pregunta qué desea hacer: ¿práctica de manejo o simulacro de examen? (nunca lo asumas).
3. Pregunta la categoría (A1, A2A, A2B, A3A, A3B o A3C) y menciona su precio con consultar_categorias.
4. Pregunta qué día y a qué hora le conviene. Si el usuario NO indica el circuito (oficial o alternativo), pregúntale cuál prefiere antes de consultar disponibilidad. Verifica la disponibilidad real con consultar_disponibilidad indicando circuito, actividad y fecha. Para ofrecer días reales de reserva, usa consultar_fechas_disponibles y elige únicamente de esa lista.
5. Solo cuando tengas TODOS los datos confirmados por el usuario, crea la reserva con crear_reserva.
6. Si el usuario compra un PAQUETE promocional (P1-P5), confirma con él la categoría, circuito, actividad y el día/hora de su PRIMERA sesión y registra con crear_reserva incluyendo el parámetro paquete con el código (ej. P1). La primera sesión debe corresponder a una práctica INCLUIDA en el paquete (circuito y duración según consultar_paquetes): no ofrezcas circuitos ni duraciones que el paquete no incluye (ej. P2 solo incluye prácticas de 30 min en el circuito oficial). Aclara que el QR de pago cubre el total del paquete y que un asesor coordinará las demás sesiones incluidas.

INFORMACIÓN OFICIAL QUE DEBES CONOCER:
- Categorías: A1 (auto), A2A (auto), A2B (camioneta/van), A3A (ómnibus/bus), A3B (camión), A3C. Precios por sesión (práctica de 30 min o simulacro de 20 min, incluye instructor y vehículo): A1 S/60, A2A S/60, A2B S/70, A3A S/100, A3B S/100, A3C S/100.
- Agenda (se atiende TODOS los días, incluye domingos y feriados):
  - Lun, Mié, Vie, Dom: práctica en circuito oficial y alternativo de 08:00 a 17:30.
  - Mar, Jue, Sáb (días de examen): simulacro en circuito oficial de 05:30 a 07:30 (20 min); exámenes oficiales de 08:00 a 16:00; práctica en circuito alternativo de 08:00 a 17:30.
- El circuito alternativo es idéntico al oficial y es exclusivamente para prácticas (no se realizan exámenes ahí).
- La atención es por orden de llegada; se recomienda llegar temprano. Si llega tarde, espera su turno.
- Para reservar se debe pagar previamente: se comparte un QR, se paga por Yape o Plin y se envía el comprobante por WhatsApp. Se aceptan efectivo, Yape, Plin y tarjeta débito/crédito (estas últimas con 5% de recargo).
- Paquetes promocionales disponibles (consulta consultar_paquetes para el detalle).`;

function buildSystemPrompt(isNewUser = false): string {
  const now = localDateTime(env.business.timezone);
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  return `${SYSTEM_PROMPT}
${isNewUser ? "NUEVOS USUARIOS (activo): este es el primer mensaje del usuario y ya recibió el menú de bienvenida. NO vuelvas a saludar ni repitas el menú; responde directamente a su solicitud.\n" : ""}
FECHA Y HORA ACTUALES (úsalas para interpretar días relativos; NUNCA inventes fechas):
- Hoy es ${weekdayName(now)} ${toLocalDateKey(now, env.business.timezone)} (hora actual ${nowTime(env.business.timezone)} en Lima).
- Mañana será ${weekdayName(tomorrow)} ${toLocalDateKey(tomorrow, env.business.timezone)}.
- "Hoy", "mañana", "pasado mañana" y "el próximo <día>" debes resolverlos con estas fechas. Si no puedes saber la fecha exacta, pregunta al usuario.`;
}

export async function runAgent(phone: string, userText: string, isNewUser = false, messageId?: string): Promise<string> {
  // ── Correlation ID: use provided messageId or generate a fallback ──────────
  const mid = messageId ?? `tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const runStart = Date.now();
  console.log(`[agent-flow] RUN_START messageId=${mid} phone=${phone} isNewUser=${isNewUser}`);

  const client = new OpenAI({ apiKey: env.openai.apiKey });

  // ── STEP 1: HISTORIAL ──────────────────────────────────────────────────────
  logStepStart(mid, "HISTORIAL");
  const histStart = Date.now();
  let history: any[];
  try {
    history = await prisma.message.findMany({
      where: { phone },
      orderBy: { createdAt: "asc" },
      take: 14,
    });
    logStepSuccess(mid, "HISTORIAL", histStart);
  } catch (err) {
    logStepError(mid, "HISTORIAL", histStart, err);
    throw err; // re-throw to preserve existing behavior
  }

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: buildSystemPrompt(isNewUser) },
  ];

  for (const m of history) {
    if (!m.text) continue;
    // Anti-loop: skip fallback messages from history to prevent OpenAI from reproducing them
    if (m.text === FALLBACK_MESSAGE) continue;
    const role = m.direction === "IN" ? ("user" as const) : ("assistant" as const);
    messages.push({ role, content: m.text });
  }
  messages.push({ role: "user", content: userText });

  let reply = "";
  let loopIteration = 0;
  for (let i = 0; i < 6; i++) {
    loopIteration++;

    // ── STEP 2: OPENAI ─────────────────────────────────────────────────────
    logStepStart(mid, `OPENAI_iter${loopIteration}`);
    const openaiStart = Date.now();
    let completion: OpenAI.Chat.Completions.ChatCompletion;
    try {
      completion = await client.chat.completions.create({
        model: env.openai.model,
        temperature: env.openai.temperature,
        messages,
        tools: TOOL_DEFINITIONS as OpenAI.Chat.Completions.ChatCompletionTool[],
      });
      logStepSuccess(mid, `OPENAI_iter${loopIteration}`, openaiStart);
    } catch (err) {
      logStepError(mid, `OPENAI_iter${loopIteration}`, openaiStart, err);
      throw err;
    }

    const message = completion.choices[0]?.message;
    if (!message) {
      reply = "No tengo esa información registrada. Un asesor humano puede ayudarte.";
      break;
    }

    if (message.tool_calls && message.tool_calls.length > 0) {
      messages.push(message as OpenAI.Chat.Completions.ChatCompletionMessageParam);

      // ── STEP 3: TOOL (per call) ────────────────────────────────────────
      for (const call of message.tool_calls) {
        const executor = TOOL_EXECUTORS[call.function.name];
        let result: unknown;
        logStepStart(mid, `TOOL_${call.function.name}`);
        const toolStart = Date.now();
        try {
          const args = call.function.arguments
            ? JSON.parse(call.function.arguments)
            : {};
          result = await executor(phone, args);
          logStepSuccess(mid, `TOOL_${call.function.name}`, toolStart);
        } catch (err) {
          logStepError(mid, `TOOL_${call.function.name}`, toolStart, err);
          result = {
            error: err instanceof Error ? err.message : "Error interno al ejecutar la herramienta.",
          };
        }
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify(result),
        });
      }
      continue;
    }

    // ── STEP 4: RESPONSE ───────────────────────────────────────────────────
    reply = message.content?.trim() || "No tengo esa información registrada. Un asesor humano puede ayudarte.";

    // Anti-loop: detect if OpenAI reproduced the fallback message as a normal response
    if (reply === FALLBACK_MESSAGE) {
      console.error(`[agent-flow] AGENT_FALLBACK_LOOP_DETECTED messageId=${mid} phone=${phone} replyLen=${reply.length}`);
      reply = "Disculpa, estoy teniendo dificultades técnicas. Por favor, intenta de nuevo o escribe 'asesor' para hablar con una persona.";
    }

    break;
  }

  const totalMs = Date.now() - runStart;
  if (reply) {
    console.log(`[agent-flow] RUN_SUCCESS messageId=${mid} durationMs=${totalMs} replyLen=${reply.length}`);
  } else {
    console.log(`[agent-flow] RUN_SUCCESS messageId=${mid} durationMs=${totalMs} replyLen=0 (fallback)`);
  }

  return reply || "No tengo esa información registrada. Un asesor humano puede ayudarte.";
}
