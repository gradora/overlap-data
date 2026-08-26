// Freeze-окна оседания: границы решают, дёргаем ли источник. Окон два —
// результаты 7д (isFrozen) и решения стюардов 14д (isStewardsFrozen, срок права
// FIA на пересмотр). Здесь же сторож против расползания длинного окна: список
// продьюсеров, которым оно разрешено, закрыт и проверяется по исходникам.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  isFrozen, isStewardsFrozen, FREEZE_AFTER_MS, STEWARDS_FREEZE_AFTER_MS,
} from "./lib/freeze.js";

const DAY_MS = 24 * 3600 * 1000;
const PRODUCERS_DIR = "src/producers";

/// Длинное окно — ТОЛЬКО там, где файл раунда накапливается слиянием и
/// неудачный прогон ничего не стирает. Добавляя сюда продьюсера, сначала
/// убедись, что он не перезаписывает файл собранным за прогон: wecfia и
/// imsafia вошли ровно тем коммитом, которым к ним приехало слияние
/// (mergeStewardsPenalties) — раньше длинное окно вдвое растягивало бы
/// период, в котором одна осечка PDF стирает уже собранное.
const STEWARDS_PRODUCERS = new Set(["fia.ts", "wecfia.ts", "imsafia.ts"]);

test("isFrozen: границы окна оседания результатов (7д)", () => {
  const now = 1_800_000_000_000;
  assert.equal(FREEZE_AFTER_MS, 7 * DAY_MS);
  // Финиш только что — не заморожен (штрафы/апелляции ещё меняют результат).
  assert.equal(isFrozen(now - 1000, now), false);
  // Ровно на границе окна — ещё не заморожен (строгое >).
  assert.equal(isFrozen(now - FREEZE_AFTER_MS, now), false);
  // За границей — заморожен.
  assert.equal(isFrozen(now - FREEZE_AFTER_MS - 1, now), true);
  // Будущий финиш и неизвестный (null) — не заморожены.
  assert.equal(isFrozen(now + 1000, now), false);
  assert.equal(isFrozen(null, now), false);
  // NaN (битая дата в курируемом расписании) — не заморожен, а не «навсегда».
  assert.equal(isFrozen(Number.NaN, now), false);
});

test("isStewardsFrozen: границы окна решений стюардов (14д)", () => {
  const now = 1_800_000_000_000;
  assert.equal(STEWARDS_FREEZE_AFTER_MS, 14 * DAY_MS);
  assert.equal(isStewardsFrozen(now - FREEZE_AFTER_MS, now), false);
  // Ровно на границе — ещё не заморожен (то же строгое >).
  assert.equal(isStewardsFrozen(now - STEWARDS_FREEZE_AFTER_MS, now), false);
  assert.equal(isStewardsFrozen(now - STEWARDS_FREEZE_AFTER_MS - 1, now), true);
  assert.equal(isStewardsFrozen(now + 1000, now), false);
  assert.equal(isStewardsFrozen(null, now), false);
  assert.equal(isStewardsFrozen(Number.NaN, now), false);
});

test("окна расходятся ровно на второй неделе (вердикт по протесту, 8–10-й день)", () => {
  const now = 1_800_000_000_000;
  // Ради этого интервала окно и разводили: результат уже можно морозить,
  // а решения стюардов — ещё нет.
  for (const day of [8, 9, 10, 13]) {
    const finish = now - day * DAY_MS;
    assert.equal(isFrozen(finish, now), true, `результат на ${day}-й день должен быть заморожен`);
    assert.equal(isStewardsFrozen(finish, now), false, `решения на ${day}-й день морозить рано`);
  }
  // На 15-й день замораживаются оба.
  const late = now - 15 * DAY_MS;
  assert.equal(isFrozen(late, now), true);
  assert.equal(isStewardsFrozen(late, now), true);
});

test("длинное окно — только у продьюсеров решений стюардов из белого списка", () => {
  // Сторож против копипасты: результатные продьюсеры обязаны остаться на 7д.
  // Проверяем по исходникам, а не по вызовам — молча расширить окно можно
  // только заменой имени функции, и здесь это станет видно.
  // Сортируем ЯВНО: readdirSync отдаёт порядок файловой системы (на macOS/APFS
  // он алфавитный, на ext4 в ubuntu-CI — хеш-порядок), а эталоны ниже — списки.
  // Без сортировки сторож зелёный локально и красный на Linux.
  const files = readdirSync(PRODUCERS_DIR).filter((f) => f.endsWith(".ts")).sort();
  const long: string[] = [];
  const short: string[] = [];
  for (const f of files) {
    const src = readFileSync(join(PRODUCERS_DIR, f), "utf8");
    // Комментарии выкидываем: имена функций окон упоминаются в объяснениях.
    const code = src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    if (/\bisStewardsFrozen\s*\(/.test(code)) long.push(f);
    for (const _ of code.matchAll(/\bisFrozen\s*\(/g)) short.push(f);
  }
  assert.deepEqual(long.sort(), [...STEWARDS_PRODUCERS].sort());
  // Стюардские продьюсеры перешли на длинное окно ЦЕЛИКОМ — короткого вызова
  // в них не осталось (смешение двух окон в одном файле было бы ошибкой).
  for (const f of STEWARDS_PRODUCERS) {
    assert.ok(!short.includes(f), `${f} перешёл на стюардское окно целиком`);
  }
  // Результатные вызовы (wec.ts зовёт трижды) — окно у них не менялось.
  // Список поимённый: новый потребитель длинного окна должен появиться здесь
  // осознанно, а не «сам собой» вместе с чужой правкой.
  assert.deepEqual(short.sort(), [
    "f1.ts", "f1beasts.ts", "f1milestones.ts", "imsa.ts", "imsahighlights.ts",
    "openf1.ts", "wec.ts", "wec.ts", "wec.ts", "wechighlights.ts",
  ]);
});
