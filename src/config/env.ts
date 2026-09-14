import "dotenv/config";

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === "") {
    throw new Error(`Falta la variable de entorno ${name}`);
  }
  return value;
}

/** Producción detectada SIN depender del objeto `env` (aún no construido). */
const isProd = (process.env.NODE_ENV ?? "development") === "production";

/**
 * Valores por defecto/débiles NUNCA aceptables como secretos en producción.
 * Comparación en minúsculas y sin espacios. NUNCA se imprime el valor.
 */
const WEAK_SECRETS = new Set([
  "cambia-este-token",
  "cambia-esta-password",
  "cambia-por-un-token-largo-aleatorio",
  "cambia-por-una-password-larga-aleatoria",
  "conducar2026",
  "conducar-ia-2026",
  "changeme",
  "change-me",
  "admin",
  "password",
  "secret",
  "token",
]);

/**
 * Secreto obligatorio en producción (fail-fast) con default SOLO-dev.
 * - Producción: debe existir, no estar vacío y no ser un valor débil conocido.
 *   Si no, aborta el arranque con un error claro. NUNCA imprime el valor.
 * - Development: se permite el default de desarrollo (arranque local fácil).
 */
function productionSecret(name: string, devFallback: string): string {
  const value = process.env[name];
  if (isProd) {
    if (value === undefined || value.trim() === "") {
      throw new Error(
        `[env] ${name} es obligatoria en producción (NODE_ENV=production) y no puede estar vacía. Defínela en el entorno; por seguridad no se imprime su valor.`,
      );
    }
    if (WEAK_SECRETS.has(value.trim().toLowerCase())) {
      throw new Error(
        `[env] ${name} usa un valor por defecto/débil, inaceptable en producción (NODE_ENV=production). Define un valor largo y aleatorio; por seguridad no se imprime su valor.`,
      );
    }
    return value;
  }
  return value ?? devFallback;
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/** Entero positivo estricto para ids de Chatwoot ("0", negativos, vacíos y no
 * numéricos → null). */
function parsePositiveInt(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return value > 0 ? value : null;
}

export interface ChatwootEnvConfig {
  enabled: boolean;
  baseUrl: string;
  accountId: number;
  inboxId: number;
  apiToken: string;
  webhookSecret: string;
}

export type ChatwootEnvValidation =
  | { ok: true; config: ChatwootEnvConfig }
  | { ok: false; errors: string[] };

const DISABLED_CONFIG: ChatwootEnvConfig = {
  enabled: false,
  baseUrl: "",
  accountId: 0,
  inboxId: 0,
  apiToken: "",
  webhookSecret: "",
};

/**
 * Validación PURA y fail-fast de la configuración de Chatwoot (testeable sin
 * arrancar la app).
 * - CHATWOOT_ENABLED=false o ausente → ok siempre, no exige NADA de Chatwoot
 *   (rollback a Meta intacto).
 * - CHATWOOT_ENABLED=true → CHATWOOT_BASE_URL (URL http/https válida),
 *   CHATWOOT_ACCOUNT_ID y CHATWOOT_INBOX_ID (enteros > 0), CHATWOOT_API_TOKEN
 *   y CHATWOOT_WEBHOOK_SECRET (no vacíos) son OBLIGATORIAS. Valores vacíos,
 *   "0", negativos o no numéricos producen un error claro (nunca /accounts/0/).
 */
export function validateChatwootEnv(
  vars: Record<string, string | undefined>,
): ChatwootEnvValidation {
  const enabled = vars.CHATWOOT_ENABLED === "true";
  if (!enabled) return { ok: true, config: DISABLED_CONFIG };

  const errors: string[] = [];

  const baseUrl = vars.CHATWOOT_BASE_URL ?? "";
  if (baseUrl === "") {
    errors.push(
      "Falta la variable de entorno CHATWOOT_BASE_URL (obligatoria cuando CHATWOOT_ENABLED=true)",
    );
  } else if (!isHttpUrl(baseUrl)) {
    errors.push(`CHATWOOT_BASE_URL debe ser una URL http(s) válida (recibido: "${baseUrl}")`);
  }

  const accountId = parsePositiveInt(vars.CHATWOOT_ACCOUNT_ID);
  if (accountId === null) {
    errors.push(
      `CHATWOOT_ACCOUNT_ID debe ser un número entero mayor que 0 (recibido: "${vars.CHATWOOT_ACCOUNT_ID ?? ""}")`,
    );
  }

  const inboxId = parsePositiveInt(vars.CHATWOOT_INBOX_ID);
  if (inboxId === null) {
    errors.push(
      `CHATWOOT_INBOX_ID debe ser un número entero mayor que 0 (recibido: "${vars.CHATWOOT_INBOX_ID ?? ""}")`,
    );
  }

  if ((vars.CHATWOOT_API_TOKEN ?? "") === "") {
    errors.push(
      "Falta la variable de entorno CHATWOOT_API_TOKEN (obligatoria cuando CHATWOOT_ENABLED=true)",
    );
  }
  if ((vars.CHATWOOT_WEBHOOK_SECRET ?? "") === "") {
    errors.push(
      "Falta la variable de entorno CHATWOOT_WEBHOOK_SECRET (obligatoria cuando CHATWOOT_ENABLED=true)",
    );
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    config: {
      enabled: true,
      baseUrl,
      accountId: accountId as number,
      inboxId: inboxId as number,
      apiToken: vars.CHATWOOT_API_TOKEN as string,
      webhookSecret: vars.CHATWOOT_WEBHOOK_SECRET as string,
    },
  };
}

const chatwootEnabled = process.env.CHATWOOT_ENABLED === "true";
if (!chatwootEnabled && process.env.CHATWOOT_ENABLED === undefined) {
  console.warn(
    "[env] CHATWOOT_ENABLED no definido; se asume false → backend Meta actual (rollback).",
  );
}

// Fail-fast de configuración ANTES de construir env: con CHATWOOT_ENABLED=true
// una config inválida (account/inbox "0", vacíos, no numéricos, URLs rotas)
// aborta el arranque con un error claro en lugar de generar /accounts/0/...
const chatwootValidation = validateChatwootEnv(process.env);
if (!chatwootValidation.ok) {
  throw new Error(
    `[env] Configuración de Chatwoot inválida (CHATWOOT_ENABLED=true):\n${chatwootValidation.errors
      .map((e) => `  - ${e}`)
      .join("\n")}`,
  );
}
const chatwootConfig = chatwootValidation.config;

// META_VERIFY_TOKEN: se conserva el default de desarrollo porque Meta/WhatsApp
// NO está activo aún (rollback intacto). En producción, si falta o es un valor
// débil se emite una ADVERTENCIA (NO bloqueante) para no romper el arranque
// mientras Meta siga desactivado. Endurecerlo es requisito ANTES de activar Meta.
const metaVerifyTokenRaw = process.env.META_VERIFY_TOKEN;
if (
  isProd &&
  (metaVerifyTokenRaw === undefined ||
    WEAK_SECRETS.has((metaVerifyTokenRaw ?? "").trim().toLowerCase()))
) {
  console.warn(
    "[env] META_VERIFY_TOKEN no definido o débil en producción (Meta NO activo: no bloqueante). Defínelo antes de activar Meta.",
  );
}

export const env = {
  port: Number(process.env.PORT ?? 3000),
  nodeEnv: process.env.NODE_ENV ?? "development",

  openai: {
    apiKey: required("OPENAI_API_KEY"),
    model: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
    temperature: Number(process.env.OPENAI_TEMPERATURE ?? 0.1),
  },

  databaseUrl: required("DATABASE_URL"),

  meta: {
    accessToken: required("META_ACCESS_TOKEN"),
    phoneNumberId: required("META_PHONE_NUMBER_ID"),
    appSecret: required("META_APP_SECRET"),
    verifyToken: process.env.META_VERIFY_TOKEN ?? "conducar-ia-2026",
    apiVersion: process.env.META_API_VERSION ?? "v21.0",
  },

  admin: {
    // En producción ADMIN_TOKEN y PANEL_PASSWORD son OBLIGATORIOS y fuertes
    // (fail-fast en el arranque); en development se admiten los defaults.
    token: productionSecret("ADMIN_TOKEN", "cambia-este-token"),
    username: process.env.PANEL_USERNAME ?? "admin",
    password: productionSecret("PANEL_PASSWORD", "conducar2026"),
  },

  qrImageUrl: process.env.QR_IMAGE_URL ?? "",
  baseUrl: process.env.BASE_URL ?? "http://localhost:3001",

  business: {
    name: process.env.BUSINESS_NAME ?? "Conducar",
    currency: process.env.CURRENCY ?? "S/",
    timezone: process.env.TIMEZONE ?? "America/Lima",
    minAdvanceHours: Number(process.env.MIN_ADVANCE_HOURS ?? 0),
    capacityPerBlock: Number(process.env.CAPACITY_PER_BLOCK ?? 1),
  },

  webhookPath: process.env.WEBHOOK_PATH ?? "/webhook/meta",

  // Feature flags (Fase 2B.7). USE_STATEFUL_ROUTER=false por defecto → producción segura.
  featureFlags: {
    useStatefulRouter: process.env.USE_STATEFUL_ROUTER === "true",
    canaryPhones: (process.env.CANARY_PHONES ?? "").split(",").filter(Boolean),
    canaryConversationIds: (process.env.CANARY_CONVERSATION_IDS ?? "")
      .split(",")
      .filter(Boolean)
      .map(Number)
      .filter((n) => Number.isFinite(n)),
  },

  // Chatwoot (Fase 2). Con enabled=false el backend Meta actual sigue intacto.
  // Con enabled=true los valores vienen ya validados (fail-fast) por validateChatwootEnv.
  chatwoot: {
    enabled: chatwootConfig.enabled,
    baseUrl: chatwootConfig.baseUrl,
    accountId: chatwootConfig.accountId,
    inboxId: chatwootConfig.inboxId,
    apiToken: chatwootConfig.apiToken,
    webhookSecret: chatwootConfig.webhookSecret,
    webhookPath: process.env.CHATWOOT_WEBHOOK_PATH ?? "/webhooks/chatwoot",
    botSenderId: Number(process.env.CHATWOOT_BOT_SENDER_ID ?? "0") || undefined,
    assigneeId: Number(process.env.CHATWOOT_ASSIGNEE_ID ?? "0") || undefined,
    timeoutMs: Number(process.env.CHATWOOT_TIMEOUT_MS ?? 15000),
    maxRetries: Number(process.env.CHATWOOT_MAX_RETRIES ?? 3),
  },
};

export function isProduction(): boolean {
  return env.nodeEnv === "production";
}