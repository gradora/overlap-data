// Продьюсер решений IMSA (RACE CONTROL на странице события) — источник PDF
// «IMSA PENALTY NOTICE» из Notice Board Al Kamel:
// /Results_NoticeBoard/<сезон>/<раунд>/18_Penalties/{TP|SP} YY-N.pdf
// (TP — Technical, SP — Sporting; нумерация сквозная по сезону). В папке
// раунда лежат нотисы всех серий уикенда — фильтруем по полю SERIES: IWSC.
// Сезон-2026 в Notice Board назван «26-2026» (дефис, не подчёркивание).
// Выход: data/imsa/fia/<season>_<round>.json — формат FiaEvent, как f1/wec.

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { extractText, getDocumentProxy } from "unpdf";
import {
  classifyDecision, mergeStewardsPenalties, planStewardsFetches, skipFirstWrite,
  type FiaEvent, type FiaPenalty, type StewardsListedDoc,
  fineAmountEur,
} from "../lib/fiadocs.js";
import { matchImsaTrack } from "../lib/alkamelimsa.js";
import { isStewardsFrozen } from "../lib/freeze.js";
import {writeJSONWithEnvelope } from "../lib/mirror.js";
import { SCHEDULE } from "../lib/schedule.js";
import { slugify } from "../lib/slug.js";
import { fetchWithRetryLog, lastModifiedISO, type RetryLogFail } from "../lib/http.js";
import { envFlag, envNumber } from "../lib/env.js";

const YEAR = Number(process.env.SEASON ?? new Date().getUTCFullYear());
const OUT_DIR = join(process.cwd(), "data", "imsa", "fia");
const NB_BASE = "https://imsa.results.alkamelcloud.com/Results_NoticeBoard";
const NOW = Date.now();
// Читаем один раз на модуль (как FIA_FORCE в fia.ts): флаг нужен и в отборе
// раундов, и в produceRound — там он снимает пропуск уже разобранных нотисов.
const FORCE = envFlag("IMSA_FIA_FORCE");

// ВЕРСИЯ IMSA-ПАРСЕРА — БАМПАТЬ ПРИ ЛЮБОЙ СМЫСЛОВОЙ ПРАВКЕ разбора:
// parseImsaPenaltyPdf / imsaDocFromName / imsaNoticeSeries (classifyDecision —
// общий с F1, его правка бампает и эту константу, и PENALTY_PARSER_VERSION).
// Продьюсер не перекачивает нотисы, уже разобранные в файле текущей версией, —
// без бампа правка парсера НЕ ДОЙДЁТ до старых записей. Константа СВОЯ, не
// F1-шная: парсеры стареют независимо, и бамп F1-классификатора не должен
// гнать перекачку чужих PDF (и наоборот). Обходы: IMSA_FIA_FORCE=1 или бамп.
export const IMSA_PENALTY_PARSER_VERSION = 1;

// MARK: HTTP (Notice Board живёт вне /Results — свой построитель URL; ретраи
// и различимая диагностика — общая механика fetchWithRetryLog из http.ts)

const PAGE_ATTEMPTS = 3;
const PDF_ATTEMPTS = 2;
const POLITE_PAUSE_MS = 200;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function nbURL(segments: string[]): string {
  let url = NB_BASE;
  for (const seg of segments) url += "/" + encodeURIComponent(seg);
  if (!segments[segments.length - 1]?.includes(".")) url += "/";
  return url;
}

/// `fail.status` — HTTP-код устойчивого отказа: вызывающему нужно отличать
/// 404 листинга (папки нет — нотисов не выписывали, штатно) от сетевой осечки.
async function nbHTML(segments: string[], label: string, fail?: RetryLogFail): Promise<string | null> {
  return fetchWithRetryLog(nbURL(segments), (res) => res.text(), {
    label, timeoutMs: 30000, attempts: PAGE_ATTEMPTS,
  }, fail);
}

