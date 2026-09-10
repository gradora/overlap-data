// Стабильный ключ файла события (lib/eventkey.ts). Проверяется главное
// обещание схемы D-лайт: суффикс нейтральный (`-<n>`), но раз присвоенный
// ключ НЕ едет — ни при отмене этапа, ни при переносе, ни при появлении
// соседа: стабильность держат наследование от прошлого файла и сторож дрейфа.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkEventKeys, f1KeyBase, imsaEventKey, mintF1EventKeys, wecEventKey,
} from "./lib/eventkey.js";

test("формат ключа: база + порядковый суффикс, без ключей источника", () => {
  assert.equal(f1KeyBase(2026, "albert-park"), "f1-2026-albert-park");
  const keys = mintF1EventKeys([
    { id: "f1-2026-1", base: f1KeyBase(2026, "albert-park"), mk: 1279 },
  ], null);
  assert.deepEqual(keys, ["f1-2026-albert-park-1"]);
});

/// Боевая коллизия, ради которой суффикс и заведён: в 2026 два события с
/// одним слагом, одним именем («Pre-Season Testing») и одной трассой —
/// предсезонки 11–13 и 18–20 февраля. Порядок номеров — по возрастанию mk.
test("два предсезонных теста на одной трассе получают разные ключи", () => {
  const base = f1KeyBase(2026, "bahrain-testing");
  // Вход нарочно вразнобой: чеканка сортирует по mk, а не по порядку входа.
  const keys = mintF1EventKeys([
    { id: "", base, mk: 1305 },
    { id: "", base, mk: 1304 },
  ], null);
  assert.deepEqual(keys, [`${base}-2`, `${base}-1`]);
  assert.deepEqual(checkEventKeys([
    { id: keys[0], eventKey: keys[0], mk: 1305 },
    { id: keys[1], eventKey: keys[1], mk: 1304 },
  ], null).fatal, []);
});

/// ГЛАВНОЕ СВОЙСТВО. Появление более раннего события не трогает ключи уже
/// существующих: прежние ключи наследуются по mk, новичок получает СЛЕДУЮЩИЙ
/// свободный номер — даже если его mk меньше соседских.
test("вставка более раннего события не меняет ключи соседей", () => {
  const base = f1KeyBase(2026, "bahrain-testing");
  const before = [
    { id: `${base}-1`, eventKey: `${base}-1`, mk: 1304 },
    { id: `${base}-2`, eventKey: `${base}-2`, mk: 1305 },
  ];
  const keys = mintF1EventKeys([
    { id: "", base, mk: 1301 },   // новичок с МЕНЬШИМ mk
    { id: "", base, mk: 1304 },
    { id: "", base, mk: 1305 },
  ], before);
  assert.deepEqual(keys, [`${base}-3`, `${base}-1`, `${base}-2`],
    "старые ключи остались собой, новичок — следующим номером");
  const after = keys.map((k, i) => ({ id: k, eventKey: k, mk: [1301, 1304, 1305][i] }));
  assert.deepEqual(checkEventKeys(after, before).fatal, []);
});

/// Номер умершего события не переиспользуется: файлы его истории не должны
/// достаться новичку.
test("номер выбывшего события не выдаётся заново", () => {
  const base = f1KeyBase(2026, "bahrain-testing");
  const before = [
    { id: `${base}-1`, eventKey: `${base}-1`, mk: 1304 },
    { id: `${base}-2`, eventKey: `${base}-2`, mk: 1305 },
  ];
  // 1304 исчез из источника, появился новый 1400.
  const keys = mintF1EventKeys([
    { id: "", base, mk: 1305 },
    { id: "", base, mk: 1400 },
  ], before);
  assert.deepEqual(keys, [`${base}-2`, `${base}-3`],
    "новичок не сел на номер умершего события");
});

/// Второе главное свойство: раунд в ключ не входит вовсе, поэтому отмена
/// этапа и перенумерация остальных ключей не трогают.
test("перенумерация раундов ключ не меняет", () => {
  const base = f1KeyBase(2026, "albert-park");
  const before = [{ id: "f1-2026-1", eventKey: `${base}-1`, mk: 1279 }];
  const keys = mintF1EventKeys([{ id: "f1-2026-2", base, mk: 1279 }], before);
  assert.deepEqual(keys, [`${base}-1`], "наследование по mk переживает смену раунда/id");
});

/// Курируемый этап и гонка без пары в кухне (mk == null): наследование по id.
test("событие без mk наследует ключ по id", () => {
  const base = f1KeyBase(2026, "sepang");
  const before = [{ id: "f1-override-2026-10-04", eventKey: `${base}-1`, mk: null }];
  const keys = mintF1EventKeys([{ id: "f1-override-2026-10-04", base, mk: null }], before);
  assert.deepEqual(keys, [`${base}-1`]);
});

