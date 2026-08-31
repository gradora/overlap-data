// Продьюсер решений стюардов FIA WEC (штрафы) — источник официальный Notice
// Board на Al Kamel (fiawec.alkamelsystems.com/noticeBoard.php): fia.com
// WEC-документов НЕ хранит (там только F1/F2/F3). Скрейпит дерево документов
// события, парсит штрафные PDF — шаблон стюардов WEC ≈ F1, но метки с
// двоеточиями и поле пилота одно («N° / Driver: 61 / Martin BERRY» — кто был
// за рулём в момент факта, не весь экипаж). Выход: data/wec/fia/
// <season>_<round>.json в структуре FiaEvent — приложение читает ТОЙ ЖЕ
// моделью, что F1-пенальти. Дат публикации в HTML нет — publishedAt берём из
// Last-Modified PDF (честный UTC, в отличие от «CET»-меток F1).
//
// Раунды: порядок слагов страницы сезона fiawec (как в календаре приложения);
// сверено с «Round N» в шапках PDF (Сан-Паулу 2026 = Round 4 = 4-й слаг).
// Notice Board 2026 начинается с Имолы — Катар (R7) появится своим чередом.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { extractText, getDocumentProxy } from "unpdf";
import {writeJSONWithEnvelope } from "../lib/mirror.js";
import { isStewardsFrozen } from "../lib/freeze.js";
import {
  appliesTo, classifyDecision, fieldValue, mergeStewardsPenalties,
  planStewardsFetches, skipFirstWrite,
  type FiaEvent, type FiaPenalty, type StewardsListedDoc,
  fineAmountEur,
} from "../lib/fiadocs.js";
import { ALKAMEL_WEC, matchAkRound, parseAkOptions, parseFileHrefs } from "../lib/alkamelwec.js";
import { readFacts, wecRacePath, wecSeasonPath } from "../lib/wecfacts.js";
import { fetchWithRetryLog, lastModifiedISO } from "../lib/http.js";
import { envFlag, envNumber } from "../lib/env.js";

const YEAR = Number(process.env.SEASON ?? new Date().getUTCFullYear());
const NB = `${ALKAMEL_WEC}/noticeBoard.php`;
const OUT_DIR = join(process.cwd(), "data", "wec", "fia");
const DATA_DIR = join(process.cwd(), "data");
const NOW = Date.now();
// Читаем один раз на модуль (как FIA_FORCE в fia.ts): флаг нужен и в отборе
// раундов, и в produceEvent — там он снимает пропуск уже разобранных документов.
const FORCE = envFlag("WEC_FIA_FORCE");

// ВЕРСИЯ WEC-ПАРСЕРА — БАМПАТЬ ПРИ ЛЮБОЙ СМЫСЛОВОЙ ПРАВКЕ разбора:
// parseWecPenaltyDoc / isWecPenaltyDoc / carFromTitle / wecRoundFromText
// (classifyDecision/appliesTo/fieldValue — общие с F1, их правка бампает и
// эту константу, и PENALTY_PARSER_VERSION). Продьюсер не перекачивает
// документы, уже разобранные в файле текущей версией, — без бампа правка
// парсера НЕ ДОЙДЁТ до старых записей. Константа СВОЯ, не F1-шная: парсеры
// стареют независимо, и бамп F1-классификатора не должен гнать перекачку
// 140 PDF Ле-Мана (и наоборот). Обходы: WEC_FIA_FORCE=1 или бамп версии.
export const WEC_PENALTY_PARSER_VERSION = 1;

// Метки шаблона стюардов WEC — в порядке появления, с двоеточиями (в отличие
// от F1). Механика «значение до ближайшей ПОЗДНЕЙ метки» — общая (fieldValue).
export const WEC_FIELD_LABELS = [
  "N° / Driver:", "Competitor:", "Session:", "Time (fact):",
  "Fact:", "Offence:", "Decision:", "Reason:",
];

export interface WecDocRef {
  doc: number;
  title: string; // «Decision no. 2 AMENDED Time of fact - Car 61»
  url: string;
}

// «Results_NoticeBoard/14_2026/05_…/010_Doc 10 - Decision no. 2 - Car 61.pdf»
// (href URL-encoded) → DocRef. Не-Doc файлы → null.
export function docFromHref(href: string): WecDocRef | null {
  const file = decodeURIComponent(href.split("/").pop() ?? "");
  const m = file.match(/^\d+_Doc\s+(\d+)\s*-\s*(.+?)\.pdf$/i);
  if (!m) return null;
  return { doc: Number(m[1]), title: m[2].trim(), url: `${ALKAMEL_WEC}/${href}` };
}