function nbHrefs(html: string): string[] {
  const out: string[] = [];
  const re = /href="([^"]+)"/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const href = m[1];
    if (href.startsWith("/") || href.startsWith("?") || href.startsWith("#") || href === "../") continue;
    try {
      out.push(decodeURIComponent(href));
    } catch {
      out.push(href);
    }
  }
  return out;
}

// MARK: Разбор PDF

/// «TP 26-11.pdf» → {kind: Technical, doc: 11}; не нотис → null.
export function imsaDocFromName(name: string): { kind: string; doc: number } | null {
  const m = name.match(/^(TP|SP)\s*\d{2}\s*-\s*(\d+)\.pdf$/i);
  if (!m) return null;
  return { kind: m[1].toUpperCase() === "TP" ? "Technical" : "Sporting", doc: Number(m[2]) };
}

const field = (text: string, re: RegExp): string =>
  (re.exec(text)?.[1] ?? "").replace(/\s+/g, " ").trim();

/// Серия нотиса — вынесена из parseImsaPenaltyPdf, чтобы прогон отличал
/// «чужая серия уик-энда» (штатный скип IMPC и младших) от «шаблон нашей серии
/// не распознан» (работа для парсера, громкий лог).
export function imsaNoticeSeries(text: string): string | null {
  return /\b(IWSC|IMPC|IMSA WeatherTech)\b/.exec(text)?.[1] ?? null;
}

/// Текст «IMSA PENALTY NOTICE» → FiaPenalty. Не-IWSC (Pilot Challenge и
/// младшие серии) и нераспознанные формы → null.
export function parseImsaPenaltyPdf(
  text: string, kind: string, doc: number, url: string, publishedAt?: string,
): FiaPenalty | null {
  // Серия — значение после кластера меток EVENT:/SERIES:/TEAM:.
  const series = imsaNoticeSeries(text);
  if (series !== "IWSC" && series !== "IMSA WeatherTech") return null;

  // Номер машины и класс — из бейджа ENTRY, вынесенного к «RETURN TROPHY».
  const entry = /RETURN TROPHY\s+(\w+)\s+((?:GTP|LMP2|LMP3|GTD PRO|GTDPRO|GTD|GSX?|TCR)\b(?:\s*PRO)?)\s+TYPE:/i.exec(text);
  const car = Number(entry?.[1]?.replace(/^0+/, "") ?? NaN);
  if (!Number.isFinite(car)) return null;

  const team = field(text, /\b(?:IWSC|IMPC)\b\s+(.*?)\s+ENTRANT REPRESENTATIVE:/s);
  let driver = field(text, /DRIVER:\s*(.*?)\s*AFFECTED PARTY:/s)
    .replace(/\s*\([^)]*\)\s*$/, "");
  if (!driver) driver = team;
  const fine = field(text, /PENALTY\s*FINE:\s*(.*?)\s*CHANGE:/s);
  const change = field(text, /CHANGE:\s*(.*?)\s*SIGNATURES/s);

  const parts: string[] = [];
  if (change && !/^n\/?a$/i.test(change)) parts.push(change);
  if (fine && !/^n\/?a$/i.test(fine)) parts.push(`Fine of ${fine}`);
  const decision = parts.join(". ") || change || fine;
  if (!decision) return null;

  let cls = classifyDecision(decision);
  if (/lap times? (?:are |is )?invalidated/i.test(decision) && cls.type === "other") {
    cls = { type: "deleted_laps" };
  }

  return {
    doc,
    parser: IMSA_PENALTY_PARSER_VERSION,
    car,
    driver,
    session: kind, // «Technical» | «Sporting» — сессию нотис не указывает
    ...cls,
    appliesTo: "race",
    corrected: false,
    ...(fineAmountEur(decision) != null ? { fineEur: fineAmountEur(decision)! } : {}),
    url,
    publishedAt,
  };
}

