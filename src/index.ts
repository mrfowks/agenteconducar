import path from "path";
import express from "express";
import { env } from "./config/env";
import { metaRouter } from "./webhooks/meta";
import { panelRouter } from "./panel/api";
import { chatwootRouter } from "./webhooks/chatwoot";
import { startReminders } from "./jobs/reminders";
import { prisma } from "./db/client";

async function bootstrap() {
  const app = express();

  // Para el webhook de Meta necesitamos el buffer crudo (verificación HMAC-SHA256).
  // Guardamos rawBody en req antes de que express.json() lo parsee.
  app.use(
    express.json({
      limit: "10mb",
      verify: (req, _res, buf) => {
        (req as any).rawBody = buf;
      },
    }),
  );

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", service: "conducar-agent", time: new Date().toISOString() });
  });

  app.use(metaRouter);
  app.use(panelRouter);
  app.use(env.chatwoot.webhookPath, chatwootRouter);

  app.use("/panel", express.static(path.join(process.cwd(), "panel")));
  app.use("/", express.static(path.join(process.cwd(), "public")));
  app.get("/", (_req, res) => res.redirect("/panel/"));

  await prisma.$connect();
  console.log("🗄️  Conexión a PostgreSQL establecida");

  startReminders();

  const server = app.listen(env.port, () => {
    console.log(`🚀 Agente Conducar escuchando en el puerto ${env.port}`);
    console.log(`   Webhook Meta: GET/POST ${env.webhookPath}`);
    console.log(`   Webhook Chatwoot: POST ${env.chatwoot.webhookPath} (enabled=${env.chatwoot.enabled})`);
    console.log(`   Panel operador: http://localhost:${env.port}/panel/`);
  });

  // Node como PID 1 NO recibe la acción por defecto de las señales no
  // manejadas (el kernel solo entrega a init las señales con handler explícito).
  // El CMD del Dockerfile usa `exec node` (Node = PID 1), así que sin este
  // handler `docker stop` acabaría en SIGKILL tras el grace period. Con él:
  // SIGTERM/SIGINT → cierre del HTTP server → desconexión de Prisma → exit 0.
  const shutdown = (signal: string) => {
    console.log(`🛑 ${signal} recibido; cerrando agente...`);
    server.close(() => {
      prisma.$disconnect().finally(() => process.exit(0));
    });
    // Red de seguridad: si quedan conexiones abiertas (keep-alive, etc.), no
    // bloquear más de 5s el apagado.
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

bootstrap().catch((err) => {
  console.error("No se pudo iniciar el agente:", err);
  process.exit(1);
});