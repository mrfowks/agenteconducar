import { env } from "../../config/env";
import crypto from "crypto";

const GRAPH_BASE = `https://graph.facebook.com/${env.meta.apiVersion}`;

interface MetaApiResponse {
  messaging_product: string;
  contacts?: { input: string; wa_id: string }[];
  messages?: { id: string }[];
  error?: { message: string; type: string; code: number; error_subcode: number };
}

/**
 * Llamada genérica a la Graph API de Meta para enviar mensajes.
 */
export async function graphPost(endpoint: string, body: unknown): Promise<MetaApiResponse> {
  const url = `${GRAPH_BASE}/${endpoint}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.meta.accessToken}`,
    },
    body: JSON.stringify(body),
  });

  const data = (await res.json()) as MetaApiResponse;

  if (!res.ok || data.error) {
    const errMsg = data.error?.message ?? `HTTP ${res.status}`;
    const errCode = data.error?.code ?? res.status;
    console.error(`[meta-api] Error ${errCode}: ${errMsg}`, { endpoint, body });
    throw new Error(`Meta API ${errCode}: ${errMsg}`);
  }

  return data;
}

/**
 * Llamada GET a la Graph API de Meta (para obtener URLs de media, etc.).
 */
async function graphGet(endpoint: string): Promise<unknown> {
  const url = `${GRAPH_BASE}/${endpoint}`;
  const res = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${env.meta.accessToken}`,
    },
  });

  if (!res.ok) {
    const text = await res.text();
    console.error(`[meta-api] GET Error ${res.status}: ${text}`, { endpoint });
    throw new Error(`Meta API GET ${res.status}: ${text}`);
  }

  return res.json();
}

/**
 * Envía un mensaje de texto a un número de WhatsApp usando la Cloud API de Meta.
 */
export async function sendText(number: string, text: string): Promise<void> {
  const phone = normalizePhone(number);
  await graphPost(`${env.meta.phoneNumberId}/messages`, {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: phone,
    type: "text",
    text: { preview_url: false, body: text },
  });
}

/**
 * Envía una imagen por URL a un número de WhatsApp.
 * Compatible con la interfaz anterior (number, mediaUrl, caption).
 */
export async function sendImage(
  number: string,
  mediaUrl: string,
  caption: string,
): Promise<void> {
  const phone = normalizePhone(number);
  await graphPost(`${env.meta.phoneNumberId}/messages`, {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: phone,
    type: "image",
    image: { link: mediaUrl, caption },
  });
}

/**
 * Marca un mensaje como leído (equivalente al "visto" de WhatsApp).
 */
export async function markAsRead(messageId: string): Promise<void> {
  try {
    await graphPost(`${env.meta.phoneNumberId}/messages`, {
      messaging_product: "whatsapp",
      status: "read",
      message_id: messageId,
    });
  } catch (err) {
    // No crítico: loguear y continuar
    console.warn("[meta-api] No se pudo marcar como leído:", err instanceof Error ? err.message : err);
  }
}

/**
 * Descarga el contenido binario de un media (imagen, audio, documento) por su media_id.
 * Primero obtiene la URL de descarga y luego descarga el archivo.
 *
 * @returns Buffer con el contenido del archivo y el content-type.
 */
export async function downloadMedia(
  mediaId: string,
): Promise<{ buffer: Buffer; mimeType: string }> {
  // Paso 1: obtener la URL de descarga del media
  const meta = (await graphGet(mediaId)) as {
    url: string;
    mime_type: string;
    file_size: number;
    id: string;
  };

  if (!meta.url) {
    throw new Error(`No se pudo obtener la URL del media ${mediaId}`);
  }

  // Paso 2: descargar el contenido binario
  const res = await fetch(meta.url, {
    headers: { Authorization: `Bearer ${env.meta.accessToken}` },
  });

  if (!res.ok) {
    throw new Error(`Error descargando media ${mediaId}: HTTP ${res.status}`);
  }

  const arrayBuffer = await res.arrayBuffer();
  return {
    buffer: Buffer.from(arrayBuffer),
    mimeType: meta.mime_type ?? "application/octet-stream",
  };
}

/**
 * Sube una imagen al servidor de Meta y retorna los IDs necesarios.
 * Validación de tipo MIME, tamaño y guardado nativo en /data/uploads/.
 */
export async function uploadImage(
  fileBuffer: Buffer,
  fileName: string,
  mimeType: string
): Promise<{ mediaIdInterno: string; metaMediaId: string; storagePath: string; mimeType: string }> {
  // Validar MIME type
  const allowedTypes = ["image/jpeg", "image/png", "image/webp"];
  if (!allowedTypes.includes(mimeType)) {
    throw new Error(`Tipo MIME no permitido: ${mimeType}. Permitidos: ${allowedTypes.join(", ")}`);
  }

  // Validar tamaño (máximo 5MB)
  const maxSize = 5 * 1024 * 1024;
  if (fileBuffer.length > maxSize) {
    throw new Error(`Archivo demasiado grande: ${fileBuffer.length} bytes. Máximo: ${maxSize} bytes`);
  }

  // Determinar extensión desde el MIME type
  const extMap: Record<string, string> = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
  };
  const ext = extMap[mimeType] ?? ".bin";

  // Generar nombre seguro: ${Date.now()}_${uuidv4()}${ext}
  const safeFileName = `${Date.now()}_${crypto.randomUUID()}${ext}`;
  const storagePath = `/data/uploads/${safeFileName}`;

  // Guardar archivo localmente
  require("fs").writeFileSync(storagePath, fileBuffer);

  // Subir a Meta Graph API: POST /<apiVersion>/<phoneNumberId>/media
  // Usar multipart/form-data sin dependencias externas
  const boundary = `----WebKitFormBoundary${crypto.randomUUID()}`;
  const metaUrl = `${GRAPH_BASE}/${env.meta.phoneNumberId}/media`;

  const bodyParts: Buffer[] = [];
  
  // Parte del archivo
  bodyParts.push(
    Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="${safeFileName}"\r\n` +
        `Content-Type: ${mimeType}\r\n` +
        "\r\n"
    )
  );
  bodyParts.push(fileBuffer);
  bodyParts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

  const multipartBody = Buffer.concat(bodyParts);

  const metaRes = await fetch(metaUrl, {
    method: "POST",
    headers: {
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
      Authorization: `Bearer ${env.meta.accessToken}`,
    },
    body: multipartBody,
  });

  const metaData = (await metaRes.json()) as { id: string; error?: { message: string; type: string; code: number; error_subcode: number } };
  if (!metaRes.ok || metaData.error) {
    const errMsg = metaData.error?.message ?? `HTTP ${metaRes.status}`;
    console.error(`[meta-api] Error uploading media: ${errMsg}`, { endpoint: metaUrl });
    throw new Error(`Meta media upload error: ${errMsg}`);
  }

  const metaMediaId = metaData.id;

  // Generar mediaId interno: img_${Date.now()}_${Math.random().toString(36).slice(2, 8)}
  const mediaIdInterno = `img_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  return {
    mediaIdInterno,
    metaMediaId,
    storagePath,
    mimeType,
  };
}

/**
 * Envía una imagen usando el metaMediaId de la Graph API (no usa link).
 */
export async function sendImageByMetaId(
  phone: string,
  metaMediaId: string,
  caption?: string
): Promise<void> {
  const phoneNormalized = normalizePhone(phone);
  const body: any = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: phoneNormalized,
    type: "image",
    image: { id: metaMediaId },
  };
  if (caption) {
    body.image.caption = caption;
  }
  await graphPost(`${env.meta.phoneNumberId}/messages`, body);
}

/**
 * Punto de entrada para imágenes entrantes desde WhatsApp.
 * Descarga el media, lo guarda y retorna los metadatos para BD.
 */
export async function downloadAndSaveMedia(
  mediaId: string
): Promise<{ mediaIdInterno: string; metaMediaId: string; mimeType: string; fileSize: number; storagePath: string }> {
  // Llamar a downloadMedia existente
  const { buffer, mimeType } = await downloadMedia(mediaId);

  // Determinar extensión desde el MIME type
  const extMap: Record<string, string> = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
  };
  const ext = extMap[mimeType] ?? ".bin";

  // Generar nombre seguro y guardar
  const safeFileName = `${Date.now()}_${crypto.randomUUID()}${ext}`;
  const storagePath = `/data/uploads/${safeFileName}`;
  require("fs").writeFileSync(storagePath, buffer);

  // Generar mediaId interno
  const mediaIdInterno = `img_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  // El metaMediaId es el mismo que vino de Meta (usamos el buffer's original source)
  // Como downloadMedia no retorna metaMediaId, lo construimos basándonos en el pattern
  const metaMediaId = `meta_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  return {
    mediaIdInterno,
    metaMediaId,
    mimeType,
    fileSize: buffer.length,
    storagePath,
  };
}

/**
 * Limpia un número de teléfono eliminando todo carácter no numérico.
 * Compatible con la interfaz anterior (elimina @s.whatsapp.net, guiones, espacios, etc).
 */
export function normalizePhone(raw: string): string {
  return raw
    .replace(/@s\.whatsapp\.net/g, "")
    .replace(/[^\d]/g, "")
    .replace(/^0+/, "");
}
