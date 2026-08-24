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
import { isStewardsFrozen } from "../lib/freeze.js";
import { scheduleSeasonMismatch } from "../lib/season.js";
import { UA } from "../lib/http.js";
import { envFlag, envNumber } from "../lib/env.js";
import {
  type DocRef, type FiaEvent, type FiaPenalty, type FiaStartingGrid,
  canReuseGrid, carryOver, eventSlugFromUrl, finalRoundFile, findSeasonUrl, isPenaltyDoc,
  markNextRace, matchRound, mergeFiaEvent, parseDocList,
  parseEventOptions, parsePenaltyDoc, parseStartingGridDoc, planPenaltyFetches, raceStartWall,
  seasonUrlYear, skipFirstWrite, slugifyRace,
  CHAMPIONSHIP_URL, PENALTY_PARSER_VERSION,
} from "../lib/fiadocs.js";


const YEAR = Number(process.env.SEASON ?? new Date().getUTCFullYear());
// Fallback, если авто-дискавери провалился (структура страницы изменилась) —
// прежняя ручная константа; правится теперь ТОЛЬКО по warning из логов.
const SEASON_URL_FALLBACK = `${CHAMPIONSHIP_URL}/season/season-2026-2072`;
const OUT_DIR = join(process.cwd(), "data", "f1", "fia");
const JOLPICA_DIR = join(process.cwd(), "data", "f1", "jolpica");
const NOW = Date.now();
// Читаем один раз на модуль: флаг нужен и в отборе раундов, и в produceEvent
// (там он снимает пропуск уже разобранных документов).
const FORCE = envFlag("FIA_FORCE");

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
const POLITE_PAUSE_MS = 200;   // между закачками PDF подряд (как в wecfia.ts)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export interface FetchOpts {
  label: string;      // как отказ подписан в логе («Doc 52», «страница сезона 2026»)
  timeoutMs: number;
  attempts: number;   // всего попыток, включая первую
  pauseMs?: number;
}

/// Почему документ не дался. Разница нужна ровно в одном месте — решении
/// «публиковать ли неполный ПЕРВЫЙ сбор раунда»:
/// * `retriable` — сеть, таймаут, 429/5xx, а также 404 на ещё не выложенный
///   документ: следующий прогон может его добрать, поэтому ждём;
/// * `permanent` — шаблон стюардов вне разбора или битый текстовый слой.
///   Такой документ не дастся НИКОГДА, пока не поправят парсер, и блокировать
///   из-за него сбор раунда нельзя (в сезоне 2026 таких 14 штук на 6 раундов:
///   «Permission to start», «Failing to set a lap time within 107%» и т.п. —
///   с блокировкой по ним половина сезона не собралась бы вовсе).
export type FetchFailure = "retriable" | "permanent";

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

