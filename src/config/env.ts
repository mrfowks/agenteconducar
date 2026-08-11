import "dotenv/config";

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === "") {
    throw new Error(`Falta la variable de entorno ${name}`);
  }
  return value;
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

  evolution: {
    url: (process.env.EVOLUTION_API_URL ?? "http://localhost:8080").replace(/\/$/, ""),
    apiKey: required("EVOLUTION_API_KEY"),
    instanceToken: process.env.EVOLUTION_INSTANCE_TOKEN ?? "",
    instance: process.env.EVOLUTION_INSTANCE ?? "conducar",
  },

  admin: {
    token: required("ADMIN_TOKEN", "cambia-este-token"),
    username: process.env.PANEL_USERNAME ?? "admin",
    password: process.env.PANEL_PASSWORD ?? "conducar2026",
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

  webhookPath: process.env.WEBHOOK_PATH ?? "/webhook/evolution",
};

export function isProduction(): boolean {
  return env.nodeEnv === "production";
}