/// Свежая чеканка: события без mk идут ПОСЛЕ событий с mk — их различитель
/// нестабильнее, и номер младше им не достаётся.
test("свежая чеканка: без mk — после событий с mk", () => {
  const base = f1KeyBase(2026, "sepang");
  const keys = mintF1EventKeys([
    { id: "f1-override-2026-10-04", base, mk: null },
    { id: "", base, mk: 1308 },
  ], null);
  assert.deepEqual(keys, [`${base}-2`, `${base}-1`]);
});

/// Прежний ключ с ЧУЖОЙ базой не наследуется: переименование трассы обязано
/// дойти до сторожа дрейфа fatal-ом, а не спрятаться тихим переносом.
test("смена базы не наследуется и ловится сторожем как дрейф", () => {
  const before = [{ id: "f1-2026-1", eventKey: "f1-2026-albert-park-1", mk: 1279 }];
  const keys = mintF1EventKeys(
    [{ id: "f1-2026-1", base: f1KeyBase(2026, "melbourne"), mk: 1279 }], before);
  assert.deepEqual(keys, ["f1-2026-melbourne-1"]);
  const check = checkEventKeys(
    [{ id: "f1-2026-1", eventKey: keys[0], mk: 1279 }], before);
  assert.equal(check.fatal.length, 1);
  assert.match(check.fatal[0], /ДРЕЙФАНУЛ/);
});

test("сторож: два события с одним ключом — fatal", () => {
  const dup = [
    { id: "f1-2026-1", eventKey: "f1-2026-bahrain-testing-1" },
    { id: "f1-2026-2", eventKey: "f1-2026-bahrain-testing-1" },
  ];
  const check = checkEventKeys(dup, null);
  assert.equal(check.fatal.length, 1);
  assert.match(check.fatal[0], /не уникален/);
});

test("сторож: дрейф ключа у события с файлами — fatal", () => {
  const was = [{ id: "f1-2026-1", eventKey: "f1-2026-albert-park-1" }];
  // Трассу переименовали — читаемая часть поехала, файлы осиротели.
  const now = [{ id: "f1-2026-1", eventKey: "f1-2026-melbourne-1" }];
  const check = checkEventKeys(now, was);
  assert.equal(check.fatal.length, 1);
  assert.match(check.fatal[0], /ДРЕЙФАНУЛ/);
  // Новое событие дрейфом не считается.
  assert.deepEqual(checkEventKeys([...was, { id: "f1-2026-2", eventKey: "f1-2026-shanghai-1" }],
                                  was).fatal, []);
});

/// Дрейф виден и через mk, когда id сменился легально (оверлей стал
/// подтверждённой гонкой): ключ при этом обязан остаться прежним.
test("сторож: сопоставление по mk ловит дрейф при смене id", () => {
  const was = [{ id: "f1-2026-sepang-1", eventKey: "f1-2026-sepang-1", mk: 1308 }];
  // Легальная смена id при том же ключе — не дрейф.
  assert.deepEqual(checkEventKeys(
    [{ id: "f1-2026-16", eventKey: "f1-2026-sepang-1", mk: 1308 }], was).fatal, []);
  // А смена КЛЮЧА при том же mk — дрейф, даже когда id уже другой.
  const check = checkEventKeys(
    [{ id: "f1-2026-16", eventKey: "f1-2026-sepang-2", mk: 1308 }], was);
  assert.equal(check.fatal.length, 1);
  assert.match(check.fatal[0], /ДРЕЙФАНУЛ \(mk 1308\)/);
});

test("WEC и IMSA: слаг источника уже является ключом, суффикс не нужен", () => {
  assert.equal(wecEventKey(2026, "6-hours-of-imola-2026"), "wec-2026-6-hours-of-imola-2026");
  assert.equal(imsaEventKey(2026, "daytona-international-speedway"),
               "imsa-2026-daytona-international-speedway");
  // Тест IMSA — полноценное событие со своим слагом, раунд у него 0.
  assert.equal(imsaEventKey(2026, "daytona-test"), "imsa-2026-daytona-test");
});

test("ключ безопасен как имя файла", () => {
  const [key] = mintF1EventKeys(
    [{ id: "", base: f1KeyBase(2026, "Autódromo José Carlos Pace!"), mk: 1300 }], null);
  assert.match(key, /^[a-z0-9-]+$/, "в ключ просочились символы, опасные для пути");
  assert.doesNotMatch(key, /--|^-|-$/, "лишние дефисы");
});
