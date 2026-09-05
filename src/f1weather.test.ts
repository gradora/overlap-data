// Продьюсер погоды F1 (producers/f1weather.ts) — бессетевой derived поверх
// зеркала openf1. Проверяется проводка и то, что архив write-once нельзя
// отравить: имена файлов, январский гейт, запечатывание урезанного ряда.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildF1Weather } from "./producers/f1weather.js";
import { mirrorSlug } from "./lib/mirror.js";

const RACE_DAY = "2025-07-27";
/// Через месяц после гонки: окно закрылось И отстоялось (freeze 7 суток).
const NOW = Date.parse("2025-08-27T12:00:00Z");
/// Через сутки после гонки: окно закрылось, но НЕ отстоялось.
const FRESH = Date.parse("2025-07-28T12:00:00Z");

const weatherRows = (n: number, startIso: string) =>
  Array.from({ length: n }, (_, i) => ({
    date: new Date(Date.parse(startIso) + i * 60_000).toISOString(),
    air_temperature: 20 + (i % 3), track_temperature: 30, humidity: 50,
    pressure: 1010, wind_speed: 1.5, wind_direction: 200, rainfall: i % 2,
  }));

interface EventSpec { id: string; round: number; meetingKey: number | null; race?: string | null }

function seed(events: EventSpec[], opts: { season?: number; declared?: number; holes?: string[] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "f1weather-"));
  const season = opts.season ?? 2025;
  mkdirSync(join(root, "f1", "calendar"), { recursive: true });
  mkdirSync(join(root, "f1", "openf1"), { recursive: true });

  writeFileSync(join(root, "f1", "calendar", `${season}.json`), JSON.stringify({
    schemaVersion: 1, series: "f1", season: opts.declared ?? season, frozen: false,
    events: events.map((e) => ({
      id: e.id, round: e.round, kind: "race", status: "confirmed", name: `E${e.round}`,
      venue: "V", country: "C", trackRef: null, assetSlug: "a",
      dates: { start: null, race: e.race === undefined ? RACE_DAY : e.race, raceTime: null },
      sprintWeekend: false,
      sourceIds: { jolpica: null, openf1: e.meetingKey == null ? null : { meetingKey: e.meetingKey },
                   override: false },
    })),
  }));

  for (const e of events) {
    if (e.meetingKey == null) continue;
    const sessions = [
      { session_key: e.meetingKey * 10 + 1, session_name: "Practice 1" },
      { session_key: e.meetingKey * 10 + 2, session_name: "Race" },
    ];
    writeFileSync(join(root, "f1", "openf1", mirrorSlug(`sessions?meeting_key=${e.meetingKey}`)),
                  JSON.stringify(sessions));
    for (const s of sessions) {
      if ((opts.holes ?? []).includes(String(s.session_key))) continue;
      writeFileSync(join(root, "f1", "openf1", mirrorSlug(`weather?session_key=${s.session_key}`)),
                    JSON.stringify(weatherRows(10, `${RACE_DAY}T12:00:00Z`)));
    }
  }
  return root;
}

const weatherFiles = (root: string) => {
  try { return readdirSync(join(root, "f1", "weather")).sort(); } catch { return []; }
};

// MARK: - Проводка

