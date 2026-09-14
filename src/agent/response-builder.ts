import type { ConversationStateData, ResponseAction } from "./types";
import type { Recommendation } from "./recommendation-engine";
import type { ToolExecutionResult } from "./tool-executor";
import type { ResolvedContext } from "./context-resolver";
import { formatCustomerTime } from "../domain/calendar";

// ── Tipos ───────────────────────────────────────────────────────

export interface ResponseBuilderInput {
  action: ResponseAction;
  state: ConversationStateData;
  context: ResolvedContext;
  recommendation: Recommendation | null;
  toolResult?: ToolExecutionResult | null;
}

export interface ResponseBuilderOutput {
  text: string;
  includeRecommendation: boolean;
  salesFollowUp: boolean;
}

// ── Response Builder ────────────────────────────────────────────

/**
 * Construye una respuesta natural para WhatsApp a partir de decisiones estructuradas.
 * NO ejecuta herramientas. NO cambia activeIntent. NO inventa información.
 */
export function buildResponse(input: ResponseBuilderInput): ResponseBuilderOutput {
  const { action, state, context, recommendation, toolResult } = input;

  switch (action.type) {
    case "RESPOND":
      return buildDirectResponse(action.content, context);

    case "ASK_CLARIFICATION":
      return buildClarificationResponse(action.options, context);

    case "REPROMPT":
      return buildRepromptResponse(action.question, action.slotName, state, context);

    case "RECOMMEND":
      return buildRecommendationResponse(recommendation, state, context);

    case "CONFIRM":
      return buildConfirmationResponse(action.summary, recommendation);

    case "EXECUTE_TOOL":
      return buildToolResultResponse(toolResult, state, recommendation);

    case "HANDOFF":
      return buildHandoffResponse(action.reason, state);

    default:
      return {
        text: "¿En qué puedo ayudarte?",
        includeRecommendation: false,
        salesFollowUp: false,
      };
  }
}

// ── Builders específicos ────────────────────────────────────────

function buildDirectResponse(
  content: string,
  context: ResolvedContext,
): ResponseBuilderOutput {
  // Respuesta directa + posible seguimiento comercial
  const salesFollowUp = !context.clientProfile.hasReservations && context.conversationContext.isNewUser;
  return {
    text: content,
    includeRecommendation: false,
    salesFollowUp,
  };
}

function buildClarificationResponse(
  options: string[],
  _context: ResolvedContext,
): ResponseBuilderOutput {
  const optionsText = options.map((o, i) => `${i + 1}. ${o}`).join("\n");
  return {
    text: `¿Me podrías explicar un poco mejor qué necesitas?\n${optionsText}`,
    includeRecommendation: false,
    salesFollowUp: false,
  };
}

function buildRepromptResponse(
  question: string,
  slotName: string,
  state: ConversationStateData,
  _context: ResolvedContext,
): ResponseBuilderOutput {
  let text = question;

  // Primer contacto: agregar contexto explicativo cuando el slot requiere
  // conocimiento que el cliente no tiene por qué tener
  if (state.messageCount <= 2 && slotName === "circuito") {
    text =
      "Tenemos dos circuitos para practicar:\n" +
      "• **Oficial**: donde se realiza el examen práctico\n" +
      "• **Alternativo**: idéntico al oficial, solo para prácticas\n\n" +
      question;
  }

  return { text, includeRecommendation: false, salesFollowUp: false };
}

function buildRecommendationResponse(
  recommendation: Recommendation | null,
  state: ConversationStateData,
  _context: ResolvedContext,
): ResponseBuilderOutput {
  if (!recommendation) {
    return {
      text: "¿En qué puedo ayudarte?",
      includeRecommendation: false,
      salesFollowUp: false,
    };
  }

  let text = "";

  switch (recommendation.type) {
    case "PACKAGE":
      text = buildPackageRecommendation(recommendation, state);
      break;

    case "CONTEXTUAL_SIMULACRO":
      text = buildSimulacroRecommendation(recommendation, state);
      break;

    case "VEHICLE":
      text = buildVehicleRecommendation(recommendation);
      break;

    case "SERVICE":
      text = buildServiceRecommendation(recommendation);
      break;

    case "DIAGNOSTIC":
      text = recommendation.reason;
      break;

    default:
      text = recommendation.reason;
  }

  return {
    text,
    includeRecommendation: true,
    salesFollowUp: true,
  };
}

