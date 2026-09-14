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
    if (updated[slot.name] !== undefined) continue; // Ya tiene valor

    const value = extractSlotValue(normalized, slot);
    if (value !== null) {
      extracted[slot.name] = value;
      updated[slot.name] = value;
    }
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
  // Formato "a las 6", "a las 10:30", "6am", "14:00"
  const timePatterns = [
    /a\s+las?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i,
    /(\d{1,2}):(\d{2})\s*(am|pm)?/i,
    /(\d{1,2})\s*(am|pm)/i,
  ];
  for (const pattern of timePatterns) {
    const match = pattern.exec(text);
    if (match) return match[0];
  }
  return null;
}

function extractNumberValue(text: string, _slot: SlotDefinition): number | null {
  const match = /\b(\d+)\b/.exec(text);
  return match ? Number(match[1]) : null;
}

function extractStringValue(text: string, _slot: SlotDefinition): string | null {
  // Para strings, devolver el texto relevante
  return text.length > 0 ? text : null;
}
