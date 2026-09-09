// Разовый конвертер этапа 1 (docs/f1-kitchen-plan.md §1): шесть семейств
// класса А в data/f1/openf1 из «ответа API как есть» → подмножество keep-полей
// канонической формой. БЕЗ СЕТИ: проход по диску, экстракция той же функцией,
// что у писателя (extractClassA), затем пометка семейств в манифесте
// `_extractor` версией схемы фактов.
//
// ЗАЧЕМ отдельным скриптом, а не прогоном писателя: писатель трогает только
// цели прогона (текущий сезон), а конвертировать надо ВЕСЬ архив 2023–2026
// разом, при гашёных кронах, с жёстким гейтом «дальше нельзя» — exit 1 здесь
// реально останавливает работу (в CI формула «exit 1 → коммита нет» была
// ложью, амендмент 4; потому жёсткие гейты живут в конвертерах этапов 1–3).
//
// Свойства:
// - битый файл (не-JSON, не-массив, строка-не-объект, вербатим-длина) —
//   ГРОМКАЯ ошибка с именем файла, не пропуск: конвертер не имеет права
//   оставить каталог в полусконвертированном виде молча;
// - идемпотентен: повторный прогон даёт 0 изменений (экстракция уже
//   канонического факта — тот же байт-в-байт текст, writeIfChanged молчит);
// - жёсткий гейт после конвертации: КАЖДЫЙ файл шести семейств обязан пройти
//   оракул формы (factTextError с живым манифестом) — иначе exit 1 с
//   перечнем нарушителей;
// - weather/race_control не трогаются вовсе (сырьё до этапов 2–3, смешанное
//   состояние каталога легально по переходной семантике манифеста).
//
// Запуск: npx tsx src/convert-openf1-a.ts

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { writeIfChanged } from "./lib/mirror.js";
import {
  OPENF1_FACTS_SCHEMA_VERSION, OPENF1_FIELDS, OPENF1_MANIFEST_NAME,
  OPENF1_MANIFEST_V, extractClassA, factTextError, familyOfFile,
  readOpenf1Manifest, writeOpenf1Manifest,
  type Openf1ClassAFamily, type Openf1Manifest,
} from "./lib/openf1facts.js";

const DIR = join(process.cwd(), "data", "f1", "openf1");
const CLASS_A = Object.keys(OPENF1_FIELDS) as Openf1ClassAFamily[];

function main() {
  const names = readdirSync(DIR).filter((n) => n !== OPENF1_MANIFEST_NAME);
  let written = 0;
  let unchanged = 0;
  const perFamily: Record<string, number> = {};
  for (const name of names) {
    const family = familyOfFile(name);
    if (family === null) {
      // Чужак в каталоге — та же громкость, что у walk-теста: конвертер не
      // должен молча обойти файл, который потом уронит CI.
      throw new Error(`${name}: файл вне восьми семейств зеркала`);
    }
    if (!(CLASS_A as string[]).includes(family)) continue;   // класс Б — этапы 2–3
    const path = join(DIR, name);
    let rows: unknown;
    try {
      rows = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      throw new Error(`${name}: не JSON — конвертировать нечего, чинить руками/добором`);
    }
    let fact: string;
    try {
      fact = extractClassA(family as Openf1ClassAFamily, rows);
    } catch (e) {
      throw new Error(`${name}: ${(e as Error).message}`);
    }
    perFamily[family] = (perFamily[family] ?? 0) + 1;
    if (writeIfChanged(path, fact)) written++;
    else unchanged++;
  }

  // Пометка семейств в манифесте — ПОСЛЕ успешной конвертации всех файлов:
  // упади экстракция на середине, манифест остался бы прежним, и оракул жил
  // бы по existsSync — недоконвертированный каталог не отравляет добор.
  // holesBaseline и прочие поля манифеста сохраняются как были.
  const manifest: Openf1Manifest =
    readOpenf1Manifest(DIR) ?? { v: OPENF1_MANIFEST_V, families: {} };
  for (const family of CLASS_A) {
    manifest.families[family] = { parser: OPENF1_FACTS_SCHEMA_VERSION };
  }
  const manifestChanged = writeOpenf1Manifest(DIR, manifest);

  // Жёсткий гейт: каждый файл шести семейств проходит оракул формы с УЖЕ
  // помеченным манифестом — ровно той проверкой, что гоняет walk-тест CI и
  // оракул полноты (factComplete = factTextError над текстом файла).
  const offenders: string[] = [];
  for (const name of names) {
    const family = familyOfFile(name);
    if (family === null || !(CLASS_A as string[]).includes(family)) continue;
    const err = factTextError(family, manifest.families[family],
      readFileSync(join(DIR, name), "utf8"));
    if (err) offenders.push(`${name}: ${err}`);
  }
  if (offenders.length) {
    console.error(`Гейт конвертера: ${offenders.length} файлов не прошли оракул формы:`);
    for (const o of offenders) console.error(`  ${o}`);
    process.exit(1);
  }

  const families = CLASS_A.map((f) => `${f}: ${perFamily[f] ?? 0}`).join(", ");
  console.log(`Конвертация класса А: ${written} файлов записано, ${unchanged} без изменений (${families})`);
  console.log(`Манифест: ${manifestChanged ? "обновлён" : "без изменений"}; гейт формы пройден.`);
}

main();
