import crypto from "crypto";
import dns from "dns";
import net from "net";
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

/**
 * Asigna una conversación a un agente específico en Chatwoot.
 * Usa PATCH /api/v1/accounts/{id}/conversations/{id} con assignee_id.
 */
export async function assignConversation(
  conversationId: number,
  assigneeId: number,
): Promise<void> {
  await chatwootFetch(accountPath(`/conversations/${conversationId}`), {
    method: "PATCH",
    json: { assignee_id: assigneeId },
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

/** Tope por defecto de un adjunto descargado (10 MB, mismo valor que MAX_ATTACHMENT_BYTES). */
export const DEFAULT_MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/** Máximo de saltos de redirect permitidos en una descarga de adjunto. */
export const MAX_ATTACHMENT_REDIRECTS = 2;

export type LookupFn = (hostname: string) => Promise<readonly string[]>;

async function defaultLookup(hostname: string): Promise<string[]> {
  return await new Promise((resolve, reject) => {
    dns.lookup(hostname, { all: true }, (err, addresses) => {
      if (err) reject(err);
      else resolve(addresses.map((a) => a.address));
    });
  });
}

function defaultPort(protocol: string): string {
  if (protocol === "https:") return "443";
  if (protocol === "http:") return "80";
  return "";
}

/** ¿Dos URLs comparten origin (protocolo + host + puerto)? */
export function sameOrigin(a: string, b: string): boolean {
  let ua: URL;
  let ub: URL;
  try {
    ua = new URL(a);
    ub = new URL(b);
  } catch {
    return false;
  }
  return (
    ua.protocol === ub.protocol &&
    ua.hostname.toLowerCase() === ub.hostname.toLowerCase() &&
    (ua.port || defaultPort(ua.protocol)) === (ub.port || defaultPort(ub.protocol))
  );
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    return null;
  }
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function ipv6Groups(ip: string): number[] | null {
  let addr = ip;
  const v4Match = addr.match(/^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (v4Match) {
    const v4 = ipv4ToInt(v4Match[2]);
    if (v4 === null) return null;
    const hex = v4.toString(16).padStart(8, "0");
    addr = `${v4Match[1]}${hex.slice(0, 4)}:${hex.slice(4)}`;
  }
  const parts = addr.split("::");
  if (parts.length > 2) return null;
  const head = parts[0] ? parts[0].split(":") : [];
  const tail = parts.length === 2 && parts[1] ? parts[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (missing < 0) return null;
  const all = [...head, ...Array(missing).fill("0"), ...tail];
  if (all.length !== 8) return null;
  const groups: number[] = [];
  for (const g of all) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    groups.push(parseInt(g, 16));
  }
  return groups;
}

/**
 * ¿Una IP concreta cae en rangos privados/link-local/metadata? Devuelve la razón
 * (string) si debe bloquearse, o null si es una IP pública. Cubre los rangos
 * exigidos: 127.0.0.0/8, 10/8, 172.16/12, 192.168/16, 169.254.0.0/16,
 * ::1, fc00::/7, fe80::/10.
 */
export function privateIpReason(ip: string): string | null {
  const host = ip.replace(/^\[|\]$/g, "");
  if (net.isIPv4(host)) {
    const int = ipv4ToInt(host);
    if (int === null) return null;
    if ((int & 0xff000000) === 0x7f000000) return "loopback (127.0.0.0/8)";
    if ((int & 0xff000000) === 0x0a000000) return "rango privado (10.0.0.0/8)";
    if (((int & 0xfff00000) >>> 0) === 0xac100000) return "rango privado (172.16.0.0/12)";
    if (((int & 0xffff0000) >>> 0) === 0xc0a80000) return "rango privado (192.168.0.0/16)";
    if (((int & 0xffff0000) >>> 0) === 0xa9fe0000) return "link-local/metadata (169.254.0.0/16)";
    return null;
  }
  if (net.isIPv6(host)) {
    const groups = ipv6Groups(host);
    if (!groups) return null;
    if (
      groups[0] === 0 && groups[1] === 0 && groups[2] === 0 && groups[3] === 0 &&
      groups[4] === 0 && groups[5] === 0 && groups[6] === 0 && groups[7] === 1
    ) {
      return "loopback (::1)";
    }
    if ((groups[0] & 0xfe00) === 0xfc00) return "unique local (fc00::/7)";
    if ((groups[0] & 0xffc0) === 0xfe80) return "link-local (fe80::/10)";
    // IPv4-mapped (::ffff:a.b.c.d): se evalúa la IPv4 embebida.
    if (
      groups[0] === 0 && groups[1] === 0 && groups[2] === 0 && groups[3] === 0 &&
      groups[4] === 0 && groups[5] === 0xffff
    ) {
      const mappedV4 = ((groups[6] << 16) | groups[7]) >>> 0;
      if ((mappedV4 & 0xff000000) === 0x7f000000) return "loopback vía IPv4-mapped (::ffff:127.0.0.0/8)";
      if ((mappedV4 & 0xff000000) === 0x0a000000) return "rango privado vía IPv4-mapped (::ffff:10.0.0.0/8)";
      if (((mappedV4 & 0xfff00000) >>> 0) === 0xac100000) return "rango privado vía IPv4-mapped (::ffff:172.16.0.0/12)";
      if (((mappedV4 & 0xffff0000) >>> 0) === 0xc0a80000) return "rango privado vía IPv4-mapped (::ffff:192.168.0.0/16)";
      if (((mappedV4 & 0xffff0000) >>> 0) === 0xa9fe0000) return "link-local vía IPv4-mapped (::ffff:169.254.0.0/16)";
    }
    return null;
  }
  return null;
}

/**
 * Valida que una URL de descarga de adjunto sea SEGURA contra SSRF:
 *   - Solo `https:` (o `http:` si es exactamente el MISMO origin que `baseUrl`).
 *   - Sin rangos privados/link-local/metadata (IP literal o por resolución DNS).
 *   - Hostnames locales (`localhost`, `*.localhost`, `*.local`) siempre bloqueados.
 * Devuelve `true` o un string con la razón del rechazo.
 */
export async function isSafeDownloadUrl(
  url: string,
  baseUrl: string,
  options: { lookup?: LookupFn } = {},
): Promise<true | string> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return `URL inválida (${url})`;
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return `protocolo no permitido (${parsed.protocol})`;
  }
  if (parsed.protocol === "http:" && !sameOrigin(parsed.href, baseUrl)) {
    return `http no permitido fuera del mismo origin de Chatwoot (${parsed.href} vs base ${baseUrl})`;
  }

  const hostname = parsed.hostname.toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    return `host local no permitido (${hostname})`;
  }

  const strippedHost = hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(strippedHost)) {
    const reason = privateIpReason(strippedHost);
    if (reason) return `IP no permitida ${strippedHost} (${reason})`;
    return true;
  }

  const lookupFn = options.lookup ?? defaultLookup;
  let addresses: readonly string[];
  try {
    addresses = await lookupFn(hostname);
  } catch (err) {
    return `no se pudo resolver ${hostname} (${err instanceof Error ? err.message : String(err)})`;
  }
  if (addresses.length === 0) return `hostname sin IPs (${hostname})`;
  for (const ip of addresses) {
    const reason = privateIpReason(ip);
    if (reason) return `host ${hostname} resuelve a IP no permitida ${ip} (${reason})`;
  }
  return true;
}

