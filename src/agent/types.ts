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
  phase: ConversationPhase;
  slots: Record<string, unknown>;
  repromptCount: number;
  lastQuestionAsked: string | null;
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
  | { type: "EXECUTE_TOOL"; tool: string; args: Record<string, unknown> }
  | { type: "HANDOFF"; reason: string }
  | { type: "ASK_CLARIFICATION"; options: string[] };