/// Почему нотис не дался — различение то же, что у fia.ts, и нужно оно тому же
/// решению «публиковать ли неполный ПЕРВЫЙ сбор» (skipFirstWrite): сетевой
/// отказ возвратный, битый текстовый слой PDF — нет (лечится правкой парсера).
type ImsaFetchFailure = "retriable" | "permanent";

/// PDF → текст + Last-Modified (ISO, единая нормализация с wecfia).
async function fetchPdf(
  segments: string[], label: string, fail?: { kind: ImsaFetchFailure },
): Promise<{ text: string; publishedAt?: string } | null> {
  const got = await fetchWithRetryLog(
    nbURL(segments),
    async (res) => ({
      bytes: new Uint8Array(await res.arrayBuffer()),
      publishedAt: lastModifiedISO(res),
    }),
    { label, timeoutMs: 30000, attempts: PDF_ATTEMPTS },
  );
  if (!got) {
    if (fail) fail.kind = "retriable";
    return null;
  }
  try {
    const docProxy = await getDocumentProxy(got.bytes);
    const { text } = await extractText(docProxy, { mergePages: true });
    return { text, ...(got.publishedAt ? { publishedAt: got.publishedAt } : {}) };
  } catch (e) {
    console.warn(`  ${label}: PDF не распарсился (unpdf: ${e instanceof Error ? e.message : e})`);
    if (fail) fail.kind = "permanent";
    return null;
  }
}

// MARK: Прогон

async function main(): Promise<void> {
  console.log(`IMSA penalties, season ${YEAR}`);
  mkdirSync(OUT_DIR, { recursive: true });

  const schedule = SCHEDULE[YEAR];
  if (!schedule) {
    console.log(`  нет курируемого расписания ${YEAR} — выходим`);
    return;
  }

  // Сезон Notice Board: у 2026 дефис («26-2026»), у прошлых подчёркивание.
  let seasonSeg: string | null = null;
  const rootHTML = await nbHTML([], "корень Notice Board");
  if (rootHTML) {
    const dirs = nbHrefs(rootHTML).filter((h) => h.endsWith("/")).map((h) => h.slice(0, -1));
    seasonSeg = dirs.find((d) => d === `${YEAR % 100}-${YEAR}` || d === `${YEAR % 100}_${YEAR}`) ?? null;
  }
  if (!seasonSeg) {
    console.log("  сезон в Notice Board не найден — выходим");
    return;
  }
  const seasonHTML = await nbHTML([seasonSeg], `листинг сезона ${YEAR}`);
  if (!seasonHTML) {
    console.log("  листинг сезона не открылся — выходим");
    return;
  }
  const roundDirs = nbHrefs(seasonHTML).filter((h) => h.endsWith("/")).map((h) => h.slice(0, -1));

  let backfill = envNumber("IMSA_FIA_BACKFILL", 1);

  for (const entry of schedule) {
    const endMs = Date.parse(`${entry.endDate}T23:59:59Z`);
    const started = Date.parse(`${entry.startDate}T00:00:00Z`) - 24 * 3600 * 1000 < NOW;
    if (!started) continue;
    const path = join(OUT_DIR, `${YEAR}_${entry.round}.json`);
    const exists = existsSync(path);
    // Стюардское окно оседания (14 дней — срок права FIA на пересмотр), как у
    // fia.ts: длинное окно стало безопасным ровно тогда, когда файл раунда
    // перестал перезаписываться итогом прогона — теперь он НАКАПЛИВАЕТСЯ
    // (mergeStewardsPenalties в produceRound, ключ session#doc: нумерация TP и
    // SP сквозная и независимая), пустой сбор поверх непустого файла запрещён,
    // а докач тянет только недостающие нотисы. Это завершает решение «14 дней
    // для всех трёх продьюсеров решений стюардов», отложенное именно из-за
    // отсутствия слияния.
    if (exists && isStewardsFrozen(endMs, NOW) && !FORCE) continue;   // было truthy: «=0» форсировал
    if (!exists && endMs < NOW) {
      if (backfill <= 0) continue;
      backfill--;
    }
    await produceRound(seasonSeg, roundDirs, entry, path);
  }
  console.log("Done.");
}

