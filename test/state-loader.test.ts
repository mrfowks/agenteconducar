import { test } from "node:test";
import assert from "node:assert/strict";
import {
  loadOrCreateState,
  saveState,
  resetState,
  isExpired,
  getExpiryMinutes,
  newExpiry,
  toStateData,
} from "../src/agent/state-loader.js";
import type { StateDbClient } from "../src/agent/state-loader.js";

// ═══════════════════════════════════════════════════════════════════
// Mock de Prisma para tests unitarios del state-loader
// ═══════════════════════════════════════════════════════════════════

interface MockState {
  id: number;
  chatwootConversationId: number | null;
  phone: string | null;
  chatwootContactId: number | null;
  sourceId: string | null;
  activeIntent: string | null;
  previousIntent: string | null;
  intentChangedAt: Date | null;
  phase: string;
  slots: Record<string, unknown>;
  repromptCount: number;
  lastQuestionAsked: string | null;
  lastToolCalled: string | null;
  messageCount: number;
  startedAt: Date;
  lastActivityAt: Date;
  expiresAt: Date | null;
}

let mockStore: Map<number, MockState>;
let nextId: number;

function resetMockStore() {
  mockStore = new Map();
  nextId = 1;
}

function createMockRecord(data: any): MockState {
  const id = nextId++;
  const now = new Date();
  return {
    id,
    chatwootConversationId: data.chatwootConversationId ?? null,
    phone: data.phone ?? null,
    chatwootContactId: data.chatwootContactId ?? null,
    sourceId: data.sourceId ?? null,
    activeIntent: data.activeIntent ?? null,
    previousIntent: data.previousIntent ?? null,
    intentChangedAt: data.intentChangedAt ?? null,
    phase: data.phase ?? "IDLE",
    slots: data.slots ?? {},
    repromptCount: data.repromptCount ?? 0,
    lastQuestionAsked: data.lastQuestionAsked ?? null,
    lastToolCalled: data.lastToolCalled ?? null,
    messageCount: data.messageCount ?? 0,
    startedAt: now,
    lastActivityAt: now,
    expiresAt: data.expiresAt ?? null,
  };
}

function createMockDb(): StateDbClient {
  return {
    conversationState: {
      findUnique: async ({ where }: any) => {
        if (where.chatwootConversationId != null) {
          return mockStore.get(where.chatwootConversationId) ?? null;
        }
        if (where.id != null) {
          for (const s of mockStore.values()) {
            if (s.id === where.id) return s;
          }
        }
        return null;
      },
      findFirst: async ({ where }: any) => {
        const results: MockState[] = [];
        for (const s of mockStore.values()) {
          if (where.phone && s.phone === where.phone) results.push(s);
        }
        if (results.length === 0) return null;
        results.sort((a, b) => b.lastActivityAt.getTime() - a.lastActivityAt.getTime());
        return results[0];
      },
      create: async ({ data }: any) => {
        if (data.chatwootConversationId != null && mockStore.has(data.chatwootConversationId)) {
          const err: any = new Error("Unique constraint failed on the fields: (`chatwootConversationId`)");
          err.code = "P2002";
          err.meta = { target: ["chatwootConversationId"] };
          throw err;
        }
        const record = createMockRecord(data);
        if (record.chatwootConversationId != null) {
          mockStore.set(record.chatwootConversationId, record);
        }
        return record;
      },
      update: async ({ where, data }: any) => {
        let record: MockState | undefined;
        if (where.chatwootConversationId != null) {
          record = mockStore.get(where.chatwootConversationId);
        } else if (where.id != null) {
          for (const s of mockStore.values()) {
            if (s.id === where.id) { record = s; break; }
          }
        }
        if (!record) throw new Error("Record to update not found");
        for (const [key, value] of Object.entries(data)) {
          if (value !== undefined) {
            (record as any)[key] = value;
          }
        }
        record.lastActivityAt = new Date();
        return record;
      },
    },
  };
}

// ═══════════════════════════════════════════════════════════════════
// Tests de funciones puras
// ═══════════════════════════════════════════════════════════════════

