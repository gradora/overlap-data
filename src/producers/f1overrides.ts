// Курируемый override-календарь F1 (data/f1/overrides/calendar.json): GC
// отживших записей + сборка витрины календаря data/f1/calendar/<год>.json
// (фаза 4 DATA-PLAN) тем же прогоном.
//
// Почему витрина живёт ЗДЕСЬ, а не в f1.ts (нового шага воркфлоу и записи в
// реестре свежести не появляется — только новая ответственность у шага):
//  1) это ЕДИНСТВЕННЫЙ шаг snapshot.yml, который идёт после ВСЕХ трёх входов
//     календаря в одном прогоне (f1 → openf1 → … → f1overrides). Собирай мы
//     внутри f1.ts, зеркало OpenF1 было бы на прогон старше самой сборки:
//     тесты, отмены и новые этапы (класс Sepang-2026) появлялись бы в витрине
//     на час позже, чем в зеркале;
//  2) курируемый слой обязан быть ПОЧИЩЕН до материализации: иначе отжившая
//     запись («прошло»/«переехало») на час въезжает в календарь, а у
//     закрывшегося сезона могла бы ещё и попасть под freeze — навсегда;
//  3) вход overrides/calendar.json и чтение jolpica-зеркала у этого продьюсера
//     уже есть — витрина не добавляет ему ни одного нового источника;
//  4) f1.ts зовут с разными SEASON (ежесуточный проход N+1, ручной бэкфилл
//     архива) — сборка там либо дублировалась бы, либо зависела от того, с
//     каким SEASON её позвали. Здесь прогон ровно один, а сезоны витрина
//     выбирает сама (coveredSeasons).
//
// GC: сама ручка остаётся ручной — продьюсер записи НЕ создаёт и не правит,
// только убирает отжившие. Два правила:
//   1) «прошло» — конец дня гонки + грейс 7 дней позади (симметрия с
//      freeze-окном): событие состоялось или тихо не случилось — фантому
//      в ленте делать нечего;
//   2) «переехало» — в jolpica-зеркале ТОГО ЖЕ сезона есть гонка с тем же
//      circuitId на дне ВНЕ окна дедупа записи (−2…+3 дня вокруг её дня
//      гонки — зеркало клиентского F1CalendarOverride.covers, менять только
//      вместе): дата-дедуп клиента такую запись больше не гасит, и на
//      старой дате воскрес бы фантом-дубль. Записи без circuitId правило
//      пропускает.
// Пока событие не прошло и не переехало, запись живёт погашенной дедупом —
// это страховка от отката источника (jolpica уберёт этап → день
// освободится → клиент снова покажет TBC-фантом).
// Битый JSON — fail-loud (файл правится руками, молча затирать нельзя), но
// падение прогона наступает ПОСЛЕ сборки витрины: одна лишняя запятая в ручном
// файле не имеет права заморозить календарь всех сезонов. Нет файла или пустой
// список — штатный no-op.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildF1CalendarFiles } from "../lib/f1calendar.js";
import { writeIfChanged } from "../lib/mirror.js";

const FILE = join(process.cwd(), "data", "f1", "overrides", "calendar.json");
const JOLPICA_CURRENT = join(process.cwd(), "data", "f1", "jolpica", "current.json");

const DAY_MS = 24 * 60 * 60 * 1000;
/// Грейс после дня гонки — как freeze-окно РЕЗУЛЬТАТОВ (апелляции/правки).
/// Именно результатов: у решений стюардов своё окно, вдвое длиннее (lib/freeze).
export const GRACE_MS = 7 * DAY_MS;

/// Запись ручного файла. Незнакомые поля переживают GC: объекты проходят
/// насквозь и не пересобираются. GC читает отсюда минимум (дата, сезон,
/// circuitId), а витрина календаря — ещё и трассу с местом; полный набор
/// полей описан у структурного двойника lib/f1calendar.F1OverrideEntry
/// (и у клиентского F1CalendarOverride) — менять только вместе.
export interface OverrideEntry {
  season: number;
  round: number;
  date: string;        // YYYY-MM-DD, день гонки
  raceName: string;
  circuitId?: string;  // jolpica circuitId — включает правило «переехало»
}

interface ScheduleRace {
  season: number;
  circuitId?: string;
  date?: string;
}

/// UTC-полночь дня «YYYY-MM-DD»; null — мусорная дата (запись не трогаем).
export function dayMs(date: string | undefined): number | null {
  if (!date) return null;
  const ms = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(ms) ? ms : null;
}

