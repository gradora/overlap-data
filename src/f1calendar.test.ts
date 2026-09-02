// Витрина календаря F1 (фаза 4). Тесты — не новые: это ПЕРЕЕЗД багажа трёх
// клиентских тест-файлов к новой ответственности, плюс предохранители записи.
//
// Портированы (имена сохранены узнаваемыми, чтобы пара читалась глазами):
//   OverlapTests/F1OverlayItemsTests.swift     — маршрутизация митингов и дедуп
//                                                ПО ДАТЕ (кейс Sepang-2026);
//   OverlapTests/F1RaceMergerTests.swift       — склейка по ПАРЕ (season, round)
//                                                (январская химера сезонов);
//   OverlapTests/F1CalendarOverrideTests.swift — курируемый слой, round-сентинел
//                                                0, TBC, самозаживление дедупа.
// Цена ошибки здесь высокая и МОЛЧАЛИВАЯ: слишком широкий дедуп съедает этап,
// слишком узкий рисует его дважды; ни то, ни другое не падает и не логируется.
// Плюс мутационная самопроверка предохранителей НА ВЫЗОВЕ (образец 3a/3b).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assetSlugFor, builtinTrackSlug, buildF1CalendarDoc, buildF1CalendarFiles,
  countryF1, countryMeeting, coveredSeasons, crossCheckCalendar,
  f1CalendarRegression, isTestingMeeting, mergePages, mergeRaces, overlayMeetings,
  orphanOverrides, overrideCovers, overrideEvents, readOverrides, slugified, trackNameF1,
  trackNameMeeting, writeF1Calendar, F1_CALENDAR_SCHEMA_VERSION,
  type F1CalendarDoc, type F1OverrideEntry, type JolpicaRace, type OpenF1MeetingRaw,
} from "./lib/f1calendar.js";

const NOW = Date.parse("2026-08-27T12:00:00Z");

// MARK: Фикстуры

function meeting(
  name: string, start: string, end: string,
  opts: { key?: number; cancelled?: boolean; shortName?: string; country?: string } = {},
): OpenF1MeetingRaw {
  return {
    meeting_key: opts.key ?? 1,
    meeting_name: name,
    date_start: `${start}T09:00:00+00:00`,
    date_end: `${end}T17:00:00+00:00`,
    year: 2026,
    is_cancelled: opts.cancelled,
    circuit_short_name: opts.shortName ?? name,
    country_name: opts.country ?? "Country",
  };
}

function race(
  round: string,
  opts: {
    season?: string; results?: unknown[]; sprintResults?: unknown[];
    sprint?: { date: string; time?: string }; date?: string;
    circuitId?: string; circuitName?: string; locality?: string; country?: string;
    name?: string;
  } = {},
): JolpicaRace {
  const season = opts.season ?? "2026";
  return {
    season,
    round,
    raceName: opts.name ?? `Race ${round}`,
    Circuit: {
      circuitId: opts.circuitId ?? `circuit-${round}`,
      circuitName: opts.circuitName ?? "Albert Park Grand Prix Circuit",
      Location: { locality: opts.locality ?? "Melbourne", country: opts.country ?? "Australia" },
    },
    date: opts.date ?? `${season}-06-0${round}`,
    time: "13:00:00Z",
    Results: opts.results ?? null,
    SprintResults: opts.sprintResults ?? null,
    Sprint: opts.sprint ?? null,
  };
}

const WINNER = [{ position: "1" }];

/// Байты ровно как в data/f1/overrides/calendar.json на бэкенде.
const OVERRIDE_JSON = `[
  {
    "season": 2026,
    "round": 16,
    "date": "2026-10-04",
    "raceName": "Bahrain Grand Prix",
    "circuitName": "Sepang International Circuit",
    "circuitId": "sepang",
    "locality": "Sepang",
    "country": "Malaysia",
    "kind": "race"
  }
]`;

const decodedOverrides = (): F1OverrideEntry[] => JSON.parse(OVERRIDE_JSON);

function docOf(input: {
  schedule?: JolpicaRace[]; results?: JolpicaRace[]; sprints?: JolpicaRace[];
  meetings?: OpenF1MeetingRaw[]; overrides?: F1OverrideEntry[]; season?: number; now?: number;
}): F1CalendarDoc {
  return buildF1CalendarDoc({
    season: input.season ?? 2026,
    schedule: input.schedule ?? [],
    results: input.results ?? [],
    sprints: input.sprints ?? [],
    meetings: input.meetings ?? [],
    overrides: input.overrides ?? [],
    now: input.now ?? NOW,
    refs: null,   // явное «без карты»: узлы порта не зависят от курируемых данных
  });
}

// MARK: - Порт F1OverlayItemsTests: маршрутизация митингов

/// Тестовый уик-энд уходит на отдельный экран тестов и НЕ дедуплится:
/// в jolpica тестов нет в принципе.
test("overlay: тестовый митинг становится testing-событием", () => {
  const items = overlayMeetings([meeting("Pre-Season Testing", "2026-02-11", "2026-02-13")], []);
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, "testing");
});

/// Отменённый этап — свой вид карточки, тоже мимо дедупа.
test("overlay: отменённый митинг становится cancelled-событием", () => {
  const items = overlayMeetings(
    [meeting("Emilia Romagna Grand Prix", "2026-05-15", "2026-05-17", { cancelled: true })], []);
  assert.equal(items[0].kind, "cancelled");
});

/// ТЕСТ ПОБЕЖДАЕТ ОТМЕНУ: отменённый ТЕСТ остаётся тестовым событием
/// (порядок проверок в функции — часть контракта).
test("overlay: тест побеждает отмену", () => {
  const items = overlayMeetings(
    [meeting("Pre-Season Testing", "2026-02-11", "2026-02-13", { cancelled: true })], []);
  assert.equal(items[0].kind, "testing");
});

// MARK: - Порт F1OverlayItemsTests: дедуп обычных гонок ПО ДАТЕ

test("overlay: день гонки jolpica внутри окна гасит митинг", () => {
  const items = overlayMeetings(
    [meeting("Australian Grand Prix", "2026-03-06", "2026-03-08")], ["2026-03-08"]);
  assert.deepEqual(items, [], "этап из jolpica продублирован оверлеем");
});