test("PURE1. isExpired(null) → false", () => {
  assert.equal(isExpired(null), false);
});

test("PURE2. isExpired(futuro) → false", () => {
  assert.equal(isExpired(new Date(Date.now() + 60_000)), false);
});

test("PURE3. isExpired(pasado) → true", () => {
  assert.equal(isExpired(new Date(Date.now() - 60_000)), true);
});

test("PURE4. getExpiryMinutes default = 30", () => {
  const original = process.env.STATE_EXPIRY_MINUTES;
  delete process.env.STATE_EXPIRY_MINUTES;
  assert.equal(getExpiryMinutes(), 30);
  if (original !== undefined) process.env.STATE_EXPIRY_MINUTES = original;
});

test("PURE5. getExpiryMinutes con env custom", () => {
  const original = process.env.STATE_EXPIRY_MINUTES;
  process.env.STATE_EXPIRY_MINUTES = "15";
  assert.equal(getExpiryMinutes(), 15);
  if (original !== undefined) process.env.STATE_EXPIRY_MINUTES = original;
  else delete process.env.STATE_EXPIRY_MINUTES;
});

test("PURE6. getExpiryMinutes con env inválido → default 30", () => {
  const original = process.env.STATE_EXPIRY_MINUTES;
  process.env.STATE_EXPIRY_MINUTES = "abc";
  assert.equal(getExpiryMinutes(), 30);
  if (original !== undefined) process.env.STATE_EXPIRY_MINUTES = original;
  else delete process.env.STATE_EXPIRY_MINUTES;
});

test("PURE7. newExpiry() es ~30 min en el futuro", () => {
  const before = Date.now() + 29 * 60_000;
  const expiry = newExpiry();
  const after = Date.now() + 31 * 60_000;
  assert.ok(expiry.getTime() >= before && expiry.getTime() <= after);
});

test("PURE8. toStateData mapea correctamente", () => {
  const now = new Date();
  const record = {
    chatwootConversationId: 42,
    phone: "51999988777",
    chatwootContactId: 9,
    sourceId: "51999988777",
    activeIntent: "PRACTICA",
    phase: "GATHERING",
    slots: { categoria: "A1" },
    repromptCount: 1,
    lastQuestionAsked: "¿Categoría?",
    messageCount: 3,
    expiresAt: now,
  };
  const result = toStateData(record);
  assert.equal(result.chatwootConversationId, 42);
  assert.equal(result.phone, "51999988777");
  assert.equal(result.chatwootContactId, 9);
  assert.equal(result.sourceId, "51999988777");
  assert.equal(result.activeIntent, "PRACTICA");
  assert.equal(result.phase, "GATHERING");
  assert.deepEqual(result.slots, { categoria: "A1" });
  assert.equal(result.repromptCount, 1);
  assert.equal(result.lastQuestionAsked, "¿Categoría?");
  assert.equal(result.messageCount, 3);
  assert.equal(result.expiresAt, now);
});

test("PURE9. toStateData con campos nulos", () => {
  const record = {
    chatwootConversationId: null,
    phone: null,
    chatwootContactId: null,
    sourceId: null,
    activeIntent: null,
    phase: "IDLE",
    slots: {},
    repromptCount: 0,
    lastQuestionAsked: null,
    messageCount: 0,
    expiresAt: null,
  };
  const result = toStateData(record);
  assert.equal(result.chatwootConversationId, null);
  assert.equal(result.phone, null);
  assert.equal(result.activeIntent, null);
  assert.equal(result.phase, "IDLE");
});

// ═══════════════════════════════════════════════════════════════════
// Tests de loadOrCreateState (con mock inyectado)
// ═══════════════════════════════════════════════════════════════════

test("SL1. crea estado nuevo por conversationId", async () => {
  resetMockStore();
  const db = createMockDb();
  const convId = 100;

  const result = await loadOrCreateState(
    { chatwootConversationId: convId, phone: null },
    db,
  );

  assert.equal(result.chatwootConversationId, convId);
  assert.equal(result.phase, "IDLE");
  assert.deepEqual(result.slots, {});
  assert.equal(result.repromptCount, 0);
  assert.equal(result.messageCount, 0);
  assert.equal(result.activeIntent, null);
  assert.equal(result.phone, null);
  assert.ok(result.expiresAt);
  assert.ok(result.expiresAt > new Date());
});

