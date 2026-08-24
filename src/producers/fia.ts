// Продьюсер решений стюардов FIA (штрафы) для F1 — источник fia.com/documents.
// Скрейпит server-rendered список документов текущего этапа, парсит штрафные
// PDF (шаблон стюардов: поля No/Driver, Session, Decision …) и официальный
// «Starting Grid», кладёт структурный data/f1/fia/<season>_<round>.json.
// Приложение читает его и прикрепляет пенальти к квале/гриду.
//
// Извлечение текста PDF — через unpdf (обёртка pdf.js). Текстовый слой у
// FIA-PDF чистый (не сканы). Продьюсер ТОЛЕРАНТЕН (как openf1): недоступность
// fia.com / сбой парсинга одного PDF не валит крон.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { extractText, getDocumentProxy } from "unpdf";
import { scheduleMirrorFile, writeJSONWithEnvelope } from "../lib/mirror.js";
import { isFrozen } from "../lib/freeze.js";
import { scheduleSeasonMismatch } from "../lib/season.js";
import { UA } from "../lib/http.js";
import { envFlag, envNumber } from "../lib/env.js";
import {
  type DocRef, type FiaEvent, type FiaPenalty, type FiaStartingGrid,
  carryOver, eventSlugFromUrl, finalRoundFile, findSeasonUrl, isPenaltyDoc,
  markNextRace, matchRound, mergeFiaEvent, parseDocList,
  parseEventOptions, parsePenaltyDoc, parseStartingGridDoc, raceStartWall,
  seasonUrlYear, slugifyRace,
  CHAMPIONSHIP_URL,
} from "../lib/fiadocs.js";


const YEAR = Number(process.env.SEASON ?? new Date().getUTCFullYear());
// Fallback, если авто-дискавери провалился (структура страницы изменилась) —
// прежняя ручная константа; правится теперь ТОЛЬКО по warning из логов.
const SEASON_URL_FALLBACK = `${CHAMPIONSHIP_URL}/season/season-2026-2072`;
const OUT_DIR = join(process.cwd(), "data", "f1", "fia");
const JOLPICA_DIR = join(process.cwd(), "data", "f1", "jolpica");
const NOW = Date.now();

function jolpicaSchedule(): {
  season: string | null;
  races: { round: string; date: string; time?: string; raceName: string }[];
} {
  try {
    const d = JSON.parse(readFileSync(join(JOLPICA_DIR, scheduleMirrorFile(YEAR)), "utf8"));
    const table = d?.MRData?.RaceTable;
    return { season: table?.season ?? null, races: table?.Races ?? [] };
  } catch {
    return { season: null, races: [] };
  }
}

// ---- Сеть ----

// Общий null был слепым: в логе крона «PDF недоступен/не распарсился» одинаково
// значило и 404 (документ ещё не выложен), и таймаут, и битый текстовый слой —
// разбирать сбой уик-энда было не по чему. Теперь причина в логе явная, а на
// то, что имеет шанс пройти со второй попытки (обрыв связи, таймаут, 429/5xx),
// делаем ретрай с паузой. На 4xx ретрай бессмысленен — на сервере ничего нет.
const PAGE_ATTEMPTS = 3;   // страниц немного — можно позволить два повтора
const PDF_ATTEMPTS = 2;    // документов полсотни: один повтор, чтобы не растянуть прогон
const RETRY_PAUSE_MS = 1500;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export interface FetchOpts {
  label: string;      // как отказ подписан в логе («Doc 52», «страница сезона 2026»)
  timeoutMs: number;
  attempts: number;   // всего попыток, включая первую
  pauseMs?: number;
}

