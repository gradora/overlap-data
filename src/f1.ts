// Зеркало F1 (Jolpica/Ergast) — кэширующий прокси. Тянет ТЕ ЖЕ URL, что
// приложение, и кладёт JSON-ответы как есть под mirror-путь f1/jolpica/<slug>.
// Приложение (SnapshotMirror.jolpicaPath) читает их первым, при промахе — прямой
// Jolpica. «current» — алиас Jolpica для активного сезона; храним под ним же,
// чтобы ключи совпали без знания года. OpenF1 (детали протокола) — TODO, пока
// приложение падает на прямой OpenF1.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { isFrozen } from "./freeze.js";
import { fetchText, mirrorSlug, writeIfChanged } from "./mirror.js";

const NOW = Date.now();

const YEAR = Number(process.env.SEASON ?? new Date().getUTCFullYear());
const JOLPICA = "https://api.jolpi.ca/ergast/f1";
const OUT_DIR = join(process.cwd(), "data", "f1", "jolpica");

// Тянем Jolpica-относительный путь и кладём под f1/jolpica/<slug>. Возвращает
// распарсенный JSON (для перечисления раундов/пагинации) или null.
async function mirror(relative: string): Promise<any | null> {
  const res = await fetchText(`${JOLPICA}/${relative}`);
  if (!res || res.status !== 200) {
    console.log(`  MISS  ${relative} (${res?.status ?? "net"})`);
    return null;
  }
  const changed = writeIfChanged(join(OUT_DIR, mirrorSlug(relative)), res.text);
  console.log(`  ${changed ? "write" : "same "} ${relative}`);
  try {
    return JSON.parse(res.text);
  } catch {
    return null;
  }
}

// Пагинация results/sprint: offset += 100, пока offset+100 < total. Каждая
// страница — отдельный mirror-файл (приложение запрашивает те же offset'ы).
async function mirrorPaginated(pathBase: string): Promise<void> {
  let offset = 0;
  while (true) {
    const json = await mirror(`${pathBase}?limit=100&offset=${offset}`);
    const total = Number(json?.MRData?.total ?? 0);
    const races = json?.MRData?.RaceTable?.Races ?? [];
    if (!json || races.length === 0 || offset + 100 >= total) break;
    offset += 100;
  }
}

async function main() {
  console.log(`F1 mirror, season ${YEAR}`);

  // Расписание — источник списка раундов.
  const schedule = await mirror("current.json");
  await mirror("current/next.json");
  await mirror("current/last/results.json");
  await mirror("current/driverStandings.json");
  await mirror("current/constructorStandings.json");

  // Все результаты гонок и спринтов сезона (пагинация).
  await mirrorPaginated("current/results.json");
  await mirrorPaginated("current/sprint.json");

  // Времена сессий по каждому раунду. Агрегаты выше (results/standings) тянем
  // всегда — они меняются штрафами/апелляциями (это и есть штраф-безопасность).
  // А per-round времена сессий неизменны → морозим после 7д от дня гонки.
  const races = schedule?.MRData?.RaceTable?.Races ?? [];
  for (const race of races) {
    const season = String(race.season ?? YEAR);
    const round = String(race.round ?? "");
    if (!round) continue;
    const rel = `${season}/${round}.json`;
    const frozen = race.date && isFrozen(Date.parse(`${race.date}T23:59:59Z`), NOW) &&
      existsSync(join(OUT_DIR, mirrorSlug(rel)));
    if (frozen) continue;
    await mirror(rel);
  }

  console.log(`Done. ${races.length} rounds.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