/// `fail` — необязательный «выхлоп» причины отказа для вызывающего (см.
/// FetchFailure). Отдельным параметром, а не типом возврата, чтобы не трогать
/// остальные три места, которым причина не нужна.
async function fetchPdfText(
  url: string, label: string, fail?: { kind: FetchFailure },
): Promise<string | null> {
  const bytes = await fetchWithRetry(
    url,
    async (res) => new Uint8Array(await res.arrayBuffer()),
    { label, timeoutMs: 30000, attempts: PDF_ATTEMPTS },
  );
  if (!bytes) {
    if (fail) fail.kind = "retriable";
    return null;
  }
  // Отдельная ветка: сеть отработала, сломался текстовый слой — ретраить нечего,
  // но в логе это должно читаться иначе, чем сетевой отказ.
  try {
    const pdf = await getDocumentProxy(bytes);
    const { text } = await extractText(pdf, { mergePages: true });
    return text;
  } catch (e) {
    console.warn(`  ${label}: PDF не распарсился (unpdf: ${errText(e)})`);
    if (fail) fail.kind = "permanent";
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
    // Замораживаем этап через СТЮАРДСКОЕ окно оседания (14 дней — срок права
    // FIA на пересмотр: вердикт по протесту выходит на 8–10-й день, в недельное
    // окно не попадал и терялся навсегда). Длинное окно здесь безопасно и почти
    // бесплатно: файл раунда накапливается (mergeFiaEvent), а прогон докачивает
    // только недостающие документы. Позже — не рескрейпим (файл остаётся).
    const frozen = isStewardsFrozen(Date.parse(`${raceDate}T23:59:59Z`), NOW);
    const isActive = !frozen && NOW >= raceStartMs - ACTIVE_LEAD_MS;
    // FIA_FORCE=1 — разовая локальная пересборка существующих файлов (например,
    // после фикса классификатора). Он работает В ДВУХ местах: здесь возвращает
    // раунд в обработку, а внутри produceEvent снимает пропуск уже разобранных
    // документов; без второго форс стал бы no-op с приходом докача.
    // Заморозку форс ОБХОДИТ — прошедший раунд проходит по needsBackfill даже
    // с существующим файлом, — но упирается в бюджет бэкфилла, поэтому полная
    // пересборка истории пишется как FIA_FORCE=1 FIA_BACKFILL=99 npm run fia.
    const needsBackfill =
      (FORCE || !existsSync(join(OUT_DIR, `${YEAR}_${round}.json`))) &&
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

  // Уже собранный файл раунда читаем ДО закачек: он же и план докача. Вместе с
  // ним поднимается guard чужого этапа — иначе при перенумерации календаря файл
  // прошлого этапа выдал бы «doc 41 уже есть», и документы нового этапа не
  // скачались бы никогда.
  const path = join(OUT_DIR, `${YEAR}_${round}.json`);
  let existing: FiaEvent | null = null;
  try {
    existing = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    /* файла ещё нет — первый сбор раунда */
  }
  // Файл того же номера, но ЧУЖОГО этапа (перенумерация календаря, отмена
  // гонки) сливать нельзя — это смешало бы решения двух уик-эндов. Перезапись.
  // Дальше этот раунд идёт как «первый сбор» (existing = null) — и попадает под
  // тот же предохранитель неполного сбора; slug помним только ради честного лога.
  let replacedEvent: string | null = null;
  const onDiskPenalties = existing?.penalties?.length ?? 0;
  if (existing && existing.event && existing.event !== eventSlug) {
    console.warn(`  R${round}: в файле был этап «${existing.event}», теперь «${eventSlug}» — пересобираем с нуля`);
    replacedEvent = existing.event;
    existing = null;
  }

  // Штрафы. Документы, которые уже разобраны в файле ТЕКУЩЕЙ версией парсера,
  // не перекачиваем (см. докач в fiadocs.ts): файл только накапливается, и
  // пропуск ничем не рискует — он лишь откладывает обновление записи.
  const penaltyDocs = docs.filter((x) => isPenaltyDoc(x.title));
  // Пустой результат НИКОГДА не ложится поверх непустого файла. Одного guard'а
  // по слагу мало: он лишь обнуляет existing, а дальше «ноль документов, ноль
  // осечек» проходит как честный чистый сбор и публикуется. Так двенадцать
  // решений Бахрейна-2025 заменились пустышкой от тестового уик-энда.
  if (!penaltyDocs.length && onDiskPenalties) {
    console.warn(
      `::warning::R${round}: «${eventSlug}» не несёт штрафных документов, а в файле ` +
        `${onDiskPenalties} решени(й) этапа «${replacedEvent ?? eventSlug}» — файл не трогаем`,
    );
    return;
  }
  const plan = planPenaltyFetches(existing, penaltyDocs, FORCE);
  if (existing && penaltyDocs.length) {
    if (FORCE) {
      console.log(`  R${round}: FIA_FORCE=1 — перечитываем все документы`);
    } else if (plan.restamp) {
      console.log(
        `  R${round}: ${plan.restamp} документ(ов) разобрано парсером другой версии (сейчас v${PENALTY_PARSER_VERSION}) — перечитываем их`,
      );
    }
  }
  const penalties: FiaPenalty[] = [];
  let failures = 0;          // не прочитано всего — для лога
  let retriable = 0;         // из них те, что следующий прогон может добрать
  for (const d of plan.fetch) {
    const fail = { kind: "retriable" as FetchFailure };
    const text = await fetchPdfText(d.url, `Doc ${d.doc}`, fail);
    if (!text) {
      failures++;
      if (fail.kind === "retriable") retriable++;
    } else {
      const p = parsePenaltyDoc(text, d);
      if (p) {
        penalties.push(p);
      } else {
        // Шаблон вне разбора — это не осечка прогона, а работа для парсера:
        // повтор не поможет никогда, поэтому сбор раунда он не блокирует.
        failures++;
        console.warn(`  Doc ${d.doc}: шаблон стюардов не распознан (парсер)`);
      }
    }
    // Вежливая пауза между PDF (как в wecfia.ts): полсотни документов подряд
    // без неё — прямой путь к 429 от fia.com.
    await sleep(POLITE_PAUSE_MS);
  }
  penalties.sort((a, b) => a.doc - b.doc);
  console.log(
    `  R${round}: штрафных доков ${penaltyDocs.length} — пропущено (уже разобрано) ${plan.reused.length}, ` +
      `скачано ${penalties.length}, не далось ${failures}`,
  );

  // Неполный ПЕРВЫЙ сбор раунда не публикуем вовсе. Слияние спасает только то,
  // что уже лежит в файле; когда файла нет, осечка закачки — это дыра, которую
  // запись увековечивает: needsBackfill смотрит ровно на существование файла,
  // поэтому у ЗАМОРОЖЕННОГО раунда второго шанса не будет никогда (R11
  // Hungarian: 5 из 13 PDF отдали 503 → в файл легли 8 решений, доки 19, 21,
  // 36, 54, 57 потеряны навсегда, и следующие исправные прогоны раунд даже не
  // трогают). Файла нет — значит следующий прогон честно повторит бэкфилл.
  // То же правило и по той же причине живёт в f1teams.ts.
  //
  // Этим же закрыт guard чужого этапа выше: он сбрасывает existing в null, то
  // есть дальше идёт ровно «первый сбор». При отказе сети прежний файл теперь
  // остаётся нетронутым, а не подменяется огрызком нового этапа (было: в файле
  // belgian, страница отдаёт dutch → 19 штрафов превращались в 10 или в 0).
  //
  // Считаем ТОЛЬКО возвратные осечки: документ, чей шаблон парсер не знает, не
  // дастся и на сотом прогоне, а раунд из-за него не собрался бы никогда. На
  // реальных данных это не теория — в сезоне 2026 таких документов 14 на шести
  // раундах, и по ним же документированный рецепт «удали файл и прогони
  // заново» уничтожил бы 107 решений безвозвратно.
  if (skipFirstWrite(existing != null, retriable)) {
    console.warn(
      `::warning::R${round}: ${retriable} из ${plan.fetch.length} документ(ов) не прочитано по возвратной ` +
        `причине, а собранного файла этого этапа нет — ` +
        (replacedEvent
          ? `файл этапа «${replacedEvent}» НЕ подменяем огрызком нового`
          : `файл НЕ создаём: неполный первый сбор хуже отсутствия файла`) +
        ` (следующий прогон повторит сбор раунда)`,
    );
    return;
  }

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
  // Перенос ограничен временем: вердикт, опубликованный уже ПОСЛЕ старта этого
  // раунда (back-to-back + стюардское окно 14 дней), к его решётке неприменим.
  const raceWall = raceStartWall(raceDate, raceTime);
  const { carried, late } = carryOver(prev, raceWall);
  if (carried.length) {
    console.log(`  перенос из ${prevFile}: ${carried.length} грид-штраф(а)`);
  }
  // ::warning:: — дальше R+2 такой вердикт сам не уедет (carryOver смотрит ровно
  // на один предыдущий файл), это случай для ручного разбора: в summary он
  // обязан быть виден.
  for (const p of late) {
    console.warn(
      `::warning::R${round}: перенос из ${prevFile} doc ${p.doc} (car ${p.car}) опубликован ${p.publishedAt} — ` +
        `уже после старта этого раунда (${raceWall}), НЕ переношу; примени руками к следующей гонке пилота`,
    );
  }

  // Официальная стартовая решётка (Final приоритетнее Provisional).
  const gridDocs = docs.filter((d) => /starting grid/i.test(d.title));
  const gridDoc =
    gridDocs.find((d) => /final/i.test(d.title)) ?? gridDocs.find((d) => /provisional/i.test(d.title));
  let startingGrid: FiaStartingGrid | undefined;
  const gridReused = canReuseGrid(existing, gridDoc, FORCE);
  if (gridDoc && gridReused) {
    console.log(`  Doc ${gridDoc.doc} (грид): пропущен — тот же документ уже разобран`);
  } else if (gridDoc) {
    const text = await fetchPdfText(gridDoc.url, `Doc ${gridDoc.doc} (грид)`);
    if (text) {
      startingGrid = parseStartingGridDoc(text, gridDoc) ?? undefined;
      if (!startingGrid) console.warn(`  Doc ${gridDoc.doc}: решётка не распознана (парсер)`);
    }
  }

  // Слияние с уже собранным файлом раунда: прогон ДОПОЛНЯЕТ его, а не заменяет,
  // и НИКОГДА ничего не удаляет (обоснование — в mergeFiaEvent). listedDocs
  // нужен только на то, чтобы заметить пропажу и сказать о ней вслух.
  const merged = mergeFiaEvent(existing, {
    penalties,
    carried,
    startingGrid,
    listedDocs: penaltyDocs.map((d) => d.doc),
  });
  // Досюда доходят два разных случая, и путать их в логе нельзя. С непустым
  // existing спасать есть что — слияние удержит прежние решения. С пустым сюда
  // проходят ТОЛЬКО невозвратные отказы (шаблон вне разбора): прежнего файла
  // нет, спасать нечего, и документ вернётся не повтором, а правкой парсера.
  if (failures) {
    console.warn(
      existing
        ? `  R${round}: ${failures} документ(ов) не прочитано — прежние решения сохраняем, ` +
          `остальные документы уже зачтены подокументно`
        : `::warning::R${round}: ${failures} документ(ов) вне разбора парсера — раунд собран без них ` +
          `(вернутся после правки парсера и бампа PENALTY_PARSER_VERSION)`,
    );
  }
  // ::warning:: — пропажа документа разбирается человеком, а в summary прогона
  // GH Actions попадают только аннотированные строки (обычные осечки сети
  // оставлены без аннотации, иначе summary забьётся шумом уик-энда).
  for (const doc of merged.missing) {
    console.warn(
      `::warning::R${round}: doc ${doc} пропал со страницы FIA — оставляю в файле, проверь руками ` +
        `(если документ и правда отозван — удали data/f1/fia/${YEAR}_${round}.json и прогони заново: ` +
        `FIA_FORCE только перекачивает документы, а слияние сохраняет прежнюю запись безусловно)`,
    );
  }

  // Классификацию «эта гонка / следующая» пересчитываем на ИТОГЕ слияния:
  // решения из файла больше не перечитываются, и разовая пометка застыла бы
  // навсегда (напр. при запоздавшем raceTime у Jolpica). Идемпотентно.
  const penaltiesOut = markNextRace(merged.penalties, raceWall);

  const out: FiaEvent = {
    season: YEAR,
    round,
    event: eventSlug,
    ...(merged.updated ? { updated: merged.updated } : {}),
    penalties: penaltiesOut,
    ...(merged.startingGrid ? { startingGrid: merged.startingGrid } : {}),
  };
  const changed = writeJSONWithEnvelope(path, out);
  // merged.kept считает всё, что пришло из файла: и намеренно пропущенное
  // докачом, и уцелевшее после осечки, и то, что вообще не появилось в
  // листинге. В логе разводим — иначе «из файла 19» на штатном докаче читается
  // как «19 раз не скачалось».
  const rescued = merged.kept - plan.reused.length;
  // Только ЯРЛЫК для лога (сравнение по ссылке: взяли ли мы разобранную в этом
  // прогоне решётку). Ни на что не влияет — прежний гейт «свежести файла» с
  // таким же сравнением как раз и ломал докач, поэтому решения он не принимает.
  const gridFromFile = merged.startingGrid != null && merged.startingGrid !== startingGrid;
  console.log(
    `  R${round}: в файле ${penaltiesOut.length} штрафов (переносов ${carried.length}` +
      `${rescued > 0 ? `, из файла без перечитки ${rescued}: осечки/пропажи` : ""}), ` +
      `грид: ${merged.startingGrid ? merged.startingGrid.kind : "нет"}${gridFromFile ? " (из файла)" : ""} → ` +
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
