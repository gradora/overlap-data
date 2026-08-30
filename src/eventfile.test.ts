// Проекция семейств в файл события (lib/eventfile.ts). Проверяется то, из-за
// чего проекция вообще выбрана формой: она ничего не выдумывает, ничего не
// накапливает и не шумит в git.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "./lib/seriesevents.js";
import { EVENT_FILE_SCHEMA_VERSION, buildEventFile, eventFilePath, stripEnvelope }
  from "./lib/eventfile.js";

const fia = {
  schemaVersion: 1, generatedAt: "2026-08-28T10:00:00.000Z", season: 2025, round: 14,
  event: "hungarian_grand_prix", updated: "2025-08-03 18:00 CET",
  penalties: [{ doc: 40, car: 5, kind: "grid" }],
  startingGrid: { kind: "final", doc: 61, entries: [{ position: 1, car: 1 }] },
};
const winners = {
  schemaVersion: 1, generatedAt: "2026-08-28T10:00:00.000Z", season: 2025, round: 14,
  circuitId: "hungaroring", winners: [{ year: 2024, driver: "O. Piastri" }],
};

const input = (over: Record<string, unknown> = {}) => ({
  season: 2025, eventKey: "f1-2025-hungaroring-1266", eventId: "f1-2025-14", round: 14,
  fia, winners, ...over,
});

test("конверт источника в проекцию не попадает", () => {
  const file = buildEventFile(input())!;
  const asText = JSON.stringify(file.fia);
  assert.doesNotMatch(asText, /generatedAt/,
    "generatedAt просочился — файл будет меняться каждый прогон источника");
  assert.doesNotMatch(asText, /schemaVersion/);
  // А season и round ОСТАЮТСЯ: клиентские модели объявляют их обязательными,
  // и без них блок не декодируется тем же декодером, что и отдельный файл.
  assert.equal((file.fia as any).season, 2025);
  assert.equal((file.fia as any).round, 14);
  assert.equal(file.season, 2025);
  assert.equal(file.round, 14);
});

test("содержимое блоков переносится дословно", () => {
  const file = buildEventFile(input())!;
  assert.deepEqual((file.fia as any).penalties, fia.penalties);
  assert.deepEqual((file.fia as any).startingGrid, fia.startingGrid);
  assert.deepEqual((file.winners as any).winners, winners.winners);
  assert.equal((file.fia as any).event, "hungarian_grand_prix");
});

test("отсутствующее семейство даёт отсутствующий блок, а не пустой", () => {
  const file = buildEventFile(input({ winners: null, highlights: undefined }))!;
  assert.ok("fia" in file);
  assert.equal("winners" in file, false, "пустой блок неотличим от «данные есть, но пустые»");
  assert.equal("highlights" in file, false);
  assert.equal("milestones" in file, false);
});

/// Оверлейные этапы (тесты, отмены) round-keyed семейств не имеют вовсе.
/// Файл-пустышка заставил бы клиента доверять пустоте вместо честного 404.
test("событие без единого блока файла не получает", () => {
  assert.equal(buildEventFile(input({ fia: null, winners: null })), null);
  assert.equal(buildEventFile(input({ fia: {}, winners: null })), null,
               "документ из одного конверта — тоже пусто");
});

test("идентичность файла лежит внутри него", () => {
  const file = buildEventFile(input())!;
  assert.equal(file.eventKey, "f1-2025-hungaroring-1266");
  assert.equal(file.eventId, "f1-2025-14");
  assert.equal(file.schemaVersion, EVENT_FILE_SCHEMA_VERSION);
  assert.equal(file.series, "f1");
  // Имя файла и ключ — одно и то же, иначе клиент получил бы молчаливый 404.
  assert.equal(eventFilePath(file.eventKey), "f1-2025-hungaroring-1266.json");
});

