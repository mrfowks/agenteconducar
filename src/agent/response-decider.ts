import type {
  ConversationStateData,
  IntentDetectionResult,
  SlotExtractionResult,
  ResponseAction,
  SlotDefinition,
} from "./types";

const MAX_REPROMPTS = 2;

/**
 * Decide qué hacer: responder, repreguntar, confirmar, ejecutar herramienta o hacer handoff.
 */
export function decideResponse(
  state: ConversationStateData,
  intent: IntentDetectionResult,
  slots: SlotExtractionResult,
  text: string,
): ResponseAction {
  // 1. Handoff explícito (usuario pide asesor)
  if (intent.intent === "HANDOFF") {
    return { type: "HANDOFF", reason: "Usuario solicitó asesor" };
  }

  // 2. Máximo 2 aclaraciones → handoff
  if (state.repromptCount >= MAX_REPROMPTS) {
    return { type: "HANDOFF", reason: "Máximo de aclaraciones alcanzado" };
  }

  // 3. Información no disponible → handoff
  if (slots.missing.length > 0 && isInformationUnavailable(slots.missing[0])) {
    return { type: "HANDOFF", reason: "Información no disponible en el sistema" };
  }

  // 4. Consulta ambigua → pedir aclaración
  if (intent.confidence < 0.5 && !state.activeIntent) {
    return {
      type: "ASK_CLARIFICATION",
      options: ["práctica de manejo", "simulacro de examen", "paquetes", "horarios"],
    };
  }

  // 5. Slots faltantes → repreguntar (UNA pregunta a la vez)
  if (slots.missing.length > 0) {
    const nextSlot = slots.missing[0];
    return { type: "REPROMPT", question: nextSlot.question, slotName: nextSlot.name };
  }

  // 6. Todos los slots completos → confirmar
  if (slots.isComplete && state.phase === "GATHERING") {
    return { type: "CONFIRM", summary: buildConfirmationSummary(state) };
  }

  // 7. Usuario confirma → ejecutar
  if (state.phase === "CONFIRMING" && isConfirmation(text)) {
    return { type: "EXECUTE_TOOL", tool: getToolForIntent(state.activeIntent), args: state.slots };
  }

  // 8. Respuesta directa
  return { type: "RESPOND", content: "Puedo ayudarte con eso. ¿Qué necesitas?" };
}

function isInformationUnavailable(slot: SlotDefinition): boolean {
  const unavailableTopics = ["examen_de_reglas", "requisitos_mtc", "estado_tramite"];
  return unavailableTopics.includes(slot.name);
}

function isConfirmation(text: string): boolean {
  const normalized = text.toLowerCase().trim();
  return /^(s[ií]|as[ií]\s+es|correcto|dale|ok|confirmo|claro|perfecto|exacto)(\s|$)/i.test(normalized);
}

function buildConfirmationSummary(state: ConversationStateData): string {
  const slots = state.slots;
  const parts: string[] = [];
  if (slots.actividad) parts.push(`Servicio: ${slots.actividad}`);
  if (slots.categoria) parts.push(`Categoría: ${slots.categoria}`);
  if (slots.circuito) parts.push(`Circuito: ${slots.circuito}`);
  if (slots.fecha) parts.push(`Fecha: ${slots.fecha}`);
  if (slots.hora) parts.push(`Hora: ${slots.hora}`);
  return `Resumen:\n${parts.join("\n")}\n\n¿Confirmas estos datos?`;
}

function getToolForIntent(intent: string | null): string {
  switch (intent) {
    case "RESERVA":
    case "SIMULACRO":
    case "PRACTICA":
      return "crear_reserva";
    case "ALQUILER_EXAMEN":
      return "consultar_categorias";
    case "PAQUETE":
      return "consultar_paquetes";
    case "HORARIOS":
      return "consultar_agenda";
    default:
      return "consultar_agenda";
  }
}
