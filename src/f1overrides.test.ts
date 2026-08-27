// GC override-календаря: правило «прошло» (конец дня гонки + грейс 7 дней),
// правило «переехало» (окно −2…+3 — зеркало клиентского
// F1CalendarOverride.covers, кейсы менять только вместе с клиентом),
// скоуп сезона и passthrough незнакомых полей записи.

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

// MARK: - Битый ручной файл не берёт витрину в заложники

/// Прогон обязан упасть (файл правится руками — молча затирать нельзя), но
/// упасть ПОСЛЕ сборки. Раньше gc() выходил из процесса до витрины, и одна
/// лишняя запятая в ручном файле замораживала календарь ВСЕХ сезонов: для
/// приложения — тихо, для владельца — одно письмо среди прочих.
///
/// Проверяем процессом целиком: контракт здесь — код возврата плюс файл на
/// диске, а не поведение отдельной функции.
test("продьюсер: битый override валит прогон, но витрину собирает", () => {
  const root = mkdtempSync(join(tmpdir(), "f1ovr-"));
  try {
    const data = join(root, "data");
    mkdirSync(join(data, "f1", "jolpica"), { recursive: true });
    mkdirSync(join(data, "f1", "overrides"), { recursive: true });
    const year = new Date().getUTCFullYear();
    const schedule = {
      MRData: { RaceTable: { season: String(year), Races: [{
        season: String(year), round: "1", raceName: "Australian Grand Prix",
        Circuit: { circuitId: "albert_park", circuitName: "Albert Park Grand Prix Circuit",
          Location: { locality: "Melbourne", country: "Australia" } },
        date: `${year}-03-08`,
      }] } },
    };
    writeFileSync(join(data, "f1", "jolpica", `${year}.json`), JSON.stringify(schedule));
    writeFileSync(join(data, "f1", "jolpica", "current.json"), JSON.stringify(schedule));
    writeFileSync(join(data, "f1", "overrides", "calendar.json"), "[{,]");   // битый

    const producer = join(process.cwd(), "src", "produce" + "rs", "f1overrides.ts");
    let code = 0;
    try {
      execFileSync("npx", ["tsx", producer], { cwd: root, stdio: "pipe" });
    } catch (e: any) {
      code = e.status;
    }
    assert.equal(code, 1, "битый ручной файл обязан валить прогон");
    const showcase = join(data, "f1", "calendar", `${year}.json`);
    assert.equal(existsSync(showcase), true, "витрина обязана собраться и без курируемого слоя");
    const doc = JSON.parse(readFileSync(showcase, "utf8"));
    assert.deepEqual(doc.events.map((e: any) => e.id), [`f1-${year}-1`]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