test("SL2. crea estado nuevo con phone y contactId", async () => {
  resetMockStore();
  const db = createMockDb();
  const convId = 110;
  const phone = "51999988777";

  const result = await loadOrCreateState(
    { chatwootConversationId: convId, phone, chatwootContactId: 42, sourceId: phone },
    db,
  );

  assert.equal(result.chatwootConversationId, convId);
  assert.equal(result.phone, phone);
  assert.equal(result.chatwootContactId, 42);
  assert.equal(result.sourceId, phone);
  assert.equal(result.phase, "IDLE");
});

test("SL3. recupera estado existente válido", async () => {
  resetMockStore();
  const db = createMockDb();
  const convId = 200;

  const existing = createMockRecord({
    chatwootConversationId: convId,
    activeIntent: "PRACTICA",
    phase: "GATHERING",
    slots: { categoria: "A1" },
    repromptCount: 1,
    messageCount: 3,
    expiresAt: new Date(Date.now() + 30 * 60_000),
  });
  mockStore.set(convId, existing);

  const result = await loadOrCreateState(
    { chatwootConversationId: convId, phone: null },
    db,
  );

  assert.equal(result.chatwootConversationId, convId);
  assert.equal(result.activeIntent, "PRACTICA");
  assert.equal(result.phase, "GATHERING");
  assert.deepEqual(result.slots, { categoria: "A1" });
  assert.equal(result.repromptCount, 1);
  assert.equal(result.messageCount, 3);
});

test("SL4. estado expirado se resetea a IDLE", async () => {
  resetMockStore();
  const db = createMockDb();
  const convId = 300;

  const expired = createMockRecord({
    chatwootConversationId: convId,
    activeIntent: "PRACTICA",
    phase: "CONFIRMING",
    slots: { categoria: "A1", circuito: "oficial", fecha: "martes", hora: "10:00" },
    repromptCount: 2,
    messageCount: 5,
    expiresAt: new Date(Date.now() - 60_000),
  });
  mockStore.set(convId, expired);

  const result = await loadOrCreateState(
    { chatwootConversationId: convId, phone: null },
    db,
  );

  assert.equal(result.activeIntent, null);
  assert.equal(result.phase, "IDLE");
  assert.deepEqual(result.slots, {});
  assert.equal(result.repromptCount, 0);
  assert.equal(result.messageCount, 0);
  const record = mockStore.get(convId)!;
  assert.equal(record.previousIntent, "PRACTICA");
  assert.ok(record.expiresAt! > new Date());
});

test("SL5. conversationId existente renueva expiresAt", async () => {
  resetMockStore();
  const db = createMockDb();
  const convId = 400;

  const futureExpiry = new Date(Date.now() + 5 * 60_000);
  const existing = createMockRecord({
    chatwootConversationId: convId,
    activeIntent: "RESERVA",
    phase: "GATHERING",
    slots: { actividad: "practica" },
    expiresAt: futureExpiry,
  });
  mockStore.set(convId, existing);

  await loadOrCreateState(
    { chatwootConversationId: convId, phone: null },
    db,
  );

  const updated = mockStore.get(convId)!;
  assert.ok(updated.expiresAt!.getTime() > futureExpiry.getTime());
});

test("SL6. mismo conversationId no crea duplicado (P2002 recovery)", async () => {
  resetMockStore();
  const db = createMockDb();
  const convId = 500;

  // Crear estado
  await loadOrCreateState(
    { chatwootConversationId: convId, phone: null },
    db,
  );

  // Segunda llamada debe recuperar el existente
  const result = await loadOrCreateState(
    { chatwootConversationId: convId, phone: null },
    db,
  );

  assert.equal(result.chatwootConversationId, convId);
  assert.equal(result.phase, "IDLE");
});

