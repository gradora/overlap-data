// Чистые функции отбора митингов OpenF1 к зеркалированию: расширяем охват на
// тесты / отменённые / ещё-не-в-Jolpica этапы, сохраняя старый Jolpica-путь.
// Без сети — фикстуры митингов в памяти.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  meetingsToSnapshot,
  matchMeeting,
  activeRoundsFrom,
  isRaceLike,
} from "./producers/openf1.js";

const DAY = 24 * 3600 * 1000;
const NOW = Date.parse("2026-03-15T12:00:00Z");

// Фикстуры митингов OpenF1 (только используемые поля).
const testing = {
  meeting_key: 1,
  meeting_name: "Pre-Season Testing",   // категория (b), к тому же вне окна ±14д
  date_start: "2026-02-26T07:00:00Z",
  date_end: "2026-02-28T15:00:00Z",
  is_cancelled: false,
};
const cancelled = {
  meeting_key: 2,
  meeting_name: "Emilia Romagna Grand Prix",   // категория (c), далёкое будущее
  date_start: "2026-09-01T09:00:00Z",
  date_end: "2026-09-03T18:00:00Z",
  is_cancelled: true,
};
const roundMatched = {
  meeting_key: 3,
  meeting_name: "Bahrain Grand Prix",   // категория (a): день гонки — 2026-02-01
  date_start: "2026-01-30T09:00:00Z",   // вне окна ±14д → отбирается ТОЛЬКО раундом
  date_end: "2026-02-01T18:00:00Z",
  is_cancelled: false,
};
const farFuture = {
  meeting_key: 4,
  meeting_name: "Japanese Grand Prix",   // обычный, вне окна, не в Jolpica → НЕ берём
  date_start: "2026-06-01T00:00:00Z",
  date_end: "2026-06-03T18:00:00Z",
  is_cancelled: false,
};
const nearFutureNew = {
  meeting_key: 5,
  meeting_name: "Saudi Arabian Grand Prix",   // категория (d): старт +5д, не в Jolpica
  date_start: "2026-03-20T00:00:00Z",
  date_end: "2026-03-22T18:00:00Z",
  is_cancelled: false,
};

const ALL = [testing, cancelled, roundMatched, farFuture, nearFutureNew];
const roundDates = ["2026-02-01"];   // Jolpica знает только Бахрейн

// key → reason для отобранных митингов.
function selected(meetings: any[], dates: string[], now = NOW, allDates: string[] = []) {
  const map = new Map<number, string>();
  for (const t of meetingsToSnapshot(meetings, dates, now, allDates)) {
    map.set(t.meeting.meeting_key, t.reason);
  }
  return map;
}

test("meetingsToSnapshot: тестовый митинг отбирается (категория testing)", () => {
  assert.equal(selected(ALL, roundDates).get(1), "testing");
});

test("meetingsToSnapshot: отменённый митинг отбирается (категория cancelled)", () => {
  assert.equal(selected(ALL, roundDates).get(2), "cancelled");
});

test("meetingsToSnapshot: сматченный на раунд Jolpica отбирается (категория round)", () => {
  assert.equal(selected(ALL, roundDates).get(3), "round");
});

test("meetingsToSnapshot: далёкий этап не в Jolpica без полного расписания НЕ отбирается (январский гард)", () => {
  assert.equal(selected(ALL, roundDates).has(4), false);
});

test("meetingsToSnapshot: этап не в Jolpica при полном расписании отбирается (категория overlay, кейс Sepang)", () => {
  // Jolpica знает Бахрейн, но не «Japanese GP» (key 4) — это оверлей-этап:
  // листинг сессий нужен клиенту круглый год, окна ±14д не ждём.
  const res = selected(ALL, roundDates, NOW, ["2026-02-01"]);
  assert.equal(res.get(4), "overlay");
  // Сматченный с расписанием Бахрейн оверлеем НЕ становится (взят раундом).
  assert.equal(res.get(3), "round");
});

test("meetingsToSnapshot: этап в окне ±14д, но не в Jolpica отбирается (категория new)", () => {
  assert.equal(selected(ALL, roundDates).get(5), "new");
});

test("meetingsToSnapshot: dedup по meeting_key, приоритет round над new", () => {
  // Бахрейн стартует в окне ±14д (13 марта) → квалифицируется и как new, но
  // раунд идёт первым и побеждает.
  const bahrainInWindow = { ...roundMatched, date_start: "2026-03-13T09:00:00Z", date_end: "2026-03-15T18:00:00Z" };
  const res = meetingsToSnapshot([bahrainInWindow], ["2026-03-15"], NOW);
  assert.equal(res.length, 1);
  assert.equal(res[0].reason, "round");
  assert.equal(res[0].finishMs, Date.parse("2026-03-15T23:59:59Z"));   // финиш из даты Jolpica, не date_end
});

test("meetingsToSnapshot: 'Testing' регистронезависим", () => {
  const m = { meeting_key: 9, meeting_name: "In-Season TESTING", date_start: "2025-01-01T00:00:00Z", date_end: "2025-01-02T00:00:00Z" };
  assert.equal(selected([m], []).get(9), "testing");
});

test("matchMeeting: интервал митинга пересекает день гонки (кейс Лас-Вегаса)", () => {
  const vegas = { meeting_key: 7, date_start: "2026-11-21T22:00:00Z", date_end: "2026-11-22T06:00:00Z" };
  assert.equal(matchMeeting([vegas], "2026-11-22")?.meeting_key, 7);   // гонка в ночь между датами
  assert.equal(matchMeeting([vegas], "2026-11-25"), undefined);
});

test("activeRoundsFrom: раунды в lead-окне против будущих", () => {
  const near = new Date(NOW + 2 * DAY).toISOString().slice(0, 10);   // через 2д — уже в 3д-окне
  const far = new Date(NOW + 30 * DAY).toISOString().slice(0, 10);   // через 30д — рано
  const past = new Date(NOW - 10 * DAY).toISOString().slice(0, 10);  // прошедшая гонка
  const schedule = { MRData: { RaceTable: { Races: [
    { round: "1", date: past },
    { round: "2", date: near },
    { round: "3", date: far },
    { round: "4" },   // без даты — пропускается
  ] } } };
  assert.deepEqual(activeRoundsFrom(schedule, NOW), [past, near]);
  assert.deepEqual(activeRoundsFrom({}, NOW), []);   // нет расписания — пусто
});

test("isRaceLike: гонка/спринт против практик, квал и shootout", () => {
  assert.equal(isRaceLike("Race"), true);
  assert.equal(isRaceLike("Sprint"), true);
  assert.equal(isRaceLike("Sprint Qualifying"), false);
  assert.equal(isRaceLike("Sprint Shootout"), false);
  assert.equal(isRaceLike("Qualifying"), false);
  assert.equal(isRaceLike("Practice 1"), false);
  assert.equal(isRaceLike(undefined), false);
});
