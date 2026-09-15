import { understandTurn } from "./turn-understanding";
import { updateContext } from "./context-updater";
import { resolveIntent } from "./intent-resolver";
import { decide } from "./conversation-decider";
import { generateResponse } from "./response-generator";
import type { ConversationContext } from "./conversation-context";

// ── Cache de contextos shadow por conversación ──────────────────
// Mantiene su propio ConversationContext separado del flujo actual
const shadowContexts = new Map<string, ConversationContext>();

function getOrCreateShadowContext(conversationKey: string): ConversationContext {
  const existing = shadowContexts.get(conversationKey);
  if (existing && existing.expiresAt && existing.expiresAt > new Date()) {
    return existing;
  }
  // Crear nuevo contexto limpio
  const fresh: ConversationContext = {
    id: conversationKey,
    phone: null,
    chatwootContactId: null,
    sourceId: null,
    activeIntent: null,
    goal: null,
    intentHistory: [],
    phase: "IDLE",
    turnCount: 0,
    lastUserMessage: "",
    lastAssistantQuestion: null,
    lastResponseHash: null,
    slots: {
      actividad: null, categoria: null, circuito: null,
      fecha: null, fechaOriginal: null, hora: null, horaOriginal: null,
      examen_fecha: null, paquete: null, experiencia: null, urgencia: null,
    },
    slotConfidence: {},
    slotSources: {},
    preferences: { prefersMorning: null, prefersAutomatic: null, prefersOfficialCircuit: null },
    constraints: { examDate: null, noSameDayAsExam: false, timeConstraints: [] },
    facts: [],
    negations: [],
    recommendations: [],
    lastRecommendationType: null,
    clarification: { count: 0, lastQuestion: null, reason: null },
    confirmation: { status: "none", summary: null, confirmedAt: null, rejectedAt: null },
    pendingAction: null,
    handoff: null,
    isNewUser: true,
    createdAt: new Date(),
    lastActivityAt: new Date(),
    expiresAt: new Date(Date.now() + 30 * 60_000),
  };
  shadowContexts.set(conversationKey, fresh);
  return fresh;
}

// ── Resultado del shadow run ────────────────────────────────────

export interface ShadowResult {
  conversationKey: string;
  messageId: string;
  turnNumber: number;
  inputText: string;

  // Estado ANTES del turno
  before: {
    activeIntent: string | null;
    phase: string;
    slots: Record<string, unknown>;
    negations: number;
    facts: number;
  };

  // Detección del turno
  turn: {
    detectedIntent: string | null;
    intentConfidence: number;
    isExplicitChange: boolean;
    newSlots: Record<string, unknown>;
    facts: string[];
    negations: string[];
    isQuestion: boolean;
    isNegation: boolean;
    isConfirmation: boolean;
    isRejection: boolean;
    isCorrection: boolean;
    needsClarification: boolean;
  };

  // Decisión del nuevo motor
  decision: {
    action: string;
    reason: string;
    targetSlot?: string;
    question?: string;
    recommendation?: { type: string; target: string; reason: string };
  };

  // Respuesta generada (NO enviada)
  responseText: string;

  // Estado DESPUÉS del turno
  after: {
    activeIntent: string | null;
    goal: string | null;
    phase: string;
    slots: Record<string, unknown>;
    negations: number;
    facts: number;
    preferences: Record<string, unknown>;
    constraints: Record<string, unknown>;
    recommendations: number;
    clarificationCount: number;
  };

  // Comparación con flujo actual (placeholder)
  comparison: {
    currentFlowAction: string; // Lo que hizo el flujo actual
    newFlowAction: string;     // Lo que haría el nuevo flujo
    differs: boolean;
  };
}

// ── Shadow Runner principal ─────────────────────────────────────

/**
 * Ejecuta el nuevo motor conversacional en modo shadow.
 * NO envía respuesta. NO ejecuta tools. Solo registra y compara.
 */
