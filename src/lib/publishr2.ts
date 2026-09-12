// Публикация витрины в объектное хранилище (Cloudflare R2) — замена serve-репо
// для фазы 7b (решение 11.09, docs/roadmap.md §7b).
//
// ЧЕМ ОТЛИЧАЕТСЯ ОТ GIT-ПУБЛИКАЦИИ. Тот шаг клонировал serve-репо на КАЖДОМ
// прогоне (~10 ГБ трафика в месяц) и складывал каждую перезапись в вечную
// историю: промах витрины — вернувшееся имя источника, случайный служебный
// файл — оставался в ней навсегда. Здесь состояние сравнивается по ETag, в
// сеть уходит только изменившееся, а ошибка живёт до следующей перезаписи.
//
// ЧТО ЗАЩИЩЕНО:
//  - состав берётся ТОЛЬКО из манифеста exportserve (границы данных считает
//    databoundary, здесь их не дублируем и не ослабляем);
//  - удаляется лишь то, чего нет в манифесте, и никогда — keep-набор с
//    атрибуциями (Open-Meteo CC-BY — требование правового чеклиста);
//  - отказ любой операции громкий: молча пропущенный файл даёт дыру в витрине,
//    которую по зелёному прогону никто не найдёт.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, type ExportEntry } from "../exportserve.js";
import { deleteObject, etagOf, listObjects, putObject, type S3Config } from "./s3.js";

/// Эти объекты кладёт владелец, а не крон: снести их публикацией значило бы
/// стереть атрибуции источников с публичной раздачи.
const KEEP = new Set(["README.md", "LICENSE", "LICENSE.md", "NOTICE", "NOTICE.md"]);

/// Одновременных запросов. Не «побольше»: R2 отвечает быстро, а витрина —
/// сотни мелких файлов, так что упор идёт в круговые задержки, и восьми хватает,
/// чтобы прогон укладывался в секунды, не рискуя упереться в лимиты аккаунта.
const CONCURRENCY = 8;

export interface PublishResult {
  put: number;
  deleted: number;
  unchanged: number;
}

function contentType(path: string): string {
  if (path.endsWith(".json")) return "application/json; charset=utf-8";
  if (path.endsWith(".md")) return "text/markdown; charset=utf-8";
  return "application/octet-stream";
}

/// Прогнать задачи пулом, сохранив громкость отказа: первая же ошибка
/// доезжает до вызывающего (Promise.all), а не тонет в фоне.
async function pool<T>(items: T[], limit: number, body: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      await body(items[i] as T);
    }
  });
  await Promise.all(workers);
}

export async function publishR2(
  cfg: S3Config, entries: ExportEntry[], dataDir = DATA_DIR,
): Promise<PublishResult> {
  const remote = new Map((await listObjects(cfg)).map((o) => [o.key, o.etag]));
  const wanted = new Set<string>();
  let put = 0;
  let unchanged = 0;

  const files = entries.flatMap((e) => e.files.map((f) => f.path));
  for (const p of files) wanted.add(p);

  await pool(files, CONCURRENCY, async (path) => {
    const body = readFileSync(join(dataDir, path));
    // Сравнение по ETag — то, ради чего хранилище выигрывает у git: витрина
    // перезаписывается каждые 15 минут, а меняется в ней десяток файлов из
    // шестисот. Без этой проверки каждый прогон гнал бы 16 МБ.
    if (remote.get(path) === etagOf(body)) { unchanged++; return; }
    await putObject(cfg, path, body, contentType(path));
    put++;
  });

  const orphans = [...remote.keys()].filter((k) => !wanted.has(k) && !KEEP.has(k));
  await pool(orphans, CONCURRENCY, async (key) => { await deleteObject(cfg, key); });

  return { put, deleted: orphans.length, unchanged };
}

/// Конфиг из окружения. Возвращает null, когда публикация не настроена, —
/// это штатный режим до 7b, а не отказ (ровно как отсутствие SERVE_REPO_URL
/// у git-публикации).
export function r2ConfigFromEnv(env: NodeJS.ProcessEnv = process.env): S3Config | null {
  const endpoint = env.R2_ENDPOINT;
  const bucket = env.R2_BUCKET;
  const accessKeyId = env.R2_ACCESS_KEY_ID;
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY;
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null;
  return { endpoint, bucket, accessKeyId, secretAccessKey };
}
