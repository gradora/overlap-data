// Чтение курируемой карты сущностей data/refs/matching.json (фаза 2 DATA-PLAN):
// одна карта вместо ~25 алиас-таблиц, размазанных по двум репозиториям.
//
// Правила слоя (сквозные для фазы):
//  - Карта КУРИРУЕМАЯ: продьюсера нет, правится руками; валидатор живёт тестом
//    (src/refs.test.ts, fail-loud на каждый CI-прогон) — validateRefs() отсюда.
//  - Чтение — fail-open: файла нет / битый JSON / незнакомая схема → undefined,
//    встроенные таблицы потребителей работают как раньше. Расхождение карты со
//    встроенной таблицей — предмет warning'а на стороне потребителя (обкатка,
//    побеждает встроенная); этот модуль только отдаёт данные и резолв-хелперы.
//  - Потребители здесь НЕ подключаются — это следующий шаг фазы.

import { readFileSync } from "node:fs";
import { join } from "node:path";

export const REFS_SCHEMA_VERSION = 1;

// MARK: Типы карты

/// Пространства алиасов трассы по источникам. Семантика значений:
///  jolpica      — circuitId (подчёркивания: «red_bull_ring»);
///  openf1       — circuit_short_name митинга («Spielberg»);
///  fiaDocPrefix — страна-префикс слага события FIA (первый «_»-токен, как в
///                 fiadocs.matchRound: «austrian», «abu»);
///  alkamelWec   — slugifyAkEvent метки события Results-архива («losail»);
///  fiawec       — отличительный токен слага гонки fiawec.com («qatar»);
///  alkamelImsa  — slugifyImsaTrack архивной папки IMSA («road-atlanta»);
///  imsaVenue    — curated длинная форма venue расписания IMSA;
///  wiki         — заголовок статьи англ. Википедии;
///  text         — прочие сырые написания (circuitName jolpica, TrackKey-алиасы).
export type RefTrackAliasSource =
  | "jolpica" | "openf1" | "fiaDocPrefix" | "alkamelWec" | "fiawec"
  | "alkamelImsa" | "imsaVenue" | "wiki" | "text";

export const REF_TRACK_ALIAS_SOURCES: RefTrackAliasSource[] = [
  "jolpica", "openf1", "fiaDocPrefix", "alkamelWec", "fiawec",
  "alkamelImsa", "imsaVenue", "wiki", "text",
];

export interface RefTrack {
  slug: string;      // канонический слаг = asset-slug приложения (ключи TRACKS в tracks.ts)
  display: string;
  country: string;   // display-форма jolpica/RaceLocation («USA», «UK», «UAE»)
  /// Часовой пояс площадки, IANA («Asia/Tokyo»). Не украшение: fiawec штампует
  /// ВСЕМ этапам парижский офсет независимо от места — у Фудзи «10:15+02:00»
  /// вместо «10:15+09:00», ошибка 7 часов. Настенное время в источнике верное,
  /// врёт только офсет, поэтому зона нужна, чтобы восстановить настоящий момент.
  /// Зона, а не смещение: летнее время меняется дважды в год.
  timezone: string;
  aliases: Partial<Record<RefTrackAliasSource, string[]>>;
}

/// Явная привязка аномалии к (source, match, season[, round]) — класс
/// «Bahrain GP in Malaysia». round: null = «не матчить ни на какой раунд»
/// (материализованное правило TESTING_SLUG).
export interface RefPin {
  source: string;
  kind: string;
  match: string;
  season?: number;
  round?: number | null;
  slug?: string;
  country?: string;
  note?: string;
}

export interface RefF1Team {
  id: string;                 // constructorId Jolpica
  display: string;
  historicIds?: string[];     // lineage: mclaren-ford…; audi ← sauber
  rebrandSeason?: number;     // сезоны ДО него openf1-имена исторической команды → historicIds[0]
  openf1Names?: string[];
  base: { country: string; city: string };
  home: string;               // circuitId Jolpica (пространство catalog.json, НЕ app-slug)
  colors?: { primary: string };
  alsoIn?: string[];
}

