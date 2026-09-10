// Продьюсер пострейс-канала питстопов — data/f1/pitstops/<eventKey>.json.
// Механика разбора, кросс-чек и правовая граница — в шапке lib/fompitstops.ts.
//
// ЗАПУСКАЕТСЯ ТОЛЬКО РУКАМИ, как и fomstatic: livetiming.formula1.com отдаёт
// раннерам GitHub 403 (замерено 27.08.2026 на снимке статики; класс источника
// тот же). Продьюсер помечен `manual` в реестре, из расчёта свежести исключён,
// и сторож workflows.test не даст поставить его в крон.
//   npm run f1pitstops               # текущий сезон
//   SEASON=2025 npm run f1pitstops   # бэкфилл прошлого
//   F1PITSTOPS_FORCE=1 npm run f1pitstops   # пересъём поверх замороженных
//
// РИТУАЛ ПОСЛЕ ЭТАПА (пока не проверен egress Railway — открытый вопрос
// roadmap): npm run f1pitstops && npm run f1highlights && npm run f1teams &&
// npm run f1beasts.
//
// ЦЕЛИ — события ВИТРИНЫ календаря (`data/f1/calendar/<год>.json`), а не
// расписание кухни: имя файла = `eventKey` витрины, внутри лежит её же `id`,
// а сшивка с путём FOM идёт через `mk` (контракт D-лайт: `Meeting.Key`
// индекса FOM И ЕСТЬ `mk`). Своей идентичности канал не заводит ни одной.
//
// ПРОПУСК УЖЕ СОБРАННОГО. Событие пропускается без единого запроса, если файл
// на месте, снят текущим парсером, накрывает все гоночные сессии митинга И
// раунд заморожен (freeze-окно результатов). До заморозки событие
// перечитывается каждый прогон: архив дописывается уже после финиша, и
// «сняли через час после клетчатого» не должно застыть навсегда.
//
// KEPT-PREVIOUS. Прогон, давший МЕНЬШЕ стопов, чем лежит в файле, файл не
// трогает: тот же предохранитель, что у f1pitawards и mergeFiaEvent — тихая
// перезапись хорошего плохим дороже пропущенного обновления.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isFrozen } from "../lib/freeze.js";
import { writeJSONWithEnvelope } from "../lib/mirror.js";
import { parseIndex, type FomSession } from "../lib/fomstatic.js";
import {
  PITSTOPS_PARSER_VERSION, buildEventPitstops, fetchSeasonIndex, fetchSessionTopics,
  raceSessionsOf, readEventPitstops, stationaryCoverage,
  writeEventPitstops, type EventPitstops,
} from "../lib/fompitstops.js";

const YEAR = Number(process.env.SEASON ?? new Date().getUTCFullYear());
const ROOT = join(process.cwd(), "data");
const FORCE = process.env.F1PITSTOPS_FORCE === "1";
const NOW = Date.now();

/// Пауза между запросами. Источник публичный и без rate limit, но сотня
/// запросов подряд — повод быть аккуратной (та же вежливость, что у fomstatic).
const DELAY_MS = 250;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/// Событие витрины в полях, нужных каналу.
export interface PitstopTarget {
  id: string;
  eventKey: string;
  round: number;
  mk: number;
  raceDay: string;
}

/// Цели прогона: подтверждённые ГОНКИ витрины, у которых день гонки прошёл и
/// есть `mk`. Тесты и отмены отсеиваются видом (`kind`), будущее — датой,
/// курируемые этапы без `mk` — отсутствием сшивки с индексом FOM.
export function pitstopTargets(events: any[], now: number): PitstopTarget[] {
  const out: PitstopTarget[] = [];
  for (const e of events ?? []) {
    if (e?.kind !== "race") continue;
    const raceDay = e?.dates?.race;
    if (typeof raceDay !== "string") continue;
    const end = Date.parse(`${raceDay}T23:59:59Z`);
    if (!Number.isFinite(end) || end >= now) continue;
    if (typeof e.eventKey !== "string" || typeof e.id !== "string") continue;
    if (typeof e.mk !== "number") continue;
    out.push({ id: e.id, eventKey: e.eventKey, round: Number(e.round ?? 0), mk: e.mk, raceDay });
  }
  return out;
}

/// Можно ли пропустить событие без запросов. Условия конъюнктивны намеренно:
/// каждое по отдельности пропускало бы то, что ещё дособирается.
export function canSkip(
  prev: EventPitstops | null, expectedTags: string[], raceDay: string, now: number,
): boolean {
  if (FORCE || !prev) return false;
  if (prev.parserVersion !== PITSTOPS_PARSER_VERSION) return false;
  const have = new Set(prev.sessions.map((s) => s.tag));
  if (!expectedTags.every((t) => have.has(t as any))) return false;
  return isFrozen(Date.parse(`${raceDay}T23:59:59Z`), now);
}