// Штрафной документ: «Decision no. M [AMENDED …] - Car N». Мульти-решения
// («Decision no. 28-30» без машины) пропускаем: в одном PDF несколько блоков
// полей, первый парс съел бы остальные — честнее лог и скип.
export function isWecPenaltyDoc(title: string): boolean {
  return /^Decision no\.\s*\d+(?!\s*-\s*\d)/i.test(title) && /-\s*Car\s+\d+/i.test(title);
}

// Номер машины из заголовка («- Car 007» → 7) — фолбэк, когда поле пилота в
// PDF отсутствует или не распарсилось.
export function carFromTitle(title: string): number | null {
  const m = title.match(/-\s*Car\s+(\d+)/i);
  return m ? Number(m[1]) : null;
}

// Раунд из шапки самого PDF («FIA World Endurance Championship Round 4 –
// 6 Hours of São Paulo 2026») — независимый свидетель, к какому этапу решение
// относится НА САМОМ ДЕЛЕ. Guard класса Катар/Бахрейн: файл wec/fia/2025_1
// (Катар) получил 42 бахрейнских решения, потому что при перенумерации
// календаря событие Notice Board сматчилось не с тем слагом сезона — сверка
// «round файла ↔ round из документов» ловит именно этот класс. Шапка — первое
// на странице; ограничение окна поиска отсекает случайные «Round N» в текстах
// решений. Нет шапки — не судим (толерантно).
export function wecRoundFromText(text: string): number | null {
  const m = text.slice(0, 300).match(/World Endurance Championship\s+Round\s+(\d+)/i);
  return m ? Number(m[1]) : null;
}

export function parseWecPenaltyDoc(
  text: string,
  ref: WecDocRef,
  publishedAt?: string,
): FiaPenalty | null {
  const L = WEC_FIELD_LABELS;
  const decision = fieldValue(text, "Decision:", L);
  if (!decision) return null;

  const driverLine = fieldValue(text, "N° / Driver:", L);
  const dm = driverLine?.match(/^(\d+)\s*\/\s*(.+?)\s*$/);
  const car = dm ? Number(dm[1]) : carFromTitle(ref.title);
  if (car == null) return null;
  // Решения против команды (без пилота) — представляем компетитором.
  const driver = dm?.[2] ?? fieldValue(text, "Competitor:", L) ?? "";

  const session = fieldValue(text, "Session:", L) ?? "";
  const cls = classifyDecision(decision);

  return {
    doc: ref.doc,
    parser: WEC_PENALTY_PARSER_VERSION,
    car,
    driver,
    session,
    type: cls.type,
    ...(cls.gridDrop != null ? { gridDrop: cls.gridDrop } : {}),
    ...(cls.seconds != null ? { seconds: cls.seconds } : {}),
    ...(cls.pitlane ? { pitlane: true } : {}),
    ...(cls.backOfGrid ? { backOfGrid: true } : {}),
    appliesTo: appliesTo(decision, session),
    corrected: /AMENDED/i.test(ref.title),
    ...(fineAmountEur(decision) != null ? { fineEur: fineAmountEur(decision)! } : {}),
    url: ref.url,
    ...(publishedAt ? { publishedAt } : {}),
  };
}

// ---- Сеть ----

// Ретраи и различимая диагностика — политика fia.ts (общая механика в
// http.ts): страницам два повтора, PDF один (у этапа их до 140 — Ле-Ман,
// растягивать прогон нельзя), между PDF вежливая пауза.
const PAGE_ATTEMPTS = 3;
const PDF_ATTEMPTS = 2;
const POLITE_PAUSE_MS = 200;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchHtml(url: string, label: string): Promise<string | null> {
  return fetchWithRetryLog(url, (res) => res.text(), {
    label, timeoutMs: 20000, attempts: PAGE_ATTEMPTS,
  });
}

/// Почему документ не дался — различение то же, что у fia.ts, и нужно оно тому
/// же решению «публиковать ли неполный ПЕРВЫЙ сбор раунда» (skipFirstWrite):
/// сетевой отказ (включая 404 на ещё не выложенный документ) — возвратный,
/// битый текстовый слой PDF — нет (его лечит правка парсера, не повтор).
type WecFetchFailure = "retriable" | "permanent";