/// Чтение ответа с ретраем и внятным логом. null — устойчивый отказ.
export async function fetchWithRetry<T>(
  url: string,
  read: (res: Response) => Promise<T>,
  opts: FetchOpts,
): Promise<T | null> {
  const { label, timeoutMs, attempts, pauseMs = RETRY_PAUSE_MS } = opts;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    let retriable = false;
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA }, signal: ctrl.signal });
      if (res.ok) return await read(res);
      retriable = res.status === 429 || res.status >= 500;
      console.warn(`  ${label}: HTTP ${res.status}${retriable ? "" : " — повтор не поможет"}`);
    } catch (e) {
      // Сработал наш AbortController → это таймаут, иначе — обрыв связи/DNS.
      retriable = true;
      console.warn(
        `  ${label}: ${ctrl.signal.aborted ? `таймаут ${timeoutMs / 1000}с` : `сеть — ${errText(e)}`}`,
      );
    } finally {
      clearTimeout(t);
    }
    if (!retriable || attempt === attempts) return null;
    console.log(`  ${label}: повтор ${attempt}/${attempts - 1} через ${pauseMs / 1000}с`);
    await sleep(pauseMs);
  }
  return null;
}

async function fetchHtml(url: string, label = "страница"): Promise<string | null> {
  return fetchWithRetry(url, (res) => res.text(), { label, timeoutMs: 20000, attempts: PAGE_ATTEMPTS });
}

async function fetchPdfText(url: string, label: string): Promise<string | null> {
  const bytes = await fetchWithRetry(
    url,
    async (res) => new Uint8Array(await res.arrayBuffer()),
    { label, timeoutMs: 30000, attempts: PDF_ATTEMPTS },
  );
  if (!bytes) return null;
  // Отдельная ветка: сеть отработала, сломался текстовый слой — ретраить нечего,
  // но в логе это должно читаться иначе, чем сетевой отказ.
  try {
    const pdf = await getDocumentProxy(bytes);
    const { text } = await extractText(pdf, { mergePages: true });
    return text;
  } catch (e) {
    console.warn(`  ${label}: PDF не распарсился (unpdf: ${errText(e)})`);
    return null;
  }
}

// ---- Продьюсер ----

// Авто-дискавери URL сезона: со стабильной страницы чемпионата выуживаем
// node-id за YEAR; провал (структура изменилась / не server-rendered) →
// прежняя хардкод-константа + warning как сигнал протухания. В худшем случае
// поведение идентично прежнему, но громкое.
async function resolveSeasonUrl(): Promise<string | null> {
  const champHtml = await fetchHtml(CHAMPIONSHIP_URL, "страница чемпионата");
  const url = champHtml ? findSeasonUrl(champHtml, YEAR) : null;
  if (url) return url;
  // Фолбэк за другой год — скрейпить ЧУЖОЙ сезон (январское окно, пока FIA не
  // создала season-ноду нового года): события 2026 писались бы в файлы 2027_N.
  // Лучше честный пропуск прогона, чем страница не того сезона.
  if (seasonUrlYear(SEASON_URL_FALLBACK) !== YEAR) {
    console.warn(
      `FIA: season-${YEAR} не найден, а fallback за ${seasonUrlYear(SEASON_URL_FALLBACK)} — пропускаем прогон (обнови SEASON_URL_FALLBACK по появлении ноды сезона)`,
    );
    return null;
  }
  console.warn(
    `FIA: season-${YEAR} не найден на странице чемпионата — fallback ${SEASON_URL_FALLBACK} (проверь node-id вручную)`,
  );
  return SEASON_URL_FALLBACK;
}

