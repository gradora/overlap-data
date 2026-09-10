// Пострейс-канал питстопов из статики FOM live timing (задача 3a roadmap):
// стационарное время каждого стопа — то, чего у нас больше нет ниоткуда.
//
// ЗАЧЕМ. `stop_duration` приезжал из openf1, и с Канады-2026 его пайплайн
// ломается вразнобой: у 10 сессий сезона поле null у ВСЕХ строк (Канада S+R,
// Монако, Австрия, Британия S+R, Венгрия, Зандворт S+R, Монца). Самолечение
// зеркала их не вылечит никогда — источник эти сессии не дозаполняет.
// Единственным фолбэком был ручной скрейп страницы наград DHL: одна строка на
// этап, только ЛУЧШЕЕ время ЛУЧШЕЙ команды, без пилота и без круга.
//
// Статика FOM отдаёт настоящие стационарные времена ВСЕХ записанных стопов:
//   <Path сессии>PitStopSeries.jsonStream        ← стационарное + пит-лейн
//   <Path сессии>PitLaneTimeCollection.jsonStream ← ВСЕ визиты в пит-лейн
// Сверка 10.09.2026: мультимножества (машина, стационарное) PSS против наших
// pit-фактов совпали 1:1 на Бельгии (28/28) и Майами (19/19), а на Барселоне
// и Китае PSS оказался СТРОГИМ НАДМНОЖЕСТВОМ. То есть это не «другой
// источник», а прямой исходник того, что openf1 перестал считать.
//
// ПОЧЕМУ КРОСС-ЧЕК PLTC ОБЯЗАТЕЛЕН, а не «для страховки». PSS теряет стопы, и
// не единицами: на Венгрии он покрывает 34 визита из 45, на Монако — 32 из 86.
// У «сирот» время в пит-лейне статистически неотличимо от сматченных стопов
// (Венгрия: 21.3–22.6 с при медиане 22.0) — это настоящие стопы, у которых
// источник не записал стационарного. Поэтому визит без пары в PSS не
// выбрасывается, а сохраняется с `stationarySec: null`: «быстрейший стоп»
// такие строки игнорирует, а медиана обязана знать, что она неполна.
//
// ПРАВОВАЯ ГРАНИЦА. Сырьё `.jsonStream` НЕ СОХРАНЯЕТСЯ — разбор в памяти,
// на диск ложатся только ЧИСЛА в нашей форме (машина, круг, секунды, UTC),
// ровно как `wec/facts` заменил 24 МБ HTML. Ни одной строки чужого выражения
// в форме нет по построению, и это держат сторожа `pitstopsFactError`:
// белый список ключей, потолок длины строки, физические диапазоны, потолок
// байтов файла. Писатель на нарушении бросает, а не пропускает молча.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { indexURL, topicURL, type FomSession } from "./fomstatic.js";
import { fetchText, type Fetched } from "./http.js";

export const PITSTOPS_SCHEMA_VERSION = 1;

/// Рычаг пересъёма, как у racecontrol: правка парсера доезжает до уже снятых
/// файлов только через бамп — иначе замороженное событие останется на старой
/// механике навсегда.
export const PITSTOPS_PARSER_VERSION = 1;

/// Топики статики. Первый несёт стационарное время, второй — полноту визитов.
export const TOPIC_PIT_STOP_SERIES = "PitStopSeries";
export const TOPIC_PIT_LANE_TIME = "PitLaneTimeCollection";

// MARK: - Форма факта

/// Тег гоночной сессии в НАШЕМ словаре (тот же, что у f1highlights.raceTag).
export type PitSessionTag = "R" | "SPR";

export interface PitStop {
  /// Номер машины — то же пространство, что `driver_number` openf1, поэтому
  /// джойн с заявкой/протоколом бесплатный.
  car: number;
  /// Круг стопа; null — источник отдал пустую строку (20 случаев за 2026,
  /// все — Австралия, где кругов нет вообще ни у одного стопа).
  lap: number | null;
  /// Стационарное время (машина стоит на домкратах). null — визит известен
  /// только из PitLaneTimeCollection: стоп БЫЛ, времени нет.
  stationarySec: number | null;
  /// Время в пит-лейне целиком (въезд→выезд).
  laneSec: number;
  /// Абсолютный UTC стопа; есть только у строк PitStopSeries.
  at?: string;
}