test("SL7. fallback a phone cuando no hay conversationId", async () => {
  resetMockStore();
  const db = createMockDb();
  const phone = "51917595954";

  const result = await loadOrCreateState(
    { chatwootConversationId: null, phone, chatwootContactId: 9, sourceId: phone },
    db,
  );

  assert.equal(result.phone, phone);
  assert.equal(result.chatwootContactId, 9);
  assert.equal(result.sourceId, phone);
  assert.equal(result.phase, "IDLE");
  assert.equal(result.chatwootConversationId, null);
});

test("SL8. phone fallback recupera estado existente", async () => {
  resetMockStore();
  const db = createMockDb();
  const phone = "51917595954";

  const existing = createMockRecord({
    phone,
    activeIntent: "SIMULACRO",
    phase: "GATHERING",
    slots: { categoria: "A2" },
    expiresAt: new Date(Date.now() + 30 * 60_000),
  });
  mockStore.set(999, existing);

  const result = await loadOrCreateState(
    { chatwootConversationId: null, phone },
    db,
  );

  assert.equal(result.activeIntent, "SIMULACRO");
  assert.equal(result.phase, "GATHERING");
  assert.deepEqual(result.slots, { categoria: "A2" });
});

test("SL9. phone fallback resetea estado expirado", async () => {
  resetMockStore();
  const db = createMockDb();
  const phone = "51999988777";

  const expired = createMockRecord({
    phone,
    activeIntent: "RESERVA",
    phase: "CONFIRMING",
    slots: { actividad: "practica", categoria: "A1" },
    repromptCount: 1,
    expiresAt: new Date(Date.now() - 60_000),
  });
  mockStore.set(888, expired);

  const result = await loadOrCreateState(
    { chatwootConversationId: null, phone },
    db,
  );

  assert.equal(result.activeIntent, null);
  assert.equal(result.phase, "IDLE");
  assert.deepEqual(result.slots, {});
  assert.equal(result.repromptCount, 0);
});

test("SL10. saveState actualiza campos correctamente", async () => {
  resetMockStore();
  const db = createMockDb();
  const convId = 600;

  const existing = createMockRecord({
    chatwootConversationId: convId,
    phase: "IDLE",
    expiresAt: new Date(Date.now() + 30 * 60_000),
  });
  mockStore.set(convId, existing);

  await saveState(convId, {
    activeIntent: "PRACTICA",
    phase: "GATHERING",
    slots: { categoria: "A1" },
    repromptCount: 1,
    messageCount: 2,
    lastQuestionAsked: "¿Qué categoría?",
  }, db);

  const updated = mockStore.get(convId)!;
  assert.equal(updated.activeIntent, "PRACTICA");
  assert.equal(updated.phase, "GATHERING");
  assert.deepEqual(updated.slots, { categoria: "A1" });
  assert.equal(updated.repromptCount, 1);
  assert.equal(updated.messageCount, 2);
  assert.equal(updated.lastQuestionAsked, "¿Qué categoría?");
});

test("SL11. saveState actualiza expiresAt", async () => {
  resetMockStore();
  const db = createMockDb();
  const convId = 700;

  const oldExpiry = new Date(Date.now() + 5 * 60_000);
  const existing = createMockRecord({
    chatwootConversationId: convId,
    phase: "IDLE",
    expiresAt: oldExpiry,
  });
  mockStore.set(convId, existing);

  await saveState(convId, { phase: "GATHERING" }, db);

  const updated = mockStore.get(convId)!;
  assert.ok(updated.expiresAt!.getTime() > oldExpiry.getTime());
});

test("SL12. saveState con parciales no sobrescribe todo", async () => {
  resetMockStore();
  const db = createMockDb();
  const convId = 800;

  const existing = createMockRecord({
    chatwootConversationId: convId,
    activeIntent: "RESERVA",
    phase: "GATHERING",
    slots: { actividad: "practica", categoria: "A1" },
    repromptCount: 1,
    messageCount: 3,
    expiresAt: new Date(Date.now() + 30 * 60_000),
  });
  mockStore.set(convId, existing);

  await saveState(convId, { repromptCount: 2 }, db);

  const updated = mockStore.get(convId)!;
  assert.equal(updated.repromptCount, 2);
  assert.equal(updated.activeIntent, "RESERVA");
  assert.equal(updated.phase, "GATHERING");
  assert.deepEqual(updated.slots, { actividad: "practica", categoria: "A1" });
  assert.equal(updated.messageCount, 3);
});

