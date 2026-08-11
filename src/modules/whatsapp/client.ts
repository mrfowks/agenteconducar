import { env } from "../../config/env";

async function api(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${env.evolution.url}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: env.evolution.apiKey,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Evolution API ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

export async function sendText(number: string, text: string): Promise<void> {
  await api(`/message/sendText/${env.evolution.instance}`, { number, text });
}

export async function sendImage(
  number: string,
  mediaUrl: string,
  caption: string,
): Promise<void> {
  await api(`/message/sendMedia/${env.evolution.instance}`, {
    number,
    mediatype: "image",
    media: mediaUrl,
    caption,
  });
}

export async function sendPresence(
  number: string,
  presence: "composing" | "recording" | "available" | "paused",
  delay?: number,
): Promise<void> {
  await api(`/chat/sendPresence/${env.evolution.instance}`, {
    number,
    presence,
    delay: delay ?? 0,
  });
}

export function normalizePhone(raw: string): string {
  return raw
    .replace(/@s\.whatsapp\.net/g, "")
    .replace(/[^\d]/g, "")
    .replace(/^0+/, "");
}
