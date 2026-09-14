import type { Intent, SlotDefinition, SlotExtractionResult, ConversationStateData } from "./types";
import { INTENT_DEFINITIONS } from "./intent-definitions";

/**
 * Extrae datos del mensaje del usuario y actualiza los slots del estado.
 * Soporta extracción múltiple ("A1 y martes").
 */
export function extractSlots(
  text: string,
  intent: Intent,
  state: ConversationStateData,
): SlotExtractionResult {
  const def = INTENT_DEFINITIONS.find((d) => d.intent === intent);
  if (!def) {
    return { extracted: {}, updated: state.slots, missing: [], isComplete: true };
  }

  const allSlots = [...def.requiredSlots, ...def.optionalSlots];
  const extracted: Record<string, unknown> = {};
  const updated = { ...state.slots };
  const normalized = text.toLowerCase().trim();

  // Extraer cada slot del texto
  for (const slot of allSlots) {
    if (updated[slot.name] !== undefined) {
      // Permitir actualización si el usuario proporciona un valor explícito
      // y el nuevo valor es diferente (corrección de un dato anterior)
      const newValue = extractSlotValue(normalized, slot);
      if (newValue !== null && newValue !== updated[slot.name]) {
        updated[slot.name] = newValue;
        extracted[slot.name] = newValue;
      }
      continue;
    }

    const value = extractSlotValue(normalized, slot);
    if (value !== null) {
      extracted[slot.name] = value;
      updated[slot.name] = value;
    }
  }

  // Detección post-extracción: examen próximo mencionado por el usuario
  const examDate = extractExamDate(normalized);
  if (examDate && updated.examen_fecha === undefined) {
    extracted.examen_fecha = examDate;
    updated.examen_fecha = examDate;
  }

  // Identificar slots requeridos que faltan
  const missing = def.requiredSlots.filter((s) => updated[s.name] === undefined);
  const isComplete = missing.length === 0;

  return { extracted, updated, missing, isComplete };
}

/**
 * Extrae el valor de un slot específico del texto.
 */
function extractSlotValue(text: string, slot: SlotDefinition): unknown {
  switch (slot.type) {
    case "enum":
      return extractEnumValue(text, slot);
    case "date":
      return extractDateValue(text, slot);
    case "time":
      return extractTimeValue(text, slot);
    case "number":
      return extractNumberValue(text, slot);
    case "string":
      return extractStringValue(text, slot);
    default:
      return null;
  }
}

function extractEnumValue(text: string, slot: SlotDefinition): string | null {
  if (!slot.enum) return null;
  for (const val of slot.enum) {
    if (text.includes(val.toLowerCase())) {
      return val;
    }
  }
  // Mapeos especiales
  if (slot.name === "actividad") {
    if (/pr[aá]ctic|manejar|conducir|clase/.test(text)) return "practica";
    if (/simulacro|simulaci[oó]n|prueba/.test(text)) return "simulacro";
  }
  if (slot.name === "circuito") {
    if (/oficial/.test(text)) return "oficial";
    if (/alternativo|alterno/.test(text)) return "alternativo";
  }
  return null;
}

function extractDateValue(text: string, _slot: SlotDefinition): string | null {
  const datePatterns = [
    { pattern: /\bhoy\b/, value: "hoy" },
    { pattern: /\bmañana\b/, value: "mañana" },
    { pattern: /\bpasado\s+mañana\b/, value: "pasado_mañana" },
    { pattern: /\blunes\b/, value: "lunes" },
    { pattern: /\bmartes\b/, value: "martes" },
    { pattern: /\bmi[eé]rcoles\b/, value: "miércoles" },
    { pattern: /\bjueves\b/, value: "jueves" },
    { pattern: /\bviernes\b/, value: "viernes" },
    { pattern: /\bs[aá]bado\b/, value: "sábado" },
    { pattern: /\bdomingo\b/, value: "domingo" },
    { pattern: /\bel\s+(\d{1,2})\b/, value: null }, // "el 15"
  ];
  for (const { pattern } of datePatterns) {
    const match = pattern.exec(text);
    if (match) return match[0];
  }
  return null;
}