// ═══════════════════════════════════════════════════════════════════
// Tests de resetState
// ═══════════════════════════════════════════════════════════════════

test("SL13. resetState resetea a IDLE", async () => {
  resetMockStore();
  const db = createMockDb();
  const convId = 900;

  const existing = createMockRecord({
    chatwootConversationId: convId,
    activeIntent: "PRACTICA",
    phase: "CONFIRMING",
    slots: { categoria: "A1", circuito: "oficial", fecha: "martes", hora: "10:00" },
    repromptCount: 2,
    lastQuestionAsked: "¿Confirmas?",
    messageCount: 8,
    expiresAt: new Date(Date.now() + 10 * 60_000),
  });
  mockStore.set(convId, existing);

  await resetState(convId, db);

  const reset = mockStore.get(convId)!;
  assert.equal(reset.activeIntent, null);
  assert.equal(reset.phase, "IDLE");
  assert.deepEqual(reset.slots, {});
  assert.equal(reset.repromptCount, 0);
  assert.equal(reset.lastQuestionAsked, null);
  assert.equal(reset.lastToolCalled, null);
  assert.equal(reset.messageCount, 0);
  assert.equal(reset.previousIntent, "PRACTICA");
  assert.ok(reset.expiresAt! > new Date());
});

test("SL14. resetState en conversationId inexistente no falla", async () => {
  resetMockStore();
  const db = createMockDb();
  const convId = 9999;

  await resetState(convId, db);
  assert.equal(mockStore.has(convId), false);
});

test("SL15. phone=null crea estado temporal", async () => {
  resetMockStore();
  const db = createMockDb();

  const result = await loadOrCreateState(
    { chatwootConversationId: null, phone: null },
    db,
  );

  assert.equal(result.phase, "IDLE");
  assert.equal(result.chatwootConversationId, null);
  assert.equal(result.phone, null);
});

test("SL16. múltiples conversationIds generan estados independientes", async () => {
  resetMockStore();
  const db = createMockDb();
  const convId1 = 1001;
  const convId2 = 1002;

  await loadOrCreateState({ chatwootConversationId: convId1, phone: null }, db);
  await loadOrCreateState({ chatwootConversationId: convId2, phone: null }, db);

  await saveState(convId1, { activeIntent: "PRACTICA" }, db);
  await saveState(convId2, { activeIntent: "SIMULACRO" }, db);

  const state1 = await loadOrCreateState({ chatwootConversationId: convId1, phone: null }, db);
  const state2 = await loadOrCreateState({ chatwootConversationId: convId2, phone: null }, db);

  assert.equal(state1.activeIntent, "PRACTICA");
  assert.equal(state2.activeIntent, "SIMULACRO");
});

test("SL17. slots complejos se preservan correctamente", async () => {
  resetMockStore();
  const db = createMockDb();
  const convId = 1100;

  const complexSlots = {
    actividad: "practica",
    categoria: "A1",
    circuito: "oficial",
    fecha: "martes",
    hora: "10:00",
    notas: "primera vez",
  };

  const existing = createMockRecord({
    chatwootConversationId: convId,
    activeIntent: "RESERVA",
    phase: "CONFIRMING",
    slots: complexSlots,
    expiresAt: new Date(Date.now() + 30 * 60_000),
  });
  mockStore.set(convId, existing);

  const result = await loadOrCreateState(
    { chatwootConversationId: convId, phone: null },
    db,
  );

  assert.deepEqual(result.slots, complexSlots);
});

test("SL18. conversación larga: messageCount acumula", async () => {
  resetMockStore();
  const db = createMockDb();
  const convId = 1200;

  await loadOrCreateState({ chatwootConversationId: convId, phone: null }, db);

  await saveState(convId, { messageCount: 1 }, db);
  await saveState(convId, { messageCount: 2 }, db);
  await saveState(convId, { messageCount: 3, activeIntent: "RESERVA", phase: "GATHERING" }, db);

  const result = await loadOrCreateState({ chatwootConversationId: convId, phone: null }, db);
  assert.equal(result.messageCount, 3);
  assert.equal(result.activeIntent, "RESERVA");
  assert.equal(result.phase, "GATHERING");
});

