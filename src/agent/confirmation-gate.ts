import type { ConversationPhase } from "./types";

// ── Tipos ───────────────────────────────────────────────────────

export interface ConfirmationGateInput {
  phase: ConversationPhase;
  slotsComplete: boolean;
  userText: string;
  hasRecommendation: boolean;
  hasPendingSideEffects: boolean;
}

export interface ConfirmationGateOutput {
  nextPhase: ConversationPhase;
  action: "WAIT" | "ASK_CONFIRM" | "EXECUTE" | "POST_ACTION_REVIEW" | "MODIFY";
  blocked: boolean;
  blockReason?: string;
}

// ── Patrones de confirmación/rechazo ────────────────────────────

const CONFIRMATION_PATTERNS =
  /^(s[ií]|as[ií]\s+es|correcto|dale|ok|confirmo|claro|perfecto|exacto|hazlo|reserva|confirmado|est[aá]\s+bien)(\s|$)/i;

const REJECTION_PATTERNS =
  /^(no|nah|para\s+nada|mejor\s+no|espera|quiero\s+cambiar|cambiemos|cambiar|mejor\s+otro|en\s+realidad\s+no)(\s|$)/i;

const MODIFICATION_PATTERNS =
  /(mejor|cambio|cambiar|espera|quiero\s+otro|quiero\s+cambiar|a\s+las?\s+\d|el\s+\w+|otro\s+circuito|otro\s+d[ií]a)/i;

// ── Confirmation Gate ───────────────────────────────────────────

/**
 * Controla las transiciones GATHERING → CONFIRMING → EXECUTING → POST_ACTION.
 * NUNCA ejecuta automáticamente. Siempre requiere confirmación explícita.
 */
export function evaluateGate(input: ConfirmationGateInput): ConfirmationGateOutput {
  const { phase, slotsComplete, userText } = input;
  const normalized = userText.toLowerCase().trim();

  // ── HANDOFF: siempre permitido desde cualquier fase ──
  if (isHandoffRequest(normalized)) {
    return {
      nextPhase: "HANDOFF",
      action: "EXECUTE",
      blocked: false,
    };
  }

  // ── Transiciones según fase actual ──

  switch (phase) {
    case "IDLE":
      // IDLE → GATHERING (al detectar intención)
      return {
        nextPhase: "GATHERING",
        action: "WAIT",
        blocked: false,
      };

    case "GATHERING":
      if (slotsComplete) {
        // Todos los slots completos → CONFIRMING
        return {
          nextPhase: "CONFIRMING",
          action: "ASK_CONFIRM",
          blocked: false,
        };
      }
      // Slots incompletos → continuar GATHERING
      return {
        nextPhase: "GATHERING",
        action: "WAIT",
        blocked: false,
      };

    case "CONFIRMING":
      // Usuario confirma → EXECUTING
      if (isConfirmation(normalized)) {
        return {
          nextPhase: "EXECUTING",
          action: "EXECUTE",
          blocked: false,
        };
      }
      // Usuario rechaza → volver a GATHERING
      if (isRejection(normalized)) {
        return {
          nextPhase: "GATHERING",
          action: "MODIFY",
          blocked: false,
        };
      }
      // Usuario modifica datos → volver a GATHERING
      if (isModification(normalized)) {
        return {
          nextPhase: "GATHERING",
          action: "MODIFY",
          blocked: false,
        };
      }
      // Sin confirmación clara → mantener CONFIRMING
      return {
        nextPhase: "CONFIRMING",
        action: "ASK_CONFIRM",
        blocked: false,
      };

    case "EXECUTING":
      // EXECUTING → POST_ACTION (después de tool execution)
      return {
        nextPhase: "POST_ACTION",
        action: "POST_ACTION_REVIEW",
        blocked: false,
      };

    case "POST_ACTION":
      // POST_ACTION: usuario puede modificar o nueva intención
      if (isModification(normalized) || !slotsComplete) {
        return {
          nextPhase: "GATHERING",
          action: "MODIFY",
          blocked: false,
        };
      }
      return {
        nextPhase: "POST_ACTION",
        action: "WAIT",
        blocked: false,
      };

    case "HANDOFF":
      // En HANDOFF: no procesar más
      return {
        nextPhase: "HANDOFF",
        action: "WAIT",
        blocked: true,
        blockReason: "Conversación derivada a asesor humano",
      };

    default:
      return {
        nextPhase: "IDLE",
        action: "WAIT",
        blocked: false,
      };
  }
}

// ── Helpers ─────────────────────────────────────────────────────

function isConfirmation(text: string): boolean {
  return CONFIRMATION_PATTERNS.test(text);
}

function isRejection(text: string): boolean {
  return REJECTION_PATTERNS.test(text);
}

function isModification(text: string): boolean {
  return MODIFICATION_PATTERNS.test(text) && !isConfirmation(text);
}

function isHandoffRequest(text: string): boolean {
  // Alinear con detectEscalationTrigger (payments/service.ts):
  // - "asesor" standalone (sin sufijo como "ía", "ías") → handoff
  // - "hablar con/quiero/necesito/pásame con" + asesor/persona/humano/alguien → handoff
  // NO activar por mención contextual ("¿Qué función tiene el asesor?")
  if (/^asesor[!.?]*$/i.test(text.trim())) return true;
  return /\b(hablar\s+con|quiero|necesito|p[aá]same\s+con)\s+(un(?:a)?\s+)?(asesor|agente|persona|humano|alguien)\b/i.test(text);
}

/**
 * Genera un resumen de confirmación con los slots disponibles.
 */
export function buildConfirmationSummary(
  slots: Record<string, unknown>,
  recommendation?: { target: string; reason: string } | null,
): string {
  const parts: string[] = [];

  if (slots.actividad) parts.push(`Servicio: ${slots.actividad}`);
  if (slots.categoria) parts.push(`Categoría: ${slots.categoria}`);
  if (slots.circuito) parts.push(`Circuito: ${slots.circuito}`);
  if (slots.fecha) parts.push(`Fecha: ${slots.fecha}`);
  if (slots.hora) parts.push(`Hora: ${slots.hora}`);

  if (recommendation) {
    parts.push(`Recomendación: ${recommendation.target}`);
  }

  return parts.length > 0
    ? `Resumen:\n${parts.join("\n")}\n\n¿Es correcto?`
    : "¿Confirmas estos datos?";
}
