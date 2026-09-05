// Историческая погода события (шаг 5.3 DATA-PLAN) — СЕНСОРНЫЙ архив, а не
// прогноз. Живёт отдельным семейством `f1/weather/<eventId>.json`, а не блоком
// внутри файла события, и это осознанное отступление от формулировки плана
// («блок weather в файле события»). Три причины, каждая проверена по коду:
//
//  1. План противоречит сам себе: фаза 6 перечисляет weather в одном ряду с
//     fia/winners/highlights/milestones — то есть как ОТДЕЛЬНЫЙ GET, который
//     она будет инлайнить. Все четыре соседа сегодня лежат отдельными файлами.
//     Значит семейство — это вход фазы 6, а не работа, которую она переделает.
//  2. Файл события WEC физически не удержит write-once: `writeWecEvent` пишет
//     по белому списку полей, `buildWecEventDoc` собирает документ с нуля и
//     prev не читает, а гейт заморозки намеренно пересобирает замороженное при
//     смене schemaVersion. Любой бамп схемы стёр бы погоду молча.
//  3. У F1 хоста нет вовсе: витрина календаря не содержит сессий (только
//     dates.start/race/raceTime) и заморожена посезонно — 2025 уже frozen.
//
// ЕДИНИЦЫ — В ИМЕНИ ПОЛЯ. Источники меряют по-разному (OpenF1 и FOM — ветер в
// м/с, Al Kamel у IMSA — °F/inHg/MPH), и молчаливая путаница здесь
// запечатывается навсегда: архив write-once. Конверсия ровно одна, на входе.
//
// ЧЕГО ЗДЕСЬ НЕТ И НЕ БУДЕТ: миллиметров осадков, вероятности дождя,
// интенсивности и синтетического WMO-кода. У датчика есть только бинарный
// флаг — его и пишем. Синтезировать код ради непустой иконки значило бы
// запечатать выдумку; иконка — забота клиента.

/// Версия ФОРМЫ файла. Аддитивные правки её не бампают.
export const WEATHER_SCHEMA_VERSION = 1;

/// Версия РАЗБОРА, отдельная от формы и записанная В КАЖДЫЙ файл — образец
/// PENALTY_PARSER_VERSION. Позволяет починить архив подокументно: событие с
/// прошлой версией разбора пересобирается даже будучи запечатанным, а
/// глобальный форс для этого не нужен.
export const WEATHER_PARSER_VERSION = 1;

/// Пределы правдоподобия. Отсчёт вне диапазона — не «экзотическая погода», а
/// перепутанные единицы или мусор источника; такую сессию не пишем вовсе.
/// Границы намеренно широкие: 779 гПа в Мехико и +60 °C на трассе в Бахрейне —
/// реальные значения, браковать их нельзя.
export const RANGES = {
  airC: [-20, 60],
  trackC: [-20, 80],
  humidity: [0, 100],
  pressureHpa: [700, 1100],
  windKmh: [0, 150],
  windDeg: [0, 360],
} as const;

export interface WeatherSamples {
  /// Абсолютное время, unix-СЕКУНДЫ. Только абсолютное: относительное время
  /// (FOM) и настенные часы без пояса (Al Kamel) в этот шаг не входят вовсе.
  t: number[];
  airC: (number | null)[];
  trackC: (number | null)[];
  humidity: (number | null)[];
  pressureHpa: (number | null)[];
  windKmh: (number | null)[];
  windDeg: (number | null)[];
  /// Бинарный флаг датчика, как есть.
  rain: (0 | 1)[];
}

export interface Stat { min: number; max: number; avg: number }

export interface WeatherSummary {
  airC: Stat | null;
  trackC: Stat | null;
  windKmh: Stat | null;
  /// Доля ВРЕМЕНИ с rain=1, а не доля строк: каденс источников плавает
  /// (у FOM провалы до 24 минут), и счёт по строкам дал бы кривую цифру,
  /// которая потом застынет навсегда.
  wetShare: number;
  wet: boolean;
}

export interface WeatherSession {
  key: string;
  name: string;
  startedAt: number | null;
  endedAt: number | null;
  samples: WeatherSamples;
  summary: WeatherSummary;
}

export interface WeatherDoc {
  schemaVersion: number;
  series: string;
  season: number;
  eventId: string;
  parserVersion: number;
  /// Окно события закрылось и отстоялось — файл больше не пересобирается
  /// (кроме случая «версия разбора устарела»).
  final: boolean;
  timeAnchor: { method: string; confidenceSec: number };
  sessions: WeatherSession[];
  summary: WeatherSummary;
}

/// Сырая строка ручки OpenF1 `weather?session_key=`.
export interface OpenF1WeatherRow {
  date?: unknown;
  air_temperature?: unknown;
  track_temperature?: unknown;
  humidity?: unknown;
  pressure?: unknown;
  wind_speed?: unknown;
  wind_direction?: unknown;
  rainfall?: unknown;
}

const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};

const inRange = (v: number | null, [lo, hi]: readonly [number, number]): boolean =>
  v === null || (v >= lo && v <= hi);

