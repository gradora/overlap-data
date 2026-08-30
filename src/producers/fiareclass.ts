// Переклассификация уже собранных решений БЕЗ СЕТИ — разовый операторский шаг.
//
// Зачем отдельно от обычного докача. Штатный путь пересборки истории
// (FIA_FORCE=1 FIA_BACKFILL=99) заново качает полторы тысячи PDF ради того,
// что уже лежит на диске: текст решения сохранён в файле, а поменялся только
// КАСКАД его разбора. Тянуть с fia.com то, что не менялось, — расточительно и
// к источнику, и ко времени.
//
// Трогает ТОЛЬКО поля классификации и штамп версии. Всё остальное — номер
// документа, машину, пилота, сессию, ссылки, даты — не касается.
//
// Прогон: npm run fiareclass

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { writeJSONWithEnvelope } from "../lib/mirror.js";
import {
  type FiaEvent, type FiaPenalty, PENALTY_PARSER_VERSION, classifyDecision,
} from "../lib/fiadocs.js";

const DATA_DIR = join(process.cwd(), "data");

/// Пересобранная запись и признак «что-то изменилось».
export function reclassify(p: FiaPenalty): { next: FiaPenalty; changed: boolean } {
  const c = classifyDecision(p.decision);
  const next: FiaPenalty = {
    ...p,
    parser: PENALTY_PARSER_VERSION,
    type: c.type,
  };
  // Поля-спутники ставим заново целиком: старое значение могло относиться к
  // прежнему типу, и оставить его значило бы смешать две классификации.
  delete next.gridDrop; delete next.seconds; delete next.pitlane; delete next.backOfGrid;
  if (c.gridDrop != null) next.gridDrop = c.gridDrop;
  if (c.seconds != null) next.seconds = c.seconds;
  if (c.pitlane) next.pitlane = true;
  if (c.backOfGrid) next.backOfGrid = true;

  const changed = JSON.stringify(next) !== JSON.stringify(p);
  return { next, changed };
}

export async function main(): Promise<void> {
  console.log("Переклассификация решений (без сети)");
  let files = 0, touched = 0, records = 0, changed = 0;
  for (const series of ["f1", "wec", "imsa"]) {
    const dir = join(DATA_DIR, series, "fia");
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).filter((n) => n.endsWith(".json"))) {
      const path = join(dir, name);
      const doc = JSON.parse(readFileSync(path, "utf8"));
      const p: FiaEvent = doc.payload ?? doc;
      if (!Array.isArray(p.penalties)) continue;
      files++;
      let fileChanged = false;
      p.penalties = p.penalties.map((pen) => {
        records++;
        const { next, changed: c } = reclassify(pen);
        if (c) { changed++; fileChanged = true; }
        return next;
      });
      if (!fileChanged) continue;
      const { schemaVersion, generatedAt, ...rest } = doc as any;
      if (writeJSONWithEnvelope(path, p.penalties ? { ...rest, penalties: p.penalties } : rest,
                                schemaVersion ?? 1)) touched++;
    }
  }
  console.log(`  файлов ${files}, записей ${records}: изменено ${changed} в ${touched} файлах`);
  console.log("Done.");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
