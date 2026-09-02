// Погода WEC/IMSA из CSV Al Kamel — шаг 5.6 DATA-PLAN, по образцу f1/weather.
//
// Источник — те же деревья событий alkamelsystems, что уже качают хайлайты:
// новой поверхности скрейпа НЕ появляется. В каждой сессии лежит
// `NN_Weather_<Session>.CSV` с абсолютным временем (TIME_UTC_SECONDS) и теми
// же сенсорами, что у OpenF1: воздух, полотно, влажность, давление, ветер.
// Юниты объявлены КОЛОНКАМИ (ºC/ºF, KPH/MPH, mbar) — конверсия по ним, а не
// по серии: доверять «WEC метрический» нельзя, макет общий с IMSA.
//
// Колонка RAIN у Al Kamel — известно непригодная (план 5.6): на дождевых
// сессиях остаётся нулём. rain поэтому ПУСТ, а wetShare/wet в summary — это
// артефакт общего типа (0/false) и НЕ означает «сухо»: клиент, подключая
// WEC/IMSA-погоду, обязан не рендерить дождевые поля у source=alkamel.
//
// Ключ файла — id события витрины (`wec-2026-<slug>`), как у f1/weather:
// совпадает с CalendarItem.id и eventKey посимвольно.

import { join } from "node:path";
import { writeJSONWithEnvelope } from "./mirror.js";
import { readPrev } from "./f1calendar.js";
import {
  RANGES, WEATHER_SCHEMA_VERSION, summarize, summarizeEvent,
  type WeatherDoc, type WeatherSamples, type WeatherSession,
} from "./weather.js";

/// Версия разбора Al Kamel — независимая от openf1-парсера.
export const AK_WEATHER_PARSER_VERSION = 1;

export interface AkWeatherRow {
  TIME_UTC_SECONDS?: string;
  AIR_TEMP?: string; TRACK_TEMP?: string; HUMIDITY?: string;
  PRESSURE?: string; WIND_SPEED?: string; WIND_DIRECTION?: string;
  AIR_TEMP_UNIT?: string; TRACK_TEMP_UNIT?: string; PRESSURE_UNIT?: string;
  WIND_SPEED_UNIT?: string;
}

