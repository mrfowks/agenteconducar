import { test } from "node:test";
import assert from "node:assert/strict";
import {
  recomputeHmac,
  verifyChatwootSignature,
  isTimestampFresh,
} from "../src/modules/chatwoot/signature";

const SECRET = "super-secret-chatwoot-webhook";

// Body crudo (la firma se calcula sobre el body EXACTO que llega).
const rawBody = Buffer.from(
  JSON.stringify({
    event: "message_created",
    id: 100,
    content: "Hola, quiero reservar",
    message_type: "incoming",
    sender: { id: 7, type: "contact" },
    conversation: { id: 55, inbox_id: 9 },
    account: { id: 1 },
  }),
);

function okHeaders(timestamp: string) {
  return {
    signature: `sha256=${recomputeHmac(SECRET, timestamp, rawBody)}`,
    timestamp,
  };
}

test("A. HMAC correcta → verify true (firma generada con recomputeHmac)", () => {
  const timestamp = String(Math.floor(Date.now() / 1000));
  assert.equal(verifyChatwootSignature(rawBody, okHeaders(timestamp), SECRET), true);
});

test("B. firma incorrecta / tampered → false", () => {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const headers = okHeaders(timestamp);
  const tamperedSig = headers.signature.slice(0, -3) + "abc";
  assert.equal(verifyChatwootSignature(rawBody, { ...headers, signature: tamperedSig }, SECRET), false);

  // Body distinto al que firmó Chatwoot.
  const otherBody = Buffer.from(rawBody.toString("utf8").replace("100", "999"));
  assert.equal(verifyChatwootSignature(otherBody, headers, SECRET), false);
});

test("C. payload sin firma → false (nunca return true por defecto)", () => {
  const timestamp = String(Math.floor(Date.now() / 1000));
  assert.equal(verifyChatwootSignature(rawBody, { timestamp }, SECRET), false);
  assert.equal(verifyChatwootSignature(rawBody, {}, SECRET), false);
  assert.equal(verifyChatwootSignature(rawBody, { signature: "", timestamp }, SECRET), false);
  assert.equal(verifyChatwootSignature(rawBody, { signature: "sha256=abc", timestamp: "" }, SECRET), false);
  // Firma sin prefijo "sha256=".
  const sig = recomputeHmac(SECRET, timestamp, rawBody);
  assert.equal(
    verifyChatwootSignature(rawBody, { signature: sig, timestamp }, SECRET),
    false,
  );
});

test("D. timestamp antiguo (>300s de desvío) → false (anti-replay)", () => {
  const oldTimestamp = String(Math.floor(Date.now() / 1000) - 3600);
  assert.equal(verifyChatwootSignature(rawBody, okHeaders(oldTimestamp), SECRET), false);
  // helper puro expuesto
  assert.equal(isTimestampFresh(Number(oldTimestamp)), false);
  assert.equal(
    isTimestampFresh(Math.floor(Date.now() / 1000) - 120),
    true,
  );
  assert.equal(isTimestampFresh(0), false);
  assert.equal(isTimestampFresh(Number.NaN), false);
});

test("recomputeHmac es determinista y hex", () => {
  const a = recomputeHmac(SECRET, "1234567890", rawBody);
  const b = recomputeHmac(SECRET, "1234567890", rawBody);
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);
});