// Заявка сезона с разрезолвленными личностями (lib/entrylist.ts).
//
// Проверяется главное обещание: слой ВЫВОДИТСЯ, а не курируется, и при этом
// НИКОГДА не привязывает строку протокола наугад. Показать одного из двух
// братьев случайно хуже, чем не показать никого.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  type JolpicaDriver, buildEntryList, normalizeFamily, resolveAcronym,
} from "./lib/entrylist.js";

const CHARLES: JolpicaDriver = {
  driverId: "leclerc", givenName: "Charles", familyName: "Leclerc",
  code: "LEC", nationality: "Monegasque",
};
const ARTHUR: JolpicaDriver = {
  driverId: "arthur_leclerc", givenName: "Arthur", familyName: "Leclerc",
};
const OWARD: JolpicaDriver = {
  driverId: "patricio_oward", givenName: "Patricio", familyName: "O'Ward",
};
const HULK: JolpicaDriver = {
  driverId: "hulkenberg", givenName: "Nico", familyName: "Hülkenberg",
  code: "HUL", nationality: "German",
};
const ENTRY = [CHARLES, ARTHUR, OWARD, HULK];

const LEL_EXCEPTION = [{ code: "LEL", driverId: "arthur_leclerc", seasons: [2025] }];

// MARK: Резолв акронима

test("точный code заявки побеждает правило", () => {
  assert.equal(resolveAcronym("LEC", ENTRY, 2025)?.driverId, "leclerc");
  assert.equal(resolveAcronym("HUL", ENTRY, 2025)?.driverId, "hulkenberg",
               "диакритика не должна мешать: code точный");
});

/// ГЛАВНЫЙ СЛУЧАЙ. Без исключения LEL не выводится ничем: правило требует,
/// чтобы фамилия начиналась на акроним, а «LECLERC» на «LEL» не начинается.
/// Привязать его к Шарлю было бы худшим исходом — чужой человек, чужой флаг.
test("братья Леклеры: без исключения — никого, с исключением — Артур", () => {
  assert.equal(resolveAcronym("LEL", ENTRY, 2025), null,
               "LEL связали наугад — это и есть подмена человека");
  assert.equal(resolveAcronym("LEL", ENTRY, 2025, LEL_EXCEPTION)?.driverId, "arthur_leclerc");
});

test("исключение действует только в свои сезоны", () => {
  assert.equal(resolveAcronym("LEL", ENTRY, 2026, LEL_EXCEPTION), null);
  const always = [{ code: "LEL", driverId: "arthur_leclerc" }];
  assert.equal(resolveAcronym("LEL", ENTRY, 2026, always)?.driverId, "arthur_leclerc",
               "без списка сезонов исключение обязано действовать во всех");
});

/// Апостроф — не мелочь: без его выброса «OWA» не находил О'Уорда, и три
/// четверти «исключений» лечились бы курированием вместо одной строки
/// нормализации.
test("нормализация фамилии: апостроф и диакритика", () => {
  assert.equal(normalizeFamily("O'Ward"), "OWARD");
  assert.equal(normalizeFamily("Hülkenberg"), "HULKENBERG");
  assert.equal(normalizeFamily("Pérez"), "PEREZ");
  assert.equal(normalizeFamily("Van der Garde"), "VANDERGARDE");
  assert.equal(resolveAcronym("OWA", ENTRY, 2025)?.driverId, "patricio_oward",
               "резервист без code выводится правилом");
});

test("неоднозначность — тоже отказ, а не первый попавшийся", () => {
  const twins: JolpicaDriver[] = [
    { driverId: "a_smith", givenName: "A", familyName: "Smith" },
    { driverId: "b_smith", givenName: "B", familyName: "Smith" },
  ];
  assert.equal(resolveAcronym("SMI", twins, 2025), null);
});

// MARK: Сборка файла

const rows = (meetingKey: number, list: Array<[string, number, string?]>) =>
  list.map(([acr, car, team]) => ({
    meeting_key: meetingKey, driver_number: car, name_acronym: acr,
    last_name: acr, ...(team ? { team_name: team } : {}),
  }));

