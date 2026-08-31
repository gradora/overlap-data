// РАЗОВЫЙ конвертер: сохранённое зеркало HTML fiawec → слой фактов.
//
// Запуск: npx tsx scripts/wec-html-to-facts.ts
//
// В бою этого кода не будет: продьюсер извлекает факты в момент записи, и путь
// страницы известен ему на месте вызова. Здесь путь приходится ВОССТАНАВЛИВАТЬ
// из имени файла, а `mirrorSlug` необратим — «не-алфанум → _» стирает разницу
// между дефисом и слэшем. Поэтому слаги берутся не из имени, а со страниц
// сезонов: они и есть источник истины о составе.
//
// После прогона:
//   1. сверить, что витрина не сдвинулась (git diff data/wec/<год> пуст);
//   2. удалить data/wec/fiawec;
//   3. вычистить его из истории — см. github-history-rewrite-limits.

import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { mirrorSlug } from "../src/lib/mirror.js";
import { raceSlugs, testSlugs } from "../src/lib/fiawecsite.js";
import { extractFacts } from "../src/lib/wecextract.js";
import {
  wecFactsDir, wecRacePath, wecResultsPath, wecSeasonPath, wecSessionsPath,
  wecStandingsPath, writeFacts,
} from "../src/lib/wecfacts.js";

const DATA_DIR = join(process.cwd(), "data");
const MIRROR_DIR = join(DATA_DIR, "wec", "fiawec");

if (!existsSync(MIRROR_DIR)) {
  console.error(`нет каталога зеркала ${MIRROR_DIR} — конвертировать нечего`);
  process.exit(1);
}

const files = readdirSync(MIRROR_DIR);
const html = (f: string) => readFileSync(join(MIRROR_DIR, f), "utf8");

/// Слаги всех сезонов, чьи страницы есть в зеркале: имя файла страницы события
/// восстанавливается только через них.
const slugByFile = new Map<string, string>();
for (const f of files) {
  const m = /^en_season_(\d{4})$/.exec(f);
  if (!m) continue;
  const year = Number(m[1]);
  for (const slug of [...raceSlugs(html(f), year), ...testSlugs(html(f), year)]) {
    slugByFile.set(mirrorSlug(wecRacePath(slug)), slug);
  }
}
console.log(`страниц сезонов: ${[...files].filter((f) => /^en_season_/.test(f)).length}, ` +
  `известных слагов: ${slugByFile.size}`);

/// Путь источника по имени файла зеркала, или null — если страницу мы больше
/// не храним (индекс результатов) либо имя не опознано.
function pathOf(file: string): string | null {
  let m = /^en_season_(\d{4})$/.exec(file);
  if (m) return wecSeasonPath(Number(m[1]));
  if (file === "en_page_manufacturers_classification") return wecStandingsPath();
  m = /^en_page_resultats_1_raceId_(\d+)_sessionId_(\d+)$/.exec(file);
  if (m) return wecResultsPath(Number(m[1]), Number(m[2]));
  m = /^en_page_resultats_1_raceId_(\d+)$/.exec(file);
  if (m) return wecSessionsPath(Number(m[1]));
  const slug = slugByFile.get(file);
  if (slug) return wecRacePath(slug);
  return null;
}

let written = 0, same = 0, skipped = 0, empty = 0;
const unknown: string[] = [];
for (const f of files) {
  const path = pathOf(f);
  if (!path) {
    if (f === "en_page_resultats_1") { skipped++; continue; } // читателей нет
    unknown.push(f);
    continue;
  }
  const facts = extractFacts(path, html(f));
  if (!facts) { skipped++; continue; }
  // Протокол без строк не переносим: пустой факт неотличим от «сессии ещё не
  // было», а продьюсер такие и не пишет — иначе конверсия завела бы файлы,
  // которых боевой прогон никогда бы не создал.
  if (facts.kind === "results" && facts.rows.length === 0) { empty++; continue; }
  if (writeFacts(DATA_DIR, path, facts)) written++; else same++;
}

console.log(`факты: записано ${written}, без изменений ${same}, ` +
  `пропущено ${skipped} (без читателей), пустых протоколов ${empty}`);
if (unknown.length) {
  console.error(`НЕ ОПОЗНАНО ${unknown.length} файлов — конверсия неполная:`);
  for (const f of unknown) console.error(`  ${f}`);
  process.exit(1);
}

const before = readdirSync(MIRROR_DIR).length;
const after = readdirSync(wecFactsDir(DATA_DIR)).length;
const size = (dir: string) => readdirSync(dir)
  .reduce((n, f) => n + readFileSync(join(dir, f)).length, 0);
console.log(`было ${before} файлов / ${(size(MIRROR_DIR) / 1e6).toFixed(2)} МБ, ` +
  `стало ${after} / ${(size(wecFactsDir(DATA_DIR)) / 1e6).toFixed(2)} МБ`);

if (process.env.WEC_DROP_MIRROR === "1") {
  rmSync(MIRROR_DIR, { recursive: true });
  console.log("зеркало HTML удалено");
}
