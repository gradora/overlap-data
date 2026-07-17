// Общий слой кэширующего прокси: тянем upstream-URL и кладём ответ как есть под
// mirror-ключ. Ключ = slug upstream-относительного пути; ИДЕНТИЧЕН приложению
// (SnapshotMirror.slug в Swift) — иначе зеркало не совпадёт.

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";

// non-[A-Za-z0-9.] → одиночный «_», без крайних «_». То же в Swift.
export const mirrorSlug = (relative: string): string =>
  relative.replace(/[^A-Za-z0-9.]+/g, "_").replace(/^_+|_+$/g, "");

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15";

export interface Fetched {
  status: number;
  text: string;
}

export async function fetchText(url: string): Promise<Fetched | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA }, signal: ctrl.signal });
    const text = await res.text();
    return { status: res.status, text };
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// Пишем только при изменении (git-чистота). Возвращает true, если записали.
export function writeIfChanged(path: string, content: string): boolean {
  if (existsSync(path) && readFileSync(path, "utf8") === content) return false;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return true;
}