const num = (v: string | undefined): number | null => {
  if (v == null || v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const c = (v: number | null, unit?: string): number | null =>
  v === null ? null : /f/i.test(unit ?? "") ? (v - 32) * 5 / 9 : v;
const kmh = (v: number | null, unit?: string): number | null =>
  v === null ? null : /mph/i.test(unit ?? "") ? v * 1.609344 : v;

/// Имперский ли макет. У WEC юниты объявлены колонками; у IMSA юнит-колонок
/// НЕТ ВООБЩЕ, а значения имперские (замерено: воздух 62°F, давление
/// 30.1 inHg). Признак — давление: диапазоны inHg (25…35) и mbar (900…1100)
/// не пересекаются, температура так не отличается (30° бывает в обоих мирах).
export function looksImperial(rows: AkWeatherRow[]): boolean {
  for (const row of rows) {
    const p = num(row.PRESSURE);
    if (p !== null) return p > 20 && p < 40;
  }
  return false;
}

const INHG_TO_HPA = 33.8639;
/// Конверсия рождает хвосты (28.611099…°C из 83.5°F) — сенсорной точности
/// выше 0.1 у источника нет, а веса и диффа хвосты добавляют.
const r1 = (v: number | null): number | null =>
  v === null ? null : Math.round(v * 10) / 10;

/// Ряды CSV → выборки в осях f1/weather. Значения вне физических диапазонов
/// (RANGES) отбрасываются ДО записи — как у openf1-нормализатора.
export function normalizeAlKamel(rows: AkWeatherRow[]): WeatherSamples {
  // Явные юнит-колонки побеждают; без них — имперская эвристика на весь файл
  // (набор согласованный: F + inHg + MPH приходят вместе).
  const imperial = looksImperial(rows);
  const unitOr = (explicit: string | undefined, imp: string) => explicit ?? (imperial ? imp : "");
  const s: WeatherSamples = { t: [], airC: [], trackC: [], humidity: [],
                              pressureHpa: [], windKmh: [], windDeg: [], rain: [] };
  const ok = (v: number | null, r: readonly [number, number]) =>
    v !== null && v >= r[0] && v <= r[1] ? v : null;
  for (const row of rows) {
    const t = num(row.TIME_UTC_SECONDS);
    if (t === null || t <= 0) continue;
    s.t.push(Math.round(t));
    s.airC.push(ok(r1(c(num(row.AIR_TEMP), unitOr(row.AIR_TEMP_UNIT, "F"))), RANGES.airC));
    s.trackC.push(ok(r1(c(num(row.TRACK_TEMP), unitOr(row.TRACK_TEMP_UNIT, "F"))), RANGES.trackC));
    s.humidity.push(ok(num(row.HUMIDITY), RANGES.humidity));
    const rawP = num(row.PRESSURE);
    const hpa = rawP === null ? null
      : /hg/i.test(unitOr(row.PRESSURE_UNIT, imperial ? "inHg" : ""))
        ? rawP * INHG_TO_HPA : rawP;
    s.pressureHpa.push(ok(hpa === null ? null : Math.round(hpa * 10) / 10, RANGES.pressureHpa));
    s.windKmh.push(ok(r1(kmh(num(row.WIND_SPEED), unitOr(row.WIND_SPEED_UNIT, "MPH"))), RANGES.windKmh));
    s.windDeg.push(ok(num(row.WIND_DIRECTION), RANGES.windDeg));
  }
  return s;
}

/// Weather-CSV сессий из дерева события: имя сессии — из каталога
/// `<TS>_<Session>/`, отбираем по последнему часу, как protokольные CSV
/// (у гонки лежат срезы «Hour N» — полный это последний).
export function pickWeatherCsvs(hrefs: string[]): { session: string; href: string }[] {
  const byName = new Map<string, { href: string; hour: number }>();
  for (const h of hrefs) {
    const f = decodeURIComponent(h);
    const file = f.split("/").pop() ?? "";
    if (!f.endsWith(".CSV") || !/^\d+_Weather_/.test(file)) continue;
    const dir = (f.split("/").slice(-2, -1)[0] ?? "").replace(/^\d+_?/, "");
    // Два макета гонки: у 6-часовых срезы «Hour N» лежат ФАЙЛАМИ в каталоге
    // Race; у Ле-Мана — КАТАЛОГАМИ «Hour N» (кумулятивными: Hour 24 несёт всю
    // гонку). Оба сводятся к сессии «Race» с выбором максимального часа.
    const dirHour = dir.match(/^(?:Hour\s+(\d+)|(\d+)H)$/i);
    const session = dirHour ? "Race"
      : dir || file.replace(/^\d+_Weather_/, "").replace(/\.CSV$/, "");
    const hour = Number(dirHour?.[1] ?? dirHour?.[2]
      ?? (file.match(/Hour\s+(\d+)/i) ?? [])[1] ?? 0);
    const prev = byName.get(session);
    if (!prev || hour >= prev.hour) byName.set(session, { href: h, hour });
  }
  // Часовые огрызки старого макета («Race 1», «Race 2») при живой полной
  // гонке — дубли её кусков, не сессии.
  if (byName.has("Race")) {
    for (const k of [...byName.keys()]) if (/^Race \d+$/.test(k)) byName.delete(k);
  }
  return [...byName.entries()].map(([session, v]) => ({ session, href: v.href }));
}

/// Сборка сессии дока из выборок; null — сессия без пригодных отсчётов.
export function akWeatherSession(name: string, samples: WeatherSamples): WeatherSession | null {
  if (samples.t.length === 0) return null;
  return {
    key: name,
    name,
    startedAt: Math.min(...samples.t),
    endedAt: Math.max(...samples.t),
    samples,
    summary: summarize(samples),
  };
}

/// Запись дока события с write-once по `final`: погода прошедшего события не
/// меняется, а протухший Al Kamel-архив не должен перезаписывать снятое.
export function writeAkWeather(
  root: string, series: "wec" | "imsa", doc: WeatherDoc, force = false,
): "written" | "unchanged" | "frozen" {
  const path = join(root, series, "weather", `${doc.eventId}.json`);
  const prev = readPrev<WeatherDoc & { schemaVersion?: number }>(path);
  if (!force && prev?.final && prev.schemaVersion === WEATHER_SCHEMA_VERSION
    && prev.parserVersion === doc.parserVersion) {
    return "frozen";
  }
  return writeJSONWithEnvelope(path, doc, WEATHER_SCHEMA_VERSION)
    ? "written" : "unchanged";
}

export { summarizeEvent };