async function main() {
  console.log(`FIA decisions, season ${YEAR}`);
  const { season: scheduleSeason, races } = jolpicaSchedule();
  // Гонка флипов: YEAR уже новый, а зеркало Jolpica ещё за прошлый сезон (или
  // наоборот). Матчить события к чужому календарю — писать прошлогодние штрафы
  // в файлы нового сезона (backfill за ~12ч отравил бы все раунды).
  if (scheduleSeasonMismatch(scheduleSeason, YEAR)) {
    console.warn(
      `FIA: зеркало расписания за сезон ${scheduleSeason}, YEAR=${YEAR} — переходное окно, пропускаем прогон`,
    );
    return;
  }
  const seasonUrl = await resolveSeasonUrl();
  if (!seasonUrl) return;
  const seasonHtml = await fetchHtml(seasonUrl, `страница сезона ${YEAR}`);
  if (!seasonHtml) {
    console.warn("FIA страница недоступна — пропускаем прогон (толерантно)");
    return;
  }
  const events = parseEventOptions(seasonHtml)
    .map((e) => ({ ...e, m: matchRound(slugifyRace(e.name), races) }))
    .sort((a, b) => (a.m?.round ?? 99) - (b.m?.round ?? 99));
  if (!events.length) {
    console.warn("FIA: селектор этапов не распарсился — пропускаем");
    return;
  }

  // Бюджет бэкфилла прошлых этапов за прогон (вежливость к fia.com): недостающие
  // файлы добираются постепенно, по возрастанию раунда (carryOver читает R-1).
  // Активный уик-энд (с четверга до заморозки) обрабатывается всегда.
  let backfill = envNumber("FIA_BACKFILL", 2);
  const ACTIVE_LEAD_MS = 4 * 24 * 3600 * 1000;

  for (const ev of events) {
    if (!ev.m) {
      console.warn(`  «${ev.name}»: нет в расписании Jolpica — пропускаем`);
      continue;
    }
    const { round, raceDate, raceTime } = ev.m;
    const raceStartMs = Date.parse(`${raceDate}T00:00:00Z`);
    // Замораживаем этап через окно оседания после гонки (штрафы могут
    // корректировать до ~7д). Позже — не рескрейпим (вежливо; файл остаётся).
    const frozen = isFrozen(Date.parse(`${raceDate}T23:59:59Z`), NOW);
    const isActive = !frozen && NOW >= raceStartMs - ACTIVE_LEAD_MS;
    // FIA_FORCE=1 — разовая локальная пересборка существующих файлов
    // (например, после фикса классификатора).
    const needsBackfill =
      (envFlag("FIA_FORCE") || !existsSync(join(OUT_DIR, `${YEAR}_${round}.json`))) &&
      raceStartMs < NOW;
    if (!isActive && !needsBackfill) continue;
    if (!isActive) {
      if (backfill <= 0) continue;
      backfill--;
      console.log(`  backfill R${round} (${ev.name})`);
    }
    const html = await fetchHtml(ev.url, `R${round}: страница события`);
    if (!html) {
      // Причина уже в логе (HTTP-код / таймаут); файл раунда не трогаем.
      console.warn(`  R${round}: страница события недоступна — файл оставляем как есть`);
      continue;
    }
    const docs = parseDocList(html);
    if (!docs.length) {
      console.log(`  R${round}: документов нет`);
      continue;
    }
    await produceEvent(docs, round, raceDate, raceTime);
  }
  console.log("Done.");
}