function extractTimeValue(text: string, _slot: SlotDefinition): string | null {
  // Patrones con AM/PM (explícito) → extraer y normalizar
  const ampmPatterns = [
    // "10:30 pm" / "10:30 p. m."
    { regex: /(\d{1,2}):(\d{2})\s*p\.?\s*m\.?/i, handler: (m: RegExpMatchArray) => normalizeTime(m[1], m[2], true) },
    // "10 pm" / "10 p. m."
    { regex: /(\d{1,2})\s*p\.?\s*m\.?/i, handler: (m: RegExpMatchArray) => normalizeTime(m[1], undefined, true) },
    // "10:30 am" / "10:30 a. m."
    { regex: /(\d{1,2}):(\d{2})\s*a\.?\s*m\.?/i, handler: (m: RegExpMatchArray) => normalizeTime(m[1], m[2], false) },
    // "10 am" / "10 a. m."
    { regex: /(\d{1,2})\s*a\.?\s*m\.?/i, handler: (m: RegExpMatchArray) => normalizeTime(m[1], undefined, false) },
    // "a las 10:30 pm" / "a las 10:30 p. m."
    { regex: /a\s+las?\s+(\d{1,2}):(\d{2})\s*p\.?\s*m\.?/i, handler: (m: RegExpMatchArray) => normalizeTime(m[1], m[2], true) },
    // "a las 10 pm" / "a las 10 p. m."
    { regex: /a\s+las?\s+(\d{1,2})\s*p\.?\s*m\.?/i, handler: (m: RegExpMatchArray) => normalizeTime(m[1], undefined, true) },
    // "a las 10:30 am" / "a las 10:30 a. m."
    { regex: /a\s+las?\s+(\d{1,2}):(\d{2})\s*a\.?\s*m\.?/i, handler: (m: RegExpMatchArray) => normalizeTime(m[1], m[2], false) },
    // "a las 10 am" / "a las 10 a. m."
    { regex: /a\s+las?\s+(\d{1,2})\s*a\.?\s*m\.?/i, handler: (m: RegExpMatchArray) => normalizeTime(m[1], undefined, false) },
  ];

  // Patrones en formato 24h explícito (con ":") → extraer directamente
  const h24Patterns = [
    // "22:00" / "10:30"
    { regex: /\b(\d{1,2}):(\d{2})\b/, handler: (m: RegExpMatchArray) => normalizeTime(m[1], m[2], undefined) },
    // "a las 10:30"
    { regex: /a\s+las?\s+(\d{1,2}):(\d{2})/, handler: (m: RegExpMatchArray) => normalizeTime(m[1], m[2], undefined) },
  ];

  // Buscar AM/PM primero (más específico)
  for (const { regex, handler } of ampmPatterns) {
    const match = regex.exec(text);
    if (match) return handler(match);
  }

  // Buscar formato 24h explícito (con ":")
  for (const { regex, handler } of h24Patterns) {
    const match = regex.exec(text);
    if (match) return handler(match);
  }

  // Sin AM/PM y sin ":" → HORA AMBIGUA, NO extraer
  // "a las 3", "sobre las 3", "tipo 3" → null (pendiente de aclaración)
  return null;
}

function normalizeTime(
  hourStr: string,
  minStr: string | undefined,
  isPm: boolean | undefined,
): string {
  let h = parseInt(hourStr, 10);
  const m = minStr ? parseInt(minStr, 10) : 0;

  if (isPm === true) {
    // PM explícito
    if (h < 12) h += 12;
  } else if (isPm === false) {
    // AM explícito
    if (h === 12) h = 0; // 12 AM = 00:00
  }
  // isPm === undefined: no convertir, usar hora tal cual
  // Solo se usa para formato 24h explícito (con ":") ej: "10:30" → 10:30
  // Nota: "a las 3" sin AM/PM ya no llega aquí (extractTimeValue devuelve null)

  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function extractNumberValue(text: string, _slot: SlotDefinition): number | null {
  const match = /\b(\d+)\b/.exec(text);
  return match ? Number(match[1]) : null;
}

function extractStringValue(text: string, _slot: SlotDefinition): string | null {
  // Para strings, devolver el texto relevante
  return text.length > 0 ? text : null;
}

/**
 * Extrae la fecha de examen mencionada por el usuario.
 * Ej: "mi examen de manejo es el sábado" → "sábado"
 */
function extractExamDate(text: string): string | null {
  const patterns = [
    /mi\s+examen\s+(?:de\s+manejo\s+)?(?:es\s+)?(?:el\s+)?(lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo)/i,
    /examen\s+(?:de\s+manejo\s+)?(?:es\s+)?(?:el\s+)?(lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo)/i,
  ];
  for (const p of patterns) {
    const m = p.exec(text);
    if (m) {
      // Normalizar sin acentos para consistencia
      return m[1].toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    }
  }
  return null;
}

/**
 * Detecta si un nuevo valor de slot contradice un valor anterior.
 * Ejemplo: timePreference="mañana" + nuevo valor "2 pm" → contradicción.
 * Se resuelve como corrección, no como error.
 */
export function detectSlotConflict(
  slotName: string,
  existingValue: unknown,
  newValue: unknown,
): { hasConflict: boolean; resolution: "update" | "keep" | "ask" } {
  if (!existingValue || !newValue) return { hasConflict: false, resolution: "update" };
  if (existingValue === newValue) return { hasConflict: false, resolution: "keep" };

  // Conflicto temporal: "mañana" vs "2 pm"
  if (slotName === "hora" || slotName === "timePreference") {
    // Si el nuevo valor es una hora concreta, reemplazar
    if (/^\d{1,2}:\d{2}$/.test(String(newValue)) || /[ap]\.?m\.?/i.test(String(newValue))) {
      return { hasConflict: true, resolution: "update" };
    }
  }

  // Conflicto de fecha: "viernes" vs "miércoles"
  if (slotName === "fecha") {
    return { hasConflict: true, resolution: "update" };
  }

  // Conflicto de categoría: "A1" vs "A2B"
  if (slotName === "categoria") {
    return { hasConflict: true, resolution: "update" };
  }

  // Conflicto de circuito: "oficial" vs "alterno"
  if (slotName === "circuito") {
    return { hasConflict: true, resolution: "update" };
  }

  return { hasConflict: false, resolution: "update" };
}