test("сборка: погода события собирается из зеркала и ложится под id витрины", () => {
  const root = seed([{ id: "f1-2025-13", round: 13, meetingKey: 1250 }]);
  try {
    const log = buildF1Weather(root, NOW, () => {});
    assert.match(log, /written 1/);
    assert.deepEqual(weatherFiles(root), ["f1-2025-13.json"]);
    const doc = JSON.parse(readFileSync(join(root, "f1", "weather", "f1-2025-13.json"), "utf8"));
    assert.equal(doc.eventId, "f1-2025-13");
    assert.equal("source" in doc, false, "происхождение — кухня, в витрину не пишется");
    assert.equal(doc.sessions.length, 2);
    assert.equal(doc.sessions[0].samples.t.length, 10);
    assert.equal(doc.timeAnchor.method, "native", "берём только источник с абсолютным временем");
    assert.equal(doc.final, true, "событие отстоялось и зеркало полное — запечатываем");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/// round = 0 это сентинел и он НЕ уникален: у сезона-2026 таких событий четыре
/// (два теста и две отмены). Ключ «сезон_раунд» схлопнул бы их в один файл и
/// погода теста легла бы под отмену.
test("имя файла: события с сентинелом round = 0 не схлопываются", () => {
  const root = seed([
    { id: "f1-meeting-1304", round: 0, meetingKey: 1304 },
    { id: "f1-meeting-1305", round: 0, meetingKey: 1305 },
    { id: "f1-meeting-1282", round: 0, meetingKey: 1282 },
    { id: "f1-meeting-1283", round: 0, meetingKey: 1283 },
  ]);
  try {
    buildF1Weather(root, NOW, () => {});
    assert.equal(weatherFiles(root).length, 4, "четыре события — четыре файла");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("событие без ключа митинга пропускается, а не пишется пустым", () => {
  const root = seed([{ id: "f1-2025-1", round: 1, meetingKey: null }]);
  try {
    assert.match(buildF1Weather(root, NOW, () => {}), /noKey 1/);
    assert.deepEqual(weatherFiles(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// MARK: - Защита архива

/// Январское отравление: файл сезона, несущий ЧУЖОЙ season. Разбери мы его —
/// погода уехала бы под id чужого года и застыла там.
test("гейт сезона: витрина с чужим season не разбирается", () => {
  const root = seed([{ id: "f1-2025-1", round: 1, meetingKey: 1250 }],
                    { season: 2025, declared: 2024 });
  try {
    assert.match(buildF1Weather(root, NOW, () => {}), /витрина непригодна/);
    assert.deepEqual(weatherFiles(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("окно не закрылось — не пишем: обрезанный ряд запечатался бы как полный", () => {
  const root = seed([{ id: "f1-2025-1", round: 1, meetingKey: 1250, race: "2099-01-01" }]);
  try {
    assert.match(buildF1Weather(root, NOW, () => {}), /skipped 1/);
    assert.deepEqual(weatherFiles(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/// Ровно тот класс, что стоил нам решений стюардов R11-2026: ПЕРВАЯ запись по
/// уже отстоявшемуся событию не защищена ничем — предохранителю регрессии
/// сравнивать не с чем, а следующий прогон увидит final и больше не тронет.
test("дыра в зеркале не даёт запечатать урезанный ряд", () => {
  const root = seed([{ id: "f1-2025-1", round: 1, meetingKey: 1250 }], { holes: ["12501"] });
  try {
    assert.match(buildF1Weather(root, NOW, () => {}), /skipped 1/);
    assert.deepEqual(weatherFiles(root), [], "лучше ничего, чем половина навсегда");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/// А до границы freeze дыра — не приговор: пишем что есть, но НЕ печатаем
/// final, чтобы следующий прогон дозаполнил.
test("дыра до отстоя: пишем неполным, но не запечатываем", () => {
  const root = seed([{ id: "f1-2025-1", round: 1, meetingKey: 1250 }], { holes: ["12501"] });
  try {
    assert.match(buildF1Weather(root, FRESH, () => {}), /written 1/);
    const doc = JSON.parse(readFileSync(join(root, "f1", "weather", "f1-2025-1.json"), "utf8"));
    assert.equal(doc.final, false, "дыра означает «архив ещё можно дозаполнить»");
    assert.equal(doc.sessions.length, 1);

    // Дозаполнение: дыра закрылась — сессия доехала, файл запечатался.
    writeFileSync(join(root, "f1", "openf1", mirrorSlug("weather?session_key=12501")),
                  JSON.stringify(weatherRows(10, `${RACE_DAY}T09:00:00Z`)));
    buildF1Weather(root, NOW, () => {});
    const after = JSON.parse(readFileSync(join(root, "f1", "weather", "f1-2025-1.json"), "utf8"));
    assert.equal(after.sessions.length, 2);
    assert.equal(after.final, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("запечатанное событие той же версии разбора не пересобирается", () => {
  const root = seed([{ id: "f1-2025-1", round: 1, meetingKey: 1250 }]);
  try {
    buildF1Weather(root, NOW, () => {});
    // Зеркало «испортилось» — но запечатанный файл трогать нельзя.
    writeFileSync(join(root, "f1", "openf1", mirrorSlug("weather?session_key=12502")),
                  JSON.stringify(weatherRows(2, `${RACE_DAY}T12:00:00Z`)));
    assert.match(buildF1Weather(root, NOW, () => {}), /unchanged 1/);
    const doc = JSON.parse(readFileSync(join(root, "f1", "weather", "f1-2025-1.json"), "utf8"));
    assert.equal(doc.sessions.find((s: any) => s.key === "12502").samples.t.length, 10,
                 "запечатанный ряд не укоротился");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
