// Клей health.ts — то, что РЕАЛЬНО бежит в кроне.
//
// Зачем отдельный файл. freshness.test.ts закрывает чистую библиотеку, и она
// закрыта хорошо. Но мутационная проверка показала: четыре предохранителя в
// самом health.ts переживали мутацию при полностью зелёном прогоне, потому что
// тесты били по двойнику, а не по клею. Каждая из четырёх молча убивала сигнал:
//
//   * перенос отметок из прошлого health.json отключён → отметки переставляются
//     на сегодня каждый час → просрочка не наступает НИКОГДА;
//   * `stale` кладётся пустым → канал алерта мёртв целиком;
//   * маркеры чужих воркфлоу не читаются → tracks «молчит» → вечная ложная
//     тревога вместо сигнала;
//   * продьюсер с маркером не отфильтрован из `producers` → вечный "unknown" →
//     приложение красит его в сломанные навсегда.
//
// Класс ошибки тот самый, ради которого сигнал и заводился: сторож против
// тихого отказа сам отказывает тихо. Поэтому здесь проверяется поведение
// экспортируемых из health.ts функций, а не их аналогов.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { join, dirname, resolve } from "node:path";
import { assembleHealth, readPrevHealth, readMarkerStamps } from "./producers/health.js";
import { PRODUCERS, TRACKS_MARKER, byKey } from "./lib/producers.js";

const TODAY = "2026-08-24";
const allSuccess = () => "success" as const;
const empty = { counts: {}, blocked: {} };

/// Каталог-песочница под data/ с заданными файлами.
function sandbox(files: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "health-"));
  for (const [rel, body] of Object.entries(files)) {
    const p = join(dir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(body));
  }
  return dir;
}

// MARK: перенос накопленных отметок

test("клей: отметки переносятся из прошлого health.json, а не изобретаются", () => {
  // Мутация «читать прошлый файл как undefined» именно здесь и пряталась:
  // без переноса каждый прогон видит чистый лист, ставит сегодня и просрочки
  // не бывает никогда.
  const prev = { lastSuccess: { fia: "2026-08-10" }, firstSeen: {} };
  const h = assembleHealth({
    today: TODAY,
    outcomeOf: () => "failure",       // в ЭТОМ прогоне успеха нет ни у кого
    prev,
    markers: {},
    ...empty,
  });
  assert.equal(h.lastSuccess.fia, "2026-08-10", "старая отметка потеряна");
});