/// Регрессия факта — по ИЗМЕРЕНИЯМ, а не по числу строк. Ценность несёт
/// stationarySec: прогон, где PitStopSeries отдал 403/пустоту, а
/// PitLaneTimeCollection жив, даёт РОВНО ТО ЖЕ число строк со сплошным
/// stationarySec:null — счёт строк такую деградацию не видит и молча затирает
/// измеренный факт (воспроизведено на Монце-2026 в ревью канала).
export function poorerThan(doc: EventPitstops, prev: EventPitstops | null): string | null {
  if (!prev) return null;
  const cand = stationaryCoverage(doc);
  const before = stationaryCoverage(prev);
  if (cand.total < before.total) return `стопов ${cand.total} < ${before.total}`;
  if (cand.covered < before.covered) {
    return `измерено ${cand.covered} < ${before.covered}`;
  }
  return null;
}

async function main() {
  console.log(`F1 pit stops (FOM static), season ${YEAR}`);

  let events: any[] = [];
  try {
    const cal = JSON.parse(readFileSync(join(ROOT, "f1", "calendar", `${YEAR}.json`), "utf8"));
    events = cal?.events ?? [];
  } catch {
    console.warn("f1pitstops: нет витрины календаря — пропускаем");
    return;
  }
  const targets = pitstopTargets(events, NOW);
  if (!targets.length) {
    console.log("  прошедших гонок в витрине нет — пропуск");
    return;
  }

  // Индекс сезона — ОДИН запрос на прогон. 403 здесь не поломка, а известное
  // состояние архива (весь 2022 мёртв целиком), поэтому выходим нулём.
  const index = await fetchSeasonIndex(YEAR);
  if (!index) {
    console.warn(`::warning::f1pitstops: индекс ${YEAR} недоступен — зеркало прежнее`);
    return;
  }
  const sessions: FomSession[] = parseIndex(index.text, (m) => console.log(m));
  console.log(`  индекс: сессий ${sessions.length}, целей ${targets.length}`);

  let written = 0;
  let skipped = 0;
  let kept = 0;
  let requests = 1;
  let stopsTotal = 0;
  let orphansTotal = 0;
  const closed: string[] = [];

  for (const t of targets) {
    const race = raceSessionsOf(sessions, t.mk);
    if (!race.length) {
      console.log(`  ${t.eventKey}: гоночных сессий по mk ${t.mk} в индексе нет — пропуск`);
      continue;
    }
    const prev = readEventPitstops(ROOT, t.eventKey);
    if (canSkip(prev, race.map((r) => r.tag), t.raceDay, NOW)) {
      skipped++;
      continue;
    }

    const snapped: { tag: "R" | "SPR"; pss: string | null; pltc: string | null }[] = [];
    for (const { session, tag } of race) {
      const topics = await fetchSessionTopics(session.path);
      requests += 2;
      snapped.push({ tag, ...topics });
      if (topics.pss === null) {
        // Не поломка: топик РОДИЛСЯ на US GP 2024 — до него источник отдаёт 403
        // при живом PitLaneTimeCollection той же сессии.
        console.log(`    ${t.eventKey} ${tag}: PitStopSeries недоступен — только визиты пит-лейна`);
      }
      await sleep(DELAY_MS);
    }

    const doc = buildEventPitstops({
      eventKey: t.eventKey, eventId: t.id, season: YEAR, round: t.round, sessions: snapped,
    });
    if (!doc) {
      console.log(`  ${t.eventKey}: стопов не снято — файл ${prev ? "прежний" : "не пишем"}`);
      continue;
    }
    const regression = poorerThan(doc, prev);
    if (regression) {
      console.warn(`::warning::f1pitstops: ${t.eventKey} — факт беднее прежнего ` +
        `(${regression}), оставляем предыдущий файл`);
      kept++;
      continue;
    }

    const changed = writeEventPitstops(ROOT, doc, writeJSONWithEnvelope);
    const cov = stationaryCoverage(doc);
    stopsTotal += cov.total;
    orphansTotal += cov.total - cov.covered;
    if (changed) written++;
    closed.push(t.eventKey);
    console.log(`  ${t.eventKey} R${t.round}: сессий ${doc.sessions.length}, ` +
      `стопов ${cov.total} (со стационарным ${cov.covered}), ` +
      `под красным ${doc.sessions.reduce((n, s) => n + s.suspended, 0)} → ` +
      `${changed ? "записано" : "без изменений"}`);
  }

  console.log(`Done. запросов ${requests}, записано ${written}, пропущено (заморожены) ` +
    `${skipped}, kept-previous ${kept}; событий с фактом ${closed.length}, ` +
    `стопов ${stopsTotal}, из них без стационарного ${orphansTotal}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    // Нулевой код на провале врал бы обёрткам ритуала: цепочка
    // `npm run f1pitstops && npm run f1highlights` поехала бы по несостоявшемуся
    // прогону и пересобрала витрину по прежним данным как по свежим.
    console.error(`f1pitstops: прогон не удался — ${e}`);
    process.exitCode = 1;
  });
}
