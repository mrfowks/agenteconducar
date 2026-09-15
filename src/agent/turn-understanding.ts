import type { ConversationContext, Intent } from "./conversation-context";

export interface TurnUnderstanding {
  // Intención detectada
  detectedIntent: Intent | null;
  intentConfidence: number;
  isExplicitChange: boolean;

  // Información extraída
  newSlots: Partial<Record<string, unknown>>;
  facts: { content: string; slotMapping: string | null }[];
  negations: { content: string; negatedSlot: string | null; negatedValue: unknown }[];

  // Análisis del turno
  isQuestion: boolean;
  isNegation: boolean;
  isConfirmation: boolean;
  isRejection: boolean;
  isCorrection: boolean;
  needsClarification: boolean;

  // Respuesta a pregunta anterior
  answersPreviousQuestion: boolean;
  answeredSlot: string | null;
}

/**
 * Interpreta el turno del cliente usando el contexto actual.
 * NO ejecuta tools. NO decide reservas. Solo entiende.
 */
export function understandTurn(text: string, ctx: ConversationContext): TurnUnderstanding {
  const normalized = text.toLowerCase().trim();

  // 1. Detectar intención
  const { intent, confidence, isExplicitChange } = detectIntent(normalized, ctx.activeIntent);

  // 2. Detectar si es pregunta
  const isQuestion = /\?|¿|cu[aá]nto|c[oó]mo|d[oó]nde|cu[aá]ndo|\bqu[eé]\b|por\s+qu[eé]|hay\s+|atienden|tienen/.test(normalized);

  // 3. Detectar negación
  const isNegation = /^(no|nah|no\s+quiero|no\s+necesito|no\s+me\s+interesa|no\s+el|no\s+la|no\s+los|no\s+las|no\s+eso|no\s+ese|no\s+esa)/i.test(normalized);

  // 4. Detectar confirmación/rechazo
  const isConfirmation = /^(s[ií]|as[ií]\s+es|correcto|dale|ok|confirmo|claro|perfecto|exacto|hazlo|reserva|confirmado|est[aá]\s+bien|afirmativo|eso\s+es|eso\s+mismo)/i.test(normalized);
  const isRejection = /^(no|nah|para\s+nada|mejor\s+no|espera|quiero\s+cambiar|cambiemos|negativo|no\s+quiero\s+eso|no\s+me\s+gusta)/i.test(normalized);

  // 5. Detectar corrección
  const isCorrection = /(mejor|cambio|cambiar|espera|quiero\s+otro|quiero\s+cambiar|en\s+realidad|mejor\s+dicho|no,\s+me\s+refer[ií]a|no,\s+quiero|no,\s+eso\s+no)/i.test(normalized);

  // 6. Extraer slots
  const newSlots = extractSlotsFromText(normalized, ctx);

  // 7. Extraer hechos
  const facts = extractFacts(normalized, ctx);

  // 8. Extraer negaciones
  const negations = extractNegations(normalized, ctx);

  // 9. Verificar si responde a pregunta anterior
  const { answersPreviousQuestion, answeredSlot } = checkIfAnswersPrevious(normalized, ctx);

  // 10. Verificar si necesita aclaración
  const needsClarification = !intent && confidence < 0.5 && !isQuestion && !isConfirmation;

  return {
    detectedIntent: intent,
    intentConfidence: confidence,
    isExplicitChange,
    newSlots,
    facts,
    negations,
    isQuestion,
    isNegation,
    isConfirmation,
    isRejection,
    isCorrection,
    needsClarification,
    answersPreviousQuestion,
    answeredSlot,
  };
}

// ── Helpers ─────────────────────────────────────────────────────

function detectIntent(text: string, currentIntent: Intent | null): { intent: Intent | null; confidence: number; isExplicitChange: boolean } {
  // Patrones de intención (más ricos que el intent-engine actual)
  const patterns: [RegExp, Intent, number][] = [
    [/\b(alquilar|alquiler)\b.*\b(veh[ií]culo|carro|auto|exam)/i, "ALQUILER_EXAMEN", 0.9],
    [/\b(simulacro|simulaci[oó]n)\b/i, "SIMULACRO", 0.85],
    [/\b(practicar|pr[aá]ctica)\b/i, "PRACTICA", 0.85],
    [/\b(paquete|paquetes)\b/i, "PAQUETE", 0.8],
    [/\b(horario|horarios|atienden|abiertos?)\b/i, "HORARIOS", 0.8],
    [/\b(reservar|reserva|agendar|cita)\b/i, "RESERVA", 0.8],
    [/\b(asesor|humano|persona)\b/i, "HANDOFF", 0.9],
  ];

  for (const [regex, intent, conf] of patterns) {
    if (regex.test(text)) {
      const isExplicitChange = currentIntent !== null && currentIntent !== intent &&
        /(en\s+realidad|mejor|cambio|no,\s+quiero|no,\s+me\s+refer[ií]a)/i.test(text);
      return { intent, confidence: conf, isExplicitChange };
    }
  }

  // Sin intención clara
  return { intent: null, confidence: 0.2, isExplicitChange: false };
}

