// Сторож синхронности: собранные решения стюардов против ТЕКУЩЕГО парсера.
//
// Класс ошибки, ради которого файл заведён: парсер улучшили, а собранные данные
// об этом не узнали. Раунды старше окна оседания штатный крон не перечитывает,
// поэтому правка классификатора живёт только в коде, а в файлах остаётся старая
// разметка — и расходится молча, без единого падения. Так в репозитории
// пролежали 18 записей: четырнадцать «Driver: Warning.» с типом other, один
// drive-through без секунд и три штрафа, записанных предупреждением (в том
// числе €10 000 Red Bull), — деньги не доезжали до приложения.
//
// Инвариант проверяемый, а не декларативный: запись, помеченная ТЕКУЩЕЙ версией
// парсера, обязана переразбираться в саму себя. Записи со старой версией из
// проверки исключены — они честно ждут пересборки:
//   FIA_FORCE=1 FIA_BACKFILL=99 npm run fia

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { classifyDecision, PENALTY_PARSER_VERSION, type FiaPenalty } from "./lib/fiadocs.js";

const DIR = join(process.cwd(), "data", "f1", "fia");

function storedPenalties(): { file: string; p: FiaPenalty }[] {
  const out: { file: string; p: FiaPenalty }[] = [];
  for (const file of readdirSync(DIR).filter((f) => f.endsWith(".json")).sort()) {
    const d = JSON.parse(readFileSync(join(DIR, file), "utf8"));
    for (const p of (d.penalties ?? []) as FiaPenalty[]) {
      if (p.carriedFrom != null) continue;   // переносы пересобираются каждый прогон
      out.push({ file, p });
    }
  }
  return out;
}

test("собранные решения разобраны текущей версией парсера", () => {
  const all = storedPenalties();
  const current = all.filter(({ p }) => p.parser === PENALTY_PARSER_VERSION);
  // Не даём проверке выродиться в пустую: если штамп версии перестанет
  // проставляться, тест обязан упасть, а не «пройти» ни на чём.
  assert.ok(
    current.length >= all.length * 0.9 && current.length > 100,
    `записей с parser=${PENALTY_PARSER_VERSION}: ${current.length} из ${all.length} — ` +
      `похоже, штамп версии сломан или историю не пересобрали ` +
      `(FIA_FORCE=1 FIA_BACKFILL=99 npm run fia)`,
  );

  const drift: string[] = [];
  for (const { file, p } of current) {
    const c = classifyDecision(p.decision);
    if (c.type !== p.type
      || (c.gridDrop ?? null) !== (p.gridDrop ?? null)
      || (c.seconds ?? null) !== (p.seconds ?? null)) {
      drift.push(`${file} doc ${p.doc}: в файле ${p.type}, парсер даёт ${c.type} — «${p.decision.slice(0, 70)}»`);
    }
  }
  assert.deepEqual(
    drift, [],
    `данные разошлись с парсером; пересобрать: FIA_FORCE=1 FIA_BACKFILL=99 npm run fia`,
  );
});

test("решение со штрафом не записано предупреждением или выговором", () => {
  // Предметный срез того же инварианта: деньги — материальная санкция, и
  // младшая ветка каскада не должна их съедать. Именно так терялись €5 000
  // Албона (Монако-2026 doc 60) и €10 000 Red Bull (Абу-Даби-2025 doc 30).
  const lost = storedPenalties()
    .filter(({ p }) => /fine of|fined/i.test(p.decision))
    .filter(({ p }) => p.type === "warning" || p.type === "reprimand" || p.type === "other")
    .map(({ file, p }) => `${file} doc ${p.doc} (${p.type}): «${p.decision.slice(0, 70)}»`);
  assert.deepEqual(lost, [], "штраф записан младшей санкцией — сумма не доедет до приложения");
});