export interface PitSessionStops {
  tag: PitSessionTag;
  stops: PitStop[];
  /// Визитов в пит-лейн длиннее `LANE_SUSPENDED_SEC` — это не питстопы, а
  /// стоянка под красным флагом (Монца: 21 запись с `Duration ~1840` на 3-м
  /// круге = получасовая остановка гонки). В `stops` они не идут, но и молчать
  /// о них нельзя: иначе счёт визитов не сойдётся ни с чем.
  ///
  /// Оговорка честности: эти же записи ЛЕЖАТ в наших pit-фактах openf1 —
  /// счётчик строк зеркала всегда был замусорен ими.
  suspended: number;
}

export interface EventPitstops {
  /// Ключ файла события витрины — он же имя файла (`f1-2026-monza-1.json`).
  eventKey: string;
  /// `id` события витрины — вход клиентских round-keyed каскадов.
  eventId: string;
  season: number;
  round: number;
  parserVersion: number;
  sessions: PitSessionStops[];
}

// MARK: - Сторожа формы

/// Потолок длины СТРОКОВОГО значения. Единственная строка в форме — ISO-8601
/// с миллисекундами (24 символа) и тег сессии (3); 32 — это она с запасом и
/// вдвое короче любого осмысленного вербатима.
export const PITSTOPS_MAX_STRING = 32;

/// Потолок байтов файла события. Самая густая гонка сезона — Монако (86
/// визитов, ~8 КБ); 64 КБ это ×8 и одновременно отсечка патологического
/// разлива (задублированные кадры, чужое семейство под нашим именем).
export const PITSTOPS_MAX_FILE_BYTES = 64 * 1024;

/// Визит длиннее — остановка гонки, а не питстоп. Порог выбран по замеру:
/// настоящие визиты 2026 укладываются в 12–71 с, а красный флаг даёт
/// 1600–2160 с. Между ними два порядка — граница не спорная.
export const LANE_SUSPENDED_SEC = 120;

/// Физические диапазоны. Стационарное 2.0–67.2 с по всему 2026 (67.2 — стоп
/// Пиастри под красным флагом Монако), пит-лейн 12–71 с.
const STATIONARY_MIN = 0.5;
const STATIONARY_MAX = LANE_SUSPENDED_SEC;
const LANE_MIN = 5;
const LAP_MAX = 200;

const STOP_KEYS = new Set(["car", "lap", "stationarySec", "laneSec", "at"]);
const SESSION_KEYS = new Set(["tag", "stops", "suspended"]);
const DOC_KEYS = new Set([
  "schemaVersion", "generatedAt", "eventKey", "eventId", "season", "round",
  "parserVersion", "sessions",
]);

const isInt = (v: unknown, min: number, max: number): boolean =>
  typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;

const isSec = (v: unknown, min: number, max: number): boolean =>
  typeof v === "number" && Number.isFinite(v) && v > min && v <= max;

const ISO_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

