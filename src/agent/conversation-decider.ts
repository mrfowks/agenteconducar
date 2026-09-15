import type { ConversationContext, DecisionAction, ConversationSlots } from "./conversation-context";
import type { TurnUnderstanding } from "./turn-understanding";
import { evaluateRecommendation } from "./recommendation-engine";
import { resolveContext } from "./context-resolver";

export interface ConversationDecision {
  action: DecisionAction;
  reason: string;
  targetSlot?: string;
  question?: string;
  recommendation?: { type: string; target: string; reason: string };
  confirmationSummary?: string;
  tool?: string;
  toolArgs?: Record<string, unknown>;
}

/**
 * Decide qué hacer basándose en el contexto completo.
 * Prioriza la comprensión del cliente sobre la recolección de slots.
 */
export function decide(ctx: ConversationContext, turn: TurnUnderstanding): ConversationDecision {
  // ── Prioridad 1: Handoff explícito ──────────────────────────────
  if (turn.detectedIntent === "HANDOFF") {
    return { action: "HANDOFF", reason: "Usuario solicitó asesor" };
  }
  if (ctx.clarification.count >= 3) {
    return { action: "HANDOFF", reason: "Máximo de aclaraciones alcanzado" };
  }

  // ── Prioridad 2: Responder pregunta explícita del cliente ───────
  if (turn.isQuestion && !turn.isConfirmation) {
    return { action: "ANSWER", reason: "Pregunta directa del cliente" };
  }

  // ── Prioridad 3: Resolver ambigüedad ────────────────────────────
  if (turn.needsClarification) {
    return {
      action: "CLARIFY",
      reason: "Intención ambigua",
      question: generateClarificationQuestion(ctx),
    };
  }

  // ── Prioridad 4: Procesar rechazo/corrección/preferencia ────────
  if (turn.isRejection || turn.isCorrection) {
    return { action: "GUIDE", reason: "Rechazo/corrección detectado" };
  }

  // ── Prioridad 5: Confirmación ───────────────────────────────────
  if (turn.isConfirmation && ctx.confirmation.status === "pending") {
    return { action: "EXECUTE", reason: "Confirmación explícita" };
  }
  if (turn.isRejection && ctx.confirmation.status === "pending") {
    return { action: "GUIDE", reason: "Rechazo de confirmación" };
  }

  // ── Prioridad 6: Continuar objetivo actual ──────────────────────
  if (ctx.activeIntent) {
    // 6a. Todos los slots completos → confirmar
    if (allRequiredSlotsComplete(ctx.slots, ctx.activeIntent)) {
      return {
        action: "CONFIRM",
        reason: "Todos los datos recopilados",
        confirmationSummary: buildSummary(ctx),
      };
    }

    // 6b. Hay recomendación contextual → ofrecer
    const recommendation = getContextualRecommendation(ctx);
    if (recommendation && !isRecommendationAlreadyOffered(ctx, recommendation.type)) {
      return {
        action: "RECOMMEND",
        reason: "Recomendación contextual disponible",
        recommendation,
      };
    }

    // 6c. Slots faltantes → preguntar el más útil
    const nextSlot = getNextUsefulSlot(ctx, turn);
    if (nextSlot) {
      return {
        action: "ASK_FOR_MISSING_INFO",
        reason: `Falta ${nextSlot.name}`,
        targetSlot: nextSlot.name,
        question: nextSlot.question,
      };
    }
  }

  // ── Prioridad 7: Sin intención clara → explorar ─────────────────
  return { action: "GUIDE", reason: "Sin intención clara, orientar al cliente" };
}

// ── Helpers ─────────────────────────────────────────────────────

function allRequiredSlotsComplete(slots: ConversationSlots, intent: string | null): boolean {
  if (!intent) return false;
  const required = getRequiredSlots(intent);
  return required.every((s) => (slots as any)[s] !== null && (slots as any)[s] !== undefined);
}

function getRequiredSlots(intent: string): string[] {
  switch (intent) {
    case "PRACTICA":
    case "SIMULACRO":
    case "RESERVA":
      return ["categoria", "circuito", "fecha", "hora"];
    case "ALQUILER_EXAMEN":
      return ["categoria", "fecha"];
    default:
      return [];
  }
}

