import type { Intent, ConversationStateData } from "./types";
import { createKnowledgeBase } from "./knowledge-base";

export interface ResolvedContext {
  // Contexto del cliente
  clientProfile: {
    hasReservations: boolean;
    lastCategory: string | null;
    lastActivity: string | null;
    hasPackage: boolean;
  };
  // Contexto temporal
  temporalContext: {
    isExamDay: boolean;
    currentDayOfWeek: string;
    currentHour: number;
  };
  // Contexto de conversación
  conversationContext: {
    messageCount: number;
    isNewUser: boolean;
    activeIntent: Intent | null;
    phase: string;
    slotsCollected: Record<string, unknown>;
    missingSlots: string[];
  };
  // Conocimiento relevante para la intención
  knowledgeContext: string;
}

const EXAM_DAYS = ["martes", "jueves", "sábado"];
const DAY_NAMES = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];

/**
 * Resuelve el contexto relevante para procesar un mensaje.
 * NO inventa datos. Solo estructura información disponible.
 */
export function resolveContext(
  state: ConversationStateData,
  intent: Intent | null,
  slots: Record<string, unknown>,
  missingSlotNames: string[],
): ResolvedContext {
  const kb = createKnowledgeBase();
  const now = new Date();
  const dayOfWeek = DAY_NAMES[now.getDay()];
  const isExamDay = EXAM_DAYS.includes(dayOfWeek);

  return {
    clientProfile: {
      hasReservations: state.messageCount > 2, // Heurística simple
      lastCategory: (slots.categoria as string) ?? null,
      lastActivity: (slots.actividad as string) ?? state.activeIntent ?? null,
      hasPackage: false, // Se actualizará con RecommendationEngine
    },
    temporalContext: {
      isExamDay,
      currentDayOfWeek: dayOfWeek,
      currentHour: now.getHours(),
    },
    conversationContext: {
      messageCount: state.messageCount,
      isNewUser: state.messageCount <= 1,
      activeIntent: state.activeIntent,
      phase: state.phase,
      slotsCollected: slots,
      missingSlots: missingSlotNames,
    },
    knowledgeContext: intent ? kb.getContextForIntent(intent) : "",
  };
}
