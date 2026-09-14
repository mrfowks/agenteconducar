// Tipos compartidos para la arquitectura conversacional Fase 2

export type Intent =
  | "ALQUILER_EXAMEN"
  | "SIMULACRO"
  | "PRACTICA"
  | "PAQUETE"
  | "HORARIOS"
  | "RESERVA"
  | "PAGO"
  | "HANDOFF"
  | "OTROS";

export type ConversationPhase =
  | "IDLE"
  | "GATHERING"
  | "CONFIRMING"
  | "EXECUTING"
  | "POST_ACTION"
  | "HANDOFF";

export interface ConversationStateData {
  chatwootConversationId: number | null;
  phone: string | null;
  chatwootContactId: number | null;
  sourceId: string | null;
  activeIntent: Intent | null;
  previousIntent?: Intent | null;
  intentChangedAt?: Date | null;
  phase: ConversationPhase;
  slots: Record<string, unknown>;
  repromptCount: number;
  lastQuestionAsked: string | null;
  /** Tipo de la última recomendación ofrecida (para evitar repetición). */
  lastRecommendationType?: string | null;
  messageCount: number;
  expiresAt: Date | null;
}

export interface SlotDefinition {
  name: string;
  question: string;
  type: "string" | "enum" | "date" | "time" | "number";
  required: boolean;
  enum?: string[];
  extractFrom?: string;
  validation?: string; // regex como string
  followUp?: string;
}

export interface IntentDefinition {
  intent: Intent;
  aliases: string[];
  requiredSlots: SlotDefinition[];
  optionalSlots: SlotDefinition[];
  tools: string[];
  exitConditions: string[];
  businessRules: string[];
}

export interface IntentDetectionResult {
  intent: Intent;
  confidence: number;
  isChange: boolean;
  isExplicitChange: boolean;
  rawText: string;
}

/**
 * Datos de recomendación para la acción RECOMMEND.
 * Estructuralmente compatible con Recommendation de recommendation-engine.ts.
 */
export interface RecommendationData {
  type: string;
  target: string;
  reason: string;
  confidence: number;
  supportingFacts: string[];
  alternatives: string[];
  estimatedValue: {
    price: number | null;
    savings: number | null;
    separateTotal: number | null;
  };
  requiresConfirmation: boolean;
}

export interface SlotExtractionResult {
  extracted: Record<string, unknown>;
  updated: Record<string, unknown>;
  missing: SlotDefinition[];
  isComplete: boolean;
}

export type ResponseAction =
  | { type: "RESPOND"; content: string }
  | { type: "REPROMPT"; question: string; slotName: string }
  | { type: "CONFIRM"; summary: string }
  | { type: "RECOMMEND"; recommendation: RecommendationData }
  | { type: "EXECUTE_TOOL"; tool: string; args: Record<string, unknown> }
  | { type: "HANDOFF"; reason: string }
  | { type: "ASK_CLARIFICATION"; options: string[] };
