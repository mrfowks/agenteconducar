import { env } from "../config/env";
import { runAgent } from "./agent";
import { processMessage } from "./conversation-router";
import { buildResponse } from "./response-builder";
import { evaluateRecommendation } from "./recommendation-engine";
import { decideResponse } from "./response-decider";
import { resolveContext } from "./context-resolver";

// ── Logging seguro ──────────────────────────────────────────────

function logRouter(event: string, data: Record<string, unknown> = {}): void {
  console.log(`[conversation-router] ${event}`, JSON.stringify(data));
}

// ── Canary check ────────────────────────────────────────────────

function isCanaryTarget(
  phone: string | null,
  conversationId: number | null,
): boolean {
  const { canaryPhones, canaryConversationIds } = env.featureFlags;

  // Sin restricciones de canary → todos pasan (full rollout)
  if (canaryPhones.length === 0 && canaryConversationIds.length === 0) {
    return true;
  }

  // Verificar conversationId primero (preferente)
  if (conversationId && canaryConversationIds.includes(conversationId)) {
    return true;
  }

  // Verificar phone
  if (phone && canaryPhones.includes(phone)) {
    return true;
  }

  return false;
}

// ── Gateway principal ───────────────────────────────────────────

export interface RouteGatewayParams {
  phone: string;
  text: string;
  isNewUser: boolean;
  messageId: string;
  chatwootConversationId: number | null;
  chatwootContactId?: number | null;
  sourceId?: string | null;
  source: "meta" | "chatwoot";
}

/**
 * Punto de decisión: ¿usar ConversationRouter o runAgent?
 *
 * USE_NEW_FLOW=shadow → ejecuta nuevo motor en paralelo (sin side effects), SIEMPRE devuelve flujo actual
 * USE_STATEFUL_ROUTER=false → runAgent (producción actual)
 * USE_STATEFUL_ROUTER=true + canary match → ConversationRouter
 * USE_STATEFUL_ROUTER=true + no canary → runAgent
 * ConversationRouter falla antes de side effect → fallback runAgent
 * ConversationRouter ejecuta side effect → NO fallback
 */