async function produceRound(
  seasonSeg: string,
  roundDirs: string[],
  entry: { round: number; venue: string },
  path: string,
): Promise<void> {
  const round = entry.round;
  const slug = slugify(entry.venue);

  // Уже собранный файл раунда читаем ДО закачек: он же и план докача (как в
  // fia.ts). Вместе с ним поднимается guard чужого этапа.
  let existing: FiaEvent | null = null;
  try {
    existing = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    /* файла ещё нет — первый сбор раунда */
  }
  // Файл того же номера, но ЧУЖОГО этапа (перенумерация курируемого
  // расписания) сливать нельзя — это смешало бы решения двух уик-эндов.
  // Дальше раунд идёт как «первый сбор» (existing = null) и попадает под
  // предохранители ниже: при осечках прежний файл остаётся нетронутым.
  let replacedEvent: string | null = null;
  const onDiskPenalties = existing?.penalties?.length ?? 0;
  if (existing && existing.event && existing.event !== slug) {
    console.warn(`  R${round}: в файле был этап «${existing.event}», теперь «${slug}» — пересобираем с нуля`);
    replacedEvent = existing.event;
    existing = null;
  }

  // Листинги папок — ДО закачек: полный список нотисов и есть план докача.
  const matched = roundDirs.filter((d) => matchImsaTrack(d, entry.venue));
  const listed: (StewardsListedDoc & { kind: string; doc: number; segments: string[] })[] = [];
  let retriable = 0;   // возвратные осечки (сеть/таймаут/429/5xx) — и листингов, и PDF
  for (const dir of matched) {
    const segments = [seasonSeg, dir, "18_Penalties"];
    const fail: RetryLogFail = {};
    const penHTML = await nbHTML(segments, `R${round}: листинг 18_Penalties (${dir})`, fail);
    if (penHTML == null) {
      // 404 — штатное «папки нет, нотисов не выписывали», не осечка. Всё
      // прочее — возвратно: блокирует ПЕРВЫЙ сбор (см. skipFirstWrite ниже),
      // а существующему файлу слияние и так ничего не даёт потерять.
      if (fail.status !== 404) retriable++;
      continue;
    }
    for (const name of nbHrefs(penHTML).filter((h) => !h.endsWith("/"))) {
      const ref = imsaDocFromName(name);
      if (!ref) continue;
      const seg = [...segments, name];
      listed.push({
        // Ключ решения — session#doc: «TP 26-11» и «SP 26-11» — РАЗНЫЕ нотисы
        // одного уик-энда (сквозные независимые нумерации), голый doc смешал бы их.
        key: `${ref.kind}#${ref.doc}`,
        url: nbURL(seg),
        corrected: false,   // переизданий с пометкой у IMSA-нотисов нет
        kind: ref.kind,
        doc: ref.doc,
        segments: seg,
      });
    }
  }

  // Пустой листинг поверх непустого файла не публикуем: раньше несматченная
  // папка раунда или упавший листинг клали пустой файл поверх хорошего.
  if (!listed.length && onDiskPenalties) {
    console.warn(
      `::warning::R${round}: нотисов в листинге нет${retriable ? " (листинг не дался)" : ""}, ` +
        `а в файле ${onDiskPenalties} решени(й) этапа «${replacedEvent ?? slug}» — файл не трогаем`,
    );
    return;
  }

  // Подокументный докач: разобранное текущей версией парсера не перекачиваем.
  const keyOf = (p: FiaPenalty): string => `${p.session}#${p.doc}`;
  const plan = planStewardsFetches(existing?.penalties ?? [], listed, keyOf, IMSA_PENALTY_PARSER_VERSION, FORCE);
  if (existing && listed.length) {
    if (FORCE) {
      console.log(`  R${round}: IMSA_FIA_FORCE=1 — перечитываем все нотисы`);
    } else if (plan.restamp) {
      console.log(
        `  R${round}: ${plan.restamp} нотис(ов) разобрано парсером другой версии (сейчас v${IMSA_PENALTY_PARSER_VERSION}) — перечитываем их`,
      );
    }
  }

  const penalties: FiaPenalty[] = [];
  let failures = 0;   // не прочитано всего (в т.ч. возвратные) — для лога
  for (const d of plan.fetch) {
    const fail = { kind: "retriable" as ImsaFetchFailure };
    const pdf = await fetchPdf(d.segments, `${d.kind} ${d.doc}`, fail);
    if (!pdf) {
      failures++;
      if (fail.kind === "retriable") retriable++;
    } else {
      const p = parseImsaPenaltyPdf(pdf.text, d.kind, d.doc, d.url, pdf.publishedAt);
      if (p) {
        penalties.push(p);
      } else if (imsaNoticeSeries(pdf.text) === "IWSC" || imsaNoticeSeries(pdf.text) === "IMSA WeatherTech") {
        // Шаблон НАШЕЙ серии вне разбора — не осечка прогона, а работа для
        // парсера: повтор не поможет, сбор раунда не блокирует.
        failures++;
        console.warn(`  ${d.kind} ${d.doc}: шаблон нотиса не распознан (парсер)`);
      }
      // Чужая серия уик-энда (IMPC и младшие) — штатный молчаливый скип.
    }
    await sleep(POLITE_PAUSE_MS);
  }
  console.log(
    `  R${round} (${entry.venue}): нотисов ${listed.length} (папок: ${matched.length}) — ` +
      `пропущено (уже разобрано) ${plan.reused.length}, скачано ${penalties.length}, не далось ${failures}`,
  );

  // Неполный ПЕРВЫЙ сбор раунда не публикуем вовсе (правило и обоснование —
  // fia.ts/skipFirstWrite): файла нет — слиянию спасать нечего, а записанный
  // огрызок закрыл бы раунду дорогу назад (бэкфилл смотрит на существование
  // файла). Блокируют только ВОЗВРАТНЫЕ осечки.
  if (skipFirstWrite(existing != null, retriable)) {
    console.warn(
      `::warning::R${round}: ${retriable} возвратных осечек, а собранного файла этапа нет — ` +
        (replacedEvent
          ? `файл этапа «${replacedEvent}» НЕ подменяем огрызком нового`
          : `файл НЕ создаём: неполный первый сбор хуже отсутствия файла`) +
        ` (следующий прогон повторит сбор раунда)`,
    );
    return;
  }

  // Слияние с файлом раунда: прогон ДОПОЛНЯЕТ его и НИКОГДА ничего не удаляет
  // (политика mergeFiaEvent — обоснование там).
  const merged = mergeStewardsPenalties(
    existing?.penalties ?? [], penalties, listed.map((d) => d.key), keyOf,
  );
  // ::warning:: — пропажа нотиса разбирается человеком (см. mergeFiaEvent:
  // вычистить и правда отозванный можно только удалив файл раунда).
  for (const key of merged.missing) {
    console.warn(
      `::warning::R${round}: нотис ${key} пропал из листинга Notice Board — оставляю в файле, проверь ` +
        `руками (если нотис и правда отозван — удали data/imsa/fia/${YEAR}_${round}.json и прогони заново)`,
    );
  }

  const out: FiaEvent = {
    season: YEAR,
    round,
    event: slug,
    ...(merged.updated ? { updated: merged.updated } : {}),
    penalties: merged.penalties,
  };
  const changed = writeJSONWithEnvelope(path, out);
  const rescued = merged.kept - plan.reused.length;
  console.log(
    `  R${round} (${entry.venue}): в файле ${merged.penalties.length} решений` +
      `${rescued > 0 ? ` (из файла без перечитки ${rescued}: осечки/пропажи)` : ""} → ` +
      `${changed ? "записано" : "без изменений"}`,
  );
}

// Запуск только как продьюсер (не при импорте из теста).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