test("SL19. repromptCount se actualiza independientemente", async () => {
  resetMockStore();
  const db = createMockDb();
  const convId = 1300;

  const existing = createMockRecord({
    chatwootConversationId: convId,
    phase: "GATHERING",
    repromptCount: 0,
    expiresAt: new Date(Date.now() + 30 * 60_000),
  });
  mockStore.set(convId, existing);

  await saveState(convId, { repromptCount: 1 }, db);
  let result = await loadOrCreateState({ chatwootConversationId: convId, phone: null }, db);
  assert.equal(result.repromptCount, 1);

  await saveState(convId, { repromptCount: 2 }, db);
  result = await loadOrCreateState({ chatwootConversationId: convId, phone: null }, db);
  assert.equal(result.repromptCount, 2);

  await saveState(convId, { repromptCount: 0 }, db);
  result = await loadOrCreateState({ chatwootConversationId: convId, phone: null }, db);
  assert.equal(result.repromptCount, 0);
});

test("SL20. expiresAt en el pasado → estado reseteado", async () => {
  resetMockStore();
  const db = createMockDb();
  const convId = 1400;

  const existing = createMockRecord({
    chatwootConversationId: convId,
    activeIntent: "RESERVA",
    phase: "GATHERING",
    slots: { actividad: "practica" },
    expiresAt: new Date(Date.now() - 5 * 60_000),
  });
  mockStore.set(convId, existing);

  const result = await loadOrCreateState(
    { chatwootConversationId: convId, phone: null },
    db,
  );

  assert.equal(result.activeIntent, null);
  assert.equal(result.phase, "IDLE");
  assert.deepEqual(result.slots, {});
});

// ═══════════════════════════════════════════════════════════════════
// Tests de P2002 (race condition)
// ═══════════════════════════════════════════════════════════════════

test("SL21. P2002 en create → re-leer existente", async () => {
  resetMockStore();
  const db = createMockDb();
  const convId = 1500;

  // Crear el primer estado
  await loadOrCreateState({ chatwootConversationId: convId, phone: null }, db);

  // Simular P2002: crear otro mock db que lanza P2002 en create pero findUnique funciona
  const p2002Db: StateDbClient = {
    conversationState: {
      ...db.conversationState,
      create: async () => {
        const err: any = new Error("P2002");
        err.code = "P2002";
        throw err;
      },
    },
  };

  // loadOrCreateState debe recuperar el existente tras P2002
  const result = await loadOrCreateState(
    { chatwootConversationId: convId, phone: null },
    p2002Db,
  );

  assert.equal(result.chatwootConversationId, convId);
  assert.equal(result.phase, "IDLE");
});

test("SL22. P2002 sin retry posible → relanza error", async () => {
  resetMockStore();
  const convId = 1600;

  // Mock db que lanza P2002 en create y devuelve null en findUnique
  const brokenDb: StateDbClient = {
    conversationState: {
      findUnique: async () => null,
      findFirst: async () => null,
      create: async () => {
        const err: any = new Error("P2002");
        err.code = "P2002";
        throw err;
      },
      update: async () => { throw new Error("should not reach"); },
    },
  };

  await assert.rejects(
    () => loadOrCreateState({ chatwootConversationId: convId, phone: null }, brokenDb),
    (err: any) => err.code === "P2002",
  );
});

test("SL23. error no-P2002 se propaga", async () => {
  resetMockStore();
  const convId = 1700;

  const errorDb: StateDbClient = {
    conversationState: {
      findUnique: async () => null,
      findFirst: async () => null,
      create: async () => { throw new Error("DB connection error"); },
      update: async () => { throw new Error("should not reach"); },
    },
  };

  await assert.rejects(
    () => loadOrCreateState({ chatwootConversationId: convId, phone: null }, errorDb),
    { message: "DB connection error" },
  );
});
