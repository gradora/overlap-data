// GC override-календаря: правило «прошло» (конец дня гонки + грейс 7 дней),
// правило «переехало» (окно −2…+3 — зеркало клиентского
// F1CalendarOverride.covers, кейсы менять только вместе с клиентом),
// скоуп сезона и passthrough незнакомых полей записи.

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { collect, dayMs, GRACE_MS, isPast, isSuperseded } from "./producers/f1overrides.js";

const DAY = 24 * 60 * 60 * 1000;

const entry = (over: Record<string, unknown> = {}): any => ({
  season: 2026,
  round: 16,
  date: "2026-10-04",
  raceName: "Sepang Grand Prix",
  circuitName: "Sepang International Circuit",
  locality: "Sepang",
  country: "Malaysia",
  kind: "race",
  circuitId: "sepang",
  ...over,
});

const race = (date: string, over: Record<string, unknown> = {}): any => ({
  season: 2026,
  circuitId: "sepang",
  date,
  ...over,
});

test("прошло: снимается ровно после конца дня гонки + грейса", () => {
  const boundary = dayMs("2026-10-04")! + DAY + GRACE_MS; // 12 окт 00:00Z
  assert.equal(isPast(entry(), boundary - 1), false);
  assert.equal(isPast(entry(), boundary), true);
});

test("прошло: мусорная и пустая дата запись не снимают", () => {
  assert.equal(isPast(entry({ date: "когда-нибудь" }), Number.MAX_SAFE_INTEGER), false);
  assert.equal(isPast(entry({ date: undefined }), Number.MAX_SAFE_INTEGER), false);
});

test("переехало: тот же сезон и трасса на дне вне окна −2…+3", () => {
  // В окне — страховка живёт (клиентский дедуп запись гасит сам).
  assert.equal(isSuperseded(entry(), [race("2026-10-04")]), false); // тот же день
  assert.equal(isSuperseded(entry(), [race("2026-10-02")]), false); // −2, край окна
  assert.equal(isSuperseded(entry(), [race("2026-10-06")]), false); // +2, в окне
  // Вне окна — дата-дедуп бессилен, запись superseded.
  assert.equal(isSuperseded(entry(), [race("2026-10-01")]), true);  // −3
  assert.equal(isSuperseded(entry(), [race("2026-10-07")]), true);  // +3, край
  // Скоупы: другая трасса / другой сезон / запись без circuitId — не матч.
  assert.equal(isSuperseded(entry(), [race("2026-10-18", { circuitId: "losail" })]), false);
  assert.equal(isSuperseded(entry(), [race("2027-10-18", { season: 2027 })]), false);
  assert.equal(isSuperseded(entry({ circuitId: undefined }), [race("2026-10-18")]), false);
});

test("collect: причины, порядок и passthrough незнакомых полей", () => {
  const past = entry({ date: "2026-03-01", raceName: "Прошедший", extra: "поле" });
  const moved = entry({ raceName: "Переехавший" });
  const alive = entry({ date: "2027-05-01", season: 2027, raceName: "Живой", circuitId: "monaco" });
  const now = dayMs("2026-10-05")!; // Переехавший ещё не «прошёл»
  const { kept, dropped } = collect([past, moved, alive], [race("2026-10-18")], now);
  assert.deepEqual(kept, [alive]);
  assert.deepEqual(
    dropped.map((d) => [d.entry.raceName, d.reason]),
    [["Прошедший", "прошло"], ["Переехавший", "переехало"]]
  );
  // Объекты не пересобираются — ручные поля переживают GC.
  assert.equal((dropped[0].entry as any).extra, "поле");
});

test("collect: пустое расписание выключает только правило «переехало»", () => {
  const moved = entry({ raceName: "Переехавший" });
  const { kept } = collect([moved], [], dayMs("2026-10-05")!);
  assert.deepEqual(kept, [moved]);
});