/// PDF → текст + Last-Modified (ISO, единая нормализация с imsafia).
async function fetchPdf(
  url: string, label: string, fail?: { kind: WecFetchFailure },
): Promise<{ text: string; publishedAt?: string } | null> {
  const got = await fetchWithRetryLog(
    url,
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
    const pdf = await getDocumentProxy(got.bytes);
    const { text } = await extractText(pdf, { mergePages: true });
    return { text, ...(got.publishedAt ? { publishedAt: got.publishedAt } : {}) };
  } catch (e) {
    console.warn(`  ${label}: PDF не распарсился (unpdf: ${e instanceof Error ? e.message : e})`);
    if (fail) fail.kind = "permanent";
    return null;
  }
}

// Даты этапа — из фактов, которые кладёт wec.ts. Раньше здесь читалась
// сохранённая страница и ключ собирался СВОЕЙ регуляркой «без импорта»:
// правка канонического mirrorSlug сюда просто не дошла бы.
const raceDates = (slug: string) =>
  readFacts(DATA_DIR, wecRacePath(slug), "race")?.info
    ?? { startMs: null, endMs: null, iso2: null };

// ---- Продьюсер ----

async function main() {
  console.log(`WEC FIA decisions, season ${YEAR}`);

  // Каркас раундов — страница сезона из wec-зеркала (сезон файла = YEAR, так
  // что season-guard тут структурный: нет файла сезона — нечего матчить).
  const seasonFacts = readFacts(DATA_DIR, wecSeasonPath(YEAR), "season");
  if (!seasonFacts) {
    console.warn(`::warning::wecfia: нет фактов сезона ${YEAR} — пропускаем прогон`);
    return;
  }
  const slugs = seasonFacts.races;
  if (!slugs.length) {
    console.warn("wecfia: слаги сезона не распарсились — пропускаем");
    return;
  }

  // Notice Board: значение сезона из селектора по лейблу-году.
  const nbHome = await fetchHtml(NB, "Notice Board");
  if (!nbHome) {
    console.warn("wecfia: Notice Board недоступен — пропускаем (толерантно)");
    return;
  }
  const seasonOpt = parseAkOptions(nbHome, "season").find((o) => o.label === String(YEAR));
  if (!seasonOpt) {
    // Гонка флипов: YEAR уже новый, а Notice Board сезон ещё не завёл.
    console.warn(`wecfia: сезона ${YEAR} нет на Notice Board — переходное окно, пропускаем`);
    return;
  }
  const seasonPage = await fetchHtml(
    `${NB}?season=${encodeURIComponent(seasonOpt.value)}`, `страница сезона ${YEAR}`,
  );
  const events = seasonPage ? parseAkOptions(seasonPage, "evvent") : [];
  if (!events.length) {
    console.warn("wecfia: селектор событий пуст — пропускаем");
    return;
  }

  // Бюджет бэкфилла (вежливость: у события до ~50 штрафных PDF).
  let backfill = envNumber("WEC_FIA_BACKFILL", 1);
  const ACTIVE_LEAD_MS = 4 * 24 * 3600 * 1000;

  // Счётчики итога. Раньше прогон печатал голое «Done.», и три разных исхода
  // выглядели одинаково: «нечего делать», «ни один раунд не сматчился» и «нет
  // дат ни у одного этапа». Последние два — тихие поломки входа, и после
  // переезда на слой фактов их цена выросла: пустой факт даёт ровно их.
  let matched = 0, datedRounds = 0, touched = 0;

  for (const ev of events) {
    const round = matchAkRound(ev.label, slugs);
    if (round == null) {
      console.warn(`  «${ev.label}»: не сматчилось со слагами сезона — пропускаем`);
      continue;
    }
    matched++;
    const dates = raceDates(slugs[round - 1]);
    if (dates.endMs != null) datedRounds++;
    // Стюардское окно оседания (14 дней — срок права FIA на пересмотр), как у
    // fia.ts: длинное окно стало безопасным ровно тогда, когда файл раунда
    // перестал перезаписываться итогом прогона — теперь он НАКАПЛИВАЕТСЯ
    // (mergeStewardsPenalties в produceEvent), осечка PDF ничего не стирает,
    // а докач тянет только недостающие документы. Это завершает решение
    // «14 дней для всех трёх продьюсеров решений стюардов», отложенное именно
    // из-за отсутствия слияния.
    const frozen = isStewardsFrozen(dates.endMs, NOW);
    const exists = existsSync(join(OUT_DIR, `${YEAR}_${round}.json`));
    const started = dates.startMs != null && dates.startMs < NOW;
    const isActive = !frozen && dates.startMs != null &&
      NOW >= dates.startMs - ACTIVE_LEAD_MS && started;
    const needsBackfill = (FORCE || !exists) && started;
    if (frozen && exists && !FORCE) continue;
    if (!isActive && !needsBackfill) continue;
    touched++;
    if (!isActive) {
      if (backfill <= 0) continue;
      backfill--;
      console.log(`  backfill R${round} (${ev.label})`);
    }

    const docsHtml = await fetchHtml(
      `${NB}?season=${encodeURIComponent(seasonOpt.value)}&evvent=${encodeURIComponent(ev.value)}`,
      `R${round}: страница документов`,
    );
    if (!docsHtml) {
      // Причина уже в логе (HTTP-код / таймаут); файл раунда не трогаем.
      console.warn(`  R${round}: страница документов недоступна — файл оставляем как есть`);
      continue;
    }
    const refs = parseFileHrefs(docsHtml, "Results_NoticeBoard")
      .map(docFromHref)
      .filter((d): d is WecDocRef => !!d);
    if (!refs.length) {
      console.log(`  R${round}: документов нет`);
      continue;
    }
    await produceEvent(refs, round, ev.label, slugs[round - 1]);
  }
  console.log(`Done. событий Notice Board ${events.length}, сматчено ${matched}, ` +
    `с датами ${datedRounds}, взято в работу ${touched}.`);
  if (matched > 0 && datedRounds === 0) {
    console.warn("::warning::wecfia: ни у одного раунда нет дат — похоже, " +
      "фактов страниц событий нет, и окна заморозки считаются вслепую");
  }
}