/// Дедуп по ДАТЕ, а не по имени: OpenF1 зовёт трассы по городу («Melbourne»),
/// jolpica — по имени трассы («Albert Park»). Совпадение имён не требуется.
test("overlay: дедуп не смотрит на имя", () => {
  const items = overlayMeetings([meeting("Melbourne", "2026-03-06", "2026-03-08")], ["2026-03-08"]);
  assert.deepEqual(items, []);
});

/// Гонка в ПОСЛЕДНИЙ день окна — внутри интервала.
test("overlay: гонка в последний день окна считается внутри", () => {
  assert.deepEqual(overlayMeetings([meeting("GP", "2026-03-06", "2026-03-08")], ["2026-03-08"]), []);
});

/// Гонка ЗА пределами окна (соседний уик-энд) митинг не гасит — иначе новый
/// этап пропал бы из ленты. Это и есть кейс Sepang-2026.
test("overlay: этап вне окна выживает (кейс Sepang-2026)", () => {
  const items = overlayMeetings(
    [meeting("Malaysian Grand Prix", "2026-10-02", "2026-10-04")],
    ["2026-09-27", "2026-10-11"]);
  assert.equal(items.length, 1, "новый этап не должен исчезать");
  assert.equal(items[0].kind, "race");
});

/// Гонка «в ночь между датами» (Лас-Вегас, Австралия, Судзука: финиш в
/// ранние UTC-часы) — самый хрупкий случай дедупа. У витрины окно считается по
/// КАЛЕНДАРЮ ИСТОЧНИКА, поэтому ответ один на всех; у клиента он зависит от
/// пояса устройства (см. таблицу паритета фазы), и западнее UTC этап рисуется
/// дважды. Здесь пинуется именно ответ витрины.
test("overlay: ночная гонка дедуплится по календарю источника", () => {
  const vegas: OpenF1MeetingRaw = {
    meeting_key: 1300, meeting_name: "Las Vegas Grand Prix",
    date_start: "2026-11-20T00:30:00+00:00", date_end: "2026-11-22T06:00:00+00:00",
    circuit_short_name: "Las Vegas", country_name: "United States",
  };
  assert.deepEqual(overlayMeetings([vegas], ["2026-11-22"]), []);
  const doc = docOf({
    schedule: [race("21", { date: "2026-11-22", circuitName: "Las Vegas Strip Street Circuit",
      locality: "Las Vegas", country: "USA" })],
    meetings: [vegas],
  });
  assert.equal(doc.events.length, 1, "этап нарисован дважды");
  assert.deepEqual(doc.events[0].sourceIds.openf1, { meetingKey: 1300 });
  assert.equal(doc.events[0].venue, "Las Vegas Strip");
  assert.equal(doc.events[0].assetSlug, "las-vegas-strip");
});

test("overlay: пустое расписание jolpica пропускает все митинги", () => {
  const items = overlayMeetings([
    meeting("GP One", "2026-03-06", "2026-03-08", { key: 1 }),
    meeting("GP Two", "2026-03-20", "2026-03-22", { key: 2 }),
  ], []);
  assert.equal(items.length, 2);
});

/// Смешанный вход: тест + дубль + новый этап — каждый по своему правилу.
test("overlay: смешанный вход маршрутизируется по правилам", () => {
  const items = overlayMeetings([
    meeting("Pre-Season Testing", "2026-02-11", "2026-02-13", { key: 1 }),
    meeting("Australian Grand Prix", "2026-03-06", "2026-03-08", { key: 2 }),
    meeting("Malaysian Grand Prix", "2026-10-02", "2026-10-04", { key: 3 }),
  ], ["2026-03-08"]);
  assert.deepEqual(items.map((i) => i.kind), ["testing", "race"],
    "остаться должны тест и новый этап; дубль — отброшен");
});

test("overlay: isTesting регистронезависим, гонка тестом не считается", () => {
  assert.equal(isTestingMeeting("PRE-SEASON TESTING"), true);
  assert.equal(isTestingMeeting("Barcelona testing"), true);
  assert.equal(isTestingMeeting("Australian Grand Prix"), false);
});

// MARK: - Порт F1RaceMergerTests: склейка по ПАРЕ (season, round)

test("merge: сортирует расписание по раунду и подмешивает результаты", () => {
  const merged = mergeRaces(
    [race("2"), race("1")],                    // нарочно вразнобой
    [race("1", { results: WINNER })],          // результаты только у R1
    []);
  assert.deepEqual(merged.map((r) => r.round), ["1", "2"]);
  assert.equal(merged[0].Results?.length, 1, "результаты подмешаны");
  assert.equal(merged[1].Results, null, "раунд без результатов остаётся из расписания");
});

test("merge: подшивает спринт-сессию", () => {
  const merged = mergeRaces(
    [race("1")], [], [race("1", { sprint: { date: "2026-05-31", time: "10:00:00Z" } })]);
  assert.equal(merged[0].Sprint?.date, "2026-05-31");
});

test("merge: пустые источники отдают расписание как есть", () => {
  assert.deepEqual(mergeRaces([race("1"), race("2")], [], []).map((r) => r.round), ["1", "2"]);
});

/// ХИМЕРА СЕЗОНОВ: расписание уже нового года, результаты ещё прошлого — тот
/// самый январский рассинхрон. Победители чужого года не должны приклеиться.
test("merge: результаты чужого сезона не приклеиваются", () => {
  const merged = mergeRaces(
    [race("1", { season: "2027" }), race("2", { season: "2027" })],
    [race("1", { season: "2026", results: WINNER }),
     race("2", { season: "2026", results: WINNER })],
    []);
  assert.equal(merged.length, 2);
  assert.ok(merged.every((r) => r.season === "2027"));
  assert.ok(merged.every((r) => r.Results === null),
    "результаты 2026 приклеились к этапам 2027 — химера сезонов");
});

test("merge: спринт чужого сезона не приклеивается", () => {
  const merged = mergeRaces(
    [race("5", { season: "2027" })], [],
    [race("5", { season: "2026", sprint: { date: "2026-06-05" } })]);
  assert.equal(merged[0].Sprint, null, "спринт 2026 приклеился к этапу 2027");
});