test("нерезолв попадает в файл, а не пропадает молча", () => {
  const list = buildEntryList({
    season: 2025, entry: ENTRY,
    rowsByMeeting: new Map([[1266, rows(1266, [["LEC", 16], ["ZZZ", 99]])]]),
  });
  assert.deepEqual(list.drivers.map((d) => d.driverId), ["leclerc"]);
  assert.equal(list.unresolved.length, 1);
  assert.equal(list.unresolved[0].acronym, "ZZZ");
  assert.equal(list.unresolved[0].car, 99);
});

test("один человек в митинге — одно место, а не по строке на сессию", () => {
  const list = buildEntryList({
    season: 2025, entry: ENTRY,
    rowsByMeeting: new Map([[1266, [...rows(1266, [["LEC", 16, "Ferrari"]]),
                                    ...rows(1266, [["LEC", 16, "Ferrari"]]),
                                    ...rows(1266, [["LEC", 16, "Ferrari"]])]]]),
  });
  assert.equal(list.drivers[0].seats.length, 1, "строки сессий не дедуплицированы");
});

test("резервист за две команды в сезоне — два места, не одна команда", () => {
  const aron: JolpicaDriver = { driverId: "paul_aron", givenName: "Paul", familyName: "Aron" };
  const list = buildEntryList({
    season: 2026, entry: [aron],
    rowsByMeeting: new Map([
      [1280, rows(1280, [["ARO", 61, "Alpine"]])],
      [1290, rows(1290, [["ARO", 97, "Audi"]])],
    ]),
  });
  assert.deepEqual(list.drivers[0].seats.map((s) => s.team), ["Alpine", "Audi"]);
  assert.deepEqual(list.drivers[0].seats.map((s) => s.car), [61, 97]);
});

/// Проекция обязана быть детерминированной: иначе ежечасный прогон коммитил бы
/// файл на ровном месте.
test("порядок водителей и мест стабилен", () => {
  const build = () => JSON.stringify(buildEntryList({
    season: 2025, entry: ENTRY,
    rowsByMeeting: new Map([
      [1270, rows(1270, [["HUL", 27], ["LEC", 16]])],
      [1266, rows(1266, [["LEC", 16], ["OWA", 89]])],
    ]),
  }));
  assert.equal(build(), build());
  const list = JSON.parse(build());
  assert.deepEqual(list.drivers.map((d: any) => d.driverId),
                   ["hulkenberg", "leclerc", "patricio_oward"]);
  assert.deepEqual(list.drivers.find((d: any) => d.driverId === "leclerc").seats
                     .map((s: any) => s.meetingKey), [1266, 1270]);
});

test("национальность переносится только если она есть", () => {
  const list = buildEntryList({
    season: 2025, entry: ENTRY,
    rowsByMeeting: new Map([[1266, rows(1266, [["LEC", 16], ["OWA", 89]])]]),
  });
  const byId = new Map(list.drivers.map((d) => [d.driverId, d]));
  assert.equal(byId.get("leclerc")?.nationality, "Monegasque");
  assert.equal("nationality" in (byId.get("patricio_oward") as object), false,
               "у резервиста национальности в заявке нет — выдумывать нечего");
});

// MARK: Опубликованные данные

/// Сторож регрессии: в опубликованной заявке не должно остаться НИ ОДНОЙ
/// несвязанной строки. Появилась — значит в заявке новый человек, которого
/// правило не выводит, и его надо разобрать глазами.
test("опубликованные заявки связаны полностью", () => {
  for (const year of [2025, 2026]) {
    const doc = JSON.parse(readFileSync(`data/f1/entrylist/${year}.json`, "utf8"));
    const p = doc.payload ?? doc;
    assert.equal(p.unresolved.length, 0,
                 `${year}: не связаны ${JSON.stringify(p.unresolved)}`);
    assert.ok(p.drivers.length >= 30, `${year}: заявка подозрительно короткая`);
    assert.ok(p.drivers.every((d: any) => d.seats.length > 0),
              `${year}: пилот без единого места — его не должно быть в файле`);
  }
});
