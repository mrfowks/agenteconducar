import type { Intent, IntentDetectionResult } from "./types";
import { INTENT_DEFINITIONS } from "./intent-definitions";

/**
 * Detecta la intención del usuario basándose en:
 * 1. "examen de reglas" → HANDOFF (prioridad máxima)
 * 2. Detección de cambio explícito
 * 3. Aliases deterministas (CITA → RESERVA)
 * 4. Preservación de intención activa para subpreguntas
 * 5. Fallback: mantener intención activa si existe
 */
export function detectIntent(
  text: string,
  currentIntent: Intent | null,
): IntentDetectionResult {
  const normalized = text.toLowerCase().trim();

  // 0. "examen de reglas" → HANDOFF (prioridad máxima, antes de aliases)
  if (/examen.*reglas|reglas.*examen/i.test(normalized)) {
    return {
      intent: "HANDOFF",
      confidence: 0.95,
      isChange: currentIntent !== "HANDOFF",
      isExplicitChange: false,
      rawText: text,
    };
  }

  // 1. Detectar cambio explícito PRIMERO
  const isExplicitChange = detectExplicitChange(normalized);

  // 2. Buscar en aliases de intenciones
  for (const def of INTENT_DEFINITIONS) {
    for (const alias of def.aliases) {
      if (normalized.includes(alias.toLowerCase())) {
        const detectedIntent = def.intent;
        const isChange = currentIntent !== null && currentIntent !== detectedIntent;

        // PRESERVACIÓN: si hay intención activa y NO es cambio explícito,
        // y la intención detectada es HORARIOS/PAGO/OTROS (subpregunta),
        // mantener la intención activa
        if (currentIntent && !isExplicitChange && isSubQuestion(detectedIntent, currentIntent)) {
          return {
            intent: currentIntent, // Mantener intención activa
            confidence: 0.8,
            isChange: false,
            isExplicitChange: false,
            rawText: text,
          };
        }

        return {
          intent: detectedIntent,
          confidence: 0.9,
          isChange,
          isExplicitChange,
          rawText: text,
        };
      }
    }
  }

  // 3. Fallback: mantener intención activa si existe
  return {
    intent: currentIntent ?? "OTROS",
    confidence: 0.3,
    isChange: false,
    isExplicitChange: false,
    rawText: text,
  };
}

/**
 * Detecta si el usuario explícitamente pide cambiar de intención.
 * Ejemplo: "en realidad quiero un simulacro", "cambio de idea"
 */
function detectExplicitChange(text: string): boolean {
  const changePatterns = [
    /\ben\s+realidad\b/,
    /\bcambio\s+de\s+(idea|opini[oó]n)\b/,
    /\bmejor\s+(quiero|deseo)\b/,
    /\bno,\s+(quiero|deseo|prefiero)\b/,
    /\bquiero\s+(cambiar|modificar)\b/,
  ];
  return changePatterns.some((p) => p.test(text));
}

/**
 * Determina si una intención detectada es una "subpregunta" dentro de un flujo activo.
 * Ejemplo: preguntar "¿qué horarios tienen?" durante ALQUILER_EXAMEN no debe cambiar la intención.
 */
function isSubQuestion(detected: Intent, current: Intent): boolean {
  // HORARIOS es una consulta transversal que no destruye el flujo activo
  if (detected === "HORARIOS" && current !== "HORARIOS") return true;
  // PAGO es parte del flujo de reserva
  if (detected === "PAGO" && (current === "RESERVA" || current === "SIMULACRO" || current === "PRACTICA" || current === "ALQUILER_EXAMEN")) return true;
  // PAQUETE puede ser una recomendación dentro de otro flujo
  if (detected === "PAQUETE" && current !== "PAQUETE" && current !== "HORARIOS") return true;
  return false;
}

/**
 * Verifica si una intención es un alias conocido de otra.
 */
export function resolveAlias(text: string): Intent | null {
  const normalized = text.toLowerCase().trim();
  for (const def of INTENT_DEFINITIONS) {
    for (const alias of def.aliases) {
      if (normalized === alias.toLowerCase()) {
        return def.intent;
      }
    }
  }
  return null;
}
