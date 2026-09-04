// Продьюсер наград DHL Fastest Pit Stop — data/f1/pitawards/<сезон>.json.
//
// РУЧНОЙ, в кроне CI его нет (см. шапку lib/pitawards.ts: FOM-класс риска +
// 403 из GitHub Actions). Запуск владельцем локально после этапа:
//   npm run f1pitawards            # текущий сезон
//   SEASON=2025 npm run f1pitawards
// Дальше данные едут обычным путём: f1beasts на очередном прогоне подберёт
// файл фолбэком для раундов, где openf1 не отдал stop_duration.
//
// Предохранители — по прецедентам витрины:
// - сезон отстоялся (frozen у витрины календаря) и файл на месте — пропуск;
// - разбор дал МЕНЬШЕ строк, чем лежит (смена разметки страницы, обрезанный
//   ответ) — kept-previous, а не тихая перезапись хорошего плохим;
// - не-200 (403 CI, антибот) — предупреждение и выход 0: зеркало прежнее.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeJSONWithEnvelope } from "../lib/mirror.js";
import {
  PITAWARDS_SCHEMA_VERSION, extractPitAwards, pitAwardsPath, readPitAwards,
} from "../lib/pitawards.js";

const YEAR = Number(process.env.SEASON ?? new Date().getUTCFullYear());
const ROOT = join(process.cwd(), "data");

// Браузерный UA: страница публичная, но фронт FOM режет «голые» клиенты.
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

async function main() {
  console.log(`F1 pit awards (DHL), season ${YEAR}`);
  if (YEAR < 2015) {
    console.log("  награда существует с 2015 года — раньше страницы нет, пропуск");
    return;
  }

  const prev = readPitAwards(ROOT, YEAR);
  try {
    const cal = JSON.parse(readFileSync(join(ROOT, "f1", "calendar", `${YEAR}.json`), "utf8"));
    if (cal?.frozen && prev) {
      console.log("  сезон отстоялся и файл на месте — пересъём не нужен");
      return;
    }
  } catch { /* витрины календаря нет — гейт не мешает съёму */ }

  const url = `https://www.formula1.com/en/results/${YEAR}/awards/fastest-pit-stops`;
  const res = await fetch(url, { headers: { "user-agent": UA } });
  if (!res.ok) {
    console.warn(`::warning::f1pitawards: ${res.status} от formula1.com — пропуск, файл прежний`);
    return;
  }
  const rows = extractPitAwards(await res.text());
  console.log(`  извлечено строк: ${rows.length}`);

  if (prev && rows.length < prev.rows.length) {
    console.warn(`::warning::f1pitawards: строк меньше прежнего (${rows.length} < ` +
      `${prev.rows.length}) — разметка страницы сменилась? Оставляем предыдущий файл`);
    return;
  }
  if (rows.length === 0) {
    console.log("  строк нет (сезон ещё не стартовал?) — файл не пишем");
    return;
  }

  const changed = writeJSONWithEnvelope(
    pitAwardsPath(ROOT, YEAR), { season: YEAR, rows }, PITAWARDS_SCHEMA_VERSION);
  console.log(`  ${changed ? "записано" : "без изменений"}: ` +
    rows.map((r) => `${r.event} ${r.seconds}`).join(", "));
  console.log("Done.");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
