// Проекция семейств в файл события (lib/eventfile.ts). Проверяется то, из-за
// чего проекция вообще выбрана формой: она ничего не выдумывает, ничего не
// накапливает и не шумит в git.

import { test } from "node:test";
import assert from "node:assert/strict";
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
  // season и round живут сверху, дублировать их в каждом блоке незачем.
  assert.equal((file.fia as any).season, undefined);
  assert.equal((file.fia as any).round, undefined);
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
