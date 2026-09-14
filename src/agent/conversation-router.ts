import { loadOrCreateState, saveState } from "./state-loader";
import { detectIntent } from "./intent-engine";
import { extractSlots } from "./slot-manager";
import { resolveContext } from "./context-resolver";
import type {
  ConversationStateData,
  Intent,
  IntentDetectionResult,
  SlotExtractionResult,
  ConversationPhase,
} from "./types";

// ── Tipos de resultado ─────────────────────────────────────────

export interface ConversationRouterResult {
  state: ConversationStateData;
  intent: IntentDetectionResult;
  intentChanged: boolean;
  slots: Record<string, unknown>;
  missingSlots: string[];
  context: ReturnType<typeof resolveContext>;
  needsClarification: boolean;
  clarificationCount: number;
  phase: ConversationPhase;
}

// ── Opciones del router ────────────────────────────────────────

export interface RouteOptions {
  chatwootConversationId: number | null;
  phone: string | null;
  chatwootContactId?: number | null;
  sourceId?: string | null;
  isNewUser?: boolean;
}

// ── Router principal ───────────────────────────────────────────

/**
 * Procesa un mensaje entrante a través del pipeline conversacional.
 * NO ejecuta side effects (reservas, pagos, handoff).
 * Solo produce un resultado estructurado para que fases posteriores consuman.
 */
export async function processMessage(
  text: string,
  options: RouteOptions,
): Promise<ConversationRouterResult> {
  // 1. Cargar o crear estado
  let state = await loadOrCreateState({
    chatwootConversationId: options.chatwootConversationId,
    phone: options.phone,
    chatwootContactId: options.chatwootContactId,
    sourceId: options.sourceId,
  });

  // 2. Detectar intención
  const intent = detectIntent(text, state.activeIntent);

  // 3. Manejar cambio de intención
  let intentChanged = false;
  if (intent.isChange && intent.isExplicitChange) {
    // Cambio explícito: actualizar intención, preservar slots compatibles
    state = {
      ...state,
      activeIntent: intent.intent,
      previousIntent: state.activeIntent,
      intentChangedAt: new Date(),
      phase: "GATHERING" as ConversationPhase,
      repromptCount: 0,
    };
    intentChanged = true;
  } else if (intent.isChange && !intent.isExplicitChange) {
    // Cambio no explícito: evaluar si es subpregunta
    // isSubQuestion ya fue evaluado por IntentEngine y devolvió activeIntent si es subpregunta
    // Si IntentEngine devolvió una intención diferente, es un cambio real
    if (intent.intent !== state.activeIntent) {
      state = {
        ...state,
        activeIntent: intent.intent,
        previousIntent: state.activeIntent,
        intentChangedAt: new Date(),
        phase: "GATHERING" as ConversationPhase,
        repromptCount: 0,
      };
      intentChanged = true;
    }
  } else if (!state.activeIntent && intent.intent !== "OTROS") {
    // Primera intención detectada
    state = {
      ...state,
      activeIntent: intent.intent,
      phase: "GATHERING" as ConversationPhase,
    };
  }

  // 4. Extraer slots
  const activeIntent = state.activeIntent ?? intent.intent;
  const slotResult = extractSlots(text, activeIntent, state);

  // 5. Actualizar slots en estado y avanzar phase si corresponde
  const { evaluateGate } = await import("./confirmation-gate");
  const gateResult = evaluateGate({
    phase: state.phase,
    slotsComplete: slotResult.isComplete,
    userText: text,
    hasRecommendation: false, // Se evaluará después
    hasPendingSideEffects: false,
  });

  state = {
    ...state,
    slots: slotResult.updated,
    messageCount: state.messageCount + 1,
    phase: gateResult.nextPhase, // ← Avanzar phase según el gate
  };

  // 6. Resolver contexto
  const context = resolveContext(
    state,
    activeIntent,
    slotResult.updated,
    slotResult.missing.map((s) => s.name),
  );

  // 7. Persistir estado actualizado
  if (options.chatwootConversationId) {
    await saveState(options.chatwootConversationId, state);
  }

  // 8. Determinar si necesita aclaración
  const needsClarification =
    intent.confidence < 0.5 && !state.activeIntent;

  return {
    state,
    intent,
    intentChanged,
    slots: slotResult.updated,
    missingSlots: slotResult.missing.map((s) => s.name),
    context,
    needsClarification,
    clarificationCount: state.repromptCount,
    phase: state.phase,
  };
}
