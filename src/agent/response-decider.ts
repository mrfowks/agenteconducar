import type {
  ConversationStateData,
  IntentDetectionResult,
  SlotExtractionResult,
  ResponseAction,
  SlotDefinition,
} from "./types";
import type { RecommendationResult } from "./recommendation-engine";
import { evaluateGate, buildConfirmationSummary } from "./confirmation-gate";
import { detectSlotConflict } from "./slot-manager";

const MAX_REPROMPTS = 3;

/**
 * Prioridad de slots: preguntar en este orden (primero lo más básico).
 *_categoria → circuito → fecha → hora
 */
const SLOT_PRIORITY: Record<string, number> = {
  categoria: 1,
  circuito: 2,
  fecha: 3,
  fecha_examen: 3,
  hora: 4,
};

export interface ResponseDeciderInput {
  state: ConversationStateData;
  intent: IntentDetectionResult;
  slots: SlotExtractionResult;
  recommendation: RecommendationResult | null;
  userText: string;
}

/**
 * Decide qué hacer: responder, repreguntar, recomendar, confirmar, ejecutar o handoff.
 * Integrado con ConfirmationGate y RecommendationEngine.
 */
export function decideResponse(input: ResponseDeciderInput): ResponseAction {
  const { state, intent, slots, recommendation, userText } = input;

  // 1. Handoff explícito
  if (intent.intent === "HANDOFF") {
    return { type: "HANDOFF", reason: "Usuario solicitó asesor" };
  }

  // 2. Máximo 3 aclaraciones → handoff
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

  // 5. Evaluar ConfirmationGate
  const gateInput = {
    phase: state.phase,
    slotsComplete: slots.isComplete,
    userText,
    hasRecommendation: recommendation?.recommendation !== null,
    hasPendingSideEffects: false, // No hay side effects en Fase 2B
  };

  const gate = evaluateGate(gateInput);

  // 6. Si el gate indica HANDOFF
  if (gate.nextPhase === "HANDOFF") {
    return { type: "HANDOFF", reason: gate.blockReason ?? "Derivación a asesor" };
  }

  // 7. Si hay recomendación y estamos en GATHERING con slots completos
  if (recommendation?.recommendation && slots.isComplete && state.phase === "GATHERING") {
    return {
      type: "RECOMMEND",
      recommendation: recommendation.recommendation,
    };
  }

  // 8. Si el gate indica CONFIRMING
  if (gate.action === "ASK_CONFIRM") {
    return {
      type: "CONFIRM",
      summary: buildConfirmationSummary(
        slots.updated,
        recommendation?.recommendation,
      ),
    };
  }

  // 9. Si el gate indica EXECUTE
  if (gate.action === "EXECUTE") {
    // En Fase 2B.4 NO ejecutamos realmente
    // Solo devolvemos la decisión estructurada
    return {
      type: "EXECUTE_TOOL",
      tool: getToolForIntent(state.activeIntent),
      args: slots.updated,
    };
  }

  // 10. Si el gate indica MODIFY (rechazo/post-acción)
  if (gate.action === "MODIFY") {
    // Volver a GATHERING: el usuario quiere cambiar algo
    return {
      type: "REPROMPT",
      question: "¿Qué dato quieres cambiar?",
      slotName: "modification",
    };
  }

  // 11. Slots faltantes → repreguntar (UNA pregunta a la vez, por prioridad)
  if (slots.missing.length > 0) {
    // Ordenar por prioridad: categoria → circuito → fecha → hora
    const sorted = [...slots.missing].sort(
      (a, b) => (SLOT_PRIORITY[a.name] ?? 99) - (SLOT_PRIORITY[b.name] ?? 99),
    );
    const nextSlot = sorted[0];
    return { type: "REPROMPT", question: nextSlot.question, slotName: nextSlot.name };
  }

  // 12. Respuesta directa
  return { type: "RESPOND", content: "Puedo ayudarte con eso. ¿Qué necesitas?" };
}

function isInformationUnavailable(slot: SlotDefinition): boolean {
  const unavailableTopics = ["examen_de_reglas", "requisitos_mtc", "estado_tramite"];
  return unavailableTopics.includes(slot.name);
}

function getToolForIntent(intent: string | null): string {
  switch (intent) {
    case "RESERVA":
    case "SIMULACRO":
    case "PRACTICA":
      return "crear_reserva";
    case "ALQUILER_EXAMEN":
      return "consultar_disponibilidad";
    case "PAQUETE":
      return "consultar_paquetes";
    case "HORARIOS":
      return "consultar_agenda";
    default:
      return "consultar_agenda";
  }
}