/// Ошибка формы факта, или null. ЧИСТАЯ функция над текстом — её гоняет и
/// писатель перед записью (там нарушение = throw), и тест, обходящий каталог.
/// Одной проверкой ловится «сырьё вернулось» во всех трёх точках.
export function pitstopsFactError(text: string): string | null {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > PITSTOPS_MAX_FILE_BYTES) {
    return `${bytes} байт против потолка ${PITSTOPS_MAX_FILE_BYTES} — патологический разлив`;
  }
  let doc: any;
  try {
    doc = JSON.parse(text);
  } catch {
    return "не JSON";
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return "не объект";
  for (const k of Object.keys(doc)) {
    if (!DOC_KEYS.has(k)) return `посторонний ключ документа «${k}»`;
  }
  if (doc.schemaVersion !== PITSTOPS_SCHEMA_VERSION) return "чужая версия схемы";
  // Оба свободных строковых поля ограничены И по алфавиту, И по длине:
  // без потолка на eventKey регексп пропускал бы вербатим-длины строку из
  // дефисов и цифр (ревью канала протащило такую).
  if (typeof doc.eventKey !== "string" || !/^f1-\d{4}-[a-z0-9-]+$/.test(doc.eventKey)
      || doc.eventKey.length > PITSTOPS_MAX_STRING) {
    return "eventKey не похож на ключ события F1 или длиннее потолка";
  }
  if (typeof doc.eventId !== "string" || !/^[a-z0-9-]+$/.test(doc.eventId)
      || doc.eventId.length > PITSTOPS_MAX_STRING) {
    return "eventId не похож на id витрины или длиннее потолка";
  }
  if (!isInt(doc.season, 2018, 2100)) return "season вне диапазона";
  if (!isInt(doc.round, 0, 40)) return "round вне диапазона";
  if (!isInt(doc.parserVersion, 1, 99)) return "parserVersion вне диапазона";
  if (!Array.isArray(doc.sessions) || doc.sessions.length === 0) {
    return "сессий нет — пустой факт не пишем";
  }
  for (const s of doc.sessions) {
    if (typeof s !== "object" || s === null || Array.isArray(s)) return "сессия — не объект";
    for (const k of Object.keys(s)) {
      if (!SESSION_KEYS.has(k)) return `посторонний ключ сессии «${k}»`;
    }
    if (s.tag !== "R" && s.tag !== "SPR") return `чужой тег сессии «${String(s.tag)}»`;
    if (!isInt(s.suspended, 0, 500)) return "suspended вне диапазона";
    if (!Array.isArray(s.stops)) return "stops — не массив";
    for (const st of s.stops) {
      if (typeof st !== "object" || st === null || Array.isArray(st)) return "стоп — не объект";
      for (const k of Object.keys(st)) {
        if (!STOP_KEYS.has(k)) return `посторонний ключ стопа «${k}»`;
      }
      if (!isInt(st.car, 1, 99)) return `номер машины вне диапазона (${String(st.car)})`;
      if (st.lap !== null && !isInt(st.lap, 1, LAP_MAX)) {
        return `круг вне диапазона (${String(st.lap)})`;
      }
      if (st.stationarySec !== null && !isSec(st.stationarySec, STATIONARY_MIN, STATIONARY_MAX)) {
        return `стационарное время вне диапазона (${String(st.stationarySec)})`;
      }
      if (!isSec(st.laneSec, LANE_MIN, LANE_SUSPENDED_SEC)) {
        return `время в пит-лейне вне диапазона (${String(st.laneSec)})`;
      }
      if (st.at !== undefined && (typeof st.at !== "string" || !ISO_Z.test(st.at))) {
        return `отметка времени не ISO-8601 Z («${String(st.at).slice(0, 40)}»)`;
      }
    }
  }
  return null;
}

// MARK: - Разбор .jsonStream

/// Кадры потока: строки «<offset>{json}», разделитель `\r\n`, BOM в начале
/// файла. Offset — время ОТ СТАРТА ФИДА, а не от старта сессии, и нам не
/// нужен вовсе: у PitStopSeries есть абсолютный `Timestamp`.
///
/// Битая строка пропускается молча: поток обрывается посреди кадра, если
/// сессию сняли на ходу, и терять из-за хвоста весь файл — хуже.
export function streamFrames(text: string): any[] {
  const out: any[] = [];
  for (const line of text.replace(/^﻿/, "").split(/\r?\n/)) {
    const i = line.indexOf("{");
    if (i < 0) continue;
    try {
      out.push(JSON.parse(line.slice(i)));
    } catch { /* оборванный кадр — не повод терять снятое */ }
  }
  return out;
}

/// Сырой стоп PitStopSeries до приведения в нашу форму.
export interface RawStop {
  car: number;
  lap: number | null;
  stationarySec: number;
  laneSec: number;
  at?: string;
}

/// Сырой визит PitLaneTimeCollection.
export interface RawVisit {
  car: number;
  lap: number | null;
  laneSec: number;
}

