// Проактивный снапшот статического архива FOM live timing (шаг 5.4 DATA-PLAN).
//
// `https://livetiming.formula1.com/static/` — публичный архив без авторизации:
// `<год>/Index.json` перечисляет митинги и сессии, у сессии есть `Path`, а по
// нему лежат срезы `<Topic>.jsonStream` (строки «HH:MM:SS.mmm{json}»).
//
// ПОЧЕМУ ПРОАКТИВНО, а не «когда понадобится». Политика ретенции архива не
// объявлена, и он уже дырявый: 2017 и ВЕСЬ 2022 отдают 403 (проверено
// 27.08.2026 — как и годом раньше при разведке). То есть данные оттуда уже
// теряли. Всё, что не снято сейчас, можно не снять никогда, а восстановить
// неоткуда: это единственный публичный источник погоды, компаундов и
// рейс-контрола за 2018–2021 (OpenF1 начинается с 2023, у Jolpica компаундов
// нет вовсе).
//
// Границы снимка — 2018–2021: 2023+ уже закрыт зеркалом OpenF1, 2017 и 2022
// недоступны. Внутри года берём ЧЕТЫРЕ среза, каждый под конкретный будущий
// продьюсер (см. SLICES) — а не всё подряд: CarData/Position — сотни мегабайт
// телеметрии на сессию, и под них нет ни одной задуманной фичи.
//
// Формат хранения — БАЙТ В БАЙТ как отдаёт источник, под путём самого
// источника (`f1/fom/<Path><Topic>.jsonStream`). Никакого парсинга здесь нет
// СОЗНАТЕЛЬНО: снимок должен пережить любые будущие правки наших парсеров, а
// разбирать строки будет тот продьюсер, которому это понадобится.

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fetchText } from "./http.js";

export const FOM_BASE = "https://livetiming.formula1.com/static/";

/// Годы снимка. 2017 и 2022 недоступны (403) — их в списке нет не по забывчивости.
export const FOM_YEARS = [2018, 2019, 2020, 2021];

/// Срезы и то, ради чего каждый снимается. Список закрытый: расширять — только
/// вместе с продьюсером-потребителем, иначе снимок разрастётся телеметрией.
export const SLICES = [
  /// Погода сессии (AirTemp/TrackTemp/Rainfall/…) — блок weather в файле
  /// события (шаг 5.3) и кейс «мастера дождя». ~15 КБ на сессию.
  "WeatherData",
  /// Стинты и компаунды. У Jolpica компаундов нет ВООБЩЕ, у OpenF1 они с 2023 —
  /// это единственный источник резины 2018–2021. Самый тяжёлый срез, ~70 КБ.
  "TimingAppData",
  /// Сообщения рейс-контрола: машинный пересчёт SC/VSC вместо ручного
  /// курирования каталога сейф-каров.
  "RaceControlMessages",
  /// Время в пит-лейне. Раздельный stop_duration появляется только в 2025 —
  /// за эти годы доступно лишь суммарное время, и другого нет.
  "PitLaneTimeCollection",
] as const;

export type Slice = (typeof SLICES)[number];

export interface FomSession {
  /// Относительный путь сессии, всегда со слэшем на конце:
  /// «2018/2018-04-15_Chinese_Grand_Prix/2018-04-15_Race/».
  path: string;
  meeting: string;
  name: string;
}

/// Путь сессии пригоден к записи на диск.
///
/// Источник отдаёт `Path` как есть, и он бывает КАКИМ УГОДНО: в индексе 2021-го
/// лежит сессия с путём «../uat/static/2022/…_FOM_High_Speed_Track_Test/» —
/// внутренний тестовый прогон, ушедший в индекс по недосмотру. Склеенный с
/// `data/f1/fom/` такой путь пишет ВНЕ каталога снимка, а то и вне `data/`.
/// В тот раз спасло только 403 от источника — полагаться на это нельзя.
///
/// Требуем: без «..» и обратных слэшей, не абсолютный, и первый сегмент —
/// четырёхзначный год. Всё остальное — не наша сессия.
export function isSafeSessionPath(path: string): boolean {
  if (path === "" || path.startsWith("/") || path.includes("\\")) return false;
  if (path.split("/").some((seg) => seg === "..")) return false;
  return /^\d{4}$/.test(path.split("/")[0]);
}

