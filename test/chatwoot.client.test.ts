import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_MAX_ATTACHMENT_BYTES,
  downloadAttachment,
  isSafeDownloadUrl,
  privateIpReason,
  sameOrigin,
} from "../src/modules/chatwoot/client";

// Tests de la descarga de adjuntos con hardening SSRF/DoS (F1 + F4).
// Los resolver y el fetch se INYECTAN: ningún test toca la red ni el DNS real.

const BASE = "https://chatwoot.example.com";
const PUBLIC_IP = ["93.184.216.34"];
const publicLookup = async () => PUBLIC_IP;

interface Call {
  url: string;
  headers: Record<string, string>;
}

function captureFetch(calls: Call[], handler: (url: string, call: Call) => Promise<Response>) {
  return async (url: string, init: { headers?: Record<string, string> } = {}): Promise<Response> => {
    const call: Call = { url: String(url), headers: (init?.headers as Record<string, string>) ?? {} };
    calls.push(call);
    return handler(String(url), call);
  };
}

// ── F4: isSafeDownloadUrl ──────────────────────────────────────────────────

test("F4-C1. URL http a host NO trusted (o protocolo distinto al de baseUrl) → rechazada", async () => {
  const r = await isSafeDownloadUrl("http://evil.example.com/x", BASE, { lookup: publicLookup });
  assert.notEqual(r, true);
  assert.ok(typeof r === "string" && /http/i.test(r), `rechazo con razón http: ${r}`);
  // http al mismo host pero protocolo distinto (https de baseUrl) ≠ mismo origin.
  const downgrade = await isSafeDownloadUrl("http://chatwoot.example.com/x", BASE, {
    lookup: publicLookup,
  });
  assert.notEqual(downgrade, true);
});

test("F4-C2. IPs de rangos privados/link-local/metadata y hosts locales → rechazadas", async () => {
  assert.ok(privateIpReason("127.0.0.1") !== null);
  assert.ok(privateIpReason("10.0.0.5") !== null);
  assert.ok(privateIpReason("172.16.0.1") !== null);
  assert.ok(privateIpReason("172.31.255.255") !== null);
  assert.ok(privateIpReason("192.168.1.10") !== null);
  assert.ok(privateIpReason("169.254.169.254") !== null);
  assert.ok(privateIpReason("::1") !== null);
  assert.ok(privateIpReason("::ffff:10.0.0.1") !== null); // IPv4-mapped privada
  assert.ok(privateIpReason("8.8.8.8") === null); // pública OK

  assert.notEqual(await isSafeDownloadUrl("http://127.0.0.1/x", BASE), true);
  assert.notEqual(await isSafeDownloadUrl("https://10.0.0.5/x", BASE), true);
  assert.notEqual(await isSafeDownloadUrl("https://192.168.1.10/x", BASE), true);
  assert.notEqual(
    await isSafeDownloadUrl("https://169.254.169.254/latest/meta-data", BASE),
    true,
  );
  assert.notEqual(await isSafeDownloadUrl("https://[::1]/x", BASE), true);
  assert.notEqual(await isSafeDownloadUrl("https://localhost/x", BASE), true);
  assert.notEqual(await isSafeDownloadUrl("https://foo.local/x", BASE), true);
});

test("F4-C3. https de host público (mismo host que baseUrl u otro CDN) → permitida", async () => {
  assert.equal(
    await isSafeDownloadUrl("https://chatwoot.example.com/rails/active_storage/a.png", BASE, {
      lookup: publicLookup,
    }),
    true,
  );
  assert.equal(
    await isSafeDownloadUrl("https://cdn.example.com/file.pdf", BASE, { lookup: publicLookup }),
    true,
  );
  assert.equal(sameOrigin(BASE + "/a", BASE), true);
  assert.equal(sameOrigin("https://cdn.example.com/x", BASE), false);
});

test("F4-C4. hostname que RESUELVE a rango privado → rechazada (fail-closed)", async () => {
  const r = await isSafeDownloadUrl("https://internal.example.com/x", BASE, {
    lookup: async () => ["10.1.2.3"],
  });
  assert.notEqual(r, true);
  assert.ok(typeof r === "string" && r.includes("10.1.2.3"), `menciona la IP resuelta: ${r}`);
});

// ── F4: downloadAttachment con redirects y retry de token ──────────────────