/// м/с → км/ч. Единственное место конверсии скорости ветра.
export const msToKmh = (ms: number | null): number | null =>
  ms === null ? null : Math.round(ms * 3.6 * 10) / 10;

export interface NormalizeResult {
  samples: WeatherSamples;
  /// Причина, по которой сессию писать НЕЛЬЗЯ. null — можно.
  reject: string | null;
}

/// Сырые строки OpenF1 → отсчёты архива.
///
/// Делает ровно три вещи и ни одной лишней: приводит время к unix-секундам,
/// конвертирует единицы, отбрасывает дубли по таймстампу и сортирует. Дыры в
/// ряду НЕ заполняются: промежуток, в котором датчик молчал, честно остаётся
/// промежутком — интерполяция здесь была бы выдумкой, запечатанной навсегда.
export function normalizeOpenF1(rows: OpenF1WeatherRow[]): NormalizeResult {
  const empty: WeatherSamples = {
    t: [], airC: [], trackC: [], humidity: [], pressureHpa: [], windKmh: [], windDeg: [], rain: [],
  };
  if (!Array.isArray(rows) || rows.length === 0) {
    return { samples: empty, reject: "нет отсчётов" };
  }

  const seen = new Set<number>();
  const t: number[] = [];
  const rowsByT = new Map<number, {
    airC: number | null; trackC: number | null; humidity: number | null;
    pressureHpa: number | null; windKmh: number | null; windDeg: number | null; rain: 0 | 1;
  }>();
  for (const row of rows) {
    const ms = Date.parse(String(row?.date ?? ""));
    if (!Number.isFinite(ms)) continue;
    const sec = Math.round(ms / 1000);
    if (seen.has(sec)) continue;     // дубль таймстампа — берём первый
    seen.add(sec);
    t.push(sec);
    rowsByT.set(sec, {
      airC: num(row.air_temperature),
      trackC: num(row.track_temperature),
      humidity: num(row.humidity),
      pressureHpa: num(row.pressure),
      windKmh: msToKmh(num(row.wind_speed)),
      windDeg: num(row.wind_direction),
      rain: num(row.rainfall) === 1 ? 1 : 0,
    });
  }
  if (t.length === 0) return { samples: empty, reject: "ни одной разбираемой метки времени" };
  t.sort((a, b) => a - b);

  const samples: WeatherSamples = {
    t,
    airC: t.map((k) => rowsByT.get(k)!.airC),
    trackC: t.map((k) => rowsByT.get(k)!.trackC),
    humidity: t.map((k) => rowsByT.get(k)!.humidity),
    pressureHpa: t.map((k) => rowsByT.get(k)!.pressureHpa),
    windKmh: t.map((k) => rowsByT.get(k)!.windKmh),
    windDeg: t.map((k) => rowsByT.get(k)!.windDeg),
    rain: t.map((k) => rowsByT.get(k)!.rain),
  };

  // Валидация ДО записи: перепутанные единицы должны падать здесь, а не
  // запечатываться в архив.
  const checks: [keyof typeof RANGES, (number | null)[]][] = [
    ["airC", samples.airC], ["trackC", samples.trackC], ["humidity", samples.humidity],
    ["pressureHpa", samples.pressureHpa], ["windKmh", samples.windKmh], ["windDeg", samples.windDeg],
  ];
  for (const [field, values] of checks) {
    const bad = values.find((v) => !inRange(v, RANGES[field] as unknown as readonly [number, number]));
    if (bad !== undefined && bad !== null) {
      return { samples: empty, reject: `${field}=${bad} вне диапазона ${RANGES[field].join("..")}` };
    }
  }
  return { samples, reject: null };
}

/// Веса отсчётов — длительности интервалов, которые они представляют.
/// Последнему отдаём типичный шаг ряда: иначе он весил бы ноль и «дождь до
/// самого финиша» терял бы хвост.
///
/// «Типичный» — НИЖНЯЯ медиана промежутков, а не верхняя. Разница не
/// косметическая: провалы каденса (у FOM до 24 минут, у Al Kamel 45–70 с)
/// сидят в хвосте распределения, и верхняя медиана на коротком ряду отдаёт
/// последнему отсчёту вес провала. На ряду [60 с, 1440 с] это превращало долю
/// мокрого времени из 4 % в 49 % — цифру, которая запечаталась бы навсегда.
export function weightsOf(t: number[]): number[] {
  if (t.length === 0) return [];
  if (t.length === 1) return [1];
  const gaps: number[] = [];
  for (let i = 1; i < t.length; i++) gaps.push(Math.max(0, t[i] - t[i - 1]));
  const sorted = [...gaps].sort((a, b) => a - b);
  const typical = sorted[Math.floor((sorted.length - 1) / 2)] || 1;
  return [...gaps, typical];
}

function statOf(values: (number | null)[], weights: number[]): Stat | null {
  let min = Infinity, max = -Infinity, acc = 0, w = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v === null) continue;
    min = Math.min(min, v);
    max = Math.max(max, v);
    acc += v * weights[i];
    w += weights[i];
  }
  if (w === 0) return null;
  return { min, max, avg: Math.round((acc / w) * 10) / 10 };
}