function extractSlotsFromText(text: string, ctx: ConversationContext): Record<string, unknown> {
  const slots: Record<string, unknown> = {};

  // Categoría
  const catMatch = /\b(A1|A2|A3)\b/i.exec(text);
  if (catMatch) slots.categoria = catMatch[1].toUpperCase();

  // Circuito
  if (/\boficial\b/i.test(text)) slots.circuito = "oficial";
  if (/\balternativo\b|\balterno\b/i.test(text)) slots.circuito = "alternativo";

  // Hora (normalizada)
  const horaMatch = extractTime(text);
  if (horaMatch) slots.hora = horaMatch;

  // Fecha (relativa)
  const fechaMatch = extractDate(text);
  if (fechaMatch) slots.fecha = fechaMatch;

  // Experiencia
  if (/\b(practic(?:ar|é|o)|sabe?\s+manejar|ya\s+manejo|he\s+practicado)\b/i.test(text)) {
    slots.experiencia = "sabe_manejar";
  }
  if (/\b(primera\s+vez|desde\s+cero|no\s+s[eé]|no\s+manejo|empezando)\b/i.test(text)) {
    slots.experiencia = "desde_cero";
  }

  // Actividad
  if (/\b(practicar|pr[aá]ctica)\b/i.test(text)) slots.actividad = "practica";
  if (/\b(simulacro)\b/i.test(text)) slots.actividad = "simulacro";

  // Examen fecha (use [a-záéíóúñü]+ to match accented characters like "sábado")
  const examenMatch = /mi\s+exam(?:en)?\s+(?:es|será|esta)\s+(?:el\s+)?([a-záéíóúñü]+)/i.exec(text);
  if (examenMatch) slots.examen_fecha = examenMatch[1];

  // Preferencias
  if (/\b(por\s+la\s+mañana|en\s+la\s+mañana|mañana\s+temprano)\b/i.test(text)) {
    slots.prefersMorning = true;
  }
  if (/\b(por\s+la\s+tarde|en\s+la\s+tarde|tarde|noche)\b/i.test(text)) {
    slots.prefersMorning = false;
  }

  return slots;
}

function extractTime(text: string): string | null {
  // "3 pm" → "15:00", "10:30 am" → "10:30", "14:00" → "14:00"
  const patterns = [
    { regex: /(\d{1,2}):(\d{2})\s*p\.?\s*m\.?/i, handler: (m: RegExpMatchArray) => normalizeTime(m[1], m[2], true) },
    { regex: /(\d{1,2})\s*p\.?\s*m\.?/i, handler: (m: RegExpMatchArray) => normalizeTime(m[1], undefined, true) },
    { regex: /(\d{1,2}):(\d{2})\s*a\.?\s*m\.?/i, handler: (m: RegExpMatchArray) => normalizeTime(m[1], m[2], false) },
    { regex: /(\d{1,2})\s*a\.?\s*m\.?/i, handler: (m: RegExpMatchArray) => normalizeTime(m[1], undefined, false) },
    { regex: /(\d{1,2}):(\d{2})/i, handler: (m: RegExpMatchArray) => normalizeTime(m[1], m[2], undefined) },
    { regex: /a\s+las?\s+(\d{1,2})(?::(\d{2}))?/i, handler: (m: RegExpMatchArray) => normalizeTime(m[1], m[2], undefined) },
  ];

  for (const { regex, handler } of patterns) {
    const match = regex.exec(text);
    if (match) return handler(match);
  }
  return null;
}

