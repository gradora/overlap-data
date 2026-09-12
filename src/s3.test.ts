// Клиент S3-совместимого хранилища (R2). Проверяется то, что нельзя увидеть
// глазами и что ломается молча: форма подписи SigV4 и поведение трёх операций.
//
// ПОЧЕМУ НЕ «ЭТАЛОННАЯ ПОДПИСЬ ИЗ ДОКУМЕНТАЦИИ». Захардкодить чужой ожидаемый
// хеш можно только скопировав его откуда-то дословно; выдуманный «эталон»
// был бы тестом, который проверяет сам себя. Поэтому проверяются СВОЙСТВА
// подписи, каждое из которых ловит реальный класс ошибки: детерминированность,
// чувствительность к каждому входу (метод, путь, тело, дата, ключ, регион) и
// состав Authorization по спецификации.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  deleteObject, encodeKey, etagOf, listObjects, putObject, signRequest, type S3Config,
} from "./lib/s3.js";

const AT = new Date("2026-09-12T10:20:30.000Z");

const cfg: S3Config = {
  endpoint: "https://acc123.r2.cloudflarestorage.com",
  bucket: "overlap-serve",
  accessKeyId: "AKIDTEST",
  secretAccessKey: "SECRETTEST",
};

const sign = (over: Partial<S3Config> = {}, method = "PUT", path = "/overlap-serve/a.json",
              payload = Buffer.from("{}"), at = AT) =>
  signRequest({ ...cfg, ...over }, method, path, {}, payload, at).authorization;

test("подпись: детерминирована и несёт спецификационный состав", () => {
  const a = sign();
  assert.equal(a, sign(), "подпись не детерминирована — отладка станет невозможной");
  assert.match(a, /^AWS4-HMAC-SHA256 Credential=AKIDTEST\/\d{8}\/auto\/s3\/aws4_request, /);
  assert.match(a, /SignedHeaders=host;x-amz-content-sha256;x-amz-date, /,
    "подписанные заголовки обязаны быть отсортированы и перечислены целиком");
  assert.match(a, /Signature=[0-9a-f]{64}$/);
  // Секрет НЕ должен просочиться в заголовок ни в каком виде.
  assert.ok(!a.includes(cfg.secretAccessKey), "секрет утёк в Authorization");
});

test("подпись: меняется от каждого входа — метода, пути, тела, даты, ключей, региона", () => {
  const base = sign();
  const variants: Record<string, string> = {
    "метод": sign({}, "DELETE"),
    "путь": sign({}, "PUT", "/overlap-serve/b.json"),
    "тело": sign({}, "PUT", "/overlap-serve/a.json", Buffer.from("{ }")),
    "дата": sign({}, "PUT", "/overlap-serve/a.json", Buffer.from("{}"),
                 new Date("2026-09-13T10:20:30.000Z")),
    "секрет": sign({ secretAccessKey: "OTHER" }),
    "ключ доступа": sign({ accessKeyId: "AKIDOTHER" }),
    "регион": sign({ region: "us-east-1" }),
  };
  for (const [what, value] of Object.entries(variants)) {
    assert.notEqual(value, base, `подпись не зависит от «${what}» — запрос примут не тот`);
  }
});

test("ключ объекта кодируется посегментно: иерархия жива, спецсимволы экранированы", () => {
  assert.equal(encodeKey("f1/2026/standings.json"), "f1/2026/standings.json",
    "слеши экранированы — вместо иерархии получится один плоский ключ");
  assert.equal(encodeKey("refs/a b.json"), "refs/a%20b.json");
  assert.equal(encodeKey("wec/2025/24-hours-of-le-mans-2025-1.json"),
               "wec/2025/24-hours-of-le-mans-2025-1.json");
});

// ---------------------------------------------------------------------------
// Операции против локального сервера, изображающего S3: проверяем ровно то,
// что уходит по сети, — метод, путь, тело и наличие подписи.
// ---------------------------------------------------------------------------

interface Seen { method: string; url: string; auth: string; body: string }

