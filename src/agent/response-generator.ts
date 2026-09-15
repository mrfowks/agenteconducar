import type { ConversationContext } from "./conversation-context";
import type { ConversationDecision } from "./conversation-decider";
import type { TurnUnderstanding } from "./turn-understanding";
import { formatCustomerTime } from "../domain/calendar";

/**
 * Genera una respuesta natural para WhatsApp.
 * No usa plantillas rígidas. Adapta el tono al contexto.
 */
export function generateResponse(
  decision: ConversationDecision,
  ctx: ConversationContext,
  turn: TurnUnderstanding,
): string {
  switch (decision.action) {
    case "ANSWER":
      return generateAnswer(ctx, turn);
    case "CLARIFY":
      return decision.question ?? "¿Podrías darme más detalles?";
    case "GUIDE":
      return generateGuide(ctx, turn);
    case "RECOMMEND":
      return generateRecommendation(decision, ctx);
    case "ASK_FOR_MISSING_INFO":
      return generateSlotQuestion(decision, ctx);
    case "CONFIRM":
      return generateConfirmation(decision, ctx);
    case "EXECUTE":
      return "Procesando tu solicitud...";
    case "HANDOFF":
      return generateHandoff(decision, ctx);
    default:
      return "¿En qué puedo ayudarte?";
  }
}

// ── Generadores específicos ──────────────────────────────────────

function generateAnswer(ctx: ConversationContext, turn: TurnUnderstanding): string {
  // Para preguntas directas, el LLM debería generar la respuesta
  // Aquí devolvemos un placeholder que el LLM enriquecerá
  const msg = ctx.lastUserMessage.toLowerCase();
  if (/horario|atienden/i.test(msg)) {
    return "Nuestros horarios de atención son de lunes a domingo, de 8:00 AM a 5:30 PM, incluyendo feriados.";
  }
  if (/circuito/i.test(msg)) {
    return "Tenemos dos circuitos:\n• oficial: donde se realiza el examen práctico\n• alternativo: idéntico al oficial, solo para prácticas";
  }
  return "Déjame consultar esa información para ti.";
}

function generateGuide(ctx: ConversationContext, turn: TurnUnderstanding): string {
  if (turn.isRejection) {
    return "Entiendo. ¿Qué prefieres hacer entonces?";
  }
  if (turn.isCorrection) {
    return "Perfecto, actualizo la información. ¿Algo más que quieras cambiar?";
  }
  return "¿En qué puedo ayudarte? Podemos hablar sobre prácticas, simulacros, paquetes u horarios.";
}

function generateRecommendation(decision: ConversationDecision, ctx: ConversationContext): string {
  if (!decision.recommendation) return "";

  const rec = decision.recommendation;
  const parts: string[] = [];

  if (rec.type === "CONTEXTUAL_SIMULACRO") {
    parts.push("Como tu examen está cerca, te conviene prepararte bien.");
    parts.push(rec.reason);
    parts.push(`📅 Martes, jueves y sábado, de 5:30 AM a 7:30 AM.`);
    parts.push(`📍 Pista oficial. 👨‍🏫 Incluye instructor. ⏱️ 20 minutos.`);
    parts.push("\nTenemos dos circuitos para practicar:");
    parts.push("• **Oficial**: donde se realiza el examen");
    parts.push("• **Alternativo**: idéntico al oficial, solo para prácticas");
    parts.push("\n¿Te gustaría reservar un simulacro o prefieres una práctica primero?");
  } else {
    parts.push(rec.reason);
    parts.push("\n¿Te gustaría continuar con esto?");
  }

  return parts.join("\n");
}

function generateSlotQuestion(decision: ConversationDecision, ctx: ConversationContext): string {
  if (decision.question) return decision.question;

  // Fallback contextual
  if (decision.targetSlot === "categoria" && ctx.slots.examen_fecha) {
    return "¿Qué categoría de licencia necesitas? (A1, A2, A3)";
  }
  return `¿Podrías indicarme ${decision.targetSlot}?`;
}

function generateConfirmation(decision: ConversationDecision, ctx: ConversationContext): string {
  const summary = decision.confirmationSummary ?? "Resumen no disponible";
  return `Perfecto, tengo estos datos:\n${summary}\n\n¿Es correcto?`;
}

function generateHandoff(decision: ConversationDecision, ctx: ConversationContext): string {
  const slots = Object.entries(ctx.slots)
    .filter(([_, v]) => v !== null && v !== undefined)
    .map(([k, v]) => `${k}: ${v}`)
    .join(", ");

  let text = "Te voy a transferir con un asesor especializado para ayudarte con este caso.";
  if (slots) text += `\n\n📋 Datos recopilados: ${slots}`;
  return text;
}
