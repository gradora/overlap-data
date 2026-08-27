// Снапшот статики FOM (lib/fomstatic.ts). Сети в тестах нет — fetch инжектится.
// Проверяется то, на чём снимок ломается молча: BOM в индексе, сессии без Path,
// resume (снятое не перекачивается), бюджет, и то, что 403 у года — это пропуск,
// а не падение.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  parseIndex, slicePath, indexPath, missingSlices, runFomSnapshot, snapshotSize,
  isSafeSessionPath, SLICES, FOM_BASE,
} from "./lib/fomstatic.js";

const INDEX = {
  Year: 2018,
  Meetings: [{
    Name: "Chinese Grand Prix",
    Sessions: [
      { Key: 5081, Name: "Practice 1" },                       // без Path
      { Key: 5082, Name: "Race", Path: "2018/2018-04-15_Chinese_Grand_Prix/2018-04-15_Race/" },
    ],
  }],
};

const SESSION = {
  path: "2018/2018-04-15_Chinese_Grand_Prix/2018-04-15_Race/",
  meeting: "Chinese Grand Prix",
  name: "Race",
};

function tempData(): string {
  return mkdtempSync(join(tmpdir(), "fomstatic-"));
}

/// Фейковый источник: индекс на год + произвольное тело срезов. Считает вызовы —
/// на этом стоят проверки resume и бюджета.
function fakeFetch(opts: { indexByYear: Record<number, string>; body?: string } ) {
  const calls: string[] = [];
  const fetch = async (url: string) => {
    calls.push(url);
    const m = /\/(\d{4})\/Index\.json$/.exec(url);
    if (m) {
      const raw = opts.indexByYear[Number(m[1])];
      return raw === undefined ? { status: 403, text: "" } : { status: 200, text: raw };
    }
    return { status: 200, text: opts.body ?? "00:00:00.000{}\n" };
  };
  return { fetch, calls };
}

// MARK: - Разбор индекса

test("индекс: BOM не роняет разбор, сессии без Path пропускаются", () => {
  const withBom = "﻿" + JSON.stringify(INDEX);
  const sessions = parseIndex(withBom);
  assert.equal(sessions.length, 1, "сессия без Path в снимок не попадает");
  assert.equal(sessions[0].path, SESSION.path);
  assert.equal(sessions[0].meeting, "Chinese Grand Prix");
  // Без чистки BOM JSON.parse падает — тогда снимок был бы пуст МОЛЧА.
  assert.deepEqual(parseIndex(JSON.stringify(INDEX)).map((s) => s.path), [SESSION.path]);
});

/// Не гипотетика: в боевом индексе 2021-го лежит сессия с путём
/// «../uat/static/2022/2022-03-27_Saudi_Arabian_Grand_Prix/…_FOM_High_Speed_Track_Test/».
/// Склеенный с data/f1/fom/ он пишет ВНЕ каталога снимка. В первом прогоне
/// спасло только 403 от источника.
test("индекс: путь, уводящий из каталога снимка, отбрасывается", () => {
  const evil = JSON.parse(JSON.stringify(INDEX));
  evil.Meetings[0].Sessions[1].Path =
    "../uat/static/2022/2022-03-27_Saudi_Arabian_Grand_Prix/2022-03-24_FOM_High_Speed_Track_Test/";
  const logged: string[] = [];
  assert.deepEqual(parseIndex(JSON.stringify(evil), (m) => logged.push(m)), []);
  assert.equal(logged.some((m) => m.includes("небезопасного пути")), true,
               "молчаливый пропуск скрыл бы, что источник отдаёт чужое");

  assert.equal(isSafeSessionPath("2018/2018-04-15_Chinese_Grand_Prix/2018-04-15_Race/"), true);
  assert.equal(isSafeSessionPath("../uat/static/2022/x/"), false);
  assert.equal(isSafeSessionPath("/etc/passwd"), false, "абсолютный путь — не путь сессии");
  assert.equal(isSafeSessionPath("2018/../../../etc/"), false, "«..» в середине тоже уводит");
  assert.equal(isSafeSessionPath("uat/2022/x/"), false, "первый сегмент обязан быть годом");
  assert.equal(isSafeSessionPath(""), false);
});

test("индекс: мусор вместо JSON — пустой список, а не исключение", () => {
  assert.deepEqual(parseIndex("<html>403</html>"), []);
  assert.deepEqual(parseIndex(""), []);
});

test("индекс: Path без хвостового слэша нормализуется", () => {
  const noSlash = JSON.parse(JSON.stringify(INDEX));
  noSlash.Meetings[0].Sessions[1].Path = SESSION.path.slice(0, -1);
  assert.equal(parseIndex(JSON.stringify(noSlash))[0].path, SESSION.path,
               "иначе путь файла склеился бы без разделителя");
});