/// Сводка по ряду. Все средние — ВЗВЕШЕННЫЕ ПО ВРЕМЕНИ (см. WeatherSummary).
export function summarize(samples: WeatherSamples): WeatherSummary {
  const w = weightsOf(samples.t);
  const total = w.reduce((a, b) => a + b, 0);
  let wet = 0;
  for (let i = 0; i < samples.rain.length; i++) if (samples.rain[i] === 1) wet += w[i];
  const wetShare = total > 0 ? Math.round((wet / total) * 1000) / 1000 : 0;
  return {
    airC: statOf(samples.airC, w),
    trackC: statOf(samples.trackC, w),
    windKmh: statOf(samples.windKmh, w),
    wetShare,
    // «Мокро» — не любая капля: одиночный отсчёт на трёхчасовой сессии это
    // шум датчика, а не дождевая гонка.
    wet: wetShare >= 0.05,
  };
}

/// Сводка события — по всем его отсчётам разом, а не среднее из средних:
/// иначе десятиминутная практика весила бы столько же, сколько гонка.
export function summarizeEvent(sessions: WeatherSession[]): WeatherSummary {
  const merged: WeatherSamples = {
    t: [], airC: [], trackC: [], humidity: [], pressureHpa: [], windKmh: [], windDeg: [], rain: [],
  };
  for (const s of [...sessions].sort((a, b) => (a.samples.t[0] ?? 0) - (b.samples.t[0] ?? 0))) {
    merged.t.push(...s.samples.t);
    merged.airC.push(...s.samples.airC);
    merged.trackC.push(...s.samples.trackC);
    merged.humidity.push(...s.samples.humidity);
    merged.pressureHpa.push(...s.samples.pressureHpa);
    merged.windKmh.push(...s.samples.windKmh);
    merged.windDeg.push(...s.samples.windDeg);
    merged.rain.push(...s.samples.rain);
  }
  // Веса считаем ПОСЕССИОННО и склеиваем: сквозной расчёт по объединённому
  // ряду дал бы ночному промежутку между практикой и гонкой вес в 20 часов.
  const w: number[] = [];
  for (const s of [...sessions].sort((a, b) => (a.samples.t[0] ?? 0) - (b.samples.t[0] ?? 0))) {
    w.push(...weightsOf(s.samples.t));
  }
  const total = w.reduce((a, b) => a + b, 0);
  let wet = 0;
  for (let i = 0; i < merged.rain.length; i++) if (merged.rain[i] === 1) wet += w[i];
  const wetShare = total > 0 ? Math.round((wet / total) * 1000) / 1000 : 0;
  return {
    airC: statOf(merged.airC, w),
    trackC: statOf(merged.trackC, w),
    windKmh: statOf(merged.windKmh, w),
    wetShare,
    wet: wetShare >= 0.05,
  };
}

/// Слияние по ключу сессии — НАКОПЛЕНИЕ, без удалений (образец mergeFiaEvent).
/// Сессия, которая была в архиве, но пропала из свежей сборки, остаётся: у
/// источника мог отвалиться один файл, и молча стирать снятое нельзя. Свежая
/// версия сессии побеждает — она полнее (архив дозаполняется, а не редеет).
export function mergeWeatherEvent(prev: WeatherDoc | null, next: WeatherDoc): WeatherDoc {
  if (!prev) return next;
  const byKey = new Map<string, WeatherSession>();
  for (const s of prev.sessions) byKey.set(s.key, s);
  for (const s of next.sessions) {
    const old = byKey.get(s.key);
    // Более короткий ряд не затирает более длинный: обрезанный ответ во время
    // живой сессии не имеет права укоротить архив.
    if (old && old.samples.t.length > s.samples.t.length) continue;
    byKey.set(s.key, s);
  }
  const sessions = [...byKey.values()]
    .sort((a, b) => (a.samples.t[0] ?? 0) - (b.samples.t[0] ?? 0));
  return { ...next, sessions, summary: summarizeEvent(sessions) };
}

/// null — писать можно; строка — причина оставить прежний файл.
/// Оси монотонны: сессий, отсчётов в каждой сессии и покрытого интервала не
/// может стать меньше. Погода прошедшего уик-энда не редеет.
export function weatherRegression(prev: WeatherDoc | null, next: WeatherDoc): string | null {
  if (!prev) return null;
  if (next.sessions.length < prev.sessions.length) {
    return `сессий стало меньше (${prev.sessions.length} → ${next.sessions.length})`;
  }
  const nextByKey = new Map(next.sessions.map((s) => [s.key, s]));
  for (const before of prev.sessions) {
    const after = nextByKey.get(before.key);
    if (!after) return `сессия ${before.key} пропала`;
    if (after.samples.t.length < before.samples.t.length) {
      return `сессия ${before.key}: отсчётов стало меньше ` +
        `(${before.samples.t.length} → ${after.samples.t.length})`;
    }
  }
  return null;
}
