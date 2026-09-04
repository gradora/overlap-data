// Награды DHL Fastest Pit Stop со страницы результатов formula1.com —
// ФОЛБЭК канала питстопов, не основной источник.
//
// ЗАЧЕМ. Стационарные времена питов идут из openf1 (stop_duration), но с
// Венгрии-2026 их пайплайн перестал их считать: поле null у всех строк, и
// живой API спустя недели пуст (у jolpica стационарных времён нет вовсе —
// их /pitstops это время пит-лейна). Таблица наград DHL на formula1.com —
// авторитетный список «этап → команда → время» по сезонам с 2015 года; там,
// где openf1 работал, числа сходятся (Бельгия 2.30, Япония 2.00).
//
// ГРАНИЦА ИСТОЧНИКА. Это FOM-класс риска (как статика live timing, уехавшая
// в приватный репозиторий), поэтому: (1) на диск кладётся ТОЛЬКО извлечённый
// факт — этап, команда, секунды; HTML разбирается в памяти, как у слоя
// фактов WEC; (2) продьюсер РУЧНОЙ — в кроне CI его нет, запускает владелец
// локально (из CI formula1.com и так отдаёт 403, как fomstatic); (3) слой
// подключается строго фолбэком: раунды, закрытые openf1, награды не трогают.
//
// Зона — «заготовка» (databoundary): приложение файл не читает, его
// потребляет продьюсер f1beasts при сборке витрины.

import { readFileSync } from "node:fs";
import { join } from "node:path";

export const PITAWARDS_SCHEMA_VERSION = 1;

/// Строка награды: ярлык этапа СО СТРАНИЦЫ (не raceName jolpica), команда и
/// стационарное время. Пилота в таблице DHL нет — награда командная.
export interface PitAwardRow {
  event: string;    // «Hungary» / «Barcelona-Catalunya» / «Great Britain»
  team: string;     // «Racing Bulls»
  seconds: number;  // 1.99
}

export interface PitAwardsDoc {
  season: number;
  rows: PitAwardRow[];
}

const decode = (s: string) =>
  s.replace(/&amp;/g, "&").replace(/&#39;|&rsquo;|’/g, "'").replace(/&nbsp;/g, " ").trim();

/// Разбор таблицы наград из HTML страницы. Строка результата — <tr> с тремя
/// смысловыми ячейками: этап (текст рядом с флагом), команда, «1.99s».
/// Шапка и видео-блоки отсеиваются требованием времени; токены «Flag of …» —
/// это alt/подписи флагов, не этап.
export function extractPitAwards(html: string): PitAwardRow[] {
  const out: PitAwardRow[] = [];
  for (const tr of html.split(/<tr[\s>]/).slice(1)) {
    // Хвост собственных атрибутов <tr …> тоже отрезается — он уже не «тег»
    // после сплита и иначе стал бы первым токеном.
    const row = (tr.split("</tr>")[0] ?? "").replace(/^[^>]*>/, "");
    const tokens = row
      .replace(/<[^>]+>/g, "|")
      .split("|")
      .map((t) => decode(t))
      .filter((t) => t && !/^Flag of /i.test(t));
    const timeIdx = tokens.findIndex((t) => /^\d+\.\d{1,3}s$/.test(t));
    if (timeIdx < 2) continue;   // нет времени либо нет этапа/команды перед ним
    const seconds = Number(tokens[timeIdx].slice(0, -1));
    // Физический диапазон: стационарный стоп — единицы секунд. Минуты или
    // нули — это не питстоп, а чужая ячейка, совпавшая форматом.
    if (!(seconds > 0.5 && seconds < 60)) continue;
    out.push({ event: tokens[0], team: tokens[timeIdx - 1], seconds });
  }
  return out;
}

export function pitAwardsPath(root: string, year: number): string {
  return join(root, "f1", "pitawards", `${year}.json`);
}

/// Файл наград сезона; null — файла нет либо чужая версия схемы (правка
/// парсера дойдёт до данных только через пересъём, версия — рычаг).
export function readPitAwards(root: string, year: number): PitAwardsDoc | null {
  try {
    const doc = JSON.parse(readFileSync(pitAwardsPath(root, year), "utf8"));
    if (doc?.schemaVersion !== PITAWARDS_SCHEMA_VERSION) return null;
    if (!Array.isArray(doc.rows)) return null;
    return { season: doc.season, rows: doc.rows };
  } catch {
    return null;
  }
}

// MARK: - Матчинг с витриной календаря

/// Событие витрины календаря в полях, нужных матчингу.
export interface AwardCalendarEvent {
  round: number;
  name?: string;
  country?: string;
  locality?: string;
  venue?: string;
  circuit?: string;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9À-ɏ]+/g, " ").trim();

/// Страны, которые страница называет иначе, чем витрина календаря.
const COUNTRY_ALIASES: Record<string, string> = {
  "great britain": "uk",
  "united kingdom": "uk",
  "united states": "usa",
  "abu dhabi": "uae",
};

/// Ярлык этапа со страницы наград → раунд события календаря, либо null.
/// Сначала география/имя подстрокой (ловит «Miami», «Barcelona-Catalunya»,
/// «United States»), затем страна с алиасами — но только когда страна в
/// сезоне ОДНА: «Spain» при Барселоне и Мадриде в календаре — не ответ.
/// Неоднозначность — это null с предупреждением у вызывающего, а не догадка:
/// неверный раунд молча задвоил бы этап в лидерборде.
export function matchAwardRound(label: string, events: AwardCalendarEvent[]): number | null {
  const l = norm(label);
  if (!l) return null;
  const geo = events.filter((e) =>
    [e.name, e.locality, e.venue, e.circuit].some((v) => {
      if (!v) return false;
      const n = norm(v);
      return n.includes(l) || l.includes(n);
    }));
  if (geo.length === 1) return geo[0].round;
  const country = COUNTRY_ALIASES[l] ?? l;
  const byCountry = events.filter((e) => norm(e.country ?? "") === country);
  if (byCountry.length === 1) return byCountry[0].round;
  return null;
}

/// Команда страницы → constructorId jolpica для цвета полоски; "" — не
/// узнали (клиент рисует нейтральную). Сверка по нормализованным именам с
/// отбросом хвоста «F1 Team»; подстрока — только от 4 символов, чтобы
/// короткие id («rb») не липли к чужим словам.
const TEAM_ALIASES: Record<string, string> = {
  "racing bulls": "rb",
  "vcarb": "rb",
};

export function awardTeamId(
  team: string, constructors: { name: string; id: string }[],
): string {
  const t = norm(team);
  if (TEAM_ALIASES[t]) return TEAM_ALIASES[t];
  for (const c of constructors) {
    const n = norm(c.name).replace(/\bf1 team\b/, "").trim();
    if (n === t) return c.id;
    if (n.length >= 4 && t.length >= 4 && (n.includes(t) || t.includes(n))) return c.id;
  }
  return "";
}
