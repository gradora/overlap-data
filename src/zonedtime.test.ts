// Восстановление момента из настенного времени площадки (lib/zonedtime.ts).
// Проверяется то, из-за чего шаг вообще понадобился: офсет источника врёт, а
// настенное время верное — значит момент надо пересобрать по зоне трассы.

import { test } from "node:test";
import assert from "node:assert/strict";
import { reanchorToZone, zoneOffsetMinutes, zonedInstantMs } from "./lib/zonedtime.js";

test("настенное время сохраняется дословно, меняется только офсет", () => {
  // Боевой случай: fiawec отдаёт Фудзи с парижским офсетом. 10:15 — верное
  // местное время сессии, +02:00 — ложь ценой в семь часов.
  assert.equal(reanchorToZone("2025-09-26T10:15:00+02:00", "Asia/Tokyo"),
               "2025-09-26T10:15:00+09:00");
  // Строка остаётся читаемой человеком ровно как в расписании.
  assert.match(reanchorToZone("2025-09-26T10:15:00+02:00", "Asia/Tokyo")!, /T10:15:00/);
});

test("зоны боевых этапов WEC пересчитываются верно", () => {
  const cases: [string, string, string][] = [
    ["2025-02-28T14:00:00+01:00", "Asia/Qatar", "+03:00"],
    ["2025-11-08T14:00:00+01:00", "Asia/Bahrain", "+03:00"],
    ["2025-07-13T13:00:00+02:00", "America/Sao_Paulo", "-03:00"],
    ["2025-09-19T13:00:00+02:00", "America/Chicago", "-05:00"],
    ["2025-06-14T16:00:00+02:00", "Europe/Paris", "+02:00"],
  ];
  for (const [src, zone, expected] of cases) {
    assert.equal(reanchorToZone(src, zone)!.slice(-6), expected, `${zone} у ${src}`);
  }
});

/// Зона, а не фиксированное смещение: переход на летнее время меняет офсет
/// дважды в год, и хардкод «Британия = +00:00» врал бы полгода.
test("летнее время учитывается", () => {
  assert.equal(reanchorToZone("2027-04-18T13:00:00+02:00", "Europe/London")!.slice(-6), "+01:00");
  assert.equal(reanchorToZone("2025-01-15T12:00:00+01:00", "Europe/London")!.slice(-6), "+00:00");
  // Южное полушарие — обратный порядок сезонов.
  assert.equal(reanchorToZone("2025-01-15T12:00:00+01:00", "Australia/Melbourne")!.slice(-6),
               "+11:00");
  assert.equal(reanchorToZone("2025-07-15T12:00:00+01:00", "Australia/Melbourne")!.slice(-6),
               "+10:00");
});

/// Граница перехода на летнее время — единственное место, где одного прохода
/// мало: наивный инстант (настенное время, прочитанное как UTC) лежит на 1–2
/// часа позже настоящего и у самой границы попадает УЖЕ в летнее время.
/// Одним проходом 01:30 CET превратилось бы в 01:30+02:00 — час мимо.
test("граница перехода на летнее время: смещение уточняется вторым проходом", () => {
  assert.equal(reanchorToZone("2025-03-30T01:30:00", "Europe/Paris"),
               "2025-03-30T01:30:00+01:00", "до перевода стрелок ещё зима");
  assert.equal(reanchorToZone("2025-03-30T03:30:00", "Europe/Paris"),
               "2025-03-30T03:30:00+02:00", "после перевода — лето");
  assert.equal(reanchorToZone("2025-10-26T03:30:00", "Europe/Paris"),
               "2025-10-26T03:30:00+01:00", "осенний переход обратно");
});

test("момент получается настоящий, а не сдвинутый", () => {
  // 10:15 в Токио — это 01:15 UTC. Наивный разбор исходной строки дал бы 08:15.
  const ms = zonedInstantMs("2025-09-26T10:15:00+02:00", "Asia/Tokyo")!;
  assert.equal(new Date(ms).toISOString(), "2025-09-26T01:15:00.000Z");
  assert.notEqual(ms, Date.parse("2025-09-26T10:15:00+02:00"));
});

test("неизвестная зона и мусорная строка — null, вызывающий оставляет как было", () => {
  assert.equal(reanchorToZone("2025-09-26T10:15:00+02:00", "Нет/Такой"), null);
  assert.equal(reanchorToZone("не дата", "Asia/Tokyo"), null);
  assert.equal(zonedInstantMs("", "Asia/Tokyo"), null);
  assert.equal(zoneOffsetMinutes(Date.now(), "Нет/Такой"), null);
});

test("смещение зоны считается в минутах и знак верный", () => {
  const summer = Date.parse("2025-07-01T12:00:00Z");
  assert.equal(zoneOffsetMinutes(summer, "UTC"), 0);
  assert.equal(zoneOffsetMinutes(summer, "Asia/Tokyo"), 9 * 60);
  assert.equal(zoneOffsetMinutes(summer, "America/Sao_Paulo"), -3 * 60);
  // Получасовые зоны существуют — округление до часов было бы ошибкой.
  assert.equal(zoneOffsetMinutes(summer, "Asia/Kolkata"), 5 * 60 + 30);
});

test("секунды и формат без секунд не теряются", () => {
  assert.equal(reanchorToZone("2025-09-26T10:15:37+02:00", "Asia/Tokyo"),
               "2025-09-26T10:15:37+09:00");
  assert.equal(reanchorToZone("2025-09-26T10:15", "Asia/Tokyo"),
               "2025-09-26T10:15:00+09:00");
});