async function produceEvent(refs: WecDocRef[], round: number, label: string, slug: string) {
  console.log(`  ${label} → R${round}, ${refs.length} документов`);

  // Уже собранный файл раунда читаем ДО закачек: он же и план докача (как в
  // fia.ts). Вместе с ним поднимается guard чужого этапа.
  const path = join(OUT_DIR, `${YEAR}_${round}.json`);
  let existing: FiaEvent | null = null;
  try {
    existing = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    /* файла ещё нет — первый сбор раунда */
  }
  // Файл того же номера, но ЧУЖОГО этапа (перенумерация календаря fiawec)
  // сливать нельзя — это смешало бы решения двух уик-эндов. Дальше раунд идёт
  // как «первый сбор» (existing = null) и попадает под предохранители ниже:
  // при осечках прежний файл остаётся нетронутым, а не подменяется огрызком.
  let replacedEvent: string | null = null;
  const onDiskPenalties = existing?.penalties?.length ?? 0;
  if (existing && existing.event && existing.event !== slug) {
    console.warn(`  R${round}: в файле был этап «${existing.event}», теперь «${slug}» — пересобираем с нуля`);
    replacedEvent = existing.event;
    existing = null;
  }

  const penaltyRefs: WecDocRef[] = [];
  for (const ref of refs) {
    if (isWecPenaltyDoc(ref.title)) {
      penaltyRefs.push(ref);
    } else if (/^Decision no\./i.test(ref.title)) {
      console.log(`  Doc ${ref.doc}: мульти-решение «${ref.title}» — пропускаем`);
    }
  }
  // Пустой результат НИКОГДА не ложится поверх непустого файла (правило
  // fia.ts, кейс Бахрейн-2025): guard по слагу лишь обнуляет existing, а
  // «ноль документов, ноль осечек» дальше прошёл бы как честный чистый сбор.
  if (!penaltyRefs.length && onDiskPenalties) {
    console.warn(
      `::warning::R${round}: «${slug}» не несёт штрафных документов, а в файле ` +
        `${onDiskPenalties} решени(й) этапа «${replacedEvent ?? slug}» — файл не трогаем`,
    );
    return;
  }

  // Подокументный докач: разобранное текущей версией парсера не перекачиваем.
  // На этапах WEC до 140 штрафных PDF (Ле-Ман) — экономия реальная.
  const listed = penaltyRefs.map((ref) => ({
    key: String(ref.doc),
    url: ref.url,
    corrected: /AMENDED/i.test(ref.title),
    ref,
  } satisfies StewardsListedDoc & { ref: WecDocRef }));
  const keyOf = (p: FiaPenalty): string => String(p.doc);
  const plan = planStewardsFetches(existing?.penalties ?? [], listed, keyOf, WEC_PENALTY_PARSER_VERSION, FORCE);
  if (existing && penaltyRefs.length) {
    if (FORCE) {
      console.log(`  R${round}: WEC_FIA_FORCE=1 — перечитываем все документы`);
    } else if (plan.restamp) {
      console.log(
        `  R${round}: ${plan.restamp} документ(ов) разобрано парсером другой версии (сейчас v${WEC_PENALTY_PARSER_VERSION}) — перечитываем их`,
      );
    }
  }

  const penalties: FiaPenalty[] = [];
  let failures = 0;    // не прочитано всего — для лога
  let retriable = 0;   // из них те, что следующий прогон может добрать
  let foreign = 0;     // шапка PDF называет ДРУГОЙ раунд — в файл не пускаем
  for (const d of plan.fetch) {
    const fail = { kind: "retriable" as WecFetchFailure };
    const pdf = await fetchPdf(d.ref.url, `Doc ${d.ref.doc}`, fail);
    if (!pdf) {
      failures++;
      if (fail.kind === "retriable") retriable++;
    } else {
      // Guard «round файла ↔ round из документов» (см. wecRoundFromText).
      const docRound = wecRoundFromText(pdf.text);
      if (docRound != null && docRound !== round) {
        foreign++;
        console.warn(
          `::warning::R${round}: Doc ${d.ref.doc} в шапке называет себя Round ${docRound} — ` +
            `чужой этап, в файл не пускаем (проверь матчинг событий Notice Board со слагами сезона)`,
        );
      } else {
        const p = parseWecPenaltyDoc(pdf.text, d.ref, pdf.publishedAt);
        if (p) {
          penalties.push(p);
        } else {
          // Шаблон вне разбора — не осечка прогона, а работа для парсера:
          // повтор не поможет никогда, поэтому сбор раунда он не блокирует.
          failures++;
          console.warn(`  Doc ${d.ref.doc}: шаблон стюардов не распознан (парсер)`);
        }
      }
    }
    await sleep(POLITE_PAUSE_MS);
  }
  console.log(
    `  R${round}: штрафных доков ${penaltyRefs.length} — пропущено (уже разобрано) ${plan.reused.length}, ` +
      `скачано ${penalties.length}, не далось ${failures}`,
  );

  // Все разобранные документы — чужого раунда, а своего не нашлось ничего:
  // это и есть класс Катар/Бахрейн (2025_1), файл не трогаем и не создаём.
  if (foreign && !penalties.length && !plan.reused.length) {
    console.warn(
      `::warning::R${round}: все ${foreign} разобранных документа(ов) — чужого раунда, ` +
        `похоже на перенумерацию календаря; файл НЕ пишем`,
    );
    return;
  }

  // Неполный ПЕРВЫЙ сбор раунда не публикуем вовсе (правило и обоснование —
  // fia.ts/skipFirstWrite): файла нет — слиянию спасать нечего, а записанный
  // огрызок закрыл бы раунду дорогу назад (бэкфилл смотрит на существование
  // файла). Блокируют только ВОЗВРАТНЫЕ осечки — документ вне разбора парсера
  // не дастся и на сотом прогоне.
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

  // Слияние с файлом раунда: прогон ДОПОЛНЯЕТ его и НИКОГДА ничего не удаляет
  // (политика mergeFiaEvent — обоснование там).
  const merged = mergeStewardsPenalties(
    existing?.penalties ?? [], penalties, listed.map((d) => d.key), keyOf,
  );
  if (failures && existing) {
    console.log(
      `  R${round}: ${failures} документ(ов) не прочитано — прежние решения сохраняем, ` +
        `остальные документы уже зачтены подокументно`,
    );
  }
  // ::warning:: — пропажа документа разбирается человеком (см. mergeFiaEvent:
  // вычистить и правда отозванный можно только удалив файл раунда).
  for (const key of merged.missing) {
    console.warn(
      `::warning::R${round}: doc ${key} пропал с Notice Board — оставляю в файле, проверь руками ` +
        `(если документ и правда отозван — удали data/wec/fia/${YEAR}_${round}.json и прогони заново)`,
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
    `  R${round}: в файле ${merged.penalties.length} штрафов` +
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
