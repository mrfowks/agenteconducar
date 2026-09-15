import type { ConversationContext, Intent } from "./conversation-context";
import type { TurnUnderstanding } from "./turn-understanding";

/**
 * Resuelve la intención activa, preservando contexto cuando el usuario
 * solo aporta información adicional sin cambiar de objetivo.
 */
export function resolveIntent(
  ctx: ConversationContext,
  turn: TurnUnderstanding,
): { activeIntent: Intent | null; goal: ConversationContext["goal"]; changed: boolean } {
  const current = ctx.activeIntent;
  const detected = turn.detectedIntent;
  const confidence = turn.intentConfidence;

  // 1. Sin intención detectada → mantener actual
  if (!detected) {
    return { activeIntent: current, goal: ctx.goal, changed: false };
  }

  // 2. Cambio explícito → aceptar
  if (turn.isExplicitChange) {
    return {
      activeIntent: detected,
      goal: deriveGoal(detected, ctx.slots),
      changed: true,
    };
  }

  // 3. Sin intención actual → aceptar detectada
  if (!current) {
    return {
      activeIntent: detected,
      goal: deriveGoal(detected, ctx.slots),
      changed: true,
    };
  }

  // 4. Misma intención → mantener
  if (detected === current) {
    return { activeIntent: current, goal: ctx.goal, changed: false };
  }

  // 5. Sub-pregunta (HORARIOS/PAGO/PAQUETE durante otra intención) → mantener actual
  if (isSubQuestion(detected, current)) {
    return { activeIntent: current, goal: ctx.goal, changed: false };
  }

  // 6. Confianza alta + diferente → cambiar
  if (confidence > 0.8) {
    return {
      activeIntent: detected,
      goal: deriveGoal(detected, ctx.slots),
      changed: true,
    };
  }

  // 7. Confianza baja → mantener actual
  return { activeIntent: current, goal: ctx.goal, changed: false };
}

function isSubQuestion(detected: Intent, current: Intent): boolean {
  if (detected === "HORARIOS" && current !== "HORARIOS") return true;
  if (detected === "PAGO" && ["RESERVA", "SIMULACRO", "PRACTICA", "ALQUILER_EXAMEN"].includes(current)) return true;
  if (detected === "PAQUETE" && current !== "PAQUETE" && current !== "HORARIOS") return true;
  return false;
}

function deriveGoal(intent: Intent | null, slots: ConversationContext["slots"]): ConversationContext["goal"] {
  switch (intent) {
    case "PRACTICA":
    case "SIMULACRO":
    case "RESERVA":
      return { type: "BOOK_SERVICE", service: intent === "SIMULACRO" ? "simulacro" : "practica" };
    case "ALQUILER_EXAMEN":
      return { type: "RENT_VEHICLE" };
    case "PAQUETE":
      return { type: "VIEW_PACKAGES" };
    case "HORARIOS":
      return { type: "VIEW_SCHEDULE" };
    case "HANDOFF":
      return { type: "TALK_TO_HUMAN" };
    default:
      return slots.categoria ? { type: "BOOK_SERVICE", service: "practica" } : { type: "AMBIGUOUS" };
  }
}
