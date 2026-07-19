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

// Год-именованный эквивалент «current»-алиаса: тот же ответ доступен у Jolpica
// и по явному сезонному пути (current.json ≡ 2026.json, current/driverStandings
// ≡ 2026/driverStandings и т.д.). Сезон — из САМОГО ответа, не из часов.
// null — у пути нет годового эквивалента (current/next.json) или сезона нет.
export function yearEquivalent(relative: string, json: any): string | null {
  const mr = json?.MRData;
  const season = mr?.RaceTable?.season ?? mr?.StandingsTable?.season;
  if (!season) return null;
  if (relative === "current.json") return `${season}.json`;
  if (relative === "current/next.json") return null; // «next» относителен, не сезонен
  if (relative === "current/last/results.json") {
    const round = mr?.RaceTable?.Races?.[0]?.round;
    return round ? `${season}/${round}/results.json` : null;
  }
  if (relative.startsWith("current/")) return `${season}/${relative.slice("current/".length)}`;
  return null;
}

// Тянем Jolpica-относительный путь и кладём под f1/jolpica/<slug>. Возвращает
// распарсенный JSON (для перечисления раундов/пагинации) или null.
//
// Тот же контент дублируем под слаг годового эквивалента пути: при флипе
// «current» на новый сезон алиасы молча заменяются пустым пред-сезоном, и
// финал прошлого года (стендинги, последняя гонка, полные results) исчезал бы
// из зеркала. Год-именованные копии — это слаги НАСТОЯЩИХ Jolpica-эндпоинтов,
// так что приложение может читать историю mirror-first с живым фолбэком.
async function mirror(relative: string): Promise<any | null> {
  const res = await fetchText(`${JOLPICA}/${relative}`);
  if (!res || res.status !== 200) {
    console.log(`  MISS  ${relative} (${res?.status ?? "net"})`);
    return null;
  }
  const changed = writeIfChanged(join(OUT_DIR, mirrorSlug(relative)), res.text);
  console.log(`  ${changed ? "write" : "same "} ${relative}`);
  let json: any = null;
  try {
    json = JSON.parse(res.text);
  } catch {
    return null;
  }
  const yearly = yearEquivalent(relative, json);
  if (yearly) writeIfChanged(join(OUT_DIR, mirrorSlug(yearly)), res.text);
  return json;
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

  // Расписание — источник списка раундов. null → полный отказ Jolpica: валим
  // прогон (exit 1), иначе продьюсер завершится «success» при пустом зеркале и
  // алерт-гейт/health.json промолчат при реальном аутэйдже.
  const schedule = await mirror("current.json");
  if (!schedule) {
    console.error("Jolpica current.json недоступен — весь прогон бесполезен");
    process.exit(1);
  }
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

// Запуск только как продьюсер (не при импорте из теста).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