test("клей: прошлый файл читается с диска", () => {
  const dir = sandbox({ "health.json": { lastSuccess: { fia: "2026-08-01" } } });
  try {
    const prev = readPrevHealth(dir) as { lastSuccess: Record<string, string> };
    assert.equal(prev.lastSuccess.fia, "2026-08-01");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("клей: битый или отсутствующий health.json не роняет прогон", () => {
  // Один кривой байт не имеет права заклинить heartbeat: без записи файла
  // GitHub через 60 дней тишины гасит расписание.
  const dir = mkdtempSync(join(tmpdir(), "health-"));
  try {
    assert.equal(readPrevHealth(dir), undefined, "нет файла — undefined");
    writeFileSync(join(dir, "health.json"), "{не json");
    assert.equal(readPrevHealth(dir), undefined, "битый файл — undefined");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// MARK: маркеры чужих воркфлоу

test("клей: маркер чужого воркфлоу читается и питает свежесть", () => {
  const dir = sandbox({ [TRACKS_MARKER]: { lastSuccess: "2026-08-20" } });
  try {
    const stamps = readMarkerStamps(dir);
    assert.equal(stamps.tracks, "2026-08-20", "маркер tracks не прочитан");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("клей: без маркера продьюсер чужого воркфлоу молчит, и это видно", () => {
  // Нет маркера — не ошибка чтения, а факт «чужой воркфлоу не отрабатывал».
  // Рассудить обязан бюджет, а не молчание.
  const dir = mkdtempSync(join(tmpdir(), "health-"));
  try {
    assert.deepEqual(readMarkerStamps(dir), {});
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("клей: продьюсер с маркером НЕ попадает в producers", () => {
  // Иначе его outcome — вечный "unknown", и экран здоровья в приложении
  // (failedProducers фильтрует != success) красит tracks в сломанные навсегда.
  const h = assembleHealth({ today: TODAY, outcomeOf: allSuccess, prev: undefined, markers: {}, ...empty });
  assert.ok(!("tracks" in h.producers), "маркерный продьюсер просочился в producers");
  assert.ok("fia" in h.producers, "обычный продьюсер обязан быть в producers");
});

// MARK: канал алерта

test("клей: stale вычисляется, а не кладётся пустым", () => {
  // Мутация «stale: []» оставляла все тесты зелёными и убивала алерт целиком.
  const fia = byKey("fia")!;
  const long = "2026-01-01";   // молчит больше любого бюджета
  const h = assembleHealth({
    today: TODAY,
    outcomeOf: () => "failure",
    prev: { lastSuccess: { fia: long }, firstSeen: {} },
    markers: {},
    ...empty,
  });
  const hit = h.stale.find((s) => s.producer === "fia");
  assert.ok(hit, "просроченный продьюсер не попал в stale");
  assert.equal(hit!.budgetDays, fia.budgetDays);
  assert.equal(hit!.everRan, true);
});

test("клей: всё свежее — stale пуст", () => {
  const h = assembleHealth({ today: TODAY, outcomeOf: allSuccess, prev: undefined, markers: {}, ...empty });
  assert.deepEqual(h.stale, [], "ложная тревога на полностью здоровом прогоне");
});

// MARK: бюджет ежечасных — закреплён числом, а не константой

test("бюджет ежечасных: трое суток молчания — норма, четвёртые — тревога", () => {
  // Числа тут НАМЕРЕННО литеральные. Через константу HOURLY тест был бы
  // тавтологией: подмена её на 300 сдвинула бы обе границы и прошла бы мимо,
  // а вместе с ней мимо прошла бы смерть двадцати продьюсеров из двадцати одного.
  const run = (since: string) => assembleHealth({
    today: "2026-08-24",
    outcomeOf: () => "failure",
    prev: { lastSuccess: { fia: since }, firstSeen: {} },
    markers: {},
    ...empty,
  }).stale.some((s) => s.producer === "fia");

  assert.equal(run("2026-08-21"), false, "3 суток молчания — ещё норма");
  assert.equal(run("2026-08-20"), true, "4 суток молчания — обязана быть тревога");
});

test("бюджет tracks: недельный ритм терпит один потерянный понедельник", () => {
  const run = (since: string) => assembleHealth({
    today: "2026-08-24",
    outcomeOf: allSuccess,
    prev: undefined,
    markers: { tracks: since },
    ...empty,
  }).stale.some((s) => s.producer === "tracks");

  assert.equal(run("2026-08-10"), false, "14 суток — ещё норма (пропущенный слот крона)");
  assert.equal(run("2026-08-09"), true, "15 суток — две недели тишины, это уже отказ");
});

// MARK: главное свойство — реестр не зависит от проводки

test("продьюсер, которого нет в воркфлоу, со временем поднимает тревогу", () => {
  // Ровно инцидент f1teams: продьюсер существует, но его никто не зовёт. Через
  // env приходит "unknown", отметка не ставится, и бюджет обязан его достать.
  const h = assembleHealth({
    today: "2026-08-24",
    outcomeOf: (k) => (k === "F1TEAMS_OUTCOME" ? "unknown" : "success"),
    prev: { lastSuccess: {}, firstSeen: { f1teams: "2026-08-07" } },
    markers: {},
    ...empty,
  });
  const hit = h.stale.find((s) => s.producer === "f1teams");
  assert.ok(hit, "неподключённый продьюсер не пойман бюджетом");
  assert.equal(hit!.everRan, false, "должен быть помечен как ни разу не отрабатывавший");
  assert.equal(hit!.since, "2026-08-07", "точка отсчёта — день появления в реестре");
});

test("реестр покрывает все продьюсеры и у каждого положительный бюджет", () => {
  assert.ok(PRODUCERS.length >= 20);
  for (const s of PRODUCERS) {
    assert.ok(s.budgetDays > 0, `${s.key}: бюджет обязан быть положительным`);
    assert.ok(s.workflow.endsWith(".yml"), `${s.key}: канал указан не файлом воркфлоу`);
  }
});

// MARK: расписания, от которых зависят шаги под `if:`

test("шаг под `if: github.event.schedule` опирается на существующее расписание", () => {
  // Дыра, которую бюджет не ловит по построению: у snapshot.yml ДВА крона —
  // ежечасный и суточный, — а шаг «Сезон N+1» стоит под `if:` по второму.
  // Убери из `on: schedule` суточную строку, и всё останется зелёным: воркфлоу
  // расписание имеет, npm-скрипты зовутся, env на месте, а шаг просто никогда
  // не матчится → skipped → success → отметка штампуется ежечасно навсегда.
  // Проход сезона N+1 при этом мёртв — тот самый канал, что открывает новый
  // год в приложении. Сверяем: каждое расписание, названное в `if:`, обязано
  // быть объявлено в `on:`.
  const text = readFileSync(".github/workflows/snapshot.yml", "utf8");
  const declared = new Set(
    [...text.matchAll(/^\s*-\s*cron:\s*["']([^"']+)["']/gm)].map((m) => m[1].trim()),
  );
  const used = [...text.matchAll(/github\.event\.schedule\s*==\s*['"]([^'"]+)['"]/g)]
    .map((m) => m[1].trim());
  assert.ok(used.length > 0, "шагов под расписание не осталось — тест устарел, обнови его");
  for (const cron of used) {
    assert.ok(
      declared.has(cron),
      `шаг ждёт расписание "${cron}", но в on.schedule его нет: ` +
      `шаг не запустится НИКОГДА, при этом всё останется зелёным. Объявлено: ${[...declared].join(", ")}`,
    );
  }
});

// MARK: main() целиком — проводка, а не только её части

test("прогон health: переносит отметки и читает маркер из своего каталога", () => {
  // Части проводки закрыты выше по отдельности, но САМА проводка в main —
  // нет: мутации «prev: undefined» и «markers: {}» переживали всё, а каждая
  // молча убивает сигнал (первая — просрочка не наступает никогда, вторая —
  // вечная ложная тревога по tracks). Гоняем продьюсера как продьюсера, в
  // отдельном каталоге, чтобы боевые данные не пострадали.
  const cwd = mkdtempSync(join(tmpdir(), "healthrun-"));
  const mod = resolve("src/producers/health.ts");
  try {
    mkdirSync(join(cwd, "data", "tracks"), { recursive: true });
    // Прошлый прогон: fia успешно отработал давно, сегодня он падает.
    writeFileSync(join(cwd, "data", "health.json"), JSON.stringify({
      schemaVersion: 1, date: "2026-08-23",
      lastSuccess: { fia: "2026-08-23" }, firstSeen: {}, stale: [],
    }));
    // Чужой воркфлоу оставил свою отметку.
    writeFileSync(join(cwd, "data", TRACKS_MARKER), JSON.stringify({ lastSuccess: "2026-08-22" }));

    const r = spawnSync("npx", ["tsx", mod], {
      cwd, encoding: "utf8",
      env: { ...process.env, FIA_OUTCOME: "failure", F1_OUTCOME: "success" },
    });
    assert.equal(r.status, 0, r.stderr);

    const out = JSON.parse(readFileSync(join(cwd, "data", "health.json"), "utf8"));
    assert.equal(out.lastSuccess.fia, "2026-08-23",
      "отметка прошлого прогона потеряна — перенос между прогонами не работает");
    assert.equal(out.lastSuccess.tracks, "2026-08-22",
      "маркер чужого воркфлоу не прочитан — tracks получит вечную ложную тревогу");
    assert.ok(!("tracks" in out.producers), "маркерный продьюсер просочился в producers");
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
