// Разовый конвертер этапа 2 (docs/f1-kitchen-plan.md §1): семейство weather в
// data/f1/openf1 из «ответа API как есть» (массив строк с ISO-датами) →
// факт-конверт { v, kind, parser, samples } с колоночным выходом
// normalizeOpenF1 (unix-секунды, км/ч, дедуп таймстампов) либо reject-маркер
// { …, reject } для пустого/непригодного сырья. БЕЗ СЕТИ: проход по диску,
// экстракция той же функцией, что у писателя (extractWeatherFact), затем
// пометка семейства в манифесте `_extractor` версией парсера погоды.
//
// ЗАЧЕМ отдельным скриптом — те же причины, что у convert-openf1-a.ts:
// писатель трогает только цели прогона (текущий сезон), а конвертировать надо
// ВЕСЬ архив разом, при гашёных кронах, с жёстким гейтом «дальше нельзя» —
// exit 1 здесь реально останавливает работу.
//
// Свойства:
// - битый файл (не-JSON) — ГРОМКАЯ ошибка с именем файла, не пропуск и не
//   reject-маркер: замаркированный битый файл прошёл бы оракул полноты, и
//   добор никогда бы его не переснял;
// - идемпотентен, но НЕ через повторную экстракцию (extractWeatherFact над
//   собственным конвертом дал бы reject — конверт не массив строк): уже-факт
//   опознаётся оракулом формы и пропускается как «без изменений»; массив —
//   сырьё, конвертируется. Не-массив, не проходящий оракул, — ошибка;
// - жёсткий гейт после конвертации: КАЖДЫЙ weather-файл обязан пройти оракул
//   формы (factTextError с живым манифестом) — иначе exit 1 с перечнем;
// - race_control не трогается вовсе (сырьё до этапа 3, смешанное состояние
//   каталога легально по переходной семантике манифеста), класс А уже
//   конвертирован этапом 1 и здесь не читается.
//
// Запуск: npx tsx src/convert-openf1-weather.ts

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { writeIfChanged } from "./lib/mirror.js";
import { WEATHER_PARSER_VERSION } from "./lib/weather.js";
import {
  OPENF1_MANIFEST_V, extractWeatherFact, factTextError, familyOfFile,
  readOpenf1Manifest, writeOpenf1Manifest, type Openf1Manifest,
} from "./lib/openf1facts.js";

const DIR = join(process.cwd(), "data", "f1", "openf1");
/// Запись манифеста, которую ждёт оракул weather (factTextError сверяет
/// entry.parser с WEATHER_PARSER_VERSION; версия ФОРМЫ конверта живёт в самом
/// файле ключом v и в константе OPENF1_WEATHER_FACT_VERSION).
const WEATHER_ENTRY = { parser: WEATHER_PARSER_VERSION };

function main() {
  const names = readdirSync(DIR).filter((n) => familyOfFile(n) === "weather");
  let written = 0;
  let unchanged = 0;
  let alreadyFacts = 0;
  let rejects = 0;
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
    if (!Array.isArray(rows)) {
      // Не сырьё. Либо уже-конверт прошлого прогона (идемпотентность), либо
      // мусор — решает тот же оракул, что охраняет walk-тест.
      const err = factTextError("weather", WEATHER_ENTRY, text);
      if (err) throw new Error(`${name}: не массив сырья и не факт (${err})`);
      alreadyFacts++;
      unchanged++;
      continue;
    }
    const fact = extractWeatherFact(rows);
    if (JSON.parse(fact).reject !== undefined) rejects++;
    rawBytes += Buffer.byteLength(text, "utf8");
    factBytes += Buffer.byteLength(fact, "utf8");
    if (writeIfChanged(path, fact)) written++;
    else unchanged++;
  }

  // Пометка семейства в манифесте — ПОСЛЕ успешной конвертации всех файлов:
  // упади экстракция на середине, манифест остался бы прежним, и оракул жил
  // бы по existsSync — недоконвертированный каталог не отравляет добор.
  // holesBaseline, записи класса А и прочие поля манифеста сохраняются как были.
  const manifest: Openf1Manifest =
    readOpenf1Manifest(DIR) ?? { v: OPENF1_MANIFEST_V, families: {} };
  manifest.families.weather = WEATHER_ENTRY;
  const manifestChanged = writeOpenf1Manifest(DIR, manifest);

  // Жёсткий гейт: каждый weather-файл проходит оракул формы с УЖЕ помеченным
  // манифестом — ровно той проверкой, что гоняет walk-тест CI и оракул полноты.
  const offenders: string[] = [];
  for (const name of names) {
    const err = factTextError("weather", manifest.families.weather,
      readFileSync(join(DIR, name), "utf8"));
    if (err) offenders.push(`${name}: ${err}`);
  }
  if (offenders.length) {
    console.error(`Гейт конвертера: ${offenders.length} файлов не прошли оракул формы:`);
    for (const o of offenders) console.error(`  ${o}`);
    process.exit(1);
  }

  const mb = (b: number) => (b / 1048576).toFixed(2);
  console.log(`Конвертация weather: ${written} файлов записано, ${unchanged} без изменений ` +
    `(из них уже-фактов: ${alreadyFacts}); reject-маркеров: ${rejects}` +
    (rawBytes > 0 ? `; сырьё ${mb(rawBytes)} МБ → факты ${mb(factBytes)} МБ` : ""));
  console.log(`Манифест: ${manifestChanged ? "обновлён" : "без изменений"}; гейт формы пройден.`);
}

main();
