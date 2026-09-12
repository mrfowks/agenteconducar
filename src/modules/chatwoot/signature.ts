import crypto from "crypto";

// ─────────────────────────────────────────────────────────────
// Verificación de firma HMAC-SHA256 de Chatwoot
//
// Chatwoot envía dos headers:
//   X-Chatwoot-Signature = "sha256=" + HMAC_SHA256(webhook_secret, "{timestamp}.{raw_body}")
//   X-Chatwoot-Timestamp  = Unix seconds (entero)
//
// raw_body es el body CRUDO en UTF-8 (el mismo que captura express.json
// con verify → req.rawBody). Timestamps con desvío > MAX_SKEW_SECONDS se
// rechazan (anti-replay). NUNCA se retorna true por defecto: sin firma o sin
// timestamp la verificación falla.
// ─────────────────────────────────────────────────────────────

export const MAX_SKEW_SECONDS = 300;

/**
 * Función pura: recalcula el HMAC-SHA256 esperado por Chatwoot.
 * @param secret  Webhook secret configurado en Chatwoot.
 * @param timestamp Unix seconds (string, tal cual llega en X-Chatwoot-Timestamp).
 * @param rawBody Buffer con el body CRUDO recibido.
 */
export function recomputeHmac(secret: string, timestamp: string, rawBody: Buffer): string {
  const data = `${timestamp}.${rawBody.toString("utf8")}`;
  return crypto.createHmac("sha256", secret).update(data, "utf8").digest("hex");
}

/** Verifica que el timestamp no está demasiado desfasado respecto al reloj local. */
export function isTimestampFresh(
  timestampSeconds: number,
  nowSeconds: number = Math.floor(Date.now() / 1000),
  maxSkew: number = MAX_SKEW_SECONDS,
): boolean {
  if (!Number.isFinite(timestampSeconds) || timestampSeconds <= 0) return false;
  return Math.abs(nowSeconds - timestampSeconds) <= maxSkew;
}

/**
 * Verifica la firma X-Chatwoot-Signature.
 * @param rawBody  Buffer con el body crudo.
 * @param headers  { signature?, timestamp? } — los headers crudos del request.
 * @param secret   CHATWOOT_WEBHOOK_SECRET.
 * @returns true solo si la firma es válida, el timestamp es reciente y la
 *          comparación HMAC coincide en tiempo constante.
 */
export function verifyChatwootSignature(
  rawBody: Buffer,
  headers: { signature?: string; timestamp?: string },
  secret: string,
): boolean {
  const signature = headers.signature ?? "";
  const timestampHeader = headers.timestamp ?? "";

  // Rechazar payload sin firma o sin timestamp (nunca "return true" por defecto).
  if (!signature || !timestampHeader) return false;
  if (!secret) return false;

  // El preámbulo debe ser "sha256=".
  if (!signature.startsWith("sha256=")) return false;

  const expectedHex = recomputeHmac(secret, timestampHeader, rawBody);
  const suppliedHex = signature.slice("sha256=".length);

  // Validación de timestamp (anti-replay). Fallos aquí no dependen del HMAC.
  const ts = Number.parseInt(timestampHeader, 10);
  if (!isTimestampFresh(ts)) return false;

  // Comparación en tiempo constante. Si las longitudes difieren no se compara
  // directamente (timingSafeEqual lanzaría); se ejecuta una comparación dummy
  // para no filtrar información por timing y se retorna false.
  const expectedBuf = Buffer.from(expectedHex, "hex");
  const suppliedBuf = Buffer.from(suppliedHex, "hex");
  if (expectedBuf.length !== suppliedBuf.length) {
    crypto.timingSafeEqual(expectedBuf, expectedBuf);
    return false;
  }
  return crypto.timingSafeEqual(expectedBuf, suppliedBuf);
}