function buildPackageRecommendation(rec: Recommendation, _state: ConversationStateData): string {
  const parts: string[] = [];

  parts.push(rec.reason);

  if (rec.estimatedValue.price) {
    parts.push(`💰 Precio: S/${rec.estimatedValue.price}`);
  }

  if (rec.estimatedValue.savings) {
    parts.push(`💰 Ahorras S/${rec.estimatedValue.savings} vs contratar por separado (S/${rec.estimatedValue.separateTotal}).`);
  }

  // Preguntar si desea continuar
  parts.push("\n¿Te gustaría reservar?");

  return parts.join("\n");
}

function buildSimulacroRecommendation(rec: Recommendation, state?: ConversationStateData): string {
  const parts: string[] = [];

  // Contexto: si el usuario mencionó examen, orientar
  if (state?.slots?.examen_fecha) {
    parts.push(`Como tu examen es pronto, te conviene prepararte bien.`);
  }

  parts.push(rec.reason);

  if (rec.estimatedValue.price) {
    parts.push(`💰 Precio individual: S/${rec.estimatedValue.price}`);
  }

  parts.push("📅 Martes, jueves y sábado, de 5:30 AM a 7:30 AM.");
  parts.push("📍 Pista oficial.");
  parts.push("👨‍🏫 Incluye instructor profesional.");
  parts.push("⏱️ Duración: 20 minutos.");

  // Contexto de circuitos
  parts.push("\nTenemos dos circuitos para practicar:");
  parts.push("• **Oficial**: donde se realiza el examen práctico");
  parts.push("• **Alternativo**: idéntico al oficial, solo para prácticas");

  parts.push("\n¿Te gustaría reservar un simulacro o prefieres una práctica primero?");

  return parts.join("\n");
}

function buildVehicleRecommendation(rec: Recommendation): string {
  const parts: string[] = [];

  parts.push(`🚗 Vehículo recomendado: ${rec.target}`);
  parts.push(rec.reason);

  parts.push("\n¿Deseas reservar el alquiler del vehículo para tu examen?");

  return parts.join("\n");
}

function buildServiceRecommendation(rec: Recommendation): string {
  // Simulacro individual → formato detallado
  if (rec.target === "SIMULACRO") {
    return buildSimulacroRecommendation(rec);
  }

  const parts: string[] = [];

  parts.push(rec.reason);

  if (rec.estimatedValue.price) {
    parts.push(`💰 Precio: S/${rec.estimatedValue.price}`);
  }

  parts.push("\n¿Te gustaría reservar?");

  return parts.join("\n");
}

function buildConfirmationResponse(
  summary: string,
  recommendation: Recommendation | null,
): ResponseBuilderOutput {
  let text = summary;

  if (recommendation) {
    text += `\n\n💡 Recomendación: ${recommendation.target}`;
    if (recommendation.estimatedValue.price) {
      text += ` (S/${recommendation.estimatedValue.price})`;
    }
  }

  return {
    text,
    includeRecommendation: !!recommendation,
    salesFollowUp: false,
  };
}

function buildToolResultResponse(
  toolResult: ToolExecutionResult | null | undefined,
  state: ConversationStateData,
  recommendation: Recommendation | null,
): ResponseBuilderOutput {
  if (!toolResult) {
    return {
      text: "Procesando tu solicitud...",
      includeRecommendation: false,
      salesFollowUp: false,
    };
  }

  switch (toolResult.status) {
    case "SUCCESS":
      return buildSuccessResponse(toolResult, state, recommendation);

    case "NO_AVAILABILITY":
      return buildNoAvailabilityResponse(toolResult, state);

    case "VALIDATION_ERROR":
      return buildValidationErrorResponse(toolResult);

    case "BUSINESS_ERROR":
      return buildBusinessErrorResponse(toolResult);

    case "TECHNICAL_ERROR":
      return buildTechnicalErrorResponse(toolResult);

    default:
      return {
        text: "Procesando tu solicitud...",
        includeRecommendation: false,
        salesFollowUp: false,
      };
  }
}