test("F4-C5. redirect a host externo que exige auth → abortado SIN api_access_token", async () => {
  const calls: Call[] = [];
  const fetchMock = captureFetch(calls, (url) => {
    if (url === `${BASE}/rails/a`) {
      return Promise.resolve(
        new Response(null, { status: 302, headers: { location: "https://evil.example.com/file" } }),
      );
    }
    return Promise.resolve(new Response(null, { status: 401 }));
  });

  await assert.rejects(
    () =>
      downloadAttachment(`${BASE}/rails/a`, {
        lookup: publicLookup,
        fetchImpl: fetchMock as never,
        baseUrl: BASE,
      }),
    /HTTP 401/,
  );

  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, "https://evil.example.com/file");
  // El api_access_token NUNCA se envió (ni a Chatwoot ni al host externo).
  assert.equal(
    calls.some((c) => Object.prototype.hasOwnProperty.call(c.headers, "api_access_token")),
    false,
    "el token no debe viajar a ningún host en este escenario",
  );
});

test("F4-C5b. redirect hacia rango privado/metadata → bloqueado por seguridad y NO se sigue", async () => {
  const calls: Call[] = [];
  const fetchMock = captureFetch(calls, (url) => {
    if (url === `${BASE}/rails/x`) {
      return Promise.resolve(
        new Response(null, {
          status: 302,
          headers: { location: "http://169.254.169.254/latest/meta-data" },
        }),
      );
    }
    throw new Error(`no debería fetchearse ${url}`);
  });

  await assert.rejects(
    () =>
      downloadAttachment(`${BASE}/rails/x`, {
        lookup: publicLookup,
        fetchImpl: fetchMock as never,
        baseUrl: BASE,
      }),
    /bloqueado por seguridad/,
  );
  assert.equal(calls.length, 1, "la metadata jamás se fetchea");
});

test("F4-C6. 401 en URL final SAME-ORIGIN → retry con api_access_token solo a ese origin", async () => {
  const calls: Call[] = [];
  let n = 0;
  const fetchMock = captureFetch(calls, () => {
    n += 1;
    if (n === 1) return Promise.resolve(new Response(null, { status: 401 }));
    return Promise.resolve(
      new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
        status: 200,
        headers: { "content-type": "image/png" },
      }),
    );
  });

  const res = await downloadAttachment(`${BASE}/rails/a.png`, {
    lookup: publicLookup,
    fetchImpl: fetchMock as never,
    baseUrl: BASE,
  });

  assert.equal(res.buffer.length, 4);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, `${BASE}/rails/a.png`);
  assert.ok(
    Object.prototype.hasOwnProperty.call(calls[1].headers, "api_access_token"),
    "el retry same-origin SÍ lleva el token",
  );
  assert.ok(
    !Object.prototype.hasOwnProperty.call(calls[0].headers, "api_access_token"),
    "el primer intento NO lleva token",
  );
});

// ── F1: tope de tamaño DENTRO de la descarga ───────────────────────────────

test("F1-C7. Content-Length > maxBytes → rechazo temprano sin leer el body", async () => {
  const calls: Call[] = [];
  const fetchMock = captureFetch(calls, () =>
    Promise.resolve(
      new Response(null, {
        status: 200,
        headers: { "content-length": "99999999", "content-type": "image/png" },
      }),
    ),
  );

  await assert.rejects(
    () =>
      downloadAttachment(`${BASE}/big`, {
        lookup: publicLookup,
        fetchImpl: fetchMock as never,
        baseUrl: BASE,
        maxBytes: DEFAULT_MAX_ATTACHMENT_BYTES,
      }),
    /Content-Length/,
  );
  assert.equal(calls.length, 1);
});

test("F1-C8. descarga por STREAM que supera maxBytes → corta y aborta con error claro", async () => {
  const chunk = Buffer.alloc(1024 * 1024, 0x61);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < 12; i++) controller.enqueue(new Uint8Array(chunk));
      controller.close();
    },
  });
  const fetchMock = async (): Promise<Response> =>
    new Response(body, { status: 200, headers: { "content-type": "image/png" } });

  const maxBytes = 5 * 1024 * 1024;
  await assert.rejects(
    () =>
      downloadAttachment(`${BASE}/big-stream`, {
        lookup: publicLookup,
        fetchImpl: fetchMock as never,
        baseUrl: BASE,
        maxBytes,
      }),
    new RegExp(`supera el tope de ${maxBytes} bytes`),
  );
});