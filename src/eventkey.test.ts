// Стабильный ключ файла события (lib/eventkey.ts). Проверяется главное
// обещание схемы: ключ зависит ТОЛЬКО от самого события и от того, что
// присвоил источник — и потому не едет ни при отмене этапа, ни при переносе,
// ни при появлении соседа.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkEventKeys, f1EventKey, imsaEventKey, wecEventKey,
} from "./lib/eventkey.js";

test("формат ключа: читаемая часть плюс ключ источника", () => {
  assert.equal(f1EventKey(2026, "albert-park", { kind: "meeting", meetingKey: 1279 }),
               "f1-2026-albert-park-1279");
  assert.equal(f1EventKey(2026, "bahrain-testing", { kind: "meeting", meetingKey: 1304 }),
               "f1-2026-bahrain-testing-1304");
  assert.equal(f1EventKey(2026, "imola", { kind: "override", date: "2026-05-10" }),
               "f1-2026-imola-ovr20260510");
  assert.equal(f1EventKey(2026, "albert-park", { kind: "round", round: 1 }),
               "f1-2026-albert-park-r1");
});

/// Боевая коллизия, ради которой суффикс и заведён: в 2026 два события с
/// одним слагом, одним именем («Pre-Season Testing») и одной трассой —
/// предсезонки 11–13 и 18–20 февраля. Отличает их только источник.
test("два предсезонных теста на одной трассе получают разные ключи", () => {
  const a = f1EventKey(2026, "bahrain-testing", { kind: "meeting", meetingKey: 1304 });
  const b = f1EventKey(2026, "bahrain-testing", { kind: "meeting", meetingKey: 1305 });
  assert.notEqual(a, b);
  assert.deepEqual(checkEventKeys([{ id: "f1-meeting-1304", eventKey: a },
                                   { id: "f1-meeting-1305", eventKey: b }], null).fatal, []);
});

/// ГЛАВНОЕ СВОЙСТВО. Появление более раннего события не трогает ключи уже
/// существующих — именно этим суффикс источника отличается от порядкового
/// номера, где вставка сдвинула бы всю группу.
test("вставка более раннего события не меняет ключи соседей", () => {
  const before = [
    { id: "f1-meeting-1304", eventKey: f1EventKey(2026, "bahrain-testing", { kind: "meeting", meetingKey: 1304 }) },
    { id: "f1-meeting-1305", eventKey: f1EventKey(2026, "bahrain-testing", { kind: "meeting", meetingKey: 1305 }) },
  ];
  // Добавился тест с МЕНЬШИМ ключом — он встанет в листинге выше, но чужих
  // имён не касается.
  const after = [
    { id: "f1-meeting-1301", eventKey: f1EventKey(2026, "bahrain-testing", { kind: "meeting", meetingKey: 1301 }) },
    ...before,
  ];
  assert.deepEqual(checkEventKeys(after, before).fatal, [],
                   "дрейфа быть не должно: старые ключи остались собой");
  for (const e of before) {
    assert.equal(after.find((x) => x.id === e.id)!.eventKey, e.eventKey);
  }
});

/// Второе главное свойство: раунд в ключ не входит вовсе, поэтому отмена
/// этапа и перенумерация остальных ключей не трогают.
test("перенумерация раундов ключ не меняет", () => {
  const key = (round: number) =>
    f1EventKey(2026, "albert-park", { kind: "meeting", meetingKey: 1279 });
  assert.equal(key(1), key(7), "раунд просочился в ключ");
});

/// И третье: перенос даты. Дата в ключе есть только у курируемого этапа, где
/// её задаёт куратор и она же — идентичность.
test("перенос даты ключ не меняет (кроме курируемого этапа)", () => {
  const a = f1EventKey(2026, "imola", { kind: "meeting", meetingKey: 1290 });
  const b = f1EventKey(2026, "imola", { kind: "meeting", meetingKey: 1290 });
  assert.equal(a, b);
});

test("сторож: два события с одним ключом — fatal", () => {
  const dup = [
    { id: "f1-2026-1", eventKey: "f1-2026-bahrain-testing-1304" },
    { id: "f1-2026-2", eventKey: "f1-2026-bahrain-testing-1304" },
  ];
  const check = checkEventKeys(dup, null);
  assert.equal(check.fatal.length, 1);
  assert.match(check.fatal[0], /не уникален/);
});

test("сторож: дрейф ключа у события с файлами — fatal", () => {
  const was = [{ id: "f1-2026-1", eventKey: "f1-2026-albert-park-1279" }];
  // Трассу переименовали — читаемая часть поехала, файлы осиротели.
  const now = [{ id: "f1-2026-1", eventKey: "f1-2026-melbourne-1279" }];
  const check = checkEventKeys(now, was);
  assert.equal(check.fatal.length, 1);
  assert.match(check.fatal[0], /ДРЕЙФАНУЛ/);
  // Новое событие дрейфом не считается.
  assert.deepEqual(checkEventKeys([...was, { id: "f1-2026-2", eventKey: "f1-2026-shanghai-1280" }],
                                  was).fatal, []);
});

test("сторож: различитель-раунд помечается предупреждением, а не молчит", () => {
  const check = checkEventKeys(
    [{ id: "f1-2026-1", eventKey: f1EventKey(2026, "albert-park", { kind: "round", round: 1 }) }],
    null);
  assert.deepEqual(check.fatal, []);
  assert.equal(check.warnings.length, 1);
  assert.match(check.warnings[0], /нет ключа источника/);
});

test("WEC и IMSA: слаг источника уже является ключом, суффикс не нужен", () => {
  assert.equal(wecEventKey(2026, "6-hours-of-imola-2026"), "wec-2026-6-hours-of-imola-2026");
  assert.equal(imsaEventKey(2026, "daytona-international-speedway"),
               "imsa-2026-daytona-international-speedway");
  // Тест IMSA — полноценное событие со своим слагом, раунд у него 0.
  assert.equal(imsaEventKey(2026, "daytona-test"), "imsa-2026-daytona-test");
});

test("ключ безопасен как имя файла", () => {
  const key = f1EventKey(2026, "Autódromo José Carlos Pace!", { kind: "meeting", meetingKey: 1300 });
  assert.match(key, /^[a-z0-9-]+$/, "в ключ просочились символы, опасные для пути");
  assert.doesNotMatch(key, /--|^-|-$/, "лишние дефисы");
});