export async function routeMessage(params: RouteGatewayParams): Promise<string> {
  const {
    phone,
    text,
    isNewUser,
    messageId,
    chatwootConversationId,
    chatwootContactId,
    sourceId,
    source,
  } = params;

  // ── Gate 0: Shadow Mode ──
  // Ejecuta el nuevo motor en paralelo SIN enviar respuestas, SIN side effects.
  // SIEMPRE devuelve la respuesta del flujo actual.
  if (env.featureFlags.useNewFlow === "shadow") {
    // 1. Ejecutar flujo actual (producción) — resultado real
    let currentResponse: string;
    if (!env.featureFlags.useStatefulRouter) {
      currentResponse = await runAgent(phone, text, isNewUser, messageId);
    } else if (isCanaryTarget(phone, chatwootConversationId)) {
      // ConversationRouter para canary targets
      try {
        const result = await processMessage(text, {
          chatwootConversationId,
          phone,
          chatwootContactId,
          sourceId,
          isNewUser,
        });
        const recommendation = evaluateRecommendation({
          activeIntent: result.state.activeIntent,
          slots: result.slots,
          state: result.state,
          context: result.context,
        });
        const action = decideResponse({
          state: result.state,
          intent: result.intent,
          slots: {
            extracted: result.slots,
            updated: result.slots,
            missing: result.missingSlots.map((name) => ({
              name,
              question: `¿Podrías indicarme ${name}?`,
              type: "string" as const,
              required: true,
            })),
            isComplete: result.missingSlots.length === 0,
          },
          recommendation,
          userText: text,
        });
        if (action.type === "RECOMMEND" && recommendation?.recommendation) {
          result.state.lastRecommendationType = recommendation.recommendation.type;
        }
        const response = buildResponse({
          action,
          state: result.state,
          context: result.context,
          recommendation: recommendation.recommendation,
        });
        currentResponse = response.text;
      } catch {
        currentResponse = await runAgent(phone, text, isNewUser, messageId);
      }
    } else {
      currentResponse = await runAgent(phone, text, isNewUser, messageId);
    }

    // 2. Ejecutar nuevo motor en shadow (sin enviar, sin side effects)
    try {
      const { runShadow } = await import("./shadow-runner");
      const conversationKey = chatwootConversationId?.toString() ?? phone ?? `msg-${messageId}`;
      const shadowResult = await runShadow(
        conversationKey,
        messageId,
        text,
        // currentFlowAction: inferir qué hizo el flujo actual
        env.featureFlags.useStatefulRouter ? "ConversationRouter" : "runAgent",
      );

      // 3. Log seguro de comparación
      console.log(
        `[shadow-runner] SHADOW_COMPARISON conv=${conversationKey.slice(-4)} msg=${messageId} current=${shadowResult.comparison.currentFlowAction} new=${shadowResult.comparison.newFlowAction} differs=${shadowResult.comparison.differs} response=${shadowResult.responseText.slice(0, 60)}`
      );
    } catch (shadowErr) {
      console.warn(`[shadow-runner] shadow error (non-blocking):`, shadowErr instanceof Error ? shadowErr.message : shadowErr);
    }

    // 4. SIEMPRE devolver la respuesta del flujo actual
    return currentResponse;
  }

  // ── Gate 1: Feature flag ──
  if (!env.featureFlags.useStatefulRouter) {
    logRouter("ROUTER_DISABLED", { source, messageId });
    return runAgent(phone, text, isNewUser, messageId);
  }

  // ── Gate 2: Canary ──
  if (!isCanaryTarget(phone, chatwootConversationId)) {
    logRouter("ROUTER_CANARY_SKIP", { source, messageId, phone: phone.slice(-4) });
    return runAgent(phone, text, isNewUser, messageId);
  }

  logRouter("ROUTER_START", { source, messageId, conversationId: chatwootConversationId });

  // ── Intentar ConversationRouter ──
  try {
    // 1. Procesar mensaje a través del pipeline
    const result = await processMessage(text, {
      chatwootConversationId,
      phone,
      chatwootContactId,
      sourceId,
      isNewUser,
    });

    // 2. Evaluar recomendación
    const recommendation = evaluateRecommendation({
      activeIntent: result.state.activeIntent,
      slots: result.slots,
      state: result.state,
      context: result.context,
    });

    // 3. Decidir respuesta
    const action = decideResponse({
      state: result.state,
      intent: result.intent,
      slots: {
        extracted: result.slots,
        updated: result.slots,
        missing: result.missingSlots.map((name) => ({
          name,
          question: `¿Podrías indicarme ${name}?`,
          type: "string" as const,
          required: true,
        })),
        isComplete: result.missingSlots.length === 0,
      },
      recommendation,
      userText: text,
    });

    // 5. Persistir tipo de recomendación ofrecida
    if (action.type === "RECOMMEND" && recommendation?.recommendation) {
      result.state.lastRecommendationType = recommendation.recommendation.type;
    }

    // 4. Construir respuesta
    const response = buildResponse({
      action,
      state: result.state,
      context: result.context,
      recommendation: recommendation.recommendation,
    });

    logRouter("ROUTER_SUCCESS", {
      source,
      messageId,
      conversationId: chatwootConversationId,
      intent: result.intent.intent,
      phase: result.phase,
      actionType: action.type,
    });

    return response.text;
  } catch (err) {
    // ── Fallback seguro ──
    // Solo fallback si NO hubo side effects
    // (en Fase 2B.7 no hay side effects reales todavía)
    logRouter("ROUTER_FALLBACK", {
      source,
      messageId,
      errorType: err instanceof Error ? err.name : "UnknownError",
      // No loggear err.message directamente para evitar filtrar tokens/secretos
    });

    return runAgent(phone, text, isNewUser, messageId);
  }
}
