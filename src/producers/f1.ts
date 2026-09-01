// Зеркало F1 (Jolpica/Ergast) — кэширующий прокси. Тянет ТЕ ЖЕ URL, что
// приложение, и кладёт JSON-ответы как есть под mirror-путь f1/jolpica/<slug>.
// Приложение (SnapshotMirror.jolpicaPath) читает их первым, при промахе — прямой
// Jolpica. «current» — алиас Jolpica для активного сезона; храним под ним же,
// чтобы ключи совпали без знания года. Детали протокола — src/openf1.ts.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { isFrozen } from "../lib/freeze.js";
import { mirrorSlug, writeIfChanged } from "../lib/mirror.js";
import { fetchTextRetry } from "../lib/http.js";
import { JOLPICA } from "../lib/sources.js";

const NOW = Date.now();

const YEAR = Number(process.env.SEASON ?? new Date().getUTCFullYear());
const OUT_DIR = join(process.cwd(), "data", "f1", "jolpica");

// Год-именованный эквивалент «current»-алиаса: тот же ответ доступен у Jolpica
// и по явному сезонному пути (current.json ≡ 2026.json, current/driverStandings
// ≡ 2026/driverStandings и т.д.). Сезон — из САМОГО ответа, не из часов.
// null — у пути нет годового эквивалента или сезона нет.
export function yearEquivalent(relative: string, json: any): string | null {
  const mr = json?.MRData;
  // DriverTable — заявка сезона (drivers.json): свою таблицу она называет
  // иначе, и без неё годовая копия не писалась вовсе.
  const season = mr?.RaceTable?.season ?? mr?.StandingsTable?.season ?? mr?.DriverTable?.season;
  if (!season) return null;
  if (relative === "current.json") return `${season}.json`;
  // current/last/results: год-именованный ключ теперь пишут пер-раундовые
  // слайсы (writeRoundResultSlices) — они кроют ВСЕ раунды, включая последний;
  // двойной владелец одного ключа дёргал бы файл каждый прогон.
  if (relative === "current/last/results.json") return null;
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
  // Ретрай на 429/5xx: разовый блип Jolpica не должен ронять прогон
  // (exit 1 на current.json шлёт владельцу алерт-письмо).
  const res = await fetchTextRetry(`${JOLPICA}/${relative}`, { attempts: 3, backoffMs: 5000 });
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
// Возвращает СКЛЕЕННЫЙ список гонок всех страниц (для пер-раундовых слайсов).
async function mirrorPaginated(pathBase: string): Promise<any[]> {
  let offset = 0;
  const all: any[] = [];
  while (true) {
    const json = await mirror(`${pathBase}?limit=100&offset=${offset}`);
    const total = Number(json?.MRData?.total ?? 0);
    const races = json?.MRData?.RaceTable?.Races ?? [];
    all.push(...races);
    if (!json || races.length === 0 || offset + 100 >= total) break;
    offset += 100;
  }
  return all;
}

// Пер-раундовые файлы <season>/<round>/results.json из уже скачанной
// пагинации (ноль лишних запросов). Раньше год-именованная копия была только
// у current/last/results — mirror-первый лукап результатов раундов 1..N-1
// всегда промахивался и уходил в live Jolpica. Строки одного раунда могут
// быть разнесены по страницам (лимит режет посреди гонки) — поэтому клеим по
// round из полного списка. Конверт — как у настоящего эндпоинта Jolpica.
function writeRoundResultSlices(allRaces: any[]): number {
  const byRound = new Map<string, any[]>();
  for (const race of allRaces) {
    const round = String(race?.round ?? "");
    if (!round) continue;
    const bucket = byRound.get(round) ?? [];
    // одна запись раунда на страницу; клеим Results
    if (bucket.length > 0) {
      bucket[0].Results = [...(bucket[0].Results ?? []), ...(race.Results ?? [])];
    } else {
      bucket.push(JSON.parse(JSON.stringify(race)));
    }
    byRound.set(round, bucket);
  }
  let written = 0;
  for (const [round, races] of byRound) {
    const season = String(races[0]?.season ?? YEAR);
    const payload = {
      MRData: {
        total: String(races[0]?.Results?.length ?? 0),
        RaceTable: { season, round, Races: races },
      },
    };
    const rel = `${season}/${round}/results.json`;
    if (writeIfChanged(join(OUT_DIR, mirrorSlug(rel)), JSON.stringify(payload)))
      written++;
  }
  return written;
}

/// Исторический сезон (SEASON < текущего): «current»-алиасов у него нет,
/// поэтому зеркалим явные year-пути — ровно те, что запрашивает приложение
/// при выборе прошлого сезона в календаре. Прогон разовый: сезон закрыт,
/// результаты и зачёты уже не меняются, поэтому существующие файлы не
/// перекачиваем (write-once).
async function historicSeason(): Promise<void> {
  console.log(`F1 mirror, season ${YEAR} (historic backfill)`);
  const schedule = await mirror(`${YEAR}.json`);
  if (!schedule) {
    console.error(`Jolpica ${YEAR}.json недоступен — весь прогон бесполезен`);
    process.exit(1);
  }
  await mirror(`${YEAR}/driverStandings.json`);
  await mirror(`${YEAR}/constructorStandings.json`);
  await mirror(`${YEAR}/drivers.json?limit=100`);   // заявка сезона, см. выше
  const allResults = await mirrorPaginated(`${YEAR}/results.json`);
  const slices = writeRoundResultSlices(allResults);
  if (slices > 0) console.log(`  round slices updated: ${slices}`);
  await mirrorPaginated(`${YEAR}/sprint.json`);

  const races = schedule?.MRData?.RaceTable?.Races ?? [];
  for (const race of races) {
    const round = String(race.round ?? "");
    if (!round) continue;
    const rel = `${YEAR}/${round}.json`;
    if (existsSync(join(OUT_DIR, mirrorSlug(rel)))) continue;   // сезон закрыт — не перекачиваем
    await mirror(rel);
  }
  console.log(`Done (historic). ${races.length} rounds.`);
}

// Будущий сезон (ежесуточный N+1-проход крона): зеркалим ТОЛЬКО опубликованный
// календарь. Непустой <N+1>.json в зеркале — рычаг открытия года в приложении
// (mirror-first проба переключателя сезонов). Пустой ответ сознательно НЕ
// пишем: пустышка в зеркале перехватывала бы mirror-first и прятала живую
// публикацию jolpica до следующего суточного прогона.
async function futureSeason(): Promise<void> {
  console.log(`F1 mirror, season ${YEAR} (future)`);
  const res = await fetchTextRetry(`${JOLPICA}/${YEAR}.json`, { attempts: 3, backoffMs: 5000 });
  if (!res || res.status !== 200) {
    console.log(`  MISS  ${YEAR}.json (${res?.status ?? "net"})`);
    return;
  }
  let races = 0;
  try {
    races = Number(JSON.parse(res.text)?.MRData?.total ?? 0);
  } catch { /* не-JSON — считаем неопубликованным */ }
  if (races === 0) {
    console.log(`  ${YEAR}.json пуст — календарь ещё не опубликован`);
    return;
  }
  const changed = writeIfChanged(join(OUT_DIR, mirrorSlug(`${YEAR}.json`)), res.text);
  console.log(`  ${changed ? "write" : "same "} ${YEAR}.json — сезон опубликован (${races} гонок)`);
}

async function main() {
  const current = new Date().getUTCFullYear();
  if (YEAR < current) return historicSeason();
  if (YEAR > current) return futureSeason();

  console.log(`F1 mirror, season ${YEAR}`);

  // Расписание — источник списка раундов. null → полный отказ Jolpica: валим
  // прогон (exit 1), иначе продьюсер завершится «success» при пустом зеркале и
  // алерт-гейт/health.json промолчат при реальном аутэйдже.
  const schedule = await mirror("current.json");
  if (!schedule) {
    console.error("Jolpica current.json недоступен — весь прогон бесполезен");
    process.exit(1);
  }
  await mirror("current/last/results.json");
  await mirror("current/driverStandings.json");
  await mirror("current/constructorStandings.json");
  // ЗАЯВКА сезона — не зачёт. Разница принципиальная: зачёт несёт только тех,
  // кто набирал очки, а заявка — всех допущенных, включая резервистов и
  // пилотов пятничных сессий. Именно её не хватало, чтобы разрезолвить
  // протоколы (2026: 32 в заявке против 23 в зачёте). limit — потому что по
  // умолчанию ручка отдаёт 30, а заявка 2025 из 36 человек.
  await mirror("current/drivers.json?limit=100");

  // Все результаты гонок и спринтов сезона (пагинация) + пер-раундовые слайсы.
  const allResults = await mirrorPaginated("current/results.json");
  const slices = writeRoundResultSlices(allResults);
  if (slices > 0) console.log(`  round slices updated: ${slices}`);
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
