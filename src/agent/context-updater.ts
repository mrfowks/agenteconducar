import type { ConversationContext, Fact, Negation } from "./conversation-context";
import type { TurnUnderstanding } from "./turn-understanding";

/** Keys handled separately from slot assignment. */
const PREFERENCE_KEYS = new Set(["prefersMorning", "prefersAutomatic", "prefersOfficialCircuit"]);

/**
 * Actualiza el ConversationContext con la información del turno actual.
 * NUNCA borra información válida solo porque no aparece en el turno actual.
 */
export function updateContext(ctx: ConversationContext, turn: TurnUnderstanding): ConversationContext {
  // Deep copy slots to avoid mutating the original context
  const updated: ConversationContext = {
    ...ctx,
    slots: { ...ctx.slots },
    preferences: { ...ctx.preferences },
    constraints: { ...ctx.constraints },
    clarification: { ...ctx.clarification },
    confirmation: { ...ctx.confirmation },
    slotConfidence: { ...ctx.slotConfidence },
    slotSources: { ...ctx.slotSources },
    facts: [...ctx.facts],
    negations: [...ctx.negations],
    recommendations: [...ctx.recommendations],
    intentHistory: [...ctx.intentHistory],
  };

  // 1. Actualizar intención (solo si confianza alta o cambio explícito)
  if (turn.detectedIntent && turn.intentConfidence > 0.7) {
    if (turn.isExplicitChange || !ctx.activeIntent) {
      updated.activeIntent = turn.detectedIntent;
      updated.intentHistory = [
        ...ctx.intentHistory,
        { intent: turn.detectedIntent, confidence: turn.intentConfidence, timestamp: new Date(), trigger: turn.newSlots ? "turn" : "context" },
      ];
    }
  }

  // 2. Merge de slots (nunca sobrescribir con null)
  for (const [key, value] of Object.entries(turn.newSlots)) {
    if (PREFERENCE_KEYS.has(key)) continue; // handled below
    if (value !== null && value !== undefined && value !== "") {
      (updated.slots as any)[key] = value;
      updated.slotConfidence[key] = turn.intentConfidence;
      updated.slotSources[key] = "user_explicit";
    }
  }

  // 2b. Merge de preferencias desde newSlots
  if ("prefersMorning" in turn.newSlots) {
    updated.preferences = { ...updated.preferences, prefersMorning: turn.newSlots.prefersMorning as boolean };
  }
  if ("prefersAutomatic" in turn.newSlots) {
    updated.preferences = { ...updated.preferences, prefersAutomatic: turn.newSlots.prefersAutomatic as boolean };
  }
  if ("prefersOfficialCircuit" in turn.newSlots) {
    updated.preferences = { ...updated.preferences, prefersOfficialCircuit: turn.newSlots.prefersOfficialCircuit as boolean };
  }

  // 3. Agregar hechos (nunca duplicar)
  for (const fact of turn.facts) {
    const exists = updated.facts.some((f) => f.content === fact.content);
    if (!exists) {
      updated.facts = [...updated.facts, { ...fact, id: `f-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, confidence: turn.intentConfidence, timestamp: new Date() }];
    }
  }

  // 4. Agregar negaciones (nunca duplicar)
  for (const neg of turn.negations) {
    const exists = updated.negations.some((n) => n.content === neg.content);
    if (!exists) {
      updated.negations = [...updated.negations, { ...neg, id: `n-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, timestamp: new Date() }];
    }
  }

  // 5. Actualizar contador de aclaraciones
  if (turn.needsClarification) {
    updated.clarification = {
      count: ctx.clarification.count + 1,
      lastQuestion: ctx.lastAssistantQuestion,
      reason: "ambiguous_intent",
    };
  }

  // 6. Actualizar metadata
  updated.turnCount = ctx.turnCount + 1;
  updated.lastActivityAt = new Date();

  return updated;
}