/// Разбор `<год>/Index.json`.
///
/// Файл приходит С BOM — `JSON.parse` на нём падает, поэтому байты чистим ДО
/// разбора. Сессии без `Path` пропускаем молча: в 2018-м их пять, в 2019 и
/// 2021 по одной (у источника нет папки — снимать нечего). Небезопасные пути
/// пропускаем ГРОМКО — это не норма, а сигнал, что источник отдал чужое.
export function parseIndex(raw: string, log?: (m: string) => void): FomSession[] {
  let doc: any;
  try {
    doc = JSON.parse(raw.replace(/^﻿/, ""));
  } catch {
    return [];
  }
  const out: FomSession[] = [];
  for (const meeting of doc?.Meetings ?? []) {
    for (const session of meeting?.Sessions ?? []) {
      if (typeof session?.Path !== "string" || session.Path === "") continue;
      if (!isSafeSessionPath(session.Path)) {
        log?.(`    ПРОПУСК небезопасного пути: ${session.Path}`);
        continue;
      }
      out.push({
        path: session.Path.endsWith("/") ? session.Path : `${session.Path}/`,
        meeting: String(meeting?.Name ?? "?"),
        name: String(session?.Name ?? "?"),
      });
    }
  }
  return out;
}

/// Путь файла снимка ОТНОСИТЕЛЬНО data/. Повторяет путь источника — так снимок
/// самоописателен: по имени файла видно, какая сессия и какой срез.
export function slicePath(session: FomSession, slice: Slice): string {
  return join("f1", "fom", session.path, `${slice}.jsonStream`);
}

/// Чего ещё нет на диске. Именно ОТСУТСТВИЕ, а не устаревание: архив прошлых
/// сезонов не меняется, и перекачивать снятое незачем — прогон обязан быть
/// resume-safe и дешёвым после первого раза.
export function missingSlices(
  dataDir: string, sessions: FomSession[],
): { session: FomSession; slice: Slice }[] {
  const out: { session: FomSession; slice: Slice }[] = [];
  for (const session of sessions) {
    for (const slice of SLICES) {
      if (!existsSync(join(dataDir, slicePath(session, slice)))) out.push({ session, slice });
    }
  }
  return out;
}

export interface FomRunResult {
  fetched: number;
  missing: number;
  failed: number;
  years: number[];
}

/// Один прогон: по каждому году добираем недостающие срезы, но не больше
/// `budget` файлов за раз. Бюджет — не про вежливость к источнику (пауза ниже
/// про неё), а про то, чтобы прогон в CI укладывался в разумное время и
/// коммитил результат порциями: снимок в 1500+ файлов не должен зависеть от
/// того, доживёт ли один джоб до конца.
export async function runFomSnapshot(input: {
  dataDir: string;
  years?: number[];
  budget?: number;
  /// Пауза между запросами. Источник публичный и без rate limit, но полторы
  /// тысячи запросов подряд — повод быть аккуратной.
  delayMs?: number;
  fetch?: (url: string) => Promise<{ status: number; text: string } | null>;
  log?: (message: string) => void;
}): Promise<FomRunResult> {
  const {
    dataDir, years = FOM_YEARS, budget = 400, delayMs = 200,
    fetch = (url: string) => fetchText(url), log = console.log,
  } = input;

  let fetched = 0;
  let failed = 0;
  let missingTotal = 0;

  for (const year of years) {
    const indexRes = await fetch(`${FOM_BASE}${year}/Index.json`);
    if (!indexRes || indexRes.status !== 200) {
      // 403 — это не поломка, а известное состояние архива (2017, 2022).
      log(`  ${year}: индекс недоступен (${indexRes?.status ?? "сеть"}) — пропуск`);
      continue;
    }
    const sessions = parseIndex(indexRes.text, log);
    const missing = missingSlices(dataDir, sessions);
    missingTotal += missing.length;
    log(`  ${year}: сессий ${sessions.length}, недостаёт срезов ${missing.length}`);

    for (const { session, slice } of missing) {
      if (fetched >= budget) break;
      const res = await fetch(`${FOM_BASE}${session.path}${slice}.jsonStream`);
      if (!res || res.status !== 200 || res.text === "") {
        failed++;
        log(`    MISS ${slice} ${session.path} (${res?.status ?? "сеть"})`);
      } else {
        const target = join(dataDir, slicePath(session, slice));
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, res.text);
        fetched++;
      }
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    }
    if (fetched >= budget) {
      log(`  бюджет ${budget} файлов исчерпан — остальное доберёт следующий прогон`);
      break;
    }
  }
  return { fetched, missing: missingTotal, failed, years };
}

/// Сколько срезов уже лежит на диске — для лога и для маркера свежести.
export function snapshotSize(dataDir: string): number {
  const root = join(dataDir, "f1", "fom");
  if (!existsSync(root)) return 0;
  let n = 0;
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) walk(p);
      else n++;
    }
  };
  walk(root);
  return n;
}

/// Прочитанный файл снимка (для будущих продьюсеров и тестов).
export function readSlice(dataDir: string, session: FomSession, slice: Slice): string | null {
  const p = join(dataDir, slicePath(session, slice));
  return existsSync(p) ? readFileSync(p, "utf8") : null;
}