test("stripEnvelope понимает обе формы: плоскую и с payload", () => {
  const flat = stripEnvelope({ schemaVersion: 1, generatedAt: "x", a: 1 });
  const nested = stripEnvelope({ schemaVersion: 1, generatedAt: "x", payload: { a: 1 } });
  assert.deepEqual(flat, { a: 1 });
  assert.deepEqual(nested, { a: 1 });
  // season/round конвертом не считаются — они нужны декодеру блока.
  assert.deepEqual(stripEnvelope({ generatedAt: "x", season: 2025, round: 14 }),
                   { season: 2025, round: 14 });
  assert.equal(stripEnvelope(null), null);
  assert.equal(stripEnvelope([1, 2]), null, "массив — не документ семейства");
  assert.equal(stripEnvelope("текст"), null);
  // null-поля источника не переносим: они ничего не сообщают, а вес занимают.
  assert.deepEqual(stripEnvelope({ a: 1, b: null }), { a: 1 });
});

/// Проекция обязана быть ЧИСТОЙ: одинаковый вход — побайтово одинаковый выход.
/// Иначе `writeJSONWithEnvelope` увидит отличие, и каждый ежечасный прогон
/// будет коммитить полсотни файлов.
test("проекция детерминирована", () => {
  const a = JSON.stringify(buildEventFile(input()));
  const b = JSON.stringify(buildEventFile(input()));
  assert.equal(a, b);
});

// MARK: - Проекция WEC и IMSA
// У этих серий файл события уже существует, поэтому проекция несёт ТОЛЬКО
// derived: сессии в неё не дублируются, а вставить блоки внутрь существующего
// файла нельзя — его пишет продьюсер зеркала, идущий в снапшоте раньше
// derived-семейств.

test("серия попадает в файл и не подменяется дефолтом", () => {
  const wec = buildEventFile({
    series: "wec", season: 2025, eventKey: "wec-2025-6-hours-of-imola-2025",
    eventId: "6-hours-of-imola-2025", round: 1, fia,
  })!;
  assert.equal(wec.series, "wec");
  assert.equal(wec.eventKey, "wec-2025-6-hours-of-imola-2025");
  // Без явной серии — F1: у него проекция появилась первой.
  assert.equal(buildEventFile(input())!.series, "f1");
});

test("у проекции WEC/IMSA нет заявки и протоколов — только derived", () => {
  const imsa = buildEventFile({
    series: "imsa", season: 2026, eventKey: "imsa-2026-daytona-international-speedway",
    eventId: "daytona-international-speedway", round: 1, fia, winners,
  })!;
  assert.deepEqual(Object.keys(imsa).filter((k) => ["entry", "milestones"].includes(k)), [],
                   "в проекцию этих серий не должно попадать ничего, кроме derived");
  assert.ok("fia" in imsa && "winners" in imsa);
});

/// Пролог WEC и тесты идут с сентинелом round 0 — round-keyed семейств у них
/// нет, и файла быть не должно.
test("событие с сентинелом раунда файла не получает", () => {
  assert.equal(buildEventFile({
    series: "wec", season: 2026, eventKey: "wec-2026-official-prologue-imola-2026",
    eventId: "official-prologue-imola-2026", round: 0,
  }), null);
});

/// ПРОВОДКА продьюсера, а не сборки: мутант «серию не передали» переживает
/// любой тест, который зовёт buildEventFile напрямую, потому что там серия
/// приходит аргументом теста. Ловится только прогоном самого продьюсера.
test("продьюсер серии пишет ИМЕННО свою серию", async () => {
  const root = mkdtempSync(join(tmpdir(), "seriesevents-"));
  mkdirSync(join(root, "wec", "2025"), { recursive: true });
  mkdirSync(join(root, "wec", "fia"), { recursive: true });
  writeFileSync(join(root, "wec", "2025", "index.json"), JSON.stringify({
    schemaVersion: 1, events: [{ round: 1, slug: "6-hours-of-imola-2025" }],
  }));
  writeFileSync(join(root, "wec", "fia", "2025_1.json"), JSON.stringify({
    schemaVersion: 1, generatedAt: "x", season: 2025, round: 1,
    event: "imola", penalties: [{ doc: 1, car: 7 }],
  }));

  await run("wec", 2025, root);

  const out = JSON.parse(readFileSync(
    join(root, "wec", "events", "wec-2025-6-hours-of-imola-2025.json"), "utf8"));
  assert.equal(out.series, "wec", "продьюсер записал чужую серию");
  assert.equal(out.eventKey, "wec-2025-6-hours-of-imola-2025");
  assert.equal(out.eventId, "6-hours-of-imola-2025");
  assert.equal(out.fia.penalties.length, 1);
  rmSync(root, { recursive: true, force: true });
});