export interface RefIdentity {
  seasons: number[];
  names: string[];   // написания источника как есть; матчинг case-insensitive
  brand?: string;
  series: string[];
}

export interface RefEnduranceTeam {
  key: string;       // стабильный ключ сквозь ребренды (кейс JOTA)
  display: string;
  identities: RefIdentity[];
}

export interface RefDriverException {
  canon: string;
  surname: string;
  aliases: string[];
  surnameSlug?: string;  // артефакт общего slugified (ø → «-»): «s-rensen»
  flag?: string;
  note?: string;
}

export interface RefsMap {
  schemaVersion: number;
  generatedAt?: string;
  note?: string;
  tracks: RefTrack[];
  pins: RefPin[];
  f1Teams: RefF1Team[];
  enduranceTeams: RefEnduranceTeam[];
  driverExceptions: {
    particles: string[];
    suffixes: string[];
    special: RefDriverException[];
  };
  countries: {
    iso3ToIso2: Record<string, string>;
    nameToIso2: Record<string, string>;
  };
}

// MARK: Загрузка (fail-open)

export const REFS_PATH = (): string => join(process.cwd(), "data", "refs", "matching.json");

/// Карта либо читается целиком и валидна по форме, либо undefined — и
/// потребитель остаётся на встроенной таблице. Никаких исключений наружу.
export function loadRefs(path: string = REFS_PATH()): RefsMap | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined; // нет файла / битый JSON — fail-open
  }
  const m = parsed as RefsMap;
  // Незнакомая схема = «карта недоступна»: старый код не должен угадывать
  // семантику будущих версий.
  if (m?.schemaVersion !== REFS_SCHEMA_VERSION) return undefined;
  if (!Array.isArray(m.tracks) || !Array.isArray(m.pins) ||
      !Array.isArray(m.f1Teams) || !Array.isArray(m.enduranceTeams)) return undefined;
  return m;
}

// MARK: Резолв-хелперы

/// Нормализация строкового ключа матчинга: регистр Al Kamel плавает по сезонам
/// («JOTA» → «Jota» в 2026), поэтому все лукапы case-insensitive.
const norm = (s: string): string => s.trim().replace(/\s+/g, " ").toLowerCase();

/// Трасса по алиасу источника; сам слаг тоже принимается (идемпотентность).
export function trackByAlias(
  refs: RefsMap, source: RefTrackAliasSource, value: string,
): RefTrack | undefined {
  const v = norm(value);
  if (!v) return undefined;
  for (const t of refs.tracks) {
    if (t.slug === v) return t;
    if ((t.aliases[source] ?? []).some((a) => norm(a) === v)) return t;
  }
  return undefined;
}

/// F1-команда по имени OpenF1. Паритет с F1TeamSlug.swift: до rebrandSeason
/// имена, не совпадающие с собственным id команды («sauber», «kick sauber»),
/// резолвятся в историческую запись (audi → sauber для сезонов < 2026).
export function f1TeamByOpenF1Name(
  refs: RefsMap, name: string, season?: number,
): RefF1Team | undefined {
  const v = norm(name);
  if (!v) return undefined;
  const team = refs.f1Teams.find((t) => (t.openf1Names ?? []).some((n) => norm(n) === v));
  if (!team) return undefined;
  if (team.rebrandSeason !== undefined && season !== undefined &&
      season < team.rebrandSeason && v !== team.id) {
    const historic = (team.historicIds ?? [])
      .map((id) => refs.f1Teams.find((t) => t.id === id))
      .find((t) => t !== undefined);
    if (historic) return historic;
  }
  return team;
}

/// Ключ эндуранс-команды сквозь ребренды. Два прохода: точный (сезон входит в
/// identity.seasons), затем сезон-агностик — чтобы имя, доехавшее до сезона,
/// который в карту ещё не внесли, не теряло ключ (карта курируемая, сезоны
/// пополняются с отставанием).
export function enduranceTeamKey(
  refs: RefsMap, name: string, season?: number,
): string | undefined {
  const v = norm(name);
  if (!v) return undefined;
  if (season !== undefined) {
    for (const team of refs.enduranceTeams) {
      for (const id of team.identities) {
        if (id.seasons.includes(season) && id.names.some((n) => norm(n) === v)) return team.key;
      }
    }
  }
  for (const team of refs.enduranceTeams) {
    if (team.identities.some((id) => id.names.some((n) => norm(n) === v))) return team.key;
  }
  return undefined;
}

