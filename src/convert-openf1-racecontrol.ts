// Разовый конвертер этапа 3 (docs/f1-kitchen-plan.md §1, вариант R1):
// семейство race_control в data/f1/openf1 из «ответа API как есть» (массив
// строк с вербатимом рейс-контрола FIA) → R1-факты: тот же JSON-массив, но
// строки — выход classifyRaceControl + legacy-ключи каскада 2023–24 + message
// СИНТЕЗОМ из фактов (racecontrolsynth.ts). Вербатим FIA не сохраняется —
// главный правовой предмет всего упражнения. БЕЗ СЕТИ: проход по диску,
// экстракция той же функцией, что у писателя (extractRaceControlFact), затем
// пометка семейства в манифесте `_extractor` версией парсера классификации.
//
// ЗАЧЕМ отдельным скриптом — те же причины, что у convert-openf1-a.ts и
// convert-openf1-weather.ts: писатель трогает только цели прогона (текущий
// сезон), а конвертировать надо ВЕСЬ архив разом, при гашёных кронах, с
// жёстким гейтом «дальше нельзя» — exit 1 здесь реально останавливает работу.
//
// Свойства:
// - битый файл (не-JSON) — ГРОМКАЯ ошибка с именем файла, не пропуск: молча
//   оставленный файл прошёл бы по existsSync-семантике до пометки манифеста
//   и отравил бы добор после неё;
// - идемпотентен, но НЕ через повторную экстракцию (classifyRaceControl над
//   собственным синтезом дал бы вторичную разметку): уже-факт опознаётся
//   оракулом формы (в R1 и сырьё, и факт — массивы, различает их пер-строчный
//   parser с белым списком ключей) и пропускается как «без изменений»;
// - полусконвертированный файл (часть строк с parser, оракул не прошёл) —
//   ошибка, не тихая переконвертация: такого состояния не порождает ни один
//   наш писатель, чинить руками;
// - жёсткий гейт после конвертации: КАЖДЫЙ race_control-файл обязан пройти
//   оракул формы (factTextError с живым манифестом) — иначе exit 1 с
//   перечнем; оракул проверяет и то, что каждый message матчится ровно одним
//   шаблоном синтезатора — вербатим не переживает гейт;
// - прочие семейства не трогаются (класс А и weather уже конвертированы
//   этапами 1–2 и здесь не читаются).
//
// Запуск: npx tsx src/convert-openf1-racecontrol.ts

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { writeIfChanged } from "./lib/mirror.js";
import { RACECONTROL_PARSER_VERSION } from "./lib/racecontrol.js";
import {
  OPENF1_MANIFEST_V, extractRaceControlFact, factTextError, familyOfFile,
  readOpenf1Manifest, writeOpenf1Manifest, type Openf1Manifest,
} from "./lib/openf1facts.js";
import { R1_EMPTY_KIND } from "./lib/racecontrolsynth.js";

const DIR = join(process.cwd(), "data", "f1", "openf1");
/// Запись манифеста, которую ждёт оракул race_control (factTextError сверяет
/// entry.parser и пер-строчный parser с RACECONTROL_PARSER_VERSION).
const RC_ENTRY = { parser: RACECONTROL_PARSER_VERSION };

function main() {
  const names = readdirSync(DIR).filter((n) => familyOfFile(n) === "race_control");
  let written = 0;
  let unchanged = 0;
  let alreadyFacts = 0;
  let markers = 0;
  let rowsIn = 0;
  let rowsKept = 0;
  let rawBytes = 0;
  let factBytes = 0;
  for (const name of names) {
    const path = join(DIR, name);
    const text = readFileSync(path, "utf8");
    let rows: unknown;
    try {
      rows = JSON.parse(text);
    } catch {
      throw new Error(`${name}: не JSON — конвертировать нечего, чинить руками/добором`);
    }
    // Уже-факт прошлого прогона (идемпотентность): в R1 и сырьё, и факт —
    // массивы, поэтому опознание — оракулом формы, а не типом корня.
    if (factTextError("race_control", RC_ENTRY, text) === null) {
      alreadyFacts++;
      unchanged++;
      continue;
    }
    if (!Array.isArray(rows)) {
      throw new Error(`${name}: не массив сырья и не факт — чинить руками`);
    }
    if (rows.some((r: any) => r?.parser !== undefined)) {
      throw new Error(`${name}: строки с parser, но оракул формы не прошёл — ` +
        `полусконвертированный файл, чинить руками`);
    }
    const fact = extractRaceControlFact(rows);
    const outRows = JSON.parse(fact) as any[];
    if (outRows.length === 1 && outRows[0]?.kind === R1_EMPTY_KIND) markers++;
    else rowsKept += outRows.length;
    rowsIn += rows.length;
    rawBytes += Buffer.byteLength(text, "utf8");
    factBytes += Buffer.byteLength(fact, "utf8");
    if (writeIfChanged(path, fact)) written++;
    else unchanged++;
  }

  // Пометка семейства в манифесте — ПОСЛЕ успешной конвертации всех файлов:
  // упади экстракция на середине, манифест остался бы прежним, и оракул жил
  // бы по existsSync — недоконвертированный каталог не отравляет добор.
  // holesBaseline и записи прочих семейств сохраняются как были.
  const manifest: Openf1Manifest =
    readOpenf1Manifest(DIR) ?? { v: OPENF1_MANIFEST_V, families: {} };
  manifest.families.race_control = RC_ENTRY;
  const manifestChanged = writeOpenf1Manifest(DIR, manifest);

  // Жёсткий гейт: каждый race_control-файл проходит оракул формы с УЖЕ
  // помеченным манифестом — ровно той проверкой, что гоняют walk-тест CI и
  // оракул полноты; message вне шаблонов синтезатора (вербатим) не пройдёт.
  const offenders: string[] = [];
  for (const name of names) {
    const err = factTextError("race_control", manifest.families.race_control,
      readFileSync(join(DIR, name), "utf8"));
    if (err) offenders.push(`${name}: ${err}`);
  }
  if (offenders.length) {
    console.error(`Гейт конвертера: ${offenders.length} файлов не прошли оракул формы:`);
    for (const o of offenders) console.error(`  ${o}`);
    process.exit(1);
  }

  const mb = (b: number) => (b / 1048576).toFixed(2);
  console.log(`Конвертация race_control: ${written} файлов записано, ${unchanged} без изменений ` +
    `(из них уже-фактов: ${alreadyFacts}); строк ${rowsIn} → ${rowsKept} ` +
    `(шум отброшен), маркеров пустых сессий: ${markers}` +
    (rawBytes > 0 ? `; сырьё ${mb(rawBytes)} МБ → факты ${mb(factBytes)} МБ` : ""));
  console.log(`Манифест: ${manifestChanged ? "обновлён" : "без изменений"}; гейт формы пройден.`);
}

main();