async function produceEvent(docs: DocRef[], round: number, raceDate: string, raceTime?: string) {
  const eventSlug = docs.map((d) => eventSlugFromUrl(d.url)).find((s): s is string => !!s);
  if (!eventSlug) {
    console.warn(`  R${round}: не извлёк event-slug — пропускаем`);
    return;
  }
  console.log(`  ${eventSlug} → R${round}, ${docs.length} документов`);

  // Штрафы. Осечки считаем: файл раунда сливается с прежним, и «документ
  // отозван» можно утверждать только по прогону, прочитавшему список целиком.
  const penaltyDocs = docs.filter((x) => isPenaltyDoc(x.title));
  let penalties: FiaPenalty[] = [];
  let failures = 0;
  for (const d of penaltyDocs) {
    const text = await fetchPdfText(d.url, `Doc ${d.doc}`);
    if (!text) {
      failures++;
      continue;
    }
    const p = parsePenaltyDoc(text, d);
    if (p) {
      penalties.push(p);
    } else {
      failures++;
      console.warn(`  Doc ${d.doc}: шаблон стюардов не распознан (парсер)`);
    }
  }
  penalties.sort((a, b) => a.doc - b.doc);

  // Пост-гоночные грид-штрафы → «на следующую гонку» (по времени публикации).
  penalties = markNextRace(penalties, raceStartWall(raceDate, raceTime));

  // Перенос next_race-штрафов из предыдущего раунда в текущий. Для R1
  // «предыдущий» — финал ПРОШЛОГО сезона: грид-штраф, выданный после старта
  // финала, по спортрегламенту переносится через межсезонье на первую гонку
  // пилота нового года. Финал ищем по максимальному существующему файлу.
  let prevFile: string | null = `${YEAR}_${round - 1}.json`;
  if (round === 1) {
    let files: string[] = [];
    try {
      files = readdirSync(OUT_DIR);
    } catch {
      /* директории ещё нет — переносить нечего */
    }
    prevFile = finalRoundFile(files, YEAR - 1);
  }
  let prev: FiaEvent | null = null;
  try {
    if (prevFile) prev = JSON.parse(readFileSync(join(OUT_DIR, prevFile), "utf8"));
  } catch {
    /* первого раунда/файла нет — переносить нечего */
  }
  // Переносы держим ОТДЕЛЬНО от собственных решений раунда: слияние пересобирает
  // их заново каждый прогон (carryOver читает локальный файл, сеть ни при чём).
  const carried = carryOver(prev);
  if (carried.length) {
    console.log(`  перенос из ${prevFile}: ${carried.length} грид-штраф(а)`);
  }

  // Официальная стартовая решётка (Final приоритетнее Provisional).
  const gridDocs = docs.filter((d) => /starting grid/i.test(d.title));
  const gridDoc =
    gridDocs.find((d) => /final/i.test(d.title)) ?? gridDocs.find((d) => /provisional/i.test(d.title));
  let startingGrid: FiaStartingGrid | undefined;
  if (gridDoc) {
    const text = await fetchPdfText(gridDoc.url, `Doc ${gridDoc.doc} (грид)`);
    if (text) {
      startingGrid = parseStartingGridDoc(text, gridDoc) ?? undefined;
      if (!startingGrid) console.warn(`  Doc ${gridDoc.doc}: решётка не распознана (парсер)`);
    }
  }

  // Слияние с уже собранным файлом раунда: прогон ДОПОЛНЯЕТ его, а не заменяет.
  const path = join(OUT_DIR, `${YEAR}_${round}.json`);
  let existing: FiaEvent | null = null;
  try {
    existing = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    /* файла ещё нет — первый сбор раунда */
  }
  // Файл того же номера, но ЧУЖОГО этапа (перенумерация календаря, отмена
  // гонки) сливать нельзя — это смешало бы решения двух уик-эндов. Перезапись.
  if (existing && existing.event && existing.event !== eventSlug) {
    console.warn(`  R${round}: в файле был этап «${existing.event}», теперь «${eventSlug}» — пересобираем с нуля`);
    existing = null;
  }
  const complete = failures === 0;
  const merged = mergeFiaEvent(existing, {
    penalties,
    carried,
    startingGrid,
    listedDocs: penaltyDocs.map((d) => d.doc),
    complete,
  });
  if (failures) {
    console.warn(
      `  R${round}: ${failures} документ(ов) не прочитано — прежние решения сохраняем, удалений не делаем`,
    );
  }
  if (merged.dropped) {
    console.log(`  R${round}: ${merged.dropped} решение(й) исчезло со страницы FIA (отзыв) — убрано`);
  }

  const out: FiaEvent = {
    season: YEAR,
    round,
    event: eventSlug,
    ...(merged.updated ? { updated: merged.updated } : {}),
    penalties: merged.penalties,
    ...(merged.startingGrid ? { startingGrid: merged.startingGrid } : {}),
  };
  const changed = writeJSONWithEnvelope(path, out);
  console.log(
    `  ${merged.penalties.length} штрафов (в прогоне ${penalties.length}, из файла ${merged.kept}, переносов ${carried.length}), ` +
      `грид: ${merged.startingGrid ? merged.startingGrid.kind : "нет"} → ${changed ? "записано" : "без изменений"}`,
  );
}

// Запуск только как продьюсер (не при импорте из теста).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
