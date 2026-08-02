// Общий слой кэширующего прокси: тянем upstream-URL и кладём ответ как есть под
// mirror-ключ. Ключ = slug upstream-относительного пути; ИДЕНТИЧЕН приложению
// (SnapshotMirror.slug в Swift) — иначе зеркало не совпадёт.

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";

// non-[A-Za-z0-9.] → одиночный «_», без крайних «_». То же в Swift.
export const mirrorSlug = (relative: string): string =>
  relative.replace(/[^A-Za-z0-9.]+/g, "_").replace(/^_+|_+$/g, "");

// HTTP-слой переехал в http.ts; реэкспорт — чтобы импорты продьюсеров не
// менялись до полного сплита src/.
export { fetchText, UA, type Fetched } from "./http.js";

// Пишем только при изменении (git-чистота). Возвращает true, если записали.
export function writeIfChanged(path: string, content: string): boolean {
  if (existsSync(path) && readFileSync(path, "utf8") === content) return false;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return true;
}

// Запись derived-JSON с конвертом {schemaVersion, generatedAt, ...payload}.
// Сравнение — БЕЗ generatedAt: метка обновляется только когда данные реально
// изменились (иначе каждый прогон дёргал бы все файлы и душил writeIfChanged).
// Раньше конверт был только у imsa-семейства: смена шейпа остальных 12 семейств
// была тихой поломкой клиента без возможности версионирования.
export function writeJSONWithEnvelope(path: string, payload: object, schemaVersion = 1): boolean {
  const body: any = { schemaVersion, ...payload };
  try {
    const existing = JSON.parse(readFileSync(path, "utf8"));
    const a: any = { ...existing };
    delete a.generatedAt;
    if (JSON.stringify(a) === JSON.stringify(body)) return false;
  } catch { /* нет файла или не JSON — пишем */ }
  mkdirSync(dirname(path), { recursive: true });
  const out = { schemaVersion, generatedAt: new Date().toISOString(), ...payload };
  writeFileSync(path, JSON.stringify(out, null, 2) + "\n");
  return true;
}

/// Файл зеркала с расписанием сезона: у текущего это «current»-алиас, у
/// исторического — явный year-путь (его пишет f1.ts в historic-режиме).
export function scheduleMirrorFile(year: number, now: Date = new Date()): string {
  return year < now.getUTCFullYear() ? mirrorSlug(`${year}.json`) : mirrorSlug("current.json");
}