function normalizeTime(h: string, m: string | undefined, isPm: boolean | undefined): string {
  let hour = parseInt(h, 10);
  const min = m ? parseInt(m, 10) : 0;
  if (isPm === true && hour < 12) hour += 12;
  if (isPm === false && hour === 12) hour = 0;
  return `${String(hour).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

function extractDate(text: string): string | null {
  const datePatterns = [
    { regex: /\bhoy\b/i, value: "hoy" },
    // "mañana" como fecha (NO cuando es preferencia horaria: "en la mañana", "por la mañana")
    { regex: /(?<!en\s+la\s+|por\s+la\s+)\bmañana\b/i, value: "mañana" },
    { regex: /\bpasado\s+mañana\b/i, value: "pasado_mañana" },
    { regex: /\blunes\b/i, value: "lunes" },
    { regex: /\bmartes\b/i, value: "martes" },
    { regex: /\bmi[eé]rcoles\b/i, value: "miércoles" },
    { regex: /\bjueves\b/i, value: "jueves" },
    { regex: /\bviernes\b/i, value: "viernes" },
    { regex: /\bs[aá]bado\b/i, value: "sábado" },
    { regex: /\bdomingo\b/i, value: "domingo" },
  ];

  for (const { regex, value } of datePatterns) {
    if (regex.test(text)) return value;
  }
  return null;
}

function extractFacts(text: string, _ctx: ConversationContext): { content: string; slotMapping: string | null }[] {
  const facts: { content: string; slotMapping: string | null }[] = [];

  // "mi examen es el sábado" (use [a-záéíóúñü]+ for accented chars)
  const examMatch = /mi\s+exam(?:en)?\s+(?:es|será|esta)\s+(?:el\s+)?([a-záéíóúñü]+)/i.exec(text);
  if (examMatch) {
    facts.push({ content: `Examen: ${examMatch[1]}`, slotMapping: "examen_fecha" });
  }

  // "ya practiqué antes"
  if (/\b(ya\s+practic(?:ar|é|o)|he\s+practicado|antes)\b/i.test(text)) {
    facts.push({ content: "Ha practicado antes", slotMapping: "experiencia" });
  }

  return facts;
}

function extractNegations(text: string, _ctx: ConversationContext): { content: string; negatedSlot: string | null; negatedValue: unknown }[] {
  const negations: { content: string; negatedSlot: string | null; negatedValue: unknown }[] = [];

  // "no quiero el oficial"
  const circuitNeg = /no\s+quiero\s+(?:el\s+)?(?:circuito\s+)?(oficial|alternativo)/i.exec(text);
  if (circuitNeg) {
    negations.push({ content: `No quiere ${circuitNeg[1]}`, negatedSlot: "circuito", negatedValue: circuitNeg[1].toLowerCase() });
  }

  // "no el mismo día", "no quiero practicar el mismo día", "no practicar el mismo día"
  if (/no\s+(?:\w+\s+){0,5}(?:el\s+)?mismo\s+d[ií]a/i.test(text)) {
    negations.push({ content: "No el mismo día del examen", negatedSlot: "fecha", negatedValue: "same_as_exam" });
  }

  return negations;
}

function checkIfAnswersPrevious(text: string, ctx: ConversationContext): { answersPreviousQuestion: boolean; answeredSlot: string | null } {
  if (!ctx.lastAssistantQuestion) return { answersPreviousQuestion: false, answeredSlot: null };

  // Si la última pregunta fue sobre categoría y el texto contiene A1/A2/A3
  if (/categor/i.test(ctx.lastAssistantQuestion)) {
    const catMatch = /\b(A1|A2|A3)\b/i.exec(text);
    if (catMatch) return { answersPreviousQuestion: true, answeredSlot: "categoria" };
  }

  // Si la última pregunta fue sobre circuito
  if (/circuito/i.test(ctx.lastAssistantQuestion)) {
    if (/\boficial\b|\balternativo\b|\balterno\b/i.test(text)) {
      return { answersPreviousQuestion: true, answeredSlot: "circuito" };
    }
  }

  // Si la última pregunta fue sobre fecha
  if (/d[ií]a|fecha/i.test(ctx.lastAssistantQuestion)) {
    if (extractDate(text)) return { answersPreviousQuestion: true, answeredSlot: "fecha" };
  }

  // Si la última pregunta fue sobre hora
  if (/hora/i.test(ctx.lastAssistantQuestion)) {
    if (extractTime(text)) return { answersPreviousQuestion: true, answeredSlot: "hora" };
  }

  // Si la última pregunta fue de confirmación
  if (/correcto|confirm/i.test(ctx.lastAssistantQuestion)) {
    if (/^(s[ií]|no|correcto|dale)/i.test(text)) {
      return { answersPreviousQuestion: true, answeredSlot: "confirmation" };
    }
  }

  return { answersPreviousQuestion: false, answeredSlot: null };
}