function fake(handler: (req: IncomingMessage, seen: Seen) => { status: number; body: string }) {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const s: Seen = {
        method: req.method ?? "",
        url: req.url ?? "",
        auth: String(req.headers.authorization ?? ""),
        body: Buffer.concat(chunks).toString("utf8"),
      };
      seen.push(s);
      const r = handler(req, s);
      res.writeHead(r.status, { "content-type": "application/xml" });
      res.end(r.body);
    });
  });
  return { server, seen };
}

const listen = (server: Server): Promise<string> =>
  new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  }));

function page(keys: string[], truncated = false, next = ""): string {
  return `<?xml version="1.0"?><ListBucketResult>` +
    keys.map((k) => `<Contents><Key>${k}</Key><ETag>"abc${k.length}"</ETag>` +
      `<Size>${k.length}</Size></Contents>`).join("") +
    `<IsTruncated>${truncated}</IsTruncated>` +
    (truncated ? `<NextContinuationToken>${next}</NextContinuationToken>` : "") +
    `</ListBucketResult>`;
}

test("LIST: страницы склеиваются — обрезка на 1000 ключей дала бы лишнюю перезаливку", async () => {
  const { server, seen } = fake((_req, s) =>
    s.url.includes("continuation-token")
      ? { status: 200, body: page(["b.json"]) }
      : { status: 200, body: page(["a.json"], true, "TOKEN2") });
  const endpoint = await listen(server);
  try {
    const objects = await listObjects({ ...cfg, endpoint });
    assert.deepEqual(objects.map((o) => o.key), ["a.json", "b.json"],
      "вторая страница потеряна — половина витрины будет считаться отсутствующей");
    assert.equal(seen.length, 2);
    assert.ok(seen.every((s) => s.auth.startsWith("AWS4-HMAC-SHA256 ")), "запрос ушёл без подписи");
    assert.ok(seen[0]?.url.includes("list-type=2"));
  } finally {
    server.close();
  }
});

test("PUT: тело и тип уходят как есть, путь несёт бакет и ключ", async () => {
  const { server, seen } = fake(() => ({ status: 200, body: "" }));
  const endpoint = await listen(server);
  try {
    await putObject({ ...cfg, endpoint }, "f1/2026/standings.json",
                    Buffer.from('{"a":1}'), "application/json");
    assert.equal(seen[0]?.method, "PUT");
    assert.equal(seen[0]?.url, "/overlap-serve/f1/2026/standings.json");
    assert.equal(seen[0]?.body, '{"a":1}');
  } finally {
    server.close();
  }
});

test("PUT: отказ хранилища — громкая ошибка, а не тихий пропуск файла", async () => {
  const { server } = fake(() => ({ status: 403, body: "<Error><Code>AccessDenied</Code></Error>" }));
  const endpoint = await listen(server);
  try {
    await assert.rejects(
      () => putObject({ ...cfg, endpoint }, "a.json", Buffer.from("{}"), "application/json"),
      /код 403/,
      "молча пропущенный файл = дыра в витрине, которую никто не заметит");
  } finally {
    server.close();
  }
});

test("DELETE: 404 — успех, отказ — ошибка", async () => {
  const { server } = fake((req) =>
    req.url?.includes("gone") ? { status: 404, body: "" } : { status: 500, body: "" });
  const endpoint = await listen(server);
  try {
    // Идемпотентность: объекта уже нет — значит цель достигнута.
    await deleteObject({ ...cfg, endpoint }, "gone.json");
    await assert.rejects(() => deleteObject({ ...cfg, endpoint }, "boom.json"), /код 500/);
  } finally {
    server.close();
  }
});

test("etag: md5 в hex — та же форма, в которой S3 отдаёт ETag", () => {
  // Совпадение форм — единственная причина, по которой сравнение «локальный
  // файл против удалённого» вообще работает и не перезаливает всё подряд.
  assert.match(etagOf(Buffer.from("hello")), /^[0-9a-f]{32}$/);
  assert.equal(etagOf(Buffer.from("hello")), etagOf(Buffer.from("hello")));
  assert.notEqual(etagOf(Buffer.from("hello")), etagOf(Buffer.from("hello ")));
});
