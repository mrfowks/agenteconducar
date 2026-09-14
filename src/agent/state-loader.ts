import { prisma } from "../db/client";
import { Prisma } from "@prisma/client";
import type { ConversationStateData, Intent, ConversationPhase } from "./types";

/**
 * Carga o crea un ConversationState para una conversación.
 * Identidad primaria: chatwootConversationId (unique).
 * phone es opcional (nullable).
 */

interface LoadOrCreateOptions {
  chatwootConversationId: number | null;
  phone: string | null;
  chatwootContactId?: number | null;
  sourceId?: string | null;
}

/** Interface para el subset de PrismaClient que usamos (permite inyectar mock) */
export interface StateDbClient {
  conversationState: {
    findUnique(args: { where: { chatwootConversationId?: number; id?: number } }): Promise<any>;
    findFirst(args: { where: { phone?: string }; orderBy?: any }): Promise<any>;
    create(args: { data: any }): Promise<any>;
    update(args: { where: { chatwootConversationId?: number; id?: number }; data: any }): Promise<any>;
  };
}

const DEFAULT_EXPIRY_MINUTES = 30;

export function getExpiryMinutes(): number {
  const val = parseInt(process.env.STATE_EXPIRY_MINUTES ?? "30", 10);
  return Number.isFinite(val) && val > 0 ? val : DEFAULT_EXPIRY_MINUTES;
}

export function isExpired(expiresAt: Date | null): boolean {
  if (!expiresAt) return false;
  return new Date() > expiresAt;
}

export function newExpiry(): Date {
  return new Date(Date.now() + getExpiryMinutes() * 60_000);
}

export function toStateData(record: any): ConversationStateData {
  return {
    chatwootConversationId: record.chatwootConversationId ?? null,
    phone: record.phone ?? null,
    chatwootContactId: record.chatwootContactId ?? null,
    sourceId: record.sourceId ?? null,
    activeIntent: (record.activeIntent as Intent) ?? null,
    phase: (record.phase as ConversationPhase) ?? "IDLE",
    slots: (record.slots as Record<string, unknown>) ?? {},
    repromptCount: record.repromptCount ?? 0,
    lastQuestionAsked: record.lastQuestionAsked ?? null,
    messageCount: record.messageCount ?? 0,
    expiresAt: record.expiresAt ?? null,
  };
}

/**
 * Carga el ConversationState existente o crea uno nuevo.
 * Si el estado existe pero está expirado, lo resetea a IDLE.
 * Si no existe, crea uno nuevo con phase=IDLE.
 *
 * Manejo de concurrencia: usa upsert con chatwootConversationId unique
 * para evitar duplicados en race conditions.
 */
