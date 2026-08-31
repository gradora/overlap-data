// Продьюсер «идущий этап WEC» (lib/weclive.ts). Главное свойство, ради которого
// он вообще отдельный: 96 прогонов в сутки не должны ничего стоить, если этапа
// нет. Второе — окно должно совпадать с тем, что клиент называл живым до 3c.

import { test } from "node:test";
import { wecFactsDir } from "./lib/wecfacts.js";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isLive, liveCandidates, liveEvent, runWecLive, LIVE_TAIL_MS } from "./lib/weclive.js";
import { WECLIVE_MARKER } from "./lib/producers.js";

const START = "2026-09-04T00:00:00+02:00";
const END = "2026-09-06T00:00:00+02:00";

function seed(events: unknown[]): string {
  const root = mkdtempSync(join(tmpdir(), "weclive-"));
  mkdirSync(join(root, "wec", "2026"), { recursive: true });
  writeFileSync(join(root, "wec", "2026", "index.json"), JSON.stringify({
    schemaVersion: 1,
    payload: { schemaVersion: 1, series: "wec", season: 2026, frozen: false, events },
  }));
  return root;
}

const event = (over: Record<string, unknown> = {}) => ({
  round: 5, slug: "lone-star-le-mans-2026", name: "Lone Star Le Mans",
  venue: "COTA", trackRef: null, status: "EventScheduled", countryCode: "us",
  start: START, end: END, resultsPath: "wec/2026/05_lone-star-le-mans-2026.json",
  sourceIds: { fiawec: { slug: "lone-star-le-mans-2026", raceId: 4953, sessions: [] } },
  ...over,
});

// MARK: - Окно

test("окно этапа: от старта до конца + сутки", () => {
  const e = liveCandidates(seed([event()]), 2026)[0];
  const start = Date.parse(START);
  const end = Date.parse(END);

  assert.equal(isLive(e, start - 1), false, "за минуту до старта — ещё не идёт");
  assert.equal(isLive(e, start), true, "старт включительно");
  assert.equal(isLive(e, end), true, "последний день ещё в окне");
  // Хвост в сутки — ради протоколов гонки и правок классификации, которые
  // доезжают уже после формального конца этапа.
  assert.equal(isLive(e, end + LIVE_TAIL_MS - 1), true);
  assert.equal(isLive(e, end + LIVE_TAIL_MS), false, "хвост закончился");
});

test("окно этапа: без дат в окно не попадают", () => {
  const noDates = liveCandidates(seed([event({ start: null, end: null })]), 2026)[0];
  assert.equal(isLive(noDates, Date.parse(START) + 1000), false);
});

test("наложение дат: берётся тот этап, что начался позже", () => {
  const root = seed([
    event({ slug: "a", start: "2026-09-01T00:00:00+02:00", end: "2026-09-05T00:00:00+02:00" }),
    event({ slug: "b", start: START, end: END }),
  ]);
  const now = Date.parse("2026-09-04T12:00:00+02:00");
  assert.equal(liveEvent(root, 2026, now)?.slug, "b");
});

// MARK: - Холостой прогон

test("холостого прогона не видно: сети нет, файлов не появляется", async () => {
  // Ради этого свойства продьюсер и отдельный: расписание */15 значит 96
  // прогонов в сутки, и все, кроме уик-эндов, обязаны стоить около нуля.
  const root = seed([event()]);
  try {
    const before = Date.parse("2026-08-27T12:00:00Z");   // за неделю до этапа
    const log = await runWecLive(before, root);
    assert.match(log, /идущих этапов нет/);
    assert.equal(existsSync(wecFactsDir(root)), false,
                 "холостой прогон не имеет права ходить в сеть");
    // Маркер свежести пишется ВСЕГДА — иначе «воркфлоу умер» и «этапов нет»
    // были бы неотличимы, и сигнал протухания молчал бы вечно.
    const marker = JSON.parse(readFileSync(join(root, WECLIVE_MARKER), "utf8"));
    assert.equal(marker.lastSuccess, "2026-08-27");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("маркер — ДЕНЬ: второй прогон в те же сутки файл не трогает", async () => {
  const root = seed([event()]);
  try {
    await runWecLive(Date.parse("2026-08-27T00:10:00Z"), root);
    const first = readFileSync(join(root, WECLIVE_MARKER), "utf8");
    await runWecLive(Date.parse("2026-08-27T23:50:00Z"), root);
    assert.equal(readFileSync(join(root, WECLIVE_MARKER), "utf8"), first,
                 "таймстемп вместо дня давал бы 96 коммитов в сутки");
    await runWecLive(Date.parse("2026-08-28T00:10:00Z"), root);
    assert.notEqual(readFileSync(join(root, WECLIVE_MARKER), "utf8"), first, "новые сутки — новая отметка");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("нет индекса сезона — тоже холостой прогон, без падения", async () => {
  const root = mkdtempSync(join(tmpdir(), "weclive-empty-"));
  try {
    assert.match(await runWecLive(Date.parse("2026-09-05T12:00:00Z"), root), /идущих этапов нет/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("этап идёт, но raceId ещё не найден — ждём полный прогон", async () => {
  const root = seed([event({ sourceIds: { fiawec: { slug: "x", raceId: null, sessions: [] } } })]);
  try {
    const log = await runWecLive(Date.parse("2026-09-05T12:00:00Z"), root);
    assert.match(log, /raceId ещё нет/);
    assert.equal(existsSync(wecFactsDir(root)), false, "в сеть без raceId не ходим");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("битый индекс не роняет прогон", async () => {
  const root = seed([event()]);
  try {
    writeFileSync(join(root, "wec", "2026", "index.json"), "{ не json");
    assert.deepEqual(liveCandidates(root, 2026), []);
    assert.match(await runWecLive(Date.parse("2026-09-05T12:00:00Z"), root), /идущих этапов нет/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