function buildSuccessResponse(
  toolResult: ToolExecutionResult,
  _state: ConversationStateData,
  _recommendation: Recommendation | null,
): ResponseBuilderOutput {
  const tool = toolResult.tool;

  if (tool === "crear_reserva") {
    return {
      text: "¡Listo! ✅ Tu reserva quedó registrada como pendiente de pago.\n\nTe envié el código QR para que realices el pago por Yape o Plin. Una vez pagado, envíanos el comprobante por este chat para confirmar tu reserva. 😉",
      includeRecommendation: false,
      salesFollowUp: false,
    };
  }

  if (tool === "consultar_disponibilidad") {
    const result = toolResult.result as { slot: string }[] | null;
    if (result && Array.isArray(result) && result.length > 0) {
      const horarios = result.map((r: { slot: string }) => `• ${formatCustomerTime(r.slot)}`).join("\n");
      return {
        text: `📅 Horarios disponibles:\n${horarios}\n\n¿Cuál prefieres?`,
        includeRecommendation: false,
        salesFollowUp: true,
      };
    }
    return {
      text: "En este momento no hay horarios disponibles para esa fecha y circuito. ¿Te gustaría probar con otro día o circuito?",
      includeRecommendation: false,
      salesFollowUp: true,
    };
  }

  if (tool === "consultar_agenda") {
    return {
      text: "Aquí tienes los horarios de atención:",
      includeRecommendation: false,
      salesFollowUp: true,
    };
  }

  if (tool === "consultar_paquetes") {
    return {
      text: "Aquí tienes la información de nuestros paquetes:",
      includeRecommendation: false,
      salesFollowUp: true,
    };
  }

  if (tool === "derivar_a_humano") {
    return buildHandoffResponse("Derivado a asesor", _state);
  }

  return {
    text: "¡Listo! ✅",
    includeRecommendation: false,
    salesFollowUp: false,
  };
}

function buildNoAvailabilityResponse(
  _toolResult: ToolExecutionResult,
  _state: ConversationStateData,
): ResponseBuilderOutput {
  return {
    text: "En este momento no hay disponibilidad para esa opción. ¿Te gustaría probar con otro día, hora o circuito?",
    includeRecommendation: false,
    salesFollowUp: true,
  };
}

function buildValidationErrorResponse(toolResult: ToolExecutionResult): ResponseBuilderOutput {
  const error = toolResult.error ?? "datos incompletos";
  return {
    text: `Necesito un dato adicional: ${error}. ¿Podrías proporcionarlo?`,
    includeRecommendation: false,
    salesFollowUp: false,
  };
}

function buildBusinessErrorResponse(toolResult: ToolExecutionResult): ResponseBuilderOutput {
  return {
    text: `No pude completar la operación: ${toolResult.error ?? "error desconocido"}. ¿Quieres que lo revise un asesor?`,
    includeRecommendation: false,
    salesFollowUp: false,
  };
}

function buildTechnicalErrorResponse(_toolResult: ToolExecutionResult): ResponseBuilderOutput {
  return {
    text: "Estoy presentando un problema técnico. Un asesor te atenderá en breve.",
    includeRecommendation: false,
    salesFollowUp: false,
  };
}

function buildHandoffResponse(
  reason: string,
  state: ConversationStateData,
): ResponseBuilderOutput {
  // Conservar contexto: mencionar lo recopilado si existe
  const slots = Object.entries(state.slots)
    .filter(([_, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}: ${v}`)
    .join(", ");

  let text = "Te voy a transferir con un asesor especializado para ayudarte con este caso.";

  if (slots) {
    text += `\n\n📋 Datos recopilados: ${slots}`;
  }

  return {
    text,
    includeRecommendation: false,
    salesFollowUp: false,
  };
}