test("merge: в пределах одного сезона склейка работает как прежде", () => {
  const merged = mergeRaces(
    [race("1")], [race("1", { results: WINNER })],
    [race("1", { sprint: { date: "2026-06-01" } })]);
  assert.equal(merged[0].Results?.length, 1);
  assert.notEqual(merged[0].Sprint, null);
});

test("merge: из смешанных сезонов берётся совпадающий по паре", () => {
  const merged = mergeRaces(
    [race("3", { season: "2026" })],
    [race("3", { season: "2025", results: WINNER }),
     race("3", { season: "2026", results: WINNER })],
    []);
  assert.equal(merged[0].season, "2026");
  assert.equal(merged[0].Results?.length, 1);
});

test("merge: страницы пагинации клеятся по раунду", () => {
  const pages = [
    [race("1", { results: [{ position: "1" }] })],
    [race("1", { results: [{ position: "2" }] }), race("2", { results: WINNER })],
  ];
  const merged = mergePages(pages);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].Results?.length, 2, "строки раунда, разорванного страницей, склеены");
  assert.equal(merged[1].round, "2");
});

// MARK: - Порт F1CalendarOverrideTests: курируемый слой

test("override: декодится форма бэкенда", () => {
  const list = decodedOverrides();
  assert.equal(list.length, 1);
  assert.equal(list[0].season, 2026);
  assert.equal(list[0].round, 16);
  assert.equal(list[0].date, "2026-10-04");
  assert.equal(list[0].kind, "race");
});

/// id по ДАТЕ (нет коллизии с раундом jolpica «f1-2026-16» — Сингапур),
/// раунд карьера — сентинел 0, статус — tbc (бейдж «TBC» у клиента).
test("override: событие получает id по дате, round 0 и статус tbc", () => {
  const doc = docOf({ overrides: decodedOverrides() });
  assert.equal(doc.events.length, 1);
  const e = doc.events[0];
  assert.equal(e.id, "f1-override-2026-10-04");
  assert.notEqual(e.id, "f1-2026-16");
  assert.equal(e.round, 0, "round-сентинел потерян — деталка утянет чужой этап");
  assert.equal(e.status, "tbc");
  assert.equal(e.kind, "race");
  assert.equal(e.name, "Bahrain Grand Prix");
  assert.equal(e.country, "Malaysia");
  assert.equal(e.dates.race, "2026-10-04");
  assert.equal(e.dates.start, "2026-10-02");
  assert.deepEqual(e.sourceIds, { jolpica: null, openf1: null, override: true });
});

/// «Sepang International Circuit» → «Sepang» → слаг «sepang»: те же факты,
/// геометрия и медиа-файл, что у настоящей гонки.
test("override: трасса и ключ ассета резолвятся как у гонки", () => {
  const e = docOf({ overrides: decodedOverrides() }).events[0];
  assert.equal(e.venue, "Sepang");
  assert.equal(e.assetSlug, "sepang");
});

test("override: гаснет, когда источник отдал этот уик-энд", () => {
  assert.deepEqual(overrideEvents(decodedOverrides(), ["2026-10-04"]), []);
  // ±день внутри окна — тоже дедупится (расхождение дат источников).
  assert.deepEqual(overrideEvents(decodedOverrides(), ["2026-10-05"]), []);
});

test("override: остаётся, когда уик-энд свободен", () => {
  const kept = overrideEvents(decodedOverrides(), ["2026-09-20", "2026-10-11"]);
  assert.equal(kept.length, 1);
});

/// Окно covers(): то же −2/+3, что у дедупа; издалека — false.
test("override: окно covers −2…+3", () => {
  assert.equal(overrideCovers("2026-10-04", "2026-10-04"), true);
  assert.equal(overrideCovers("2026-10-04", "2026-10-02"), true);   // −2 включительно
  assert.equal(overrideCovers("2026-10-04", "2026-10-06"), true);   // +2 (до <+3)
  assert.equal(overrideCovers("2026-10-04", "2026-10-07"), false);  // +3 — уже вне
  assert.equal(overrideCovers("2026-10-04", "2026-10-01"), false);  // −3 — вне
});

/// Тесты и отмены курируемым слоем не заводятся: они приходят живым оверлеем.
test("override: не-гоночные записи не материализуются", () => {
  const entries: F1OverrideEntry[] = [
    { season: 2026, round: 0, date: "2026-02-13", raceName: "Test", kind: "testing" },
  ];
  assert.deepEqual(overrideEvents(entries, []), []);
});

/// Kuala Lumpur (OpenF1 short-name перенесённого этапа) → канон Sepang, а
/// страна — по ТРАССЕ, не по протухшему country_name митинга.
test("override/оверлей: Kuala Lumpur → Sepang, страна по трассе", () => {
  const m = meeting("Bahrain Grand Prix", "2026-10-02", "2026-10-04",
    { key: 1308, shortName: "Kuala Lumpur", country: "Bahrain" });
  assert.equal(trackNameMeeting(m), "Sepang");
  assert.equal(countryMeeting(m, trackNameMeeting(m)), "Malaysia");
  assert.equal(builtinTrackSlug("Sepang"), "sepang");
});

// MARK: - Каноника трасс и ключи ассетов (порт RaceLocation/MediaKey/TrackKey)

test("каноника: имена трасс нормализуются как на экране", () => {
  assert.equal(trackNameF1("Albert Park Grand Prix Circuit", "Melbourne"), "Albert Park");
  assert.equal(trackNameF1("Losail International Circuit", "Lusail"), "Losail");
  assert.equal(trackNameF1("Las Vegas Strip Street Circuit", "Las Vegas"), "Las Vegas Strip");
  assert.equal(trackNameF1("Autódromo José Carlos Pace", "São Paulo"), "Interlagos");
  assert.equal(trackNameF1("Circuit de Barcelona-Catalunya", "Barcelona"), "Barcelona");
  assert.equal(trackNameF1("", "Madrid"), "Madrid", "пустое имя уводит на фолбэк-город");
  assert.equal(trackNameMeeting(meeting("GP", "2026-01-01", "2026-01-02", { shortName: "Spielberg" })),
    "Red Bull Ring");
  assert.equal(trackNameMeeting(meeting("GP", "2026-01-01", "2026-01-02", { shortName: "Sakhir" })),
    "Bahrain", "решение владельца: обложка теста — bahrain-testing, не sakhir-…");
});