function getContextualRecommendation(ctx: ConversationContext): { type: string; target: string; reason: string } | null {
  // Evaluar con el motor de recomendaciones existente
  const context = resolveContext(ctx as any, ctx.activeIntent, ctx.slots as any, getMissingSlots(ctx));
  const result = evaluateRecommendation({
    activeIntent: ctx.activeIntent,
    slots: ctx.slots as any,
    state: ctx as any,
    context,
  });

  if (result.recommendation && !isRecommendationAlreadyOffered(ctx, result.recommendation.type)) {
    return {
      type: result.recommendation.type,
      target: result.recommendation.target,
      reason: result.recommendation.reason,
    };
  }
  return null;
}

function isRecommendationAlreadyOffered(ctx: ConversationContext, type: string): boolean {
  return ctx.recommendations.some((r) => r.type === type && r.status !== "rejected");
}

function getMissingSlots(ctx: ConversationContext): string[] {
  const required = getRequiredSlots(ctx.activeIntent ?? "");
  return required.filter((s) => (ctx.slots as any)[s] === null || (ctx.slots as any)[s] === undefined);
}

function getNextUsefulSlot(ctx: ConversationContext, turn: TurnUnderstanding): { name: string; question: string } | null {
  const missing = getMissingSlots(ctx);
  if (missing.length === 0) return null;

  // Prioridad base: categoria → circuito → fecha → hora
  let priority: Record<string, number> = { categoria: 1, circuito: 2, fecha: 3, hora: 4 };

  // Si el usuario mencionó examen, preguntar fecha antes que circuito
  // (la fecha es más urgente cuando hay contexto de examen próximo)
  if (ctx.slots.examen_fecha && missing.includes("fecha")) {
    priority = { categoria: 1, fecha: 2, circuito: 3, hora: 4 };
  }

  const sorted = missing.sort((a, b) => (priority[a] ?? 99) - (priority[b] ?? 99));

  const name = sorted[0];

  // Generar pregunta contextual (no genérica)
  const questions: Record<string, string> = {
    categoria: "¿Qué categoría de licencia necesitas? (A1 para auto, A2 para camioneta/van, A3 para bus/camión)",
    circuito: buildCircuitQuestion(ctx),
    fecha: "¿Qué día te gustaría practicar?",
    hora: buildTimeQuestion(ctx),
  };

  return { name, question: questions[name] ?? `¿Podrías indicarme ${name}?` };
}

function buildCircuitQuestion(ctx: ConversationContext): string {
  // Si el examen está cerca, contextualizar
  if (ctx.slots.examen_fecha || ctx.constraints.examDate) {
    return "Tenemos el circuito oficial (donde se hace el examen) y el alternativo (idéntico, solo para prácticas). ¿Cuál prefieres?";
  }
  return "¿En qué circuito prefieres? Tenemos oficial y alternativo.";
}

function buildTimeQuestion(ctx: ConversationContext): string {
  if (ctx.preferences.prefersMorning) {
    return "¿A qué hora de la mañana te viene bien?";
  }
  return "¿Qué hora te conviene?";
}

function buildSummary(ctx: ConversationContext): string {
  const parts: string[] = [];
  if (ctx.slots.actividad) parts.push(`Servicio: ${ctx.slots.actividad}`);
  if (ctx.slots.categoria) parts.push(`Categoría: ${ctx.slots.categoria}`);
  if (ctx.slots.circuito) parts.push(`Circuito: ${ctx.slots.circuito}`);
  if (ctx.slots.fecha) parts.push(`Fecha: ${ctx.slots.fecha}`);
  if (ctx.slots.hora) parts.push(`Hora: ${ctx.slots.hora}`);
  return parts.join("\n");
}

function generateClarificationQuestion(ctx: ConversationContext): string {
  if (ctx.activeIntent) {
    return `¿Podrías darme más detalles sobre lo que necesitas?`;
  }
  return "¿Qué te gustaría hacer? ¿Practicar manejo, hacer un simulacro, o consultar sobre nuestros servicios?";
}