export async function loadOrCreateState(
  options: LoadOrCreateOptions,
  db: StateDbClient = prisma as unknown as StateDbClient,
): Promise<ConversationStateData> {
  const { chatwootConversationId, phone, chatwootContactId, sourceId } = options;

  // Buscar por chatwootConversationId (preferente, unique)
  if (chatwootConversationId != null) {
    const existing = await db.conversationState.findUnique({
      where: { chatwootConversationId },
    });

    if (existing) {
      // Estado existe: verificar expiración
      if (isExpired(existing.expiresAt)) {
        // Estado expirado: resetear a IDLE
        const reset = await db.conversationState.update({
          where: { id: existing.id },
          data: {
            activeIntent: null,
            previousIntent: existing.activeIntent, // preservar como previous
            intentChangedAt: new Date(),
            phase: "IDLE",
            slots: {},
            repromptCount: 0,
            lastQuestionAsked: null,
            lastToolCalled: null,
            messageCount: 0,
            expiresAt: newExpiry(),
          },
        });
        return toStateData(reset);
      }

      // Estado válido: actualizar lastActivityAt y expiresAt
      const updated = await db.conversationState.update({
        where: { id: existing.id },
        data: {
          lastActivityAt: new Date(),
          expiresAt: newExpiry(), // renovar expiración
        },
      });
      return toStateData(updated);
    }

    // No existe: crear nuevo (maneja race condition via P2002)
    try {
      const created = await db.conversationState.create({
        data: {
          chatwootConversationId,
          phone: phone ?? undefined,
          chatwootContactId: chatwootContactId ?? undefined,
          sourceId: sourceId ?? undefined,
          phase: "IDLE",
          slots: {},
          repromptCount: 0,
          messageCount: 0,
          expiresAt: newExpiry(),
        },
      });
      return toStateData(created);
    } catch (err: any) {
      // P2002 = unique constraint violation (race condition: otro request lo creó primero)
      if (err?.code === "P2002") {
        // Re-leer el registro creado por el otro request
        const retry = await db.conversationState.findUnique({
          where: { chatwootConversationId },
        });
        if (retry) return toStateData(retry);
      }
      throw err;
    }
  }

  // Sin chatwootConversationId: buscar por phone (fallback)
  if (phone) {
    const existing = await db.conversationState.findFirst({
      where: { phone },
      orderBy: { lastActivityAt: "desc" },
    });

    if (existing) {
      if (isExpired(existing.expiresAt)) {
        const reset = await db.conversationState.update({
          where: { id: existing.id },
          data: {
            activeIntent: null,
            previousIntent: existing.activeIntent,
            intentChangedAt: new Date(),
            phase: "IDLE",
            slots: {},
            repromptCount: 0,
            lastQuestionAsked: null,
            lastToolCalled: null,
            messageCount: 0,
            expiresAt: newExpiry(),
          },
        });
        return toStateData(reset);
      }

      const updated = await db.conversationState.update({
        where: { id: existing.id },
        data: {
          lastActivityAt: new Date(),
          expiresAt: newExpiry(),
        },
      });
      return toStateData(updated);
    }

    // Crear nuevo por phone
    const created = await db.conversationState.create({
      data: {
        phone,
        chatwootContactId: chatwootContactId ?? undefined,
        sourceId: sourceId ?? undefined,
        phase: "IDLE",
        slots: {},
        repromptCount: 0,
        messageCount: 0,
        expiresAt: newExpiry(),
      },
    });
    return toStateData(created);
  }

  // Sin conversationId ni phone: crear estado temporal (sin persistir identidad)
  // Esto no debería ocurrir en producción, pero es un fallback seguro
  const created = await db.conversationState.create({
    data: {
      phase: "IDLE",
      slots: {},
      repromptCount: 0,
      messageCount: 0,
      expiresAt: newExpiry(),
    },
  });
  return toStateData(created);
}

/**
 * Guarda el estado actualizado en la BD.
 * Solo actualiza los campos que pueden cambiar durante el procesamiento.
 */
export async function saveState(
  chatwootConversationId: number,
  updates: Partial<ConversationStateData>,
  db: StateDbClient = prisma as unknown as StateDbClient,
): Promise<void> {
  await db.conversationState.update({
    where: { chatwootConversationId },
    data: {
      activeIntent: updates.activeIntent ?? undefined,
      phase: updates.phase ?? undefined,
      slots: updates.slots !== undefined ? (updates.slots as Prisma.InputJsonValue) : undefined,
      repromptCount: updates.repromptCount ?? undefined,
      lastQuestionAsked: updates.lastQuestionAsked ?? undefined,
      messageCount: updates.messageCount ?? undefined,
      lastActivityAt: new Date(),
      expiresAt: newExpiry(),
    },
  });
}

/**
 * Resetea el estado a IDLE (usado para timeout o reinicio explícito).
 */
export async function resetState(
  chatwootConversationId: number,
  db: StateDbClient = prisma as unknown as StateDbClient,
): Promise<void> {
  const existing = await db.conversationState.findUnique({
    where: { chatwootConversationId },
  });
  if (!existing) return;

  await db.conversationState.update({
    where: { id: existing.id },
    data: {
      activeIntent: null,
      previousIntent: existing.activeIntent,
      intentChangedAt: new Date(),
      phase: "IDLE",
      slots: {},
      repromptCount: 0,
      lastQuestionAsked: null,
      lastToolCalled: null,
      messageCount: 0,
      expiresAt: newExpiry(),
    },
  });
}