test("каноника: три пространства слагов не смешиваются", () => {
  // media (assetSlug) ≠ backend/refs (trackRef): файлы уже названы так.
  assert.equal(slugified("Las Vegas Strip"), "las-vegas-strip");
  assert.equal(builtinTrackSlug("Las Vegas Strip"), "las-vegas");
  assert.equal(slugified("Madring"), "madring");
  assert.equal(builtinTrackSlug("Madring"), "madrid");
  assert.equal(builtinTrackSlug("Lusail"), "losail");
});

test("ассеты: у теста конвенция «<трасса>-testing», у отмены — обычная", () => {
  assert.equal(assetSlugFor("Bahrain", "testing"), "bahrain-testing");
  assert.equal(assetSlugFor("Bahrain", "cancelled"), "bahrain");
  assert.equal(assetSlugFor("Bahrain", "race"), "bahrain");
});

test("страна: формы источников унифицируются", () => {
  assert.equal(countryF1("United States"), "USA");
  assert.equal(countryF1("United Kingdom"), "UK");
  assert.equal(countryF1("United Arab Emirates"), "UAE");
  assert.equal(countryF1("Italy"), "Italy");
});

// MARK: - Документ: статусы, спринт, привязка ключей

test("документ: гонка jolpica — confirmed с раундом и ключом источника", () => {
  const doc = docOf({ schedule: [race("1", { date: "2026-03-08" })] });
  const e = doc.events[0];
  assert.equal(e.id, "f1-2026-1");
  assert.equal(e.status, "confirmed");
  assert.equal(e.round, 1);
  assert.deepEqual(e.sourceIds.jolpica, { season: 2026, round: 1 });
  assert.equal(e.dates.start, "2026-03-06", "старт уик-энда — день гонки минус два");
  assert.equal(e.dates.raceTime, "13:00:00Z");
});

test("документ: спринт-уик-энд виден и по сессии расписания, и по результатам", () => {
  const bySession = docOf({ schedule: [race("1", { sprint: { date: "2026-03-07" } })] });
  assert.equal(bySession.events[0].sprintWeekend, true);
  const byResults = docOf({
    schedule: [race("1")],
    sprints: [race("1", { sprintResults: WINNER })],
  });
  assert.equal(byResults.events[0].sprintWeekend, true);
  assert.equal(docOf({ schedule: [race("1")] }).events[0].sprintWeekend, false);
});

/// Митинг, съеденный дедупом, обязан найтись у СВОЕЙ гонки: «пропал из ленты»
/// и «потерял meeting_key» не имеют права разъехаться.
test("документ: съеденный дедупом митинг отдаёт ключ своей гонке", () => {
  const doc = docOf({
    schedule: [race("1", { date: "2026-03-08" })],
    meetings: [meeting("Melbourne", "2026-03-06", "2026-03-08", { key: 1279 })],
  });
  assert.equal(doc.events.length, 1, "митинг не должен добавлять второе событие");
  assert.deepEqual(doc.events[0].sourceIds.openf1, { meetingKey: 1279 });
  assert.deepEqual(crossCheckCalendar(doc, [meeting("Melbourne", "2026-03-06", "2026-03-08",
    { key: 1279 })]).warnings, []);
});

test("документ: оверлей-событие несёт свой meeting_key и сентинел 0", () => {
  const doc = docOf({
    schedule: [race("1", { date: "2026-03-08" })],
    meetings: [
      meeting("Melbourne", "2026-03-06", "2026-03-08", { key: 1279 }),
      meeting("Pre-Season Testing", "2026-02-11", "2026-02-13", { key: 1304, shortName: "Sakhir" }),
    ],
  });
  const testing = doc.events.find((e) => e.kind === "testing")!;
  assert.equal(testing.id, "f1-meeting-1304");
  assert.equal(testing.round, 0);
  assert.equal(testing.status, "tbc");
  assert.equal(testing.assetSlug, "bahrain-testing");
  assert.equal(testing.sourceIds.jolpica, null);
});

test("документ: события отсортированы по дню, тест впереди первой гонки", () => {
  const doc = docOf({
    schedule: [race("2", { date: "2026-03-15" }), race("1", { date: "2026-03-08" })],
    meetings: [meeting("Pre-Season Testing", "2026-02-11", "2026-02-13", { key: 9 })],
  });
  assert.deepEqual(doc.events.map((e) => e.dates.race),
    ["2026-02-13", "2026-03-08", "2026-03-15"]);
});

test("документ: сезон морозится, когда последнее событие отстоялось", () => {
  const past = docOf({ schedule: [race("1", { season: "2025", date: "2025-12-07" })], season: 2025 });
  assert.equal(past.frozen, true);
  const live = docOf({ schedule: [race("1", { date: "2026-12-06" })] });
  assert.equal(live.frozen, false);
});

// MARK: - Кросс-чек ключей (расширение guard 0.3)

test("кросс-чек: ключ jolpica за чужой сезон — фатал", () => {
  const doc = docOf({ schedule: [race("1", { date: "2026-03-08" })] });
  doc.events[0].sourceIds.jolpica = { season: 2025, round: 1 };   // мутация: химера
  const check = crossCheckCalendar(doc, []);
  assert.equal(check.fatal.length, 1);
  assert.match(check.fatal[0], /химера сезонов/);
});

test("кросс-чек: tbc с ненулевым раундом — фатал (сентинел потерян)", () => {
  const doc = docOf({ overrides: decodedOverrides() });
  doc.events[0].round = 16;   // мутация: «улучшили» сентинел официальным номером
  assert.match(crossCheckCalendar(doc, []).fatal.join(" "), /сентинел 0 потерян/);
});

test("кросс-чек: один meeting_key у двух событий — фатал", () => {
  const doc = docOf({
    schedule: [race("1", { date: "2026-03-08" })],
    meetings: [meeting("Melbourne", "2026-03-06", "2026-03-08", { key: 1279 })],
  });
  doc.events.push({ ...doc.events[0], id: "f1-2026-99", round: 99,
    sourceIds: { jolpica: { season: 2026, round: 99 }, openf1: { meetingKey: 1279 }, override: false } });
  assert.match(crossCheckCalendar(doc, []).fatal.join(" "), /выдан двум событиям/);
});