const numOrNull = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v !== "string" || v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/// Разбор PitStopSeries.
///
/// ГЛАВНАЯ ЛОВУШКА. Кадры инкрементальные, и `PitTimes[car]` — массив,
/// индексируемый ПОРЯДКОВЫМ НОМЕРОМ стопа; но приходит он двумя разными
/// формами: первый стоп машины — полным массивом `[entry]`, следующие —
/// разреженным патчем-объектом `{"1": entry}` с числовым КЛЮЧОМ-ИНДЕКСОМ
/// (Монако-2026, машина 5: кадры `[…]`, `{"1":…}`, `{"2":…}`). Наивный
/// `Array.isArray` роняет парсер на второй форме — проверено.
///
/// Ревизий уже записанного индекса и `_deleted` в этом топике за 2025–2026
/// не встречено ни разу (аудит 74 файлов, 1969 кадров), но мёрдж по индексу
/// их и так переживает: поздний кадр перетирает ранний.
export function parsePitStopSeries(text: string): RawStop[] {
  const byCar = new Map<number, RawStop[]>();
  for (const frame of streamFrames(text)) {
    const times = frame?.PitTimes;
    if (typeof times !== "object" || times === null) continue;
    for (const [carKey, value] of Object.entries<any>(times)) {
      const car = numOrNull(carKey);
      if (car === null || value === null || typeof value !== "object") continue;
      const pairs: [number, any][] = Array.isArray(value)
        ? value.map((e, i) => [i, e])
        : Object.entries(value).map(([k, e]) => [Number(k), e]);
      const bucket = byCar.get(car) ?? [];
      byCar.set(car, bucket);
      for (const [idx, entry] of pairs) {
        if (!Number.isInteger(idx) || idx < 0) continue;
        const p = entry?.PitStop;
        const stationarySec = numOrNull(p?.PitStopTime);
        const laneSec = numOrNull(p?.PitLaneTime);
        if (stationarySec === null || laneSec === null) continue;
        const at = typeof entry?.Timestamp === "string" ? entry.Timestamp : undefined;
        bucket[idx] = {
          car, lap: numOrNull(p?.Lap), stationarySec, laneSec,
          ...(at && ISO_Z.test(at) ? { at } : {}),
        };
      }
    }
  }
  // Разреженный массив (патч пришёл раньше базового кадра) — дырки выкидываем.
  return [...byCar.values()].flatMap((b) => b.filter((x) => x != null));
}

