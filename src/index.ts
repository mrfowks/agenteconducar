import path from "path";
import express from "express";
import { env } from "./config/env";
import { evolutionRouter } from "./webhooks/evolution";
import { panelRouter } from "./panel/api";
import { startReminders } from "./jobs/reminders";
import { prisma } from "./db/client";

async function bootstrap() {
  const app = express();
  app.use(express.json({ limit: "10mb" }));

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", service: "conducar-agent", time: new Date().toISOString() });
  });

  app.use(evolutionRouter);
  app.use(panelRouter);

  app.use("/panel", express.static(path.join(process.cwd(), "panel")));
  app.use("/", express.static(path.join(process.cwd(), "public")));
  app.get("/", (_req, res) => res.redirect("/panel/"));

  await prisma.$connect();
  console.log("🗄️  Conexión a PostgreSQL establecida");

  startReminders();

  app.listen(env.port, () => {
    console.log(`🚀 Agente Conducar escuchando en el puerto ${env.port}`);
    console.log(`   Webhook Evolution: POST ${env.webhookPath}`);
    console.log(`   Panel operador: http://localhost:${env.port}/panel/`);
  });
}

bootstrap().catch((err) => {
  console.error("No se pudo iniciar el agente:", err);
  process.exit(1);
});