/// Митинг, который не стал событием и не отдал ключ гонке, — это ровно класс
/// Sepang-2026 («был у источника, исчез из ленты»), только теперь он кричит.
test("кросс-чек: непредставленный митинг — предупреждение, не блокировка", () => {
  const doc = docOf({ schedule: [race("1", { date: "2026-03-08" })] });
  const check = crossCheckCalendar(doc, [meeting("Sepang", "2026-10-02", "2026-10-04", { key: 1308 })]);
  assert.equal(check.fatal.length, 0);
  assert.match(check.warnings.join(" "), /не представлен/);
});

// MARK: - Предохранитель записи (мутационная самопроверка НА ВЫЗОВЕ)

test("предохранитель: сжатие состава не затирает прежний файл", () => {
  const prev = docOf({ schedule: [race("1"), race("2")] });
  const next = docOf({ schedule: [race("1")] });
  assert.match(f1CalendarRegression(prev, next)!, /событий стало меньше/);
  assert.equal(f1CalendarRegression(null, next), null, "первый прогон обязан записать файл");
  assert.equal(f1CalendarRegression(prev, prev), null);
});

test("предохранитель: пропажа этапов jolpica при том же числе событий", () => {
  const prev = docOf({ schedule: [race("1", { date: "2026-03-08" })] });
  const next = docOf({
    meetings: [meeting("Melbourne", "2026-03-06", "2026-03-08", { key: 1279 })],
  });
  assert.equal(prev.events.length, next.events.length);
  assert.match(f1CalendarRegression(prev, next)!, /этапы исчезли из витрины неотменёнными/);
});

test("предохранитель: ОТМЕНА этапа посреди сезона — не деградация", () => {
  // Блокер, найденный скептиком фазы 4: jolpica СНИМАЕТ отменённый раунд из
  // расписания, поэтому число confirmed законно сжимается — ровно в том
  // классе событий, ради которого заведён kind: cancelled. Слепой счёт морозил
  // витрину навсегда (kept-previous каждый час, F1_CALENDAR_FORCE не помогает —
  // он про freeze), а клиент тихо уходил на живой мердж.
  const prev = docOf({
    schedule: [race("1", { date: "2026-03-08" }), race("2", { date: "2026-03-15" })],
  });
  // Второй раунд отменён: из расписания jolpica пропал, но митинг OpenF1
  // остался и отдаёт его отменённым — событие в файле СОХРАНЯЕТСЯ, сменив вид.
  const next = docOf({
    schedule: [race("1", { date: "2026-03-08" })],
    meetings: [meeting("Melbourne", "2026-03-06", "2026-03-08", { key: 1279 }),
               meeting("Jeddah", "2026-03-13", "2026-03-15", { key: 1280, cancelled: true })],
  });
  const confirmedBefore = prev.events.filter((e) => e.status === "confirmed").length;
  const confirmedAfter = next.events.filter((e) => e.status === "confirmed").length;
  assert.ok(confirmedAfter < confirmedBefore, "фикстура обязана сжимать confirmed");
  assert.equal(f1CalendarRegression(prev, next), null,
               "законная отмена не имеет права заморозить витрину");
});

test("предохранитель: пропажа привязки к митингам OpenF1", () => {
  const prev = docOf({
    schedule: [race("1", { date: "2026-03-08" })],
    meetings: [meeting("Melbourne", "2026-03-06", "2026-03-08", { key: 1279 })],
  });
  const next = docOf({ schedule: [race("1", { date: "2026-03-08" })] });
  assert.match(f1CalendarRegression(prev, next)!, /привязка к митингам OpenF1 пропала/);
});

