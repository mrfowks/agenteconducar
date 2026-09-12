import { test } from "node:test";
import assert from "node:assert/strict";
import { validateChatwootEnv } from "../src/config/env";

// ── CORRECCIÓN 3: fail-fast de configuración Chatwoot ──────────────────────

test("E1. CHATWOOT_ENABLED=false sin variables Chatwoot → arranca OK (rollback intacto)", () => {
  const res = validateChatwootEnv({ CHATWOOT_ENABLED: "false" });
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.config.enabled, false);
    assert.equal(res.config.accountId, 0);
    assert.equal(res.config.inboxId, 0);
  }
});

test("E2. CHATWOOT_ENABLED ausente → arranca OK sin exigir nada de Chatwoot", () => {
  const res = validateChatwootEnv({});
  assert.equal(res.ok, true);
  if (res.ok) assert.equal(res.config.enabled, false);
});

test("E3. CHATWOOT_ENABLED=true sin variables → fail-fast con TODOS los errores claros", () => {
  const res = validateChatwootEnv({ CHATWOOT_ENABLED: "true" });
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.errors.length, 5);
    for (const name of [
      "CHATWOOT_BASE_URL",
      "CHATWOOT_ACCOUNT_ID",
      "CHATWOOT_INBOX_ID",
      "CHATWOOT_API_TOKEN",
      "CHATWOOT_WEBHOOK_SECRET",
    ]) {
      assert.ok(
        res.errors.some((e) => e.includes(name)),
        `error para ${name} presente`,
      );
    }
  }
});

test("E4. account/inbox '0' → error claro (nunca genera /accounts/0/)", () => {
  const vars = {
    CHATWOOT_ENABLED: "true",
    CHATWOOT_BASE_URL: "https://chatwoot.example.com",
    CHATWOOT_ACCOUNT_ID: "0",
    CHATWOOT_INBOX_ID: "0",
    CHATWOOT_API_TOKEN: "token-de-prueba",
    CHATWOOT_WEBHOOK_SECRET: "secret-de-prueba",
  };
  const res = validateChatwootEnv(vars);
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.ok(
      res.errors.some((e) => e.includes("CHATWOOT_ACCOUNT_ID") && e.includes("mayor que 0")),
    );
    assert.ok(
      res.errors.some((e) => e.includes("CHATWOOT_INBOX_ID") && e.includes("mayor que 0")),
    );
  }
});

test("E5. account/inbox vacío, no numérico o negativo → error claro", () => {
  const base = {
    CHATWOOT_ENABLED: "true",
    CHATWOOT_BASE_URL: "https://chatwoot.example.com",
    CHATWOOT_API_TOKEN: "token-de-prueba",
    CHATWOOT_WEBHOOK_SECRET: "secret-de-prueba",
  };
  for (const acct of ["", "abc", "-3", "1.5"]) {
    const res = validateChatwootEnv({ ...base, CHATWOOT_ACCOUNT_ID: acct, CHATWOOT_INBOX_ID: "9" });
    assert.equal(res.ok, false, `account "${acct}" debe fallar`);
    if (!res.ok) assert.ok(res.errors.some((e) => e.includes("CHATWOOT_ACCOUNT_ID")));
  }
  for (const inbox of ["", "-1", "x", "0.5"]) {
    const res = validateChatwootEnv({ ...base, CHATWOOT_ACCOUNT_ID: "1", CHATWOOT_INBOX_ID: inbox });
    assert.equal(res.ok, false, `inbox "${inbox}" debe fallar`);
    if (!res.ok) assert.ok(res.errors.some((e) => e.includes("CHATWOOT_INBOX_ID")));
  }
});

test("E6. CHATWOOT_BASE_URL no http(s) → error claro", () => {
  const vars = {
    CHATWOOT_ENABLED: "true",
    CHATWOOT_BASE_URL: "ftp://chatwoot.example.com",
    CHATWOOT_ACCOUNT_ID: "1",
    CHATWOOT_INBOX_ID: "9",
    CHATWOOT_API_TOKEN: "token-de-prueba",
    CHATWOOT_WEBHOOK_SECRET: "secret-de-prueba",
  };
  const res = validateChatwootEnv(vars);
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.ok(res.errors.some((e) => e.includes("CHATWOOT_BASE_URL") && e.includes("http(s)")));
  }
});

test("E7. Configuración completa y válida → ok con valores parseados", () => {
  const vars = {
    CHATWOOT_ENABLED: "true",
    CHATWOOT_BASE_URL: "https://chatwoot.example.com",
    CHATWOOT_ACCOUNT_ID: "1",
    CHATWOOT_INBOX_ID: "9",
    CHATWOOT_API_TOKEN: "token-de-prueba",
    CHATWOOT_WEBHOOK_SECRET: "secret-de-prueba",
  };
  const res = validateChatwootEnv(vars);
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.config.enabled, true);
    assert.equal(res.config.accountId, 1);
    assert.equal(res.config.inboxId, 9);
    assert.equal(res.config.baseUrl, "https://chatwoot.example.com");
    assert.equal(res.config.apiToken, "token-de-prueba");
  }
});