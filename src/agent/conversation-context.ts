// Tipos para el nuevo motor conversacional

export type Intent =
  | "ALQUILER_EXAMEN" | "SIMULACRO" | "PRACTICA" | "PAQUETE"
  | "HORARIOS" | "RESERVA" | "PAGO" | "HANDOFF" | "OTROS";

export type ConversationPhase =
  | "IDLE" | "EXPLORING" | "GATHERING" | "CONFIRMING"
  | "EXECUTING" | "POST_ACTION" | "HANDOFF";

export type ConversationGoal =
  | { type: "BOOK_SERVICE"; service: "practica" | "simulacro" }
  | { type: "GET_INFO"; topic: string }
  | { type: "VIEW_SCHEDULE" }
  | { type: "VIEW_PACKAGES" }
  | { type: "RENT_VEHICLE" }
  | { type: "TALK_TO_HUMAN" }
  | { type: "AMBIGUOUS" };

export type DecisionAction =
  | "ANSWER" | "CLARIFY" | "GUIDE" | "RECOMMEND"
  | "ASK_FOR_MISSING_INFO" | "CONFIRM" | "EXECUTE" | "HANDOFF";

export interface ConversationSlots {
  actividad: "practica" | "simulacro" | null;
  categoria: "A1" | "A2A" | "A2B" | "A3A" | "A3B" | "A3C" | null;
  circuito: "oficial" | "alternativo" | null;
  fecha: string | null;
  fechaOriginal: string | null;
  hora: string | null;
  horaOriginal: string | null;
  examen_fecha: string | null;
  paquete: string | null;
  experiencia: "desde_cero" | "sabe_manejar" | null;
  urgencia: "normal" | "alta" | null;
}

export interface UserPreferences {
  prefersMorning: boolean | null;
  prefersAutomatic: boolean | null;
  prefersOfficialCircuit: boolean | null;
}

export interface UserConstraints {
  examDate: string | null;
  noSameDayAsExam: boolean;
  timeConstraints: string[];
}

export interface Fact {
  id: string;
  content: string;
  confidence: number;
  timestamp: Date;
  slotMapping: string | null;
}

export interface Negation {
  id: string;
  content: string;
  timestamp: Date;
  negatedSlot: string | null;
  negatedValue: unknown;
}

export interface RecommendationRecord {
  id: string;
  type: string;
  target: string;
  reason: string;
  timestamp: Date;
  status: "offered" | "accepted" | "rejected" | "expired";
}

export interface ClarificationState {
  count: number;
  lastQuestion: string | null;
  reason: string | null;
}

export interface ConfirmationState {
  status: "none" | "pending" | "confirmed" | "rejected";
  summary: string | null;
  confirmedAt: Date | null;
  rejectedAt: Date | null;
}

export interface PendingAction {
  type: "tool_execution";
  tool: string;
  args: Record<string, unknown>;
  readyAt: Date;
}

export interface HandoffState {
  reason: string;
  triggeredAt: Date;
  contextSummary: string;
}

export interface ConversationContext {
  // Identidad
  id: string; // chatwootConversationId o phone
  phone: string | null;
  chatwootContactId: number | null;
  sourceId: string | null;

  // Intención y objetivo
  activeIntent: Intent | null;
  goal: ConversationGoal | null;
  intentHistory: { intent: Intent; confidence: number; timestamp: Date; trigger: string }[];

  // Contexto conversacional
  phase: ConversationPhase;
  turnCount: number;
  lastUserMessage: string;
  lastAssistantQuestion: string | null;
  lastResponseHash: string | null;

  // Slots
  slots: ConversationSlots;
  slotConfidence: Record<string, number>;
  slotSources: Record<string, "user_explicit" | "user_inferred" | "system_derived">;

  // Preferencias y restricciones
  preferences: UserPreferences;
  constraints: UserConstraints;

  // Datos del usuario
  facts: Fact[];
  negations: Negation[];

  // Recomendaciones
  recommendations: RecommendationRecord[];
  lastRecommendationType: string | null;

  // Estado
  clarification: ClarificationState;
  confirmation: ConfirmationState;
  pendingAction: PendingAction | null;
  handoff: HandoffState | null;

  // Metadata
  isNewUser: boolean;
  createdAt: Date;
  lastActivityAt: Date;
  expiresAt: Date | null;
}