test("запись: конверт, идемпотентность, заморозка и предохранители", () => {
  const dir = mkdtempSync(join(tmpdir(), "f1calendar-"));
  const path = join(dir, "2026.json");
  try {
    const doc = docOf({ schedule: [race("1", { date: "2026-12-06" }), race("2", { date: "2026-12-13" })] });
    assert.equal(writeF1Calendar(path, doc), "written");
    const raw = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(raw.schemaVersion, F1_CALENDAR_SCHEMA_VERSION);
    assert.equal(raw.series, "f1");
    assert.equal(raw.season, 2026);
    assert.equal(raw.frozen, false);
    assert.equal(raw.events.length, 2);
    assert.ok(typeof raw.generatedAt === "string");

    // Идемпотентность: те же входы — файл не дёргается.
    assert.equal(writeF1Calendar(path, docOf({
      schedule: [race("1", { date: "2026-12-06" }), race("2", { date: "2026-12-13" })],
    })), "unchanged");

    // Деградация входа — прежний файл не тронут.
    assert.equal(writeF1Calendar(path, docOf({ schedule: [race("1", { date: "2026-12-06" })] })),
      "kept-previous");
    assert.equal(JSON.parse(readFileSync(path, "utf8")).events.length, 2);

    // Фатал кросс-чека — тоже fail-closed.
    const broken = docOf({ schedule: [race("1", { date: "2026-12-06" }), race("2", { date: "2026-12-13" }), race("3", { date: "2026-12-20" })] });
    broken.events[0].sourceIds.jolpica = { season: 2025, round: 1 };
    assert.equal(writeF1Calendar(path, broken, crossCheckCalendar(broken, [])), "kept-previous");
    assert.equal(JSON.parse(readFileSync(path, "utf8")).events.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("запись: замороженный сезон не пересобирается, кроме смены схемы", () => {
  const dir = mkdtempSync(join(tmpdir(), "f1calendar-"));
  const path = join(dir, "2025.json");
  try {
    const doc = docOf({ schedule: [race("1", { season: "2025", date: "2025-12-07" })], season: 2025 });
    assert.equal(doc.frozen, true);
    assert.equal(writeF1Calendar(path, doc), "written");
    const grown = docOf({
      schedule: [race("1", { season: "2025", date: "2025-12-07" }),
                 race("2", { season: "2025", date: "2025-12-14" })],
      season: 2025,
    });
    assert.equal(writeF1Calendar(path, grown), "frozen", "история переписана");
    assert.equal(JSON.parse(readFileSync(path, "utf8")).events.length, 1);

    // Файл прошлой версии схемы обязан пересобраться даже будучи замороженным.
    const stale = JSON.parse(readFileSync(path, "utf8"));
    stale.schemaVersion = F1_CALENDAR_SCHEMA_VERSION - 1;
    writeFileSync(path, JSON.stringify(stale));
    assert.equal(writeF1Calendar(path, grown), "written");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// MARK: - Раздача meeting_key гонкам jolpica

/// Ключ митинга — часть контракта витрины: по нему клиент читает сессии, грид и
/// шины. Раздаётся он ТЕМ ЖЕ предикатом окна, которым работал дедуп ленты,
/// иначе «этап пропал из ленты» и «этап потерял ключ» разъезжаются — на этом
/// стыке жил Sepang-2026. Три инварианта раздачи (все три раньше не проверялись
/// ни одним тестом):
test("ключ митинга: одна гонка — один ключ, повторно не выдаётся", () => {
  // Порченое зеркало: окно митинга растянуто на два уик-энда сразу и накрывает
  // ОБА дня гонки. Без учёта уже выданных ключей его получили бы обе гонки, и
  // кросс-чек свалился бы в fatal «meeting_key выдан двум событиям» — то есть
  // витрина замерла бы вся из-за одного кривого поля.
  const doc = docOf({
    schedule: [race("1", { date: "2026-03-08" }), race("2", { date: "2026-03-15" })],
    meetings: [meeting("Melbourne", "2026-03-06", "2026-03-15", { key: 1279 })],
  });
  const keys = doc.events
    .filter((e) => e.sourceIds.jolpica)
    .map((e) => e.sourceIds.openf1?.meetingKey ?? null);
  assert.deepEqual(keys, [1279, null], "второй гонке тот же ключ не достаётся");
  assert.deepEqual(crossCheckCalendar(doc, []).fatal, []);
});

test("ключ митинга: гонка без своего митинга остаётся без ключа", () => {
  const doc = docOf({
    schedule: [race("1", { date: "2026-03-08" }), race("2", { date: "2026-03-15" }),
               race("3", { date: "TBC" })],   // источник иногда отдаёт день мусором
    meetings: [meeting("Shanghai", "2026-03-13", "2026-03-15", { key: 1280 })],
  });
  const byId = new Map(doc.events.map((e) => [e.id, e]));
  assert.equal(byId.get("f1-2026-1")!.sourceIds.openf1, null, "чужой ключ не подставляется");
  assert.deepEqual(byId.get("f1-2026-2")!.sourceIds.openf1, { meetingKey: 1280 });
  // Без дня сопоставлять не с чем — «первый попавшийся» здесь был бы уже не
  // догадкой, а порчей контракта: клиент пошёл бы за сессиями чужого этапа.
  assert.equal(byId.get("f1-2026-3")!.dates.race, null);
  assert.equal(byId.get("f1-2026-3")!.sourceIds.openf1, null);
});

test("ключ митинга: оверлейный митинг свой ключ гонке не отдаёт", () => {
  // Тест накрывает день гонки (так бывает у предсезонки на трассе этапа). Он
  // остался в ленте СОБСТВЕННЫМ событием, поэтому «съеденным дедупом» не
  // считается — и одолжить свой ключ гонке не может: иначе один ключ висел бы
  // на двух событиях файла.
  const doc = docOf({
    schedule: [race("1", { date: "2026-03-08" })],
    meetings: [meeting("Pre-Season Testing", "2026-03-06", "2026-03-08", { key: 1304 })],
  });
  const byId = new Map(doc.events.map((e) => [e.id, e]));
  assert.equal(byId.get("f1-2026-1")!.sourceIds.openf1, null);
  assert.equal(byId.get("f1-meeting-1304")!.kind, "testing");
  assert.deepEqual(crossCheckCalendar(doc, []).fatal, []);
});

// MARK: - Оркестрация: чтение зеркал, season-guard, охват

function seedRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "f1caldata-"));
  const jolpica = join(root, "f1", "jolpica");
  mkdirSync(jolpica, { recursive: true });
  mkdirSync(join(root, "f1", "openf1"), { recursive: true });
  mkdirSync(join(root, "f1", "overrides"), { recursive: true });
  const schedule = (season: string, races: JolpicaRace[]): string =>
    JSON.stringify({ MRData: { total: String(races.length), RaceTable: { season, Races: races } } });

  writeFileSync(join(jolpica, "2026.json"), schedule("2026", [
    race("1", { date: "2026-03-08", circuitName: "Albert Park Grand Prix Circuit" }),
    race("2", { date: "2026-03-15", circuitName: "Shanghai International Circuit",
      locality: "Shanghai", country: "China", sprint: { date: "2026-03-14" } }),
  ]));
  writeFileSync(join(jolpica, "2026_results.json_limit_100_offset_0"),
    schedule("2026", [race("1", { date: "2026-03-08", results: WINNER })]));
  writeFileSync(join(jolpica, "2026_sprint.json_limit_100_offset_0"),
    schedule("2026", [race("2", { date: "2026-03-15", sprintResults: WINNER })]));
  writeFileSync(join(root, "f1", "openf1", "meetings_year_2026"), JSON.stringify([
    meeting("Melbourne", "2026-03-06", "2026-03-08", { key: 1279 }),
    meeting("Pre-Season Testing", "2026-02-11", "2026-02-13", { key: 1304, shortName: "Sakhir" }),
  ]));
  writeFileSync(join(root, "f1", "overrides", "calendar.json"), OVERRIDE_JSON);
  return root;
}

test("оркестрация: собирает файл сезона из зеркал на диске", () => {
  const root = seedRoot();
  try {
    const log = buildF1CalendarFiles(NOW, root);
    assert.match(log, /2026: written/);
    const doc = JSON.parse(readFileSync(join(root, "f1", "calendar", "2026.json"), "utf8"));
    assert.equal(doc.schemaVersion, F1_CALENDAR_SCHEMA_VERSION);
    assert.deepEqual(doc.events.map((e: any) => e.id),
      ["f1-meeting-1304", "f1-2026-1", "f1-2026-2", "f1-override-2026-10-04"]);
    // Курируемый этап жив: его уик-энд источники ещё не заняли.
    const ov = doc.events.find((e: any) => e.sourceIds.override);
    assert.equal(ov.round, 0);
    assert.equal(ov.status, "tbc");
    // Спринт доехал обоими путями, ключ митинга привязан к гонке.
    assert.equal(doc.events.find((e: any) => e.id === "f1-2026-2").sprintWeekend, true);
    assert.deepEqual(doc.events.find((e: any) => e.id === "f1-2026-1").sourceIds.openf1,
      { meetingKey: 1279 });
    // Второй прогон — идемпотентность.
    assert.match(buildF1CalendarFiles(NOW, root), /2026: unchanged/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/// Январское отравление на уровне ЧТЕНИЯ: файл сезона несёт чужой season —
/// пишем не «как есть», а не пишем вовсе.
test("оркестрация: season-guard пропускает сезон с чужим расписанием", () => {
  const root = seedRoot();
  try {
    const path = join(root, "f1", "jolpica", "2026.json");
    const doc = JSON.parse(readFileSync(path, "utf8"));
    doc.MRData.RaceTable.season = "2025";                        // мутация
    writeFileSync(path, JSON.stringify(doc));
    const log = buildF1CalendarFiles(NOW, root);
    assert.match(log, /2026: нет расписания/);
    assert.equal(coveredSeasons(root, 2026).includes(2026), true,
      "сезон в охвате есть — guard срабатывает именно на содержимом");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("оркестрация: курируемый слой не применяется к ЗАКРЫТОМУ сезону", () => {
  const root = seedRoot();
  try {
    assert.equal(readOverrides(root, 2026, 2026).length, 1);
    assert.equal(readOverrides(root, 2026, 2027).length, 0,
      "закрытый сезон курируемых фантомов не получает");
    assert.equal(readOverrides(root, 2025, 2025).length, 0, "запись чужого сезона не берётся");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/// Ручка владельца существует РАДИ МЕЖСЕЗОНЬЯ: в декабре заводят этап
/// следующего года, которого источники ещё не отдают. Прежний фильтр
/// «только текущий год» съедал ровно этот кейс — молча, без строки в логе.
test("оркестрация: курируемая запись сезона N+1 доезжает до витрины", () => {
  const root = seedRoot();
  try {
    writeFileSync(join(root, "f1", "overrides", "calendar.json"), JSON.stringify([
      { season: 2027, round: 1, date: "2027-03-07", raceName: "Malaysian Grand Prix",
        circuitName: "Sepang International Circuit", locality: "Kuala Lumpur",
        country: "Malaysia", kind: "race" },
    ]));
    assert.equal(readOverrides(root, 2027, 2026).length, 1,
      "межсезонная правка на следующий год обязана применяться");
    // И до файла сезона она тоже доезжает — не только до чтения.
    writeFileSync(join(root, "f1", "jolpica", "2027.json"), JSON.stringify({
      MRData: { RaceTable: { season: "2027", Races: [race("1", { season: "2027", date: "2027-04-11" })] } },
    }));
    const log = buildF1CalendarFiles(NOW, root);
    assert.match(log, /2027: written/, log);
    const doc = JSON.parse(readFileSync(join(root, "f1", "calendar", "2027.json"), "utf8"));
    assert.deepEqual(doc.events.map((e: any) => e.id), ["f1-override-2027-03-07", "f1-2027-1"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("оркестрация: курируемая запись мимо всех сезонов — сирота в логе", () => {
  const root = seedRoot();
  try {
    writeFileSync(join(root, "f1", "overrides", "calendar.json"), JSON.stringify([
      { season: 2031, round: 1, date: "2031-03-07", raceName: "Опечатка в годе",
        circuitName: "Sepang International Circuit", locality: "Kuala Lumpur",
        country: "Malaysia", kind: "race" },
    ]));
    assert.deepEqual(orphanOverrides(root, [2026]).map((e) => e.season), [2031]);
    assert.deepEqual(orphanOverrides(root, [2026, 2031]), [], "собранный сезон — не сирота");
    // Год с пустым расписанием попадает в ОХВАТ, но собран не будет («календарь
    // ещё не опубликован») — и его курируемая запись обязана числиться сиротой.
    // Считать сирот по охвату мало: запись уехала бы в тишину ровно в
    // межсезонье, ради которого ручка и заведена.
    writeFileSync(join(root, "f1", "overrides", "calendar.json"), JSON.stringify([
      { season: 2027, round: 1, date: "2027-03-07", raceName: "Malaysian Grand Prix",
        circuitName: "Sepang International Circuit", locality: "Kuala Lumpur",
        country: "Malaysia", kind: "race" },
    ]));
    writeFileSync(join(root, "f1", "jolpica", "2027.json"),
      JSON.stringify({ MRData: { RaceTable: { season: "2027", Races: [] } } }));
    assert.equal(coveredSeasons(root, 2026).includes(2027), true, "в охвате год есть");
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (m: string) => { warnings.push(String(m)); };
    let log = "";
    try { log = buildF1CalendarFiles(NOW, root); } finally { console.warn = warn; }
    assert.match(log, /2027: нет расписания/, log);
    assert.equal(warnings.some((w) => w.includes("2027/2027-03-07")), true,
      `сирота обязана быть в логе, а было: ${warnings.join(" | ")}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("оркестрация: охват — от нижней границы приложения до следующего года", () => {
  const root = seedRoot();
  try {
    assert.deepEqual(coveredSeasons(root, 2026), [2026], "год без зеркала расписания не собирается");
    writeFileSync(join(root, "f1", "jolpica", "2027.json"),
      JSON.stringify({ MRData: { RaceTable: { season: "2027", Races: [] } } }));
    assert.deepEqual(coveredSeasons(root, 2026), [2026, 2027],
      "опубликованный N+1 подхватывается тем же признаком, что и в приложении");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// MARK: - Сторож ключа файла события (фаза 6)
// Ключ — имя файла нового семейства `events/`, поэтому две вещи обязаны быть
// fatal, а не предупреждением: коллизия (второй файл молча перезапишет
// первый) и дрейф (файлы прежнего имени осиротеют, а история начнётся с нуля).

test("ключ события: у каждого события он есть и он уникален", () => {
  const doc = docOf({
    schedule: [race("1", { date: "2026-03-08" }), race("2", { date: "2026-03-15" })],
    meetings: [meeting("Melbourne", "2026-03-06", "2026-03-08", { key: 1279 }),
               meeting("Shanghai", "2026-03-13", "2026-03-15", { key: 1280 })],
  });
  const keys = doc.events.map((e) => e.eventKey);
  assert.equal(keys.length, new Set(keys).size, "ключи не уникальны");
  assert.ok(keys.every((k) => /^f1-2026-[a-z0-9-]+$/.test(k)), keys.join(", "));
  assert.deepEqual(crossCheckCalendar(doc, []).fatal, []);
});

test("ключ события: раунд в него не входит — перенумерация ключ не двигает", () => {
  const asRound1 = docOf({
    schedule: [race("1", { date: "2026-03-08" })],
    meetings: [meeting("Melbourne", "2026-03-06", "2026-03-08", { key: 1279 })],
  });
  const asRound2 = docOf({
    schedule: [race("2", { date: "2026-03-08" })],
    meetings: [meeting("Melbourne", "2026-03-06", "2026-03-08", { key: 1279 })],
  });
  assert.equal(asRound1.events[0].eventKey, asRound2.events[0].eventKey,
               "ключ поехал вместе с раундом — вся затея бессмысленна");
  // А вот id, наоборот, раунд содержит — потому ключ и понадобился отдельный.
  assert.notEqual(asRound1.events[0].id, asRound2.events[0].id);
});

test("ключ события: дрейф относительно опубликованного — fatal, файл не пишется", () => {
  const doc = docOf({
    schedule: [race("1", { date: "2026-03-08" })],
    meetings: [meeting("Melbourne", "2026-03-06", "2026-03-08", { key: 1279 })],
  });
  const published = { events: [{ id: doc.events[0].id, eventKey: "f1-2026-melbourne-1279" }] };
  const check = crossCheckCalendar(doc, [], published);
  assert.equal(check.fatal.length, 1, "дрейф ключа обязан быть fatal");
  assert.match(check.fatal[0], /ДРЕЙФАНУЛ/);

  // И fatal обязан ОСТАНОВИТЬ запись, а не только напечататься. Сезон берём
  // НЕзамороженный: у замороженного запись и так не идёт, и проверка fatal до
  // неё просто не доходит — тест бы прошёл сам собой.
  const live = docOf({
    schedule: [race("1", { date: "2026-03-08" })],
    meetings: [meeting("Melbourne", "2026-03-06", "2026-03-08", { key: 1279 })],
    now: Date.parse("2026-03-09T00:00:00Z"),
  });
  const liveCheck = crossCheckCalendar(live, [],
    { events: [{ id: live.events[0].id, eventKey: "f1-2026-melbourne-1279" }] });
  assert.equal(live.frozen, false, "сезон обязан быть незамороженным для этой половины");
  const dir = mkdtempSync(join(tmpdir(), "f1cal-key-"));
  const path = join(dir, "2026.json");
  writeFileSync(path, JSON.stringify({ schemaVersion: 1, season: 2026, events: [] }));
  assert.equal(writeF1Calendar(path, live, liveCheck), "kept-previous");
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).events, [],
                   "файл всё-таки перезаписан при fatal");
});

test("ключ события: первый сбор сезона дрейфом не считается", () => {
  const doc = docOf({
    schedule: [race("1", { date: "2026-03-08" })],
    meetings: [meeting("Melbourne", "2026-03-06", "2026-03-08", { key: 1279 })],
  });
  assert.deepEqual(crossCheckCalendar(doc, [], null).fatal, []);
});

// MARK: - v2: сессии, город, сырое имя трассы

/// Времена сессий берутся ИЗ РАСПИСАНИЯ и переживают мердж с результатами.
/// В merged-строке сыгранного этапа сессий нет вовсе (она из results-страниц) —
/// баг первого захода клал у сыгранных пустоту, и v2 был бы бесполезен ровно
/// для тех этапов, которые смотрят чаще всего.
test("v2: сессии уик-энда из расписания, у сыгранного этапа тоже", () => {
  const scheduled: JolpicaRace = {
    ...race("1", { date: "2026-03-08" }),
    FirstPractice: { date: "2026-03-06", time: "01:30:00Z" },
    Qualifying: { date: "2026-03-07", time: "05:00:00Z" },
  };
  // Строка результатов того же раунда — без сессионных блоков, как в зеркале.
  const played = race("1", { date: "2026-03-08", results: [{ position: "1" }] });
  const doc = docOf({ schedule: [scheduled], results: [played] });
  const e = doc.events[0];
  assert.deepEqual(e.sessions, {
    fp1: { date: "2026-03-06", time: "01:30:00Z" },
    qualifying: { date: "2026-03-07", time: "05:00:00Z" },
  });
  assert.equal(e.locality, "Melbourne");
  assert.equal(e.circuit, "Albert Park Grand Prix Circuit",
    "сырое имя источника: джойн домашней трассы команды живёт на нём");
  // Будущий этап без опубликованных сессий блока не получает — «нет данных»
  // отличимо от «пустое расписание».
  const bare = docOf({ schedule: [race("2")] }).events[0];
  assert.equal("sessions" in bare, false);
});

/// КОНТРАКТ-ПИН: ключи, которые декодит клиент (CodingKeys F1CalendarSource и
/// F1SeasonStandingsSource). Переименование поля витрины иначе не роняло бы
/// ни одного теста до прода — менять только ПАРОЙ с клиентом.
test("контракт: ключи события витрины запинены парой с клиентом", () => {
  const doc = docOf({ schedule: [{
    ...race("1", { date: "2026-03-08", results: [{ position: "1" }] }),
    FirstPractice: { date: "2026-03-06", time: "01:30:00Z" },
    Qualifying: { date: "2026-03-07" },
    Sprint: { date: "2026-03-07" },
  }] });
  const e = doc.events[0] as Record<string, unknown>;
  const required = ["id", "round", "kind", "status", "name", "venue", "country",
    "trackRef", "assetSlug", "dates", "sprintWeekend", "sourceIds", "eventKey",
    "locality", "circuit", "sessions"];
  for (const k of required) assert.ok(k in e, `ключ «${k}» пропал из события витрины`);
  assert.deepEqual(Object.keys(e.sessions as object).sort(),
    ["fp1", "qualifying", "sprint"], "ключи sessions уехали от клиентских");
  assert.deepEqual(Object.keys((e.dates as object)).sort(), ["race", "raceTime", "start"]);
});
