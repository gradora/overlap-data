// Общий слой Open-Meteo для витринного прогноза (фаза B кухни F1, план §2).
// Два хоста — Forecast API (прогноз + недавнее прошлое через past_days) и
// Archive API (ERA5, факт по датам). URL-билдеры — порт клиентских
// forecastURL/archiveURL из WeatherService.swift 1:1: те же оси hourly, тот же
// масштаб past_days/forecast_days под окно события. Единицы назначаем САМИ
// запросом (timeformat=unixtime, windspeed_unit=kmh) — поэтому, в отличие от
// weather.ts с его тремя разноюнитными источниками, конверсий в пайплайне ноль
// и единицы в имена полей не выносятся (решение дизайна §1).
//
// Санация — аналог RANGES сенсорного архива, но мягче по механике: отсчёт вне
// диапазона превращается в null, а не отвергает ряд целиком. Прогноз не
// write-once (пересобирается каждый час), терять шесть осей из-за одного
// мусорного часа незачем; выдумки при этом не появляется — null это честное
// «значения нет».

import { fetchJSON } from "./http.js";

const DAY_MS = 24 * 3600 * 1000;

export interface Coord { lat: number; lon: number }

/// Окно события в ms epoch (первая и последняя сессии уик-энда).
export interface EventWindow { startMs: number; endMs: number }

/// Почасовой блок — ФОРМА 1:1 с клиентским HourlyForecast (Weather.swift):
/// параллельные массивы с nullable-элементами (null-хвост на границе горизонта
/// прогноза легален и не роняет декод). Время — unix-СЕКУНДЫ, без null.
export interface ForecastHourly {
  time: number[];
  temperature_2m: (number | null)[];
  precipitation_probability: (number | null)[];
  precipitation: (number | null)[];
  wind_speed_10m: (number | null)[];
  weather_code: (number | null)[];
}

/// Пределы правдоподобия (образец RANGES из weather.ts). Границы широкие:
/// +56 °C в Долине Смерти и ливень 300+ мм/ч в тропиках — реальность, браковать
/// нельзя; а вот температура в Фаренгейтах или ветер в узлах×10 сюда не пройдут.
export const FORECAST_RANGES = {
  temperature_2m: [-60, 60],
  precipitation_probability: [0, 100],
  precipitation: [0, 500],
  wind_speed_10m: [0, 200],
  weather_code: [0, 99],
} as const;

/// Оси hourly Forecast API — ровно клиентский набор из forecastURL.
const FORECAST_AXES =
  "temperature_2m,precipitation_probability,precipitation,wind_speed_10m,weather_code";

/// Оси Archive API: без precipitation_probability — у ERA5 её нет вовсе
/// (порядок и состав — клиентский archiveURL).
const ARCHIVE_AXES = "temperature_2m,precipitation,weather_code,wind_speed_10m";

const isoDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/// Forecast API: past_days покрывает недавнее прошлое (до 92), forecast_days —
/// будущее (до 16). Оба масштабируются под окно события, чтобы не тянуть
/// лишнее, — формулы клиентские, включая запасы +2/+1 дня.
export function forecastURL(coord: Coord, window: EventWindow, nowMs: number): string {
  const pastDays = Math.min(92, Math.max(1,
    Math.ceil(Math.max(0, nowMs - window.startMs) / DAY_MS) + 2));
  const forecastDays = Math.min(16, Math.max(1,
    Math.ceil(Math.max(0, window.endMs + DAY_MS - nowMs) / DAY_MS) + 1));
  return `https://api.open-meteo.com/v1/forecast?latitude=${coord.lat}&longitude=${coord.lon}` +
    `&hourly=${FORECAST_AXES}` +
    `&timeformat=unixtime&windspeed_unit=kmh&past_days=${pastDays}&forecast_days=${forecastDays}`;
}

/// Archive API (ERA5): факт по ISO-дням. Запас −1/+1 день вокруг окна — забота
/// вызывающего (как у клиента: он передаёт уже расширенные даты).
export function archiveURL(coord: Coord, startMs: number, endMs: number): string {
  return `https://archive-api.open-meteo.com/v1/archive?latitude=${coord.lat}&longitude=${coord.lon}` +
    `&hourly=${ARCHIVE_AXES}` +
    `&timeformat=unixtime&windspeed_unit=kmh` +
    `&start_date=${isoDay(startMs)}&end_date=${isoDay(endMs)}`;
}

/// Лёгкий запрос «сейчас на трассе» — клиентский fetchCurrent: сутки назад +
/// сутки вперёд, из которых семейство now оставит окно −3ч…+6ч.
export function nowURL(coord: Coord): string {
  return `https://api.open-meteo.com/v1/forecast?latitude=${coord.lat}&longitude=${coord.lon}` +
    `&hourly=${FORECAST_AXES}` +
    `&timeformat=unixtime&windspeed_unit=kmh&past_days=1&forecast_days=1`;
}

const AXES = [
  "temperature_2m", "precipitation_probability", "precipitation",
  "wind_speed_10m", "weather_code",
] as const;

type Axis = (typeof AXES)[number];

const inRange = (v: number, [lo, hi]: readonly [number, number]): boolean =>
  v >= lo && v <= hi;

/// Сырой блок hourly Open-Meteo → выровненные оси с санацией.
///
/// Три вещи: (1) выбрасываются строки с неразбираемым временем — время без
/// null по контракту формы; (2) отсутствующая ось (probability у Archive)
/// дозаполняется null до длины time, чтобы все шесть осей всегда были
/// параллельны; (3) значение вне FORECAST_RANGES → null, не выдумка и не отказ.
/// null — блока нет или в нём ни одного пригодного часа.
export function sanitizeHourly(raw: unknown): ForecastHourly | null {
  if (raw === null || typeof raw !== "object") return null;
  const src = raw as Record<string, unknown>;
  const rawTime = Array.isArray(src.time) ? src.time : [];

  // Индексы часов с валидным временем: битая метка уносит с собой всю строку,
  // иначе оси разъехались бы по смыслу.
  const keep: number[] = [];
  const time: number[] = [];
  for (let i = 0; i < rawTime.length; i++) {
    const t = rawTime[i];
    if (typeof t === "number" && Number.isFinite(t)) { keep.push(i); time.push(t); }
  }
  if (time.length === 0) return null;

  const axis = (name: Axis): (number | null)[] => {
    const arr = Array.isArray(src[name]) ? (src[name] as unknown[]) : [];
    return keep.map((i) => {
      const v = arr[i];
      if (typeof v !== "number" || !Number.isFinite(v)) return null;
      return inRange(v, FORECAST_RANGES[name]) ? v : null;
    });
  };

  return {
    time,
    temperature_2m: axis("temperature_2m"),
    precipitation_probability: axis("precipitation_probability"),
    precipitation: axis("precipitation"),
    wind_speed_10m: axis("wind_speed_10m"),
    weather_code: axis("weather_code"),
  };
}

/// Один запрос Open-Meteo → санированный почасовой блок. null — сеть, не-200,
/// битый JSON или пустой ряд; различать это вызывающему не нужно — во всех
/// случаях действует kept-previous (lib/forecast.ts). Таймаут и ретрай на
/// 429/5xx — общие, из http.ts.
export async function fetchOpenMeteoHourly(url: string): Promise<ForecastHourly | null> {
  const json = await fetchJSON(url);
  if (json === null || typeof json !== "object") return null;
  return sanitizeHourly((json as Record<string, unknown>).hourly);
}
