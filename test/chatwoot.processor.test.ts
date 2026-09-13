import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_ATTACHMENT_BYTES,
  resolveAttachment,
  resolveStoredMimeType,
} from "../src/modules/chatwoot/processor";
import { buildStoragePath } from "../src/modules/chatwoot/mapper";

// PNG válido (firma 89 50 4E 47 ...) y PDF (firma %PDF).
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PDF = Buffer.from([0x25, 0x50, 0x44, 0x46]);

// ── B3: resolveAttachment (data_url/file_url reales de Chatwoot v4.17.1) ────

// (a) data_url=https (URL real de Active Storage) con downloadAttachment mockeado.
// El test NUNCA toca la red: el mock devuelve un buffer PNG válido + content-type.
test("P1. data_url=https real (mock PNG + content-type image/png) → buffer íntegro, MIME image/png, storagePath .png", async () => {
  const calls: string[] = [];
  const resolved = await resolveAttachment(
    { id: 900, data_url: "https://chatwoot.example.com/rails/active_storage/...png" },
    {
      downloadAttachment: async (url) => {
        calls.push(url);
        return { buffer: PNG, mimeType: "image/png" };
      },
    },
  );
  assert.deepEqual(calls, ["https://chatwoot.example.com/rails/active_storage/...png"]);
  // Archivo resultante NO corrupto: el buffer es exactamente el PNG descargado.
  assert.equal(resolved.buffer.equals(PNG), true);
  assert.equal(resolved.mimeType, "image/png");
  assert.equal(resolveStoredMimeType(resolved.mimeType, resolved.buffer), "image/png");
  // storagePath correcto: /data/uploads/<ts>_<uuid>.png
  assert.match(
    buildStoragePath(resolved.mimeType, "png"),
    /^\/data\/uploads\/\d{13}_[0-9a-f-]{36}\.png$/,
  );
});

// (b) data: URI legacy → decodificación correcta. L7 ya cubre dataUrlToBuffer
// como unidad; este test cubre la rama data: de resolveAttachment (función nueva).
test("P2. data_url=data:image/png;base64,... → decodifica correcto (rama legacy de resolveAttachment)", async () => {
  const b64 = PNG.toString("base64");
  const resolved = await resolveAttachment({
    id: 901,
    data_url: `data:image/png;base64,${b64}`,
  });
  assert.equal(resolved.mimeType, "image/png");
  assert.equal(resolved.buffer.equals(PNG), true);
});

// (c) URL https cuyo buffer supera MAX_ATTACHMENT_BYTES → rechazo seguro (throws claro).
test("P3. data_url=https que supera MAX_ATTACHMENT_BYTES → rechazo seguro con mensaje claro", async () => {
  const big = Buffer.alloc(MAX_ATTACHMENT_BYTES + 1);
  await assert.rejects(
    () =>
      resolveAttachment(
        { id: 902, data_url: "https://chatwoot.example.com/rails/active_storage/big" },
        {
          downloadAttachment: async () => ({ buffer: big, mimeType: "application/octet-stream" }),
        },
      ),
    /excede el límite de MAX_ATTACHMENT_BYTES/,
  );
});

// (d) formato inválido → rechazo seguro: Buffer vacío, NUNCA bytes basura.
test("P4. formato inválido ('garbage') → rechazo seguro con Buffer vacío", async () => {
  const resolved = await resolveAttachment({ id: 903, data_url: "garbage" });
  assert.equal(resolved.buffer.length, 0);
  assert.equal(resolved.buffer.equals(Buffer.alloc(0)), true);
});

// (e) attachment.file_url presente y data_url ausente → se usa file_url.
test("P5. attachment.file_url presente y data_url ausente → descarga usando file_url", async () => {
  const calls: string[] = [];
  const resolved = await resolveAttachment(
    { id: 904, file_url: "https://chatwoot.example.com/rails/active_storage/a.pdf" },
    {
      downloadAttachment: async (url) => {
        calls.push(url);
        return { buffer: PDF, mimeType: "application/pdf" };
      },
    },
  );
  assert.deepEqual(calls, ["https://chatwoot.example.com/rails/active_storage/a.pdf"]);
  assert.equal(resolved.buffer.equals(PDF), true);
  assert.equal(resolved.mimeType, "application/pdf");
});

// sniffMimeType como fallback si la descarga no da content-type específico.
test("P6. resolveStoredMimeType: content-type genérico/vacío → sniffMimeType como respaldo", () => {
  assert.equal(resolveStoredMimeType("application/octet-stream", PNG), "image/png");
  assert.equal(resolveStoredMimeType("image/png", PNG), "image/png");
  assert.equal(resolveStoredMimeType("", PNG), "image/png");
  assert.equal(
    resolveStoredMimeType("application/octet-stream", Buffer.from([0x00, 0x01, 0x02, 0x03])),
    "application/octet-stream",
  );
});