-- CreateEnum
CREATE TYPE "Intent" AS ENUM ('ALQUILER_EXAMEN', 'SIMULACRO', 'PRACTICA', 'PAQUETE', 'HORARIOS', 'RESERVA', 'PAGO', 'HANDOFF', 'OTROS');

-- CreateEnum
CREATE TYPE "ConversationPhase" AS ENUM ('IDLE', 'GATHERING', 'CONFIRMING', 'EXECUTING', 'POST_ACTION', 'HANDOFF');

-- CreateTable
CREATE TABLE "ConversationState" (
    "id" SERIAL NOT NULL,
    "chatwootConversationId" INTEGER,
    "phone" TEXT,
    "chatwootContactId" INTEGER,
    "sourceId" TEXT,
    "activeIntent" "Intent",
    "intentConfidence" DOUBLE PRECISION,
    "previousIntent" "Intent",
    "intentChangedAt" TIMESTAMP(3),
    "phase" "ConversationPhase" NOT NULL DEFAULT 'IDLE',
    "slots" JSONB NOT NULL DEFAULT '{}',
    "repromptCount" INTEGER NOT NULL DEFAULT 0,
    "lastQuestionAsked" TEXT,
    "lastToolCalled" TEXT,
    "lastResponseHash" TEXT,
    "messageCount" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastActivityAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "ConversationState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ConversationState_chatwootConversationId_key" ON "ConversationState"("chatwootConversationId");

-- CreateIndex
CREATE INDEX "ConversationState_phone_idx" ON "ConversationState"("phone");

-- CreateIndex
CREATE INDEX "ConversationState_chatwootConversationId_idx" ON "ConversationState"("chatwootConversationId");

-- CreateIndex
CREATE INDEX "ConversationState_chatwootContactId_idx" ON "ConversationState"("chatwootContactId");

-- CreateIndex
CREATE INDEX "ConversationState_activeIntent_idx" ON "ConversationState"("activeIntent");

-- CreateIndex
CREATE INDEX "ConversationState_phase_idx" ON "ConversationState"("phase");

-- CreateIndex
CREATE INDEX "ConversationState_expiresAt_idx" ON "ConversationState"("expiresAt");