export interface DownloadAttachmentOptions {
  /** Timeout total de la descarga (abort). */
  timeoutMs?: number;
  /** Tope de bytes del adjunto; por defecto 10 MiB. */
  maxBytes?: number;
  /** baseUrl contra la que se evalúa same-origin (tests); producción usa env. */
  baseUrl?: string;
  /** Resolución DNS inyectable (tests); producción usa net.dns.lookup. */
  lookup?: LookupFn;
  /** fetch inyectable (tests); producción usa el fetch global. */
  fetchImpl?: typeof fetch;
}

/** Lee el body por stream con corte en `maxBytes`; si excede, aborta y lanza. */
async function readBodyCapped(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  sourceUrl: string,
  controller: AbortController,
): Promise<Buffer> {
  if (!body) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let total = 0;
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.byteLength > 0) {
        total += value.byteLength;
        if (total > maxBytes) {
          controller.abort();
          throw new Error(
            `[chatwoot-client] adjunto ${sourceUrl} supera el tope de ${maxBytes} bytes: descarga abortada de forma segura`,
          );
        }
        chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
      }
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

/**
 * Descarga un archivo adjunto por su file_url.
 *
 * HARDENING (F1 + F4):
 *   - Tope de tamaño DENTRO de la descarga: rechazo temprano por cabecera
 *     `Content-Length` y lectura por stream con corte en `maxBytes` (abort).
 *   - Anti-SSRF: `redirect: "manual"`, cada salto se valida con
 *     `isSafeDownloadUrl` contra el MISMO baseUrl, máx. 2 saltos.
 *   - El reintento con `api_access_token` (401/403) SOLO si la URL final es
 *     exactamente same-origin (protocolo+host+puerto) con Chatwoot. El token
 *     jamás se envía a otro host (ni siquiera dentro de un retry con redirect).
 */