/// Pin по (source, match[, season]); pin без сезона действует для любого.
export function pinFor(
  refs: RefsMap, source: string, match: string, season?: number,
): RefPin | undefined {
  const v = norm(match);
  return refs.pins.find((p) =>
    p.source === source && norm(p.match) === v &&
    (p.season === undefined || season === undefined || p.season === season));
}

// MARK: Валидатор (используется тестом; пустой список = карта валидна)

const SLUG_RE = /^[a-z0-9-]+$/;
const ISO2_RE = /^[a-z]{2}$/;
const ISO3_RE = /^[a-z]{3}$/;

export function validateRefs(refs: RefsMap): string[] {
  const errors: string[] = [];
  const err = (msg: string): void => { errors.push(msg); };

  if (refs.schemaVersion !== REFS_SCHEMA_VERSION) {
    err(`schemaVersion ${refs.schemaVersion} ≠ ${REFS_SCHEMA_VERSION}`);
  }

  // --- Трассы: слаги уникальны, алиасы не дублируются МЕЖДУ трассами ---
  const slugs = new Set<string>();
  for (const t of refs.tracks) {
    if (!t.slug || !SLUG_RE.test(t.slug)) err(`tracks: битый слаг «${t.slug}»`);
    if (slugs.has(t.slug)) err(`tracks: дубль слага «${t.slug}»`);
    slugs.add(t.slug);
    if (!t.display) err(`tracks[${t.slug}]: пустой display`);
  }
  // Внутри одного source-пространства алиас может принадлежать только одной
  // трассе — иначе резолв недетерминирован. Кросс-пространственные совпадения
  // легальны («qatar» — и fiaDocPrefix, и fiawec-токен одной трассы).
  for (const source of REF_TRACK_ALIAS_SOURCES) {
    const owner = new Map<string, string>();
    for (const t of refs.tracks) {
      for (const a of t.aliases[source] ?? []) {
        const key = norm(a);
        if (!key) { err(`tracks[${t.slug}].${source}: пустой алиас`); continue; }
        const prev = owner.get(key);
        if (prev !== undefined && prev !== t.slug) {
          err(`tracks: алиас ${source}:«${a}» у двух трасс — ${prev} и ${t.slug}`);
        }
        owner.set(key, t.slug);
      }
    }
  }

  // --- Pins: ссылки на существующие слаги, непустой match ---
  for (const p of refs.pins) {
    if (!p.source || !p.match) err(`pins: пустой source/match (${JSON.stringify(p)})`);
    if (p.slug !== undefined && !slugs.has(p.slug)) {
      err(`pins[${p.source}:${p.match}]: слаг «${p.slug}» не существует`);
    }
    if (p.season !== undefined && !Number.isInteger(p.season)) {
      err(`pins[${p.source}:${p.match}]: season не целое`);
    }
  }

  // --- F1-команды: id уникальны, historicIds и openf1-имена без коллизий ---
  const ids = new Set<string>();
  for (const t of refs.f1Teams) {
    if (!t.id) err("f1Teams: пустой id");
    if (ids.has(t.id)) err(`f1Teams: дубль id «${t.id}»`);
    ids.add(t.id);
    if (!t.home) err(`f1Teams[${t.id}]: пустой home`);
  }
  // home живёт в пространстве circuitId Jolpica (см. тип выше) — опечатка тут
  // не ловилась НИЧЕМ: клиентский паритет-тест поле не декодирует, а до этой
  // проверки валидатор смотрел только на непустоту. Каждое значение обязано
  // резолвиться через jolpica-алиасы трасс той же карты.
  const jolpicaIds = new Set(refs.tracks.flatMap((t) => t.aliases?.jolpica ?? []));
  for (const t of refs.f1Teams) {
    if (t.home && !jolpicaIds.has(t.home)) {
      err(`f1Teams[${t.id}]: home «${t.home}» не резолвится ни одним jolpica-алиасом трасс`);
    }
  }
  const historicOwner = new Map<string, string>();
  for (const t of refs.f1Teams) {
    for (const h of t.historicIds ?? []) {
      // Исторический id может быть и самостоятельной записью (audi ← sauber),
      // но не может принадлежать двум семьям сразу.
      const prev = historicOwner.get(h);
      if (prev !== undefined) err(`f1Teams: historicId «${h}» у двух команд — ${prev} и ${t.id}`);
      historicOwner.set(h, t.id);
    }
  }
  const nameOwner = new Map<string, string>();
  for (const t of refs.f1Teams) {
    for (const n of t.openf1Names ?? []) {
      const key = norm(n);
      const prev = nameOwner.get(key);
      if (prev !== undefined && prev !== t.id) {
        err(`f1Teams: openf1-имя «${n}» у двух команд — ${prev} и ${t.id}`);
      }
      nameOwner.set(key, t.id);
    }
  }

  // --- Эндуранс-команды: ключи уникальны, сезоны identities одного key не
  // пересекаются, имя принадлежит одному key глобально (иначе резолв неоднозначен) ---
  const keys = new Set<string>();
  const teamNameOwner = new Map<string, string>();
  for (const team of refs.enduranceTeams) {
    if (!team.key || !SLUG_RE.test(team.key)) err(`enduranceTeams: битый key «${team.key}»`);
    if (keys.has(team.key)) err(`enduranceTeams: дубль key «${team.key}»`);
    keys.add(team.key);
    const seasonOwner = new Map<number, number>();
    team.identities.forEach((id, i) => {
      if (!id.names.length) err(`enduranceTeams[${team.key}]: identity #${i} без имён`);
      if (!id.seasons.length) err(`enduranceTeams[${team.key}]: identity #${i} без сезонов`);
      for (const s of id.seasons) {
        const prev = seasonOwner.get(s);
        if (prev !== undefined) {
          err(`enduranceTeams[${team.key}]: сезон ${s} в identities #${prev} и #${i}`);
        }
        seasonOwner.set(s, i);
      }
      for (const n of id.names) {
        const key = norm(n);
        const prev = teamNameOwner.get(key);
        if (prev !== undefined && prev !== team.key) {
          err(`enduranceTeams: имя «${n}» у двух ключей — ${prev} и ${team.key}`);
        }
        teamNameOwner.set(key, team.key);
      }
    });
  }

  // --- Исключения пилотов ---
  const dx = refs.driverExceptions;
  for (const p of dx?.particles ?? []) {
    if (!p || p !== p.toLowerCase()) err(`driverExceptions.particles: «${p}» не lowercase`);
  }
  for (const s of dx?.suffixes ?? []) {
    if (!s || s !== s.toLowerCase()) err(`driverExceptions.suffixes: «${s}» не lowercase`);
  }
  for (const sp of dx?.special ?? []) {
    if (!sp.canon || !sp.surname) err("driverExceptions.special: пустой canon/surname");
    if (sp.flag !== undefined && !ISO2_RE.test(sp.flag)) {
      err(`driverExceptions.special[${sp.canon}]: флаг «${sp.flag}» не ISO2`);
    }
    if (!sp.aliases?.length) err(`driverExceptions.special[${sp.canon}]: нет алиасов`);
  }

  // --- Страны ---
  for (const [k, v] of Object.entries(refs.countries?.iso3ToIso2 ?? {})) {
    if (!ISO3_RE.test(k)) err(`countries.iso3ToIso2: ключ «${k}» не ISO3`);
    if (!ISO2_RE.test(v)) err(`countries.iso3ToIso2[${k}]: «${v}» не ISO2`);
  }
  for (const [k, v] of Object.entries(refs.countries?.nameToIso2 ?? {})) {
    if (!k || k !== k.toUpperCase()) err(`countries.nameToIso2: ключ «${k}» не UPPERCASE`);
    if (!ISO2_RE.test(v)) err(`countries.nameToIso2[${k}]: «${v}» не ISO2`);
  }

  return errors;
}
