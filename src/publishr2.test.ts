// Публикация витрины в объектное хранилище. Проверяется то, ради чего
// хранилище и выбрано вместо serve-репо, и то, что дороже всего сломать:
// заливается только изменившееся, осиротевшее удаляется, атрибуции живут,
// отказ громкий.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AddressInfo } from "node:net";
import { publishR2, r2ConfigFromEnv } from "./lib/publishr2.js";
import { etagOf, type S3Config } from "./lib/s3.js";
import type { ExportEntry } from "./exportserve.js";

interface Seen { method: string; url: string; body: Buffer }

/// Фейковое хранилище: помнит содержимое и записывает все обращения.
function fakeStore(initial: Record<string, string>) {
  const objects = new Map(Object.entries(initial));
  const seen: Seen[] = [];
  let failPut = false;

  const server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const url = req.url ?? "";
      const body = Buffer.concat(chunks);
      seen.push({ method: req.method ?? "", url, body });
      const key = decodeURIComponent(url.split("?")[0] ?? "").replace(/^\/bucket\/?/, "");

      if (req.method === "GET") {
        const xml = `<?xml version="1.0"?><ListBucketResult>` +
          [...objects.entries()].map(([k, v]) =>
            `<Contents><Key>${k}</Key><ETag>"${etagOf(Buffer.from(v))}"</ETag>` +
            `<Size>${v.length}</Size></Contents>`).join("") +
          `<IsTruncated>false</IsTruncated></ListBucketResult>`;
        res.writeHead(200, { "content-type": "application/xml" });
        return res.end(xml);
      }
      if (req.method === "PUT") {
        if (failPut) { res.writeHead(403); return res.end(""); }
        objects.set(key, body.toString("utf8"));
        res.writeHead(200);
        return res.end("");
      }
      if (req.method === "DELETE") {
        objects.delete(key);
        res.writeHead(204);
        return res.end("");
      }
      res.writeHead(405);
      res.end("");
    });
  });

  return {
    server, seen, objects,
    breakPut() { failPut = true; },
    puts: () => seen.filter((s) => s.method === "PUT").map((s) => s.url.replace("/bucket/", "")),
    deletes: () => seen.filter((s) => s.method === "DELETE").map((s) => s.url.replace("/bucket/", "")),
  };
}

const listen = (server: Server): Promise<string> =>
  new Promise((r) => server.listen(0, "127.0.0.1", () =>
    r(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));

function cfgFor(endpoint: string): S3Config {
  return { endpoint, bucket: "bucket", accessKeyId: "AKID", secretAccessKey: "SECRET" };
}

/// Локальная «витрина»: файлы на диске + манифест той же формы, что отдаёт
/// exportserve.
function localShowcase(files: Record<string, string>): { dir: string; entries: ExportEntry[] } {
  const dir = mkdtempSync(join(tmpdir(), "publish-r2-"));
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(dir, dirname(path)), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
  const entries: ExportEntry[] = [{
    family: "test", dir: "test",
    files: Object.entries(files).map(([path, body]) => ({ path, bytes: body.length })),
  }];
  return { dir, entries };
}

test("публикуется только изменившееся — иначе каждый тик гнал бы витрину целиком", async () => {
  const { dir, entries } = localShowcase({
    "f1/2026/standings.json": '{"v":2}',
    "refs/brands.json": '{"same":true}',
  });
  // В хранилище: один файл совпадает по содержимому, другой устарел.
  const store = fakeStore({
    "f1/2026/standings.json": '{"v":1}',
    "refs/brands.json": '{"same":true}',
  });
  const endpoint = await listen(store.server);
  try {
    const r = await publishR2(cfgFor(endpoint), entries, dir);
    assert.deepEqual(store.puts(), ["f1/2026/standings.json"],
      "перезалит неизменившийся файл — смысл ETag-сравнения потерян");
    assert.equal(r.put, 1);
    assert.equal(r.unchanged, 1);
    assert.equal(store.objects.get("f1/2026/standings.json"), '{"v":2}');
  } finally {
    store.server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("осиротевший объект удаляется, атрибуции — никогда", async () => {
  const { dir, entries } = localShowcase({ "refs/brands.json": "{}" });
  const store = fakeStore({
    "refs/brands.json": "{}",
    "f1/2025/gone.json": "{}",      // семейство ушло из витрины
    "LICENSE": "attributions",       // кладёт владелец
    "README.md": "витрина",
  });
  const endpoint = await listen(store.server);
  try {
    const r = await publishR2(cfgFor(endpoint), entries, dir);
    assert.deepEqual(store.deletes(), ["f1/2025/gone.json"],
      "снесено лишнее: LICENSE/README кладёт владелец, крон не имеет права их трогать");
    assert.equal(r.deleted, 1);
    assert.ok(store.objects.has("LICENSE") && store.objects.has("README.md"),
      "атрибуции источников стёрты публикацией — прямое нарушение правового чеклиста");
  } finally {
    store.server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("отказ хранилища доезжает до вызывающего, а не прячется в пуле", async () => {
  const { dir, entries } = localShowcase({
    "a.json": "1", "b.json": "2", "c.json": "3", "d.json": "4",
    "e.json": "5", "f.json": "6", "g.json": "7", "h.json": "8", "i.json": "9",
  });
  const store = fakeStore({});
  store.breakPut();
  const endpoint = await listen(store.server);
  try {
    // Девять файлов при пуле в восемь — отказ обязан всплыть даже если
    // случился не в первой волне.
    await assert.rejects(() => publishR2(cfgFor(endpoint), entries, dir), /код 403/,
      "молча пропущенный файл = дыра в витрине при зелёном прогоне");
  } finally {
    store.server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("конфиг из окружения: неполный набор — это «не настроено», а не отказ", () => {
  assert.equal(r2ConfigFromEnv({}), null);
  assert.equal(r2ConfigFromEnv({ R2_ENDPOINT: "https://x", R2_BUCKET: "b" }), null,
    "половина переменных не должна включать публикацию");
  const full = r2ConfigFromEnv({
    R2_ENDPOINT: "https://x", R2_BUCKET: "b",
    R2_ACCESS_KEY_ID: "k", R2_SECRET_ACCESS_KEY: "s",
  });
  assert.equal(full?.bucket, "b");
});
