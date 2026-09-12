// Минимальный клиент S3-совместимого хранилища (Cloudflare R2) — ровно три
// операции, которые нужны публикации витрины: LIST, PUT, DELETE.
//
// ПОЧЕМУ СВОЙ, А НЕ SDK. У проекта одна прод-зависимость (unpdf), и тянуть
// ради трёх запросов пакет с сотней транзитивных — плохой размен: этот файл
// целиком меньше, чем package-lock после установки SDK, и полностью читаем.
// Подпись — AWS Signature V4, у R2 регион всегда `auto`, сервис `s3`.
//
// ЧЕГО ЗДЕСЬ НЕТ И НЕ НУЖНО: multipart (файлы витрины — десятки килобайт),
// пагинация LIST свыше 1000 ключей обрабатывается, но версионирование, ACL и
// пресайны не поддерживаются осознанно — публикации они не требуются.
//
// БЕЗОПАСНОСТЬ: секрет используется только для вычисления подписи и НИКОГДА не
// попадает в заголовки, URL или лог. Ошибки печатают код ответа и ключ, но не
// тело запроса и не подпись.

import { createHash, createHmac } from "node:crypto";

export interface S3Config {
  /// `https://<accountid>.r2.cloudflarestorage.com`
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /// У R2 всегда "auto"; параметр есть ради совместимости с обычным S3.
  region?: string;
}

const hash = (data: string | Buffer): string =>
  createHash("sha256").update(data).digest("hex");

const hmac = (key: Buffer | string, data: string): Buffer =>
  createHmac("sha256", key).update(data).digest();

/// Кодирование сегмента пути по правилам AWS: encodeURIComponent плюс символы,
/// которые он оставляет как есть, а подпись требует закодированными. Слеши
/// сохраняются — ключ объекта иерархический (`f1/2026/standings.json`).
export function encodeKey(key: string): string {
  return key
    .split("/")
    .map((seg) =>
      encodeURIComponent(seg).replace(/[!'()*]/g, (c) =>
        `%${c.charCodeAt(0).toString(16).toUpperCase()}`))
    .join("/");
}

/// Канонический запрос и подпись по спецификации AWS SigV4. Вынесено отдельно
/// от отправки, потому что это единственная часть, которую можно проверить
/// тестом без сети.
export function signRequest(
  cfg: S3Config,
  method: string,
  path: string,
  query: Record<string, string>,
  payload: Buffer,
  now: Date,
): Record<string, string> {
  const region = cfg.region ?? "auto";
  const host = new URL(cfg.endpoint).host;
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = hash(payload);

  // Параметры запроса в каноническом виде — отсортированы по имени.
  const canonicalQuery = Object.keys(query).sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(query[k] ?? "")}`)
    .join("&");

  // Подписываем минимальный набор: host задаёт адресата, две x-amz-* —
  // содержимое и время. Меньше подписанных заголовков — меньше способов
  // разойтись с прокси, больше подписанных смысла не добавляет.
  const headers: Record<string, string> = {
    host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  const signedHeaders = Object.keys(headers).sort().join(";");
  const canonicalHeaders = Object.keys(headers).sort()
    .map((k) => `${k}:${headers[k]}\n`).join("");

  const canonicalRequest = [
    method, path, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash,
  ].join("\n");

  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256", amzDate, scope, hash(canonicalRequest),
  ].join("\n");

  const kDate = hmac(`AWS4${cfg.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, "s3");
  const kSigning = hmac(kService, "aws4_request");
  const signature = hmac(kSigning, stringToSign).toString("hex");

  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

async function call(
  cfg: S3Config, method: string, path: string,
  query: Record<string, string> = {}, payload: Buffer = Buffer.alloc(0),
): Promise<{ status: number; text: string }> {
  const headers = signRequest(cfg, method, path, query, payload, new Date());
  const qs = Object.keys(query).sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(query[k] ?? "")}`)
    .join("&");
  const url = `${cfg.endpoint.replace(/\/$/, "")}${path}${qs ? `?${qs}` : ""}`;
  const res = await fetch(url, {
    method,
    headers,
    // Uint8Array, а не Buffer: типы fetch не принимают Buffer напрямую,
    // хотя рантайм с ним работает — приведение снимает расхождение.
    body: method === "GET" || method === "HEAD" ? undefined : new Uint8Array(payload),
  });
  return { status: res.status, text: await res.text() };
}

export interface RemoteObject { key: string; etag: string; size: number }

/// Полный список объектов бакета (ListObjectsV2 с продолжением). Витрина —
/// сотни ключей, но пагинация обязана быть: молчаливая обрезка на 1000 дала бы
/// «файла нет» и лишнюю перезаливку, а при удалении — осиротевшие объекты.
export async function listObjects(cfg: S3Config, prefix = ""): Promise<RemoteObject[]> {
  const out: RemoteObject[] = [];
  let token: string | undefined;
  do {
    const query: Record<string, string> = { "list-type": "2", "max-keys": "1000" };
    if (prefix) query.prefix = prefix;
    if (token) query["continuation-token"] = token;
    const r = await call(cfg, "GET", `/${cfg.bucket}`, query);
    if (r.status !== 200) throw new Error(`LIST: код ${r.status}`);
    for (const m of r.text.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const body = m[1] ?? "";
      const key = /<Key>([\s\S]*?)<\/Key>/.exec(body)?.[1];
      if (!key) continue;
      out.push({
        key,
        etag: (/<ETag>"?([^"<]*)"?<\/ETag>/.exec(body)?.[1] ?? "").trim(),
        size: Number(/<Size>(\d+)<\/Size>/.exec(body)?.[1] ?? 0),
      });
    }
    token = /<IsTruncated>true<\/IsTruncated>/.test(r.text)
      ? /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(r.text)?.[1]
      : undefined;
  } while (token);
  return out;
}

export async function putObject(
  cfg: S3Config, key: string, body: Buffer, contentType: string,
): Promise<void> {
  const headers = signRequest(cfg, "PUT", `/${cfg.bucket}/${encodeKey(key)}`, {}, body, new Date());
  const url = `${cfg.endpoint.replace(/\/$/, "")}/${cfg.bucket}/${encodeKey(key)}`;
  const res = await fetch(url, {
    method: "PUT",
    headers: { ...headers, "content-type": contentType },
    body: new Uint8Array(body),
  });
  // Тело ответа в текст ошибки не кладём: у S3 оно может содержать эхо
  // заголовков запроса.
  if (res.status < 200 || res.status >= 300) throw new Error(`PUT ${key}: код ${res.status}`);
}

export async function deleteObject(cfg: S3Config, key: string): Promise<void> {
  const r = await call(cfg, "DELETE", `/${cfg.bucket}/${encodeKey(key)}`);
  // 404 — уже нет, это успех идемпотентного удаления.
  if (r.status !== 204 && r.status !== 200 && r.status !== 404) {
    throw new Error(`DELETE ${key}: код ${r.status}`);
  }
}

/// MD5 в hex — форма, в которой S3 отдаёт ETag для непартированных объектов.
/// Нужна, чтобы не перезаливать неизменившиеся файлы: витрина переписывается
/// каждые 15 минут, а меняется в ней десяток файлов из шестисот.
export function etagOf(body: Buffer): string {
  return createHash("md5").update(body).digest("hex");
}