test("путь файла повторяет путь источника", () => {
  assert.equal(slicePath(SESSION, "WeatherData"),
               join("f1", "fom", SESSION.path, "WeatherData.jsonStream"));
});

// MARK: - Resume и бюджет

test("недостающие срезы: снятое не перечисляется", () => {
  const root = tempData();
  try {
    assert.equal(missingSlices(root, [SESSION]).length, SLICES.length);
    const p = join(root, slicePath(SESSION, "WeatherData"));
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, "уже снято");
    const missing = missingSlices(root, [SESSION]);
    assert.equal(missing.length, SLICES.length - 1);
    assert.equal(missing.some((m) => m.slice === "WeatherData"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("прогон: снимает все срезы и второй раз в сеть за ними не ходит", async () => {
  const root = tempData();
  try {
    const first = fakeFetch({ indexByYear: { 2018: JSON.stringify(INDEX) } });
    const r1 = await runFomSnapshot({
      dataDir: root, years: [2018], delayMs: 0, fetch: first.fetch, log: () => {},
    });
    assert.equal(r1.fetched, SLICES.length);
    assert.equal(snapshotSize(root), SLICES.length + 1, "срезы + индекс года");
    assert.equal(readFileSync(join(root, slicePath(SESSION, "WeatherData")), "utf8"),
                 "00:00:00.000{}\n", "байты источника сохраняются как есть");

    // Resume: второй прогон трогает только индекс.
    const second = fakeFetch({ indexByYear: { 2018: JSON.stringify(INDEX) } });
    const r2 = await runFomSnapshot({
      dataDir: root, years: [2018], delayMs: 0, fetch: second.fetch, log: () => {},
    });
    assert.equal(r2.fetched, 0);
    assert.deepEqual(second.calls, [`${FOM_BASE}2018/Index.json`],
                     "снятое перекачивать нельзя: 1500 файлов каждый прогон");
    assert.equal(snapshotSize(root), SLICES.length + 1, "повтор не плодит файлов");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/// Отсчёты в срезах идут ОТНОСИТЕЛЬНЫМ временем от старта фида, а час старта и
/// пояс сессии лежат только в индексе. Снимок без индекса — это данные, смысл
/// которых потерян.
test("прогон: индекс года сохраняется рядом со срезами", async () => {
  const root = tempData();
  try {
    const src = fakeFetch({ indexByYear: { 2018: JSON.stringify(INDEX) } });
    await runFomSnapshot({ dataDir: root, years: [2018], delayMs: 0, fetch: src.fetch, log: () => {} });
    const saved = readFileSync(join(root, indexPath(2018)), "utf8");
    assert.equal(JSON.parse(saved).Meetings[0].Sessions[1].Key, 5082,
                 "без StartDate/GmtOffset из индекса относительное время не привязать");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("прогон: бюджет ограничивает порцию, остальное доберёт следующий", async () => {
  const root = tempData();
  try {
    const src = fakeFetch({ indexByYear: { 2018: JSON.stringify(INDEX) } });
    const r = await runFomSnapshot({
      dataDir: root, years: [2018], budget: 2, delayMs: 0, fetch: src.fetch, log: () => {},
    });
    assert.equal(r.fetched, 2);
    assert.equal(r.missing, SLICES.length, "недостача считается ДО бюджета — иначе не видно масштаба");
    assert.equal(snapshotSize(root), 2 + 1, "два среза + индекс");

    const rest = await runFomSnapshot({
      dataDir: root, years: [2018], budget: 99, delayMs: 0,
      fetch: fakeFetch({ indexByYear: { 2018: JSON.stringify(INDEX) } }).fetch, log: () => {},
    });
    assert.equal(rest.fetched, SLICES.length - 2);
    assert.equal(snapshotSize(root), SLICES.length + 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// MARK: - Отказы источника

test("403 у года — пропуск, а не падение (это состояние 2017 и 2022)", async () => {
  const root = tempData();
  try {
    const src = fakeFetch({ indexByYear: { 2018: JSON.stringify(INDEX) } });
    const r = await runFomSnapshot({
      dataDir: root, years: [2017, 2018, 2022], delayMs: 0, fetch: src.fetch, log: () => {},
    });
    assert.equal(r.fetched, SLICES.length, "доступный год снят несмотря на два закрытых");
    assert.equal(existsSync(join(root, "f1", "fom", "2017")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("пустой ответ среза не создаёт файл — иначе дыра застынет навсегда", async () => {
  const root = tempData();
  try {
    const src = fakeFetch({ indexByYear: { 2018: JSON.stringify(INDEX) }, body: "" });
    const r = await runFomSnapshot({
      dataDir: root, years: [2018], delayMs: 0, fetch: src.fetch, log: () => {},
    });
    assert.equal(r.fetched, 0);
    assert.equal(r.failed, SLICES.length);
    assert.equal(snapshotSize(root), 1,
                 "на диске только индекс: пустышка среза означала бы «снято» и больше не перезапрашивалась бы");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
