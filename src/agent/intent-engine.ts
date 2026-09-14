import type { Intent, IntentDetectionResult } from "./types";
import { INTENT_DEFINITIONS } from "./intent-definitions";

/**
 * Detecta la intención del usuario basándose en:
 * 1. Aliases deterministas (CITA → RESERVA)
 * 2. Regex para patrones conocidos
 * 3. Fallback a clasificación (no implementado aquí, se delega a OpenAI)
 */
export function detectIntent(
  text: string,
  currentIntent: Intent | null,
): IntentDetectionResult {
  const normalized = text.toLowerCase().trim();

  // 1. Buscar en aliases de intenciones
  for (const def of INTENT_DEFINITIONS) {
    for (const alias of def.aliases) {
      if (normalized.includes(alias.toLowerCase())) {
        const isChange = currentIntent !== null && currentIntent !== def.intent;
        const isExplicitChange = detectExplicitChange(normalized);

        return {
          intent: def.intent,
          confidence: 0.9,
          isChange,
          isExplicitChange,
          rawText: text,
        };
      }
    }
  }

  // 2. Detección por patrones específicos
  if (/examen.*reglas|reglas.*examen/i.test(normalized)) {
    return {
      intent: "HANDOFF",
      confidence: 0.95,
      isChange: currentIntent !== "HANDOFF",
      isExplicitChange: false,
      rawText: text,
    };
  }

  // 3. Fallback: no detectada
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
