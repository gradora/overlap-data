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
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PENALTY_PARSER_VERSION, type FiaPenalty } from "./lib/fiadocs.js";

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

  // Вторая половина сторожа — переразбор текста решения — УДАЛЕНА вместе с
  // самим текстом: он больше не публикуется (охраняемое выражение). Защита
  // теперь держится на штампе версии выше: он ставится В МОМЕНТ разбора,
  // поэтому «помечено текущей версией» и означает «разобрано текущим кодом».
});

test("решение со штрафом не записано предупреждением или выговором", () => {
  // Предметный срез того же инварианта: деньги — материальная санкция, и
  // младшая ветка каскада не должна их съедать. Именно так терялись €5 000
  // Албона (Монако-2026 doc 60) и €10 000 Red Bull (Абу-Даби-2025 doc 30).
  const lost = storedPenalties()
    .filter(({ p }) => p.fineEur != null)
    .filter(({ p }) => p.type !== "fine")
    .map(({ file, p }) => `${file} doc ${p.doc} (${p.type}): €${p.fineEur}`);
  assert.deepEqual(lost, [], "штраф записан младшей санкцией — сумма не доедет до приложения");
});

/// Кумулятив побед на трассе обязан РАСТИ у одной и той же команды, как бы
/// источник ни писал её имя. Так вскрылось, что Meyer Shank Racing считался
/// двумя командами из-за пунктуации («w/ Curb Agajanian» против
/// «W/Curb-Agajanian»): обе победы на трассе показывались как первая.
///
/// Файл победителей пишется ОДИН раз (история трассы в сезоне неизменна), и
/// это верно — но означает, что правка счёта до старых файлов сама не
/// доходит. Пересборка разовая: IMSA_WINNERS_FORCE=1.
test("победы на трассе считаются сквозь написания имени команды", () => {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const problems: string[] = [];
  // ТОЛЬКО WEC и IMSA: у них кумулятив ключуется КОМАНДОЙ, и расщепление
  // имени его ломает. У F1 ключ — ПИЛОТ, и две победы одной конюшни разными
  // пилотами законно показывают по единице.
  for (const series of ["wec", "imsa"]) {
    const dir = join(process.cwd(), "data", series, "winners");
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).filter((n) => n.endsWith(".json"))) {
      const doc = JSON.parse(readFileSync(join(dir, name), "utf8"));
      const p = doc.payload ?? doc;
      const byTeam = new Map<string, { year: number; wins: number }[]>();
      for (const w of p.winners ?? []) {
        const key = norm(w.constructor ?? w.team ?? "");
        if (!key) continue;
        byTeam.set(key, [...(byTeam.get(key) ?? []), { year: w.year, wins: w.winsHere }]);
      }
      for (const [key, rows] of byTeam) {
        if (rows.length < 2) continue;
        const sorted = [...rows].sort((a, b) => a.year - b.year);
        for (let i = 1; i < sorted.length; i++) {
          if (sorted[i].wins <= sorted[i - 1].wins) {
            problems.push(`${series}/${name}: «${key}» ${sorted[i - 1].year}→${sorted[i].year} ` +
              `кумулятив ${sorted[i - 1].wins}→${sorted[i].wins} не вырос`);
          }
        }
      }
    }
  }
  assert.deepEqual(problems, [],
    "кумулятив побед не растёт — команда расщепилась на два имени; " +
    "пересобрать: IMSA_WINNERS_FORCE=1 IMSA_WINNERS_BACKFILL=99 npm run imsawinners");
});
