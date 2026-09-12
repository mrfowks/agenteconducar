-- Fase 2: mapeo de conversaciones Conducar ↔ Chatwoot.
-- Se generó manualmente (no hay BD local con credenciales válidas para
-- `prisma migrate dev`); SQL válido para que `prisma migrate deploy` lo
-- aplique en la BD de desarrollo/producción.
-- No toca migraciones anteriores ni elimina datos.

-- AlterTable
ALTER TABLE "Conversation"
  ADD COLUMN     "chatwootAccountId" INTEGER,
  ADD COLUMN     "chatwootContactId" INTEGER,
  ADD COLUMN     "chatwootConversationId" INTEGER,
  ADD COLUMN     "chatwootInboxId" INTEGER,
  ADD COLUMN     "chatwootSourceId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Conversation_chatwootConversationId_key" ON "Conversation"("chatwootConversationId");