export async function runShadow(
  conversationKey: string,
  messageId: string,
  text: string,
  currentFlowAction: string, // Lo que el flujo actual hizo/va a hacer
): Promise<ShadowResult> {
  // 1. Obtener contexto shadow
  const ctx = getOrCreateShadowContext(conversationKey);

  // 2. Capturar estado ANTES
  const before = {
    activeIntent: ctx.activeIntent,
    phase: ctx.phase,
    slots: { ...ctx.slots },
    negations: ctx.negations.length,
    facts: ctx.facts.length,
  };

  // 3. Ejecutar pipeline del nuevo motor
  const turn = understandTurn(text, ctx);
  const updatedCtx = updateContext(ctx, turn);
  const { activeIntent, goal, changed } = resolveIntent(updatedCtx, turn);
  updatedCtx.activeIntent = activeIntent;
  updatedCtx.goal = goal;
  updatedCtx.lastUserMessage = text;

  const decision = decide(updatedCtx, turn);
  const responseText = generateResponse(decision, updatedCtx, turn);

  // 4. Actualizar el contexto shadow (persistir entre turnos)
  updatedCtx.turnCount = ctx.turnCount + 1;
  updatedCtx.lastActivityAt = new Date();
  updatedCtx.expiresAt = new Date(Date.now() + 30 * 60_000);
  shadowContexts.set(conversationKey, updatedCtx);

  // 5. Capturar estado DESPUÉS
  const after = {
    activeIntent: updatedCtx.activeIntent,
    goal: updatedCtx.goal ? JSON.stringify(updatedCtx.goal) : null,
    phase: updatedCtx.phase,
    slots: { ...updatedCtx.slots },
    negations: updatedCtx.negations.length,
    facts: updatedCtx.facts.length,
    preferences: { ...updatedCtx.preferences },
    constraints: { ...updatedCtx.constraints },
    recommendations: updatedCtx.recommendations.length,
    clarificationCount: updatedCtx.clarification.count,
  };

  // 6. Comparar con flujo actual
  const comparison = {
    currentFlowAction,
    newFlowAction: decision.action,
    differs: currentFlowAction !== decision.action,
  };

  // 7. Log seguro (sin secretos)
  logShadowResult({
    conversationKey,
    messageId,
    turnNumber: updatedCtx.turnCount,
    inputText: text.slice(0, 50),
    newIntent: after.activeIntent,
    newAction: decision.action,
    differs: comparison.differs,
  });

  return {
    conversationKey,
    messageId,
    turnNumber: updatedCtx.turnCount,
    inputText: text,
    before,
    turn: {
      detectedIntent: turn.detectedIntent,
      intentConfidence: turn.intentConfidence,
      isExplicitChange: turn.isExplicitChange,
      newSlots: turn.newSlots,
      facts: turn.facts.map((f) => f.content),
      negations: turn.negations.map((n) => n.content),
      isQuestion: turn.isQuestion,
      isNegation: turn.isNegation,
      isConfirmation: turn.isConfirmation,
      isRejection: turn.isRejection,
      isCorrection: turn.isCorrection,
      needsClarification: turn.needsClarification,
    },
    decision: {
      action: decision.action,
      reason: decision.reason,
      targetSlot: decision.targetSlot,
      question: decision.question,
      recommendation: decision.recommendation,
    },
    responseText,
    after,
    comparison,
  };
}

// ── Logging seguro ──────────────────────────────────────────────

function logShadowResult(data: {
  conversationKey: string;
  messageId: string;
  turnNumber: number;
  inputText: string;
  newIntent: string | null;
  newAction: string;
  differs: boolean;
}): void {
  console.log(
    `[shadow-runner] SHADOW_RESULT conv=${data.conversationKey.slice(-4)} msg=${data.messageId} turn=${data.turnNumber} intent=${data.newIntent ?? "null"} action=${data.newAction} differs=${data.differs}`
  );
}

/**
 * Limpia el contexto shadow de una conversación (para testing o reset).
 */
export function resetShadowContext(conversationKey: string): void {
  shadowContexts.delete(conversationKey);
}

/**
 * Devuelve el contexto shadow actual (para inspección en tests).
 */
export function getShadowContext(conversationKey: string): ConversationContext | undefined {
  return shadowContexts.get(conversationKey);
}