/// Разбор PitLaneTimeCollection. Форма ДРУГАЯ: `PitTimes[car]` — ОДИН объект
/// (не массив), `Duration` = время в пит-лейне, `Timestamp` отсутствует.
/// Ключ `_deleted` («машина покинула пит-лейн») машиной не является и в счёт
/// не идёт.
///
/// Одна машина заезжает в пит-лейн несколько раз за гонку, а кадр держит
/// только последний визит — поэтому визиты копим по КАДРАМ, а не по машинам,
/// и дедуплицируем по (машина, круг, десятые пит-лейна): повтор того же
/// визита в двух кадрах не должен превращаться в два стопа.
export function parsePitLaneTimes(text: string): RawVisit[] {
  const seen = new Set<string>();
  const out: RawVisit[] = [];
  for (const frame of streamFrames(text)) {
    const times = frame?.PitTimes;
    if (typeof times !== "object" || times === null) continue;
    for (const [carKey, value] of Object.entries<any>(times)) {
      if (carKey === "_deleted") continue;
      const car = numOrNull(carKey);
      const laneSec = numOrNull(value?.Duration);
      if (car === null || laneSec === null) continue;
      const lap = numOrNull(value?.Lap);
      const key = `${car}|${lap ?? "-"}|${laneSec.toFixed(1)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ car, lap, laneSec });
    }
  }
  return out;
}

// MARK: - Мёрдж и кросс-чек

/// Допуск сходимости времён пит-лейна двух топиков. PSS печатает три знака
/// («31.197»), PLTC — один («31.1»), то есть расхождение округления до 0.1;
/// 0.6 покрывает его с запасом и при этом вчетверо меньше разброса между
/// СОСЕДНИМИ визитами одной машины.
const LANE_TOLERANCE = 0.6;

/// Сшивка двух топиков в один список стопов сессии.
///
/// Несущая — PitStopSeries: только у неё есть стационарное время. Дальше
/// каждый визит PitLaneTimeCollection пытается найти СВОЮ строку в PSS —
/// сначала по (машина, круг), потом по сходимости времени пит-лейна; кто пары
/// не нашёл, тот и есть потерянный источником стоп, и он идёт в выдачу с
/// `stationarySec: null`. Каждая строка PSS расходуется не более одного раза,
/// иначе двухстоповая гонка схлопывала бы визиты одной машины в один.
export function mergePitStops(
  pss: RawStop[], visits: RawVisit[],
): { stops: PitStop[]; suspended: number } {
  const used = new Array<boolean>(pss.length).fill(false);

  const claim = (v: RawVisit, byLap: boolean): boolean => {
    for (let i = 0; i < pss.length; i++) {
      if (used[i] || pss[i].car !== v.car) continue;
      const hit = byLap
        ? v.lap !== null && pss[i].lap === v.lap
        : Math.abs(pss[i].laneSec - v.laneSec) <= LANE_TOLERANCE;
      if (hit) { used[i] = true; return true; }
    }
    return false;
  };

  // Два прохода: сперва ВСЕ точные совпадения по кругу, потом уже допуск по
  // времени. Одним проходом визит с известным кругом мог бы «съесть» чужую
  // строку по допуску раньше, чем до неё дойдёт её законный владелец.
  const orphans: RawVisit[] = [];
  const pending = visits.filter((v) => !claim(v, true));
  for (const v of pending) if (!claim(v, false)) orphans.push(v);

  const stops: PitStop[] = [];
  let suspended = 0;
  const push = (s: PitStop) => {
    if (s.laneSec > LANE_SUSPENDED_SEC) { suspended++; return; }
    stops.push(s);
  };
  for (const s of pss) push({ ...s });
  for (const v of orphans) {
    push({ car: v.car, lap: v.lap, stationarySec: null, laneSec: v.laneSec });
  }

  // Порядок детерминированный (круг → машина → пит-лейн): writeIfChanged
  // сравнивает текст, и «тот же факт в другом порядке» дёргал бы git каждый
  // прогон. Стоп без круга идёт первым — сортировать его нечем.
  stops.sort((a, b) =>
    (a.lap ?? -1) - (b.lap ?? -1) || a.car - b.car || a.laneSec - b.laneSec);
  return { stops, suspended };
}

/// «Race» → R, «Sprint» → SPR; всё остальное — null. Идёт по `Session.Name`
/// индекса, а не по `Type`: у спринта Type тоже «Race» (см. FomSession.type).
export function pitSessionTag(name: string): PitSessionTag | null {
  const n = name.toLowerCase();
  if (n.includes("qual") || n.includes("shootout")) return null;
  if (n.includes("sprint")) return "SPR";
  if (n.includes("race")) return "R";
  return null;
}

/// Гоночные сессии митинга по индексу сезона, в порядке спринт→гонка.
export function raceSessionsOf(sessions: FomSession[], meetingKey: number):
  { session: FomSession; tag: PitSessionTag }[] {
  return sessions
    .filter((s) => s.meetingKey === meetingKey && s.type === "Race")
    .map((s) => ({ session: s, tag: pitSessionTag(s.name) }))
    .filter((x): x is { session: FomSession; tag: PitSessionTag } => x.tag !== null);
}

// MARK: - Сеть

export interface FomFetch {
  (url: string): Promise<Fetched | null>;
}

/// Индекс сезона. null — источник отдал не 200 либо индекс не разобрался.
///
/// ГРАБЛЯ: на 403 источник отдаёт 111 байт XML `<Error><Code>AccessDenied`,
/// а не пустоту — проверять надо именно `status`, иначе XML уедет в JSON.parse
/// (там он молча даст пустой список, и «года нет» станет неотличимо от
/// «года не отдали»).
export async function fetchSeasonIndex(
  year: number, fetch: FomFetch = fetchText,
): Promise<{ text: string } | null> {
  const res = await fetch(indexURL(year));
  return res && res.status === 200 && res.text !== "" ? { text: res.text } : null;
}

/// Оба топика сессии одним заходом. `null` у топика — не поломка, а известное
/// состояние архива: PitStopSeries РОДИЛСЯ на US GP 2024 (до него 403 при
/// живом PitLaneTimeCollection той же сессии), и весь 2023 отдаёт 403.
export async function fetchSessionTopics(
  sessionPath: string, fetch: FomFetch = fetchText,
): Promise<{ pss: string | null; pltc: string | null }> {
  const get = async (topic: string): Promise<string | null> => {
    const res = await fetch(topicURL(sessionPath, topic));
    return res && res.status === 200 && res.text !== "" ? res.text : null;
  };
  return { pss: await get(TOPIC_PIT_STOP_SERIES), pltc: await get(TOPIC_PIT_LANE_TIME) };
}

// MARK: - Файл факта

export function pitstopsPath(root: string, eventKey: string): string {
  return join(root, "f1", "pitstops", `${eventKey}.json`);
}

/// Сборка факта события из снятых текстов топиков.
///
/// Сессия без ЕДИНОГО стопа в выдачу не идёт: пустой список неотличим от
/// «не сняли», а различать их обязан вызывающий (для него это разные решения —
/// писать файл или оставить прежний). Событие вообще без сессий даёт null.
export function buildEventPitstops(input: {
  eventKey: string;
  eventId: string;
  season: number;
  round: number;
  sessions: { tag: PitSessionTag; pss: string | null; pltc: string | null }[];
}): EventPitstops | null {
  const sessions: PitSessionStops[] = [];
  for (const s of input.sessions) {
    if (s.pss === null && s.pltc === null) continue;
    const merged = mergePitStops(
      s.pss ? parsePitStopSeries(s.pss) : [],
      s.pltc ? parsePitLaneTimes(s.pltc) : [],
    );
    if (!merged.stops.length) continue;
    sessions.push({ tag: s.tag, stops: merged.stops, suspended: merged.suspended });
  }
  if (!sessions.length) return null;
  return {
    eventKey: input.eventKey, eventId: input.eventId, season: input.season,
    round: input.round, parserVersion: PITSTOPS_PARSER_VERSION, sessions,
  };
}

/// Запись факта. Сторож формы прогоняется по ГОТОВОМУ ТЕКСТУ и на нарушении
/// БРОСАЕТ: тихий пропуск здесь означал бы, что чужое выражение или мусорное
/// число доехали до диска, а прогон отчитался нулём.
export function writeEventPitstops(
  root: string, doc: EventPitstops,
  write: (path: string, payload: object, schemaVersion: number) => boolean,
): boolean {
  const { eventKey, eventId, season, round, parserVersion, sessions } = doc;
  const payload = { eventKey, eventId, season, round, parserVersion, sessions };
  const preview = JSON.stringify(
    { schemaVersion: PITSTOPS_SCHEMA_VERSION, generatedAt: new Date().toISOString(), ...payload },
    null, 2) + "\n";
  const err = pitstopsFactError(preview);
  if (err !== null) throw new Error(`f1pitstops ${eventKey}: ${err}`);
  return write(pitstopsPath(root, eventKey), payload, PITSTOPS_SCHEMA_VERSION);
}

/// Факт события с диска; null — файла нет, он бит или не прошёл сторожа формы.
/// Читатель применяет ТЕ ЖЕ сторожа, что писатель: испорченный руками файл не
/// должен доехать до витрины только потому, что его никто не перепроверил.
export function readEventPitstops(root: string, eventKey: string): EventPitstops | null {
  let text: string;
  try {
    text = readFileSync(pitstopsPath(root, eventKey), "utf8");
  } catch {
    return null;
  }
  if (pitstopsFactError(text) !== null) return null;
  const doc = JSON.parse(text);
  return {
    eventKey: doc.eventKey, eventId: doc.eventId, season: doc.season,
    round: doc.round, parserVersion: doc.parserVersion, sessions: doc.sessions,
  };
}

// MARK: - Потребители

/// Стопы события со стационарным временем, по всем гоночным сессиям.
/// Именно этот срез нужен «быстрейшему питу»: строка без стационарного —
/// свидетельство визита, а не измерение.
export function timedStops(doc: EventPitstops | null): (PitStop & { tag: PitSessionTag })[] {
  if (!doc) return [];
  return doc.sessions.flatMap((s) =>
    s.stops.filter((x) => x.stationarySec !== null).map((x) => ({ ...x, tag: s.tag })));
}

/// Факты сезона по РАУНДАМ витрины: календарь читается один раз, дальше
/// потребитель ходит по карте. Резолв «раунд → eventKey» живёт здесь, а не в
/// трёх продьюсерах: разъехавшись, они молча разошлись бы в том, чей факт
/// считается фактом этого этапа.
export function readSeasonPitstops(root: string, season: number): Map<number, EventPitstops> {
  const out = new Map<number, EventPitstops>();
  let events: any[];
  try {
    events = JSON.parse(
      readFileSync(join(root, "f1", "calendar", `${season}.json`), "utf8"))?.events ?? [];
  } catch {
    return out;   // витрины календаря нет — резолвить нечем
  }
  for (const e of events) {
    if (e?.kind !== "race" || typeof e?.eventKey !== "string") continue;
    const round = Number(e?.round);
    if (!Number.isInteger(round) || round < 1) continue;
    const doc = readEventPitstops(root, e.eventKey);
    if (doc) out.set(round, doc);
  }
  return out;
}

/// Полнота стационарных времён события: сколько стопов измерено из скольких
/// известных. Медиана без этой пары молча врёт — на Монако PSS покрывает
/// меньше половины визитов.
export function stationaryCoverage(doc: EventPitstops | null): { covered: number; total: number } {
  if (!doc) return { covered: 0, total: 0 };
  let covered = 0;
  let total = 0;
  for (const s of doc.sessions) {
    for (const x of s.stops) {
      total++;
      if (x.stationarySec !== null) covered++;
    }
  }
  return { covered, total };
}