export async function downloadAttachment(
  fileUrl: string,
  options: DownloadAttachmentOptions = {},
): Promise<{ buffer: Buffer; mimeType: string }> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_ATTACHMENT_BYTES;
  const timeoutMs = options.timeoutMs ?? env.chatwoot.timeoutMs;
  const baseUrl = options.baseUrl ?? env.chatwoot.baseUrl;
  const lookup = options.lookup;
  const fetchImpl = options.fetchImpl ?? fetch;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const fetchOnce = (url: string, headers: Record<string, string>): Promise<Response> =>
    fetchImpl(url, { headers, redirect: "manual", signal: controller.signal });

  const runRedirects = async (
    url: string,
    headers: Record<string, string>,
  ): Promise<{ res: Response; finalUrl: string }> => {
    let current = url;
    for (let hop = 0; hop <= MAX_ATTACHMENT_REDIRECTS; hop++) {
      const safety = await isSafeDownloadUrl(current, baseUrl, { lookup });
      if (safety !== true) {
        throw new Error(`[chatwoot-client] URL de adjunto no permitida (${current}): ${safety}`);
      }
      const res = await fetchOnce(current, headers);
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        if (!location) {
          throw new ChatwootApiError(
            res.status,
            `Error descargando adjunto: redirect sin Location (${current})`,
          );
        }
        let next: string;
        try {
          next = new URL(location, current).href;
        } catch {
          throw new Error(`[chatwoot-client] Location de redirect inválida (${location})`);
        }
        const nextSafety = await isSafeDownloadUrl(next, baseUrl, { lookup });
        if (nextSafety !== true) {
          controller.abort();
          throw new Error(`[chatwoot-client] redirect de adjunto bloqueado por seguridad (${next}): ${nextSafety}`);
        }
        current = next;
        continue;
      }
      return { res, finalUrl: current };
    }
    controller.abort();
    throw new Error(
      `[chatwoot-client] adjunto excede el máximo de ${MAX_ATTACHMENT_REDIRECTS} saltos de redirect`,
    );
  };

  try {
    let { res, finalUrl } = await runRedirects(fileUrl, {});

    // Retry con `api_access_token` SOLO si la URL final es same-origin con
    // Chatwoot. Nunca se reenvía el token a otro host.
    if (!res.ok && (res.status === 401 || res.status === 403)) {
      if (baseUrl && sameOrigin(finalUrl, baseUrl)) {
        console.warn(
          "[chatwoot-client] file_url pidió auth, reintentando con api_access_token SOLO same-origin",
        );
        const retry = await fetchOnce(finalUrl, { api_access_token: env.chatwoot.apiToken });
        if (retry.status >= 300 && retry.status < 400) {
          controller.abort();
          throw new Error(
            "[chatwoot-client] redirect durante retry autenticado no permitido (el api_access_token NO se reenvía a otro host)",
          );
        }
        res = retry;
      } else {
        console.warn(
          "[chatwoot-client] 401/403 sin retry con token: la URL final NO es same-origin con Chatwoot",
        );
      }
    }

    if (!res.ok) {
      throw new ChatwootApiError(
        res.status,
        `Error descargando adjunto ${fileUrl}: HTTP ${res.status}`,
      );
    }

    // (a) Rechazo temprano por cabecera Content-Length.
    const contentLength = res.headers.get("content-length");
    if (contentLength) {
      const parsed = Number(contentLength);
      if (Number.isFinite(parsed) && parsed > maxBytes) {
        controller.abort();
        throw new Error(
          `[chatwoot-client] adjunto ${fileUrl} excede el tope de ${maxBytes} bytes (Content-Length=${contentLength}): se rechaza sin leer el body`,
        );
      }
    }

    // (b) Lectura por stream con corte en `maxBytes + 1` y abort si excede.
    const mimeType = res.headers.get("content-type") ?? "application/octet-stream";
    const buffer = await readBodyCapped(res.body, maxBytes, fileUrl, controller);
    return { buffer, mimeType };
  } finally {
    clearTimeout(timer);
  }
}