import crypto from "crypto";
import { env } from "../../config/env";

// ─────────────────────────────────────────────────────────────
// Cliente HTTP de la API pública de Chatwoot.
//
// - Todas las llamadas usan el header `api_access_token`.
// - Retries SOLO para 5xx / 429 / timeout / errores de red, con backoff
//   exponencial base 500 ms (500 * 2^n + jitter). Los 4xx NO se reintentan.
// - El rate limit (3000 req/min/IP) es irrelevante a nuestro volumen, pero un
//   429 dispara el mismo backoff que los 5xx.
// ─────────────────────────────────────────────────────────────

export class ChatwootApiError extends Error {
  readonly status: number;
  readonly code?: string;
  constructor(status: number, message: string, code?: string) {
    super(`Chatwoot API ${status}: ${message}`);
    this.name = "ChatwootApiError";
    this.status = status;
    this.code = code;
  }
}

const BASE_PATH = "/api/v1";

interface FetchOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  json?: unknown;
  /** Body multipart ya construido (Buffer) y su Content-Type. */
  formData?: { body: Buffer; contentType: string };
  timeoutMs?: number;
  maxRetries?: number;
}

function accountPath(rest: string): string {
  return `${BASE_PATH}/accounts/${env.chatwoot.accountId}${rest}`;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * Llamada centralizada a la API de Chatwoot con reintentos controlados.
 * Los path deben venir completos: ej. `/api/v1/accounts/1/conversations/2/messages`.
 */
export async function chatwootFetch(
  path: string,
  options: FetchOptions = {},
): Promise<unknown> {
  const method = options.method ?? "GET";
  const timeoutMs = options.timeoutMs ?? env.chatwoot.timeoutMs;
  const maxRetries = options.maxRetries ?? env.chatwoot.maxRetries;

  const headers: Record<string, string> = {
    api_access_token: env.chatwoot.apiToken,
  };
  let body: Buffer | string | undefined;

  if (options.json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(options.json);
  } else if (options.formData) {
    headers["Content-Type"] = options.formData.contentType;
    body = options.formData.body;
  }

  let lastError: unknown = null;
  let attempt = 0;

  while (attempt <= maxRetries) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${env.chatwoot.baseUrl}${path}`, {
        method,
        headers,
        body,
        signal: controller.signal,
      });

      if (res.ok) {
        const text = await res.text();
        if (!text) return {};
        try {
          return JSON.parse(text);
        } catch {
          // Respuesta no-JSON (p.ej. toggle_status puede devolver JSON; si viene
          // texto plano lo devolvemos tal cual).
          return { raw: text };
        }
      }

      if (isRetryableStatus(res.status) && attempt < maxRetries) {
        const delay = 500 * Math.pow(2, attempt) + Math.floor(Math.random() * 250);
        console.warn(
          `[chatwoot-client] HTTP ${res.status} en ${method} ${path}, reintento ${attempt + 1}/${maxRetries} en ${delay}ms`,
        );
        await sleep(delay);
        attempt += 1;
        continue;
      }

      const detail = await res.text().catch(() => "");
      throw new ChatwootApiError(res.status, detail || `HTTP ${res.status}`, String(res.status));
    } catch (err: unknown) {
      const isAbort =
        err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
      if (!(err instanceof ChatwootApiError) && attempt < maxRetries) {
        lastError = err;
        const delay = 500 * Math.pow(2, attempt) + Math.floor(Math.random() * 250);
        console.warn(
          `[chatwoot-client] ${isAbort ? "timeout" : "error de red"} en ${method} ${path}${err instanceof Error ? ` (${err.message})` : ""}, reintento ${attempt + 1}/${maxRetries} en ${delay}ms`,
        );
        await sleep(delay);
        attempt += 1;
        continue;
      }
      if (err instanceof ChatwootApiError) throw err;
      throw new Error(`Chatwoot API error de red: ${err instanceof Error ? err.message : String(err)}, path=${path}`);
    } finally {
      clearTimeout(timer);
    }
  }

  throw new Error(`Chatwoot API falló tras ${maxRetries} reintentos: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

export interface ChatwootContact {
  id: number;
  name?: string | null;
  phone_number?: string | null;
  contact_inboxes?: { id?: number; source_id?: string; inbox_id?: number }[];
}

// ── Mensajes ────────────────────────────────────────────────

/** Envía un mensaje de TEXTO saliente a una conversación (no privado). */
export async function sendTextMessage(conversationId: number, content: string): Promise<void> {
  await chatwootFetch(accountPath(`/conversations/${conversationId}/messages`), {
    method: "POST",
    json: { content, message_type: "outgoing", private: false },
  });
}

export interface MediaPayload {
  buffer: Buffer;
  filename: string;
  mimeType: string;
  caption?: string;
}

function buildMediaMultipart(fields: {
  content: string;
  attachment: MediaPayload;
}): { body: Buffer; contentType: string } {
  const boundary = `----ConducarBoundary${crypto.randomUUID()}`;
  const parts: Buffer[] = [];

  const textField = (name: string, value: string) =>
    Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="${name}"\r\n` +
        `\r\n${value}\r\n`,
    );

  parts.push(textField("content", fields.content));
  parts.push(textField("message_type", "outgoing"));
  parts.push(textField("private", "false"));
  parts.push(
    Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="attachments[]"; filename="${fields.attachment.filename}"\r\n` +
        `Content-Type: ${fields.attachment.mimeType}\r\n` +
        `\r\n`,
    ),
  );
  parts.push(fields.attachment.buffer);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

/** Envía una IMAGEN/MEDIA saliente a una conversación (multipart manual). */
export async function sendMediaMessage(
  conversationId: number,
  attachment: MediaPayload,
): Promise<void> {
  const caption = attachment.caption?.trim() ? attachment.caption : attachment.filename;
  const multipart = buildMediaMultipart({ content: caption, attachment });
  await chatwootFetch(accountPath(`/conversations/${conversationId}/messages`), {
    method: "POST",
    formData: multipart,
  });
}

// ── Contactos y conversaciones ──────────────────────────────

/**
 * Busca contactos por phone/name/email/identifier.
 * NOTA: la forma exacta de la respuesta (`payload` vs `data`) puede variar;
 * se toleran ambas. REQUIERE VERIFICACIÓN EN CHATWOOT: confirmar la forma
 * real de la respuesta en la versión instalada.
 */
export async function searchContactByPhone(phone: string): Promise<ChatwootContact[]> {
  const q = encodeURIComponent(phone);
  const data = (await chatwootFetch(accountPath(`/contacts/search?q=${q}`), {
    method: "GET",
  })) as { payload?: ChatwootContact[]; data?: ChatwootContact[] };
  const list = data?.payload ?? data?.data ?? [];
  return Array.isArray(list) ? list : [];
}

/**
 * Crea un contacto en Chatwoot.
 * El upsert "crear o devolver" NO está documentado: se implementa búsqueda
 * primero y creación solo si no existe (ver mapper.getOrCreateConversation).
 * Respuesta documentada: { id, contact_inboxes: [{ source_id, inbox_id }] }.
 */
export async function createContact(input: {
  name?: string;
  phoneNumber: string;
  inboxId: number;
}): Promise<ChatwootContact> {
  return (await chatwootFetch(accountPath("/contacts"), {
    method: "POST",
    json: {
      inbox_id: input.inboxId,
      name: input.name ?? input.phoneNumber,
      phone_number: input.phoneNumber,
    },
  })) as ChatwootContact;
}

/** Crea una conversación a partir de contact_inbox (source_id), inbox y contacto. */
export async function createConversation(input: {
  sourceId: string;
  inboxId: number;
  contactId: number;
}): Promise<{ id: number }> {
  return (await chatwootFetch(accountPath("/conversations"), {
    method: "POST",
    json: {
      source_id: input.sourceId,
      inbox_id: input.inboxId,
      contact_id: input.contactId,
    },
  })) as { id: number };
}

// ── Estados ─────────────────────────────────────────────────

/** Libera la conversación desde el panel Chatwoot (marca como resuelta). */
export async function resolveConversation(conversationId: number): Promise<void> {
  await chatwootFetch(accountPath(`/conversations/${conversationId}/toggle_status`), {
    method: "POST",
    json: { status: "resolved" },
    maxRetries: 1,
  });
}

// ── Media entrante ──────────────────────────────────────────

/**
 * Descarga un archivo adjunto por su file_url.
 *
 * REQUIERE VERIFICACIÓN EN CHATWOOT: la autenticación del file_url no está
 * documentada en los hechos verificados. Estrategia: intenta SIN header y, ante
 * 401/403, reintenta con `api_access_token`. Si tu instalación firma las URLs o
 * las protege con otro esquema, ajustar aquí.
 */
export async function downloadAttachment(
  fileUrl: string,
  options: { timeoutMs?: number } = {},
): Promise<{ buffer: Buffer; mimeType: string }> {
  const timeoutMs = options.timeoutMs ?? env.chatwoot.timeoutMs;

  const run = async (headers: Record<string, string>): Promise<Response> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(fileUrl, { headers, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  };

  let res = await run({});
  if (!res.ok && (res.status === 401 || res.status === 403)) {
    console.warn("[chatwoot-client] file_url pidió auth, reintentando con api_access_token (REQUIERE VERIFICACIÓN EN CHATWOOT)");
    res = await run({ api_access_token: env.chatwoot.apiToken });
  }

  if (!res.ok) {
    throw new ChatwootApiError(res.status, `Error descargando adjunto ${fileUrl}: HTTP ${res.status}`);
  }

  const arrayBuffer = await res.arrayBuffer();
  const mimeType = res.headers.get("content-type") ?? "application/octet-stream";
  return { buffer: Buffer.from(arrayBuffer), mimeType };
}