/// Правило «прошло»: конец дня гонки + грейс уже позади.
export function isPast(entry: OverrideEntry, nowMs: number): boolean {
  const ms = dayMs(entry.date);
  return ms != null && ms + DAY_MS + GRACE_MS <= nowMs;
}

/// Правило «переехало»: тот же сезон + тот же circuitId, но день гонки вне
/// окна −2…+3 (day >= anchor−2d && day < anchor+3d — как covers() клиента).
export function isSuperseded(entry: OverrideEntry, schedule: ScheduleRace[]): boolean {
  if (!entry.circuitId) return false;
  const anchor = dayMs(entry.date);
  if (anchor == null) return false;
  const lo = anchor - 2 * DAY_MS;
  const hi = anchor + 3 * DAY_MS;
  return schedule.some((race) => {
    if (race.season !== entry.season || race.circuitId !== entry.circuitId) return false;
    const day = dayMs(race.date);
    return day != null && (day < lo || day >= hi);
  });
}

export interface GCResult {
  kept: OverrideEntry[];
  dropped: { entry: OverrideEntry; reason: "прошло" | "переехало" }[];
}

/// Один проход GC; порядок оставшихся записей сохраняется.
export function collect(
  entries: OverrideEntry[],
  schedule: ScheduleRace[],
  nowMs: number
): GCResult {
  const kept: OverrideEntry[] = [];
  const dropped: GCResult["dropped"] = [];
  for (const entry of entries) {
    if (isPast(entry, nowMs)) dropped.push({ entry, reason: "прошло" });
    else if (isSuperseded(entry, schedule)) dropped.push({ entry, reason: "переехало" });
    else kept.push(entry);
  }
  return { kept, dropped };
}

/// Расписание из jolpica-зеркала на диске (пишет продьюсер f1 тем же
/// прогоном раньше). Нет зеркала/битое — правило «переехало» в этом прогоне
/// просто выключено, правило «прошло» от расписания не зависит.
function readSchedule(): ScheduleRace[] {
  try {
    const d = JSON.parse(readFileSync(JOLPICA_CURRENT, "utf8"));
    const races: any[] = d?.MRData?.RaceTable?.Races ?? [];
    return races.map((r) => ({
      season: Number(r.season),
      circuitId: r.Circuit?.circuitId,
      date: r.date,
    }));
  } catch {
    return [];
  }
}

function main() {
  const ok = gc();
  // Витрина календаря — ПОСЛЕ GC (см. шапку): курируемый слой на диске уже
  // без отживших записей. Сети в сборке нет вовсе, только чтение файлов,
  // поэтому отсутствие override-файла её не отменяет.
  //
  // И битый файл — тоже НЕ отменяет. Fail-loud обязан разбудить владельца, а
  // не взять в заложники все сезоны календаря: раньше gc() выходил из процесса
  // прямо здесь, и одна лишняя запятая в ручном файле замораживала витрину
  // целиком до ручной починки — тихо для приложения и заметно только письмом.
  // Курируемый слой при этом не приедет (чтение витрины к битому файлу
  // fail-open и вернёт пустой список) — это честная деградация одного слоя.
  console.log(buildF1CalendarFiles(Date.now()));
  if (!ok) process.exit(1);
}

/// GC курируемого файла. Битый JSON — fail-loud: файл ручной, молча затирать
/// нельзя. Возвращает false вместо выхода из процесса — прогон обязан упасть,
/// но ПОСЛЕ витрины (см. main).
function gc(): boolean {
  if (!existsSync(FILE)) {
    console.log("override-файла нет — нечего убирать");
    return true;
  }
  let entries: unknown;
  try {
    entries = JSON.parse(readFileSync(FILE, "utf8"));
  } catch (e) {
    console.error(`::error::битый ${FILE}: ${e} — файл ручной, чинить тоже руками`);
    return false;
  }
  if (!Array.isArray(entries)) {
    console.error(`::error::${FILE}: ожидался массив записей`);
    return false;
  }
  const { kept, dropped } = collect(entries as OverrideEntry[], readSchedule(), Date.now());
  for (const { entry, reason } of dropped) {
    console.log(`::notice::override снят (${reason}): ${entry.raceName} ${entry.date}`);
  }
  const changed = writeIfChanged(FILE, JSON.stringify(kept, null, 2) + "\n");
  console.log(changed ? `убрано: ${dropped.length}, осталось: ${kept.length}` : "без изменений");
  return true;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
