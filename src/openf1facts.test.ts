// Предохранители заготовки OpenF1 (lib/openf1facts.ts, этап 0): реестр полей,
// переходная семантика манифеста, оракул полноты, сторожа формы, матрица дыр
// (без отменённых) и предполётный храповик. Плюс walk-тест CI по боевому
// корпусу: сегодня, до конвертации, он ОБЯЗАН быть зелёным на сырье — и обязан
// краснеть, когда конвертированное семейство откатится в сырьё.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mirrorSlug } from "./lib/mirror.js";
import { isFrozen } from "./lib/freeze.js";
import { WEATHER_PARSER_VERSION } from "./lib/weather.js";
import { RACECONTROL_PARSER_VERSION } from "./lib/racecontrol.js";
import {
  OPENF1_FACTS_SCHEMA_VERSION, OPENF1_FIELDS, OPENF1_MANIFEST_NAME,
  OPENF1_MANIFEST_V, OPENF1_MAX_FILE_BYTES, OPENF1_MAX_STRING,
  OPENF1_WEATHER_FACT_VERSION, PIT_HEAL_SINCE_SEASON,
  countOpenf1Holes, expectedMeetingHandles, extractClassA, extractRaceControlFact,
  extractWeatherFact,
  factComplete, factTextError, familyOfFile, familyOfRelative,
  frozenMeetingComplete, openf1MeetingIndex, openf1NullFieldWarnings,
  parseWeatherFact, pitNeedsHeal, preflightOpenf1Holes,
  readOpenf1Manifest, writeOpenf1Manifest,
  type Openf1ClassAFamily, type Openf1Manifest,
} from "./lib/openf1facts.js";

const DATA_DIR = join(process.cwd(), "data", "f1", "openf1");
const sandbox = () => mkdtempSync(join(tmpdir(), "openf1facts-"));
const put = (dir: string, relative: string, doc: unknown) =>
  writeFileSync(join(dir, mirrorSlug(relative)), JSON.stringify(doc));

/// Манифест с одним конвертированным семейством — для фикстур оракула.
const manifestWith = (families: Openf1Manifest["families"]): Openf1Manifest =>
  ({ v: OPENF1_MANIFEST_V, families });

/// Замер по диску 07.09.2026 (фиксируем грандфазеринг; отменённые митинги —
/// ВНЕ матрицы, их 64 «вечные» дыры в счёт не входят): 21 дыра — 7 живых
/// session_result/stints Японии-2026, 13 одиночных pit 2023–25 и один
/// session_result квалификации Бельгии-2023 (сессия 9135); race_control — 0.
/// Порог — «не больше»: закрытие дыр добором законно (по-митинговая карта в
/// манифесте опустится сама), НОВЫЕ дыры — тревога.
const MEASURED_HOLES_2026_09_07 = 21;

// MARK: - Реестр полей

test("реестр: keep и drop не пересекаются, clientRequired ⊆ keep", () => {
  for (const [family, spec] of Object.entries(OPENF1_FIELDS)) {
    for (const k of spec.clientRequired) {
      assert.ok(spec.keep.includes(k),
        `${family}: клиентски-обязательный «${k}» не в keep — Swift-декодер каскада 2023–24 ослепнет`);
    }
    for (const k of spec.keep) {
      assert.ok(!spec.drop.includes(k), `${family}: «${k}» и оставлен, и выброшен`);
    }
    assert.ok(new Set(spec.keep).size === spec.keep.length, `${family}: дубль в keep`);
  }
});

/// Каждый ключ БОЕВОГО корпуса класса А классифицирован: либо keep, либо
/// осознанный drop. Новое поле источника (как когда-то points в session_result)
/// не проскочит неназванным — конвертация этапа 1 молча выбросила бы его, и
/// расширять реестр задним числом пришлось бы historic-перекачкой.
test("реестр: union ключей боевого корпуса покрыт keep ∪ drop", () => {
  const union = new Map<Openf1ClassAFamily, Set<string>>();
  for (const name of readdirSync(DATA_DIR)) {
    const family = familyOfFile(name);
    if (family === null || family === "weather" || family === "race_control") continue;
    let rows: unknown;
    try {
      rows = JSON.parse(readFileSync(join(DATA_DIR, name), "utf8"));
    } catch {
      continue;   // не-JSON сырьё в union не участвует; форму держит walk-тест
    }
    const keys = union.get(family) ?? new Set();
    for (const r of Array.isArray(rows) ? rows : []) {
      for (const k of Object.keys(r ?? {})) keys.add(k);
    }
    union.set(family, keys);
  }
  assert.ok(union.size === 6, `в корпусе нашлось ${union.size} семейств класса А из 6`);
  for (const [family, keys] of union) {
    const spec = OPENF1_FIELDS[family];
    const unnamed = [...keys].filter((k) => !spec.keep.includes(k) && !spec.drop.includes(k));
    assert.deepEqual(unnamed, [],
      `${family}: ключи корпуса не классифицированы — назвать в keep или drop осознанно`);
  }
});

// MARK: - Имя файла ↔ семейство

test("familyOfFile: session_result не путается с sessions, чужак — null", () => {
  assert.equal(familyOfFile("session_result_session_key_9070"), "session_result");
  assert.equal(familyOfFile("sessions_meeting_key_1219"), "sessions");
  assert.equal(familyOfFile("meetings_year_2026"), "meetings");
  assert.equal(familyOfFile("race_control_session_key_9070"), "race_control");
  assert.equal(familyOfFile(OPENF1_MANIFEST_NAME), null);
  assert.equal(familyOfFile("lap_times_session_key_1"), null);
  assert.equal(familyOfRelative("pit?session_key=9"), "pit");
  assert.equal(familyOfRelative("meetings?year=2026"), "meetings");
  assert.equal(familyOfRelative("laps?session_key=9"), null);
});

/// Имя манифеста недостижимо для mirrorSlug: ведущие не-алфанумы срезаются,
/// значит никакая ручка API не может записаться ПОВЕРХ манифеста (и наоборот).
test("_extractor не коллидирует с пространством имён зеркала", () => {
  assert.notEqual(mirrorSlug(OPENF1_MANIFEST_NAME), OPENF1_MANIFEST_NAME);
  assert.equal(familyOfFile(mirrorSlug("_extractor")), null);
});

// MARK: - Оракул: переходная семантика

/// Амендмент 3 дословно: семейство без записи в манифесте живёт по existsSync —
/// сырьё с любыми ключами полно, отсутствие файла — нет. Именно это делает
/// этап 0 безопасным: гейт заморозки уже ходит через оракул, а данные ещё сырьё.
test("неконвертированное семейство: оракул = existsSync, сырьё валидно", () => {
  const dir = sandbox();
  const raw = [{ session_key: 1, meeting_key: 2, circuit_key: 63, gmt_offset: "01:00:00" }];
  put(dir, "sessions?meeting_key=2", raw);
  for (const manifest of [null, manifestWith({})]) {
    assert.equal(factComplete(dir, manifest, "sessions?meeting_key=2"), true);
    assert.equal(factComplete(dir, manifest, "sessions?meeting_key=3"), false);
  }
  rmSync(dir, { recursive: true, force: true });
});

// MARK: - Оракул: класс А

test("класс А: точное равенство множества keep-ключей, по ВСЕМ строкам", () => {
  const dir = sandbox();
  const manifest = manifestWith({ stints: { parser: OPENF1_FACTS_SCHEMA_VERSION } });
  const ok = { driver_number: 1, stint_number: 1, compound: "SOFT" };
  const nullFilled = { driver_number: 2, stint_number: 1, compound: null };   // амендмент 2

  put(dir, "stints?session_key=1", [ok, nullFilled]);
  assert.equal(factComplete(dir, manifest, "stints?session_key=1"), true,
    "отсутствующее у источника поле, записанное как null, — полноценный факт");

  // Сырьё, дописанное в хвост: row[0] чистый, row[1] несёт лишний ключ.
  put(dir, "stints?session_key=2", [ok, { ...ok, lap_start: 1 }]);
  assert.equal(factComplete(dir, manifest, "stints?session_key=2"), false,
    "проверка только row[0] пропустила бы возврат сырья в хвосте");

  // Недостающий keep-ключ — устаревшая/битая экстракция, не факт.
  put(dir, "stints?session_key=3", [{ driver_number: 3, stint_number: 1 }]);
  assert.equal(factComplete(dir, manifest, "stints?session_key=3"), false);

  // Пустой массив — валидный факт (спринт без питстопов), не дыра.
  put(dir, "stints?session_key=4", []);
  assert.equal(factComplete(dir, manifest, "stints?session_key=4"), true);

  // Мусор вместо JSON — переснять, а не упасть и не принять.
  writeFileSync(join(dir, mirrorSlug("stints?session_key=5")), "не json");
  assert.equal(factComplete(dir, manifest, "stints?session_key=5"), false);

  // Бамп версии экстракции объявляет ВЕСЬ архив семейства устаревшим — так
  // правка реестра доезжает до замороженных митингов добором (механика WEC).
  const bumped = manifestWith({ stints: { parser: OPENF1_FACTS_SCHEMA_VERSION + 1 } });
  assert.equal(factComplete(dir, bumped, "stints?session_key=1"), false);
  rmSync(dir, { recursive: true, force: true });
});

// MARK: - Экстракция класса А (этап 1)

test("extractClassA: keep-фильтр, null-дополнение, канонический порядок, \\n", () => {
  // Ключи источника вперемешку и с лишними (meeting_key, lap_start) — на
  // выходе только keep, в порядке реестра; отсутствующий compound — явным null
  // (амендмент 2), иначе оракул точного равенства множеств звал бы добор вечно.
  const raw = [
    { compound: "SOFT", lap_start: 1, stint_number: 2, driver_number: 44, meeting_key: 9 },
    { driver_number: 81, stint_number: 1 },
  ];
  const text = extractClassA("stints", raw);
  assert.equal(text,
    '[{"driver_number":44,"stint_number":2,"compound":"SOFT"},' +
    '{"driver_number":81,"stint_number":1,"compound":null}]\n');
  // Идемпотентность конвертера держится здесь: экстракция уже извлечённого —
  // те же байты, writeIfChanged на повторном прогоне молчит.
  assert.equal(extractClassA("stints", JSON.parse(text)), text);
  // Пустой массив — валидный факт (спринт без питстопов).
  assert.equal(extractClassA("pit", []), "[]\n");
  // Выход проходит оракул формы конвертированного семейства — писатель и
  // walk-тест смотрят одной проверкой.
  assert.equal(factTextError("stints", { parser: OPENF1_FACTS_SCHEMA_VERSION }, text), null);
});

test("extractClassA: сторож-throw — не-массив, не-объект, вербатим-длина", () => {
  assert.throws(() => extractClassA("stints", { detail: "объект вместо массива" }), /не массив/);
  assert.throws(() => extractClassA("stints", [42]), /не объект/);
  const verbatim = { driver_number: 1, stint_number: 1,
    compound: "В".repeat(OPENF1_MAX_STRING + 1) };
  assert.throws(() => extractClassA("stints", [verbatim]), /длиннее/,
    "вербатим-длина в keep-значении не должна пролезть в запись даже одним прогоном");
});

/// Пин состояния этапов 1–3: все восемь семейств конвертированы и помечены.
/// Без этой проверки walk-тест «гейтится манифестом» превращался бы в
/// вакуум — стёртый манифест делал бы весь каталог «сырьём» и walk молчал бы
/// про любой откат. Это же ловит забытый конвертер после бампа версии:
/// «версия кода == parser манифеста» краснеет на первом пуше.
test("живой манифест: все восемь семейств помечены конвертированными", () => {
  const manifest = readOpenf1Manifest(DATA_DIR);
  for (const family of Object.keys(OPENF1_FIELDS) as Openf1ClassAFamily[]) {
    assert.deepEqual(manifest?.families?.[family], { parser: OPENF1_FACTS_SCHEMA_VERSION },
      `${family}: нет пометки в _extractor — оракул и walk-тест не проверяют его форму`);
  }
  // У класса Б версия семейства — версия его ПАРСЕРА (Openf1FamilyEntry):
  // конвертеры этапов 2–3 пишут ровно её, оракул сверяет с константой кода.
  assert.deepEqual(manifest?.families?.weather, { parser: WEATHER_PARSER_VERSION },
    "weather: нет пометки в _extractor — оракул и walk-тест не проверяют его форму");
  assert.deepEqual(manifest?.families?.race_control, { parser: RACECONTROL_PARSER_VERSION },
    "race_control: нет пометки в _extractor — оракул и walk-тест не проверяют его форму");
});

// MARK: - Сторожа формы (§2.2/§2.4)

test("сторож строки: вербатим-длина в конвертированном файле — не факт", () => {
  const entry = { parser: OPENF1_FACTS_SCHEMA_VERSION };
  const long = "В".repeat(OPENF1_MAX_STRING + 1);
  const row = { driver_number: 1, stint_number: 1, compound: long };
  assert.match(String(factTextError("stints", entry, JSON.stringify([row]))),
    /длиннее/, "строка сверх потолка обязана рубиться — это JSON-аналог «нет HTML»");
  // Ровно на потолке — легитимно (замер корпуса: максимум keep-строк 25).
  const edge = { ...row, compound: "В".repeat(OPENF1_MAX_STRING) };
  assert.equal(factTextError("stints", entry, JSON.stringify([edge])), null);
  // Неконвертированное семейство сторож не трогает — сырьё живёт до этапа 1.
  assert.equal(factTextError("stints", undefined, JSON.stringify([row])), null);
});

test("сторож байтов: файл сверх потолка семейства — не факт", () => {
  const entry = { parser: OPENF1_FACTS_SCHEMA_VERSION };
  // Валидный JSON, раздутый пробелами за потолок sessions (боевой максимум ×4).
  const bloated = "[]".padEnd(OPENF1_MAX_FILE_BYTES.sessions + 1, " ");
  assert.match(String(factTextError("sessions", entry, bloated)), /потолка/);
  assert.equal(factTextError("sessions", entry, "[]"), null);
  // У каждого семейства есть свой замеренный потолок.
  for (const [family, cap] of Object.entries(OPENF1_MAX_FILE_BYTES)) {
    assert.ok(cap > 0, `${family}: потолок не замерен`);
  }
});

// MARK: - Оракул: класс Б (на будущее, этапы 2–3)

test("weather: конверт с текущими v+parser; reject-маркер — тоже факт", () => {
  const dir = sandbox();
  const manifest = manifestWith({ weather: { parser: WEATHER_PARSER_VERSION } });
  const envelope = { v: OPENF1_WEATHER_FACT_VERSION, kind: "weather",
    parser: WEATHER_PARSER_VERSION, samples: { t: [] } };
  put(dir, "weather?session_key=1", envelope);
  assert.equal(factComplete(dir, manifest, "weather?session_key=1"), true);

  // «Нет отсчётов» — знание, а не дыра: им живёт учёт holes у f1weather.
  put(dir, "weather?session_key=2", { ...envelope, samples: undefined, reject: "нет отсчётов" });
  assert.equal(factComplete(dir, manifest, "weather?session_key=2"), true);

  put(dir, "weather?session_key=3", { ...envelope, parser: WEATHER_PARSER_VERSION + 1 });
  assert.equal(factComplete(dir, manifest, "weather?session_key=3"), false,
    "чужая версия парсера обязана читаться как отсутствие (isCurrent WEC)");

  // Версия семейства в манифесте проверяется так же, как у race_control:
  // отставший entry.parser объявляет устаревшим ВСЁ семейство разом.
  const stale = manifestWith({ weather: { parser: WEATHER_PARSER_VERSION - 1 } });
  assert.equal(factComplete(dir, stale, "weather?session_key=1"), false);

  // Сырьё (массив строк) и конверт без samples/reject фактами не являются:
  // возврат сырья после этапа 2 ловится формой, как у класса А.
  put(dir, "weather?session_key=4", [{ date: "2030-05-03T10:00:00Z" }]);
  assert.equal(factComplete(dir, manifest, "weather?session_key=4"), false);
  assert.match(String(factTextError("weather", { parser: WEATHER_PARSER_VERSION },
    JSON.stringify({ v: OPENF1_WEATHER_FACT_VERSION, kind: "weather",
      parser: WEATHER_PARSER_VERSION }))), /без samples и без reject/);
  rmSync(dir, { recursive: true, force: true });
});

// MARK: - Экстракция weather (этап 2)

test("extractWeatherFact: конверт с выходом normalizeOpenF1, канонично, \\n", () => {
  // Дубль таймстампа отбрасывается (берётся первый), ряд сортируется, время —
  // unix-секунды, ветер м/с → км/ч: samples РОВНО выход normalizeOpenF1.
  const row = (date: string, air: number, rain: number) => ({
    date, air_temperature: air, track_temperature: 30, humidity: 50,
    pressure: 1010, wind_speed: 2, wind_direction: 200, rainfall: rain,
  });
  const text = extractWeatherFact([
    row("1970-01-01T00:02:00Z", 21, 0),
    row("1970-01-01T00:01:00Z", 20, 1),
    row("1970-01-01T00:01:00.000Z", 99, 1),   // дубль — отброшен
  ]);
  assert.equal(text,
    `{"v":${OPENF1_WEATHER_FACT_VERSION},"kind":"weather","parser":${WEATHER_PARSER_VERSION},` +
    '"samples":{"t":[60,120],"airC":[20,21],"trackC":[30,30],"humidity":[50,50],' +
    '"pressureHpa":[1010,1010],"windKmh":[7.2,7.2],"windDeg":[200,200],"rain":[1,0]}}\n');
  // Выход проходит оракул формы — писатель, конвертер и walk-тест смотрят
  // одной проверкой.
  assert.equal(factTextError("weather", { parser: WEATHER_PARSER_VERSION }, text), null);
  // Читатель видит те же samples: круг запись → чтение без потерь.
  const parsed = parseWeatherFact(text);
  assert.ok(parsed !== null && "samples" in parsed);
  assert.deepEqual(parsed.samples.t, [60, 120]);
});

test("extractWeatherFact: пустое/непригодное сырьё — reject-маркер, не ошибка", () => {
  const rejectOf = (rows: unknown) => {
    const doc = JSON.parse(extractWeatherFact(rows));
    assert.equal(doc.samples, undefined);
    return doc.reject as string;
  };
  // Причины — те же строки normalizeOpenF1, что раньше печатал варнинг
  // читателя: счёт holes и текст варнингов у f1weather не меняются.
  assert.equal(rejectOf([]), "нет отсчётов");
  // Не-массив коэрсится в [], как делал читатель до переезда.
  assert.equal(rejectOf({ detail: "объект вместо массива" }), "нет отсчётов");
  assert.equal(rejectOf([{ date: "не дата" }]), "ни одной разбираемой метки времени");
  assert.match(rejectOf([{ date: "2030-05-03T10:00:00Z", air_temperature: 999 }]),
    /airC=999 вне диапазона/);
  // Reject-маркер — валидный факт: проходит оракул (им живёт учёт holes).
  assert.equal(factTextError("weather", { parser: WEATHER_PARSER_VERSION },
    extractWeatherFact([])), null);
  // НЕ идемпотентна над собственным выходом: конверт — не массив строк, и
  // повторная экстракция дала бы reject. Потому конвертер обязан опознавать
  // уже-факт оракулом и пропускать, а не перегонять через экстракцию.
  assert.equal(JSON.parse(extractWeatherFact(JSON.parse(extractWeatherFact([])))).reject,
    "нет отсчётов");
});

test("parseWeatherFact: samples/reject/не-факт — три исхода читателя", () => {
  const fact = { v: OPENF1_WEATHER_FACT_VERSION, kind: "weather",
    parser: WEATHER_PARSER_VERSION, samples: { t: [60], airC: [20], trackC: [30],
      humidity: [50], pressureHpa: [1010], windKmh: [7.2], windDeg: [200], rain: [0] } };
  const okay = parseWeatherFact(JSON.stringify(fact));
  assert.ok(okay !== null && "samples" in okay && okay.samples.airC[0] === 20);

  const reject = parseWeatherFact(JSON.stringify(
    { v: OPENF1_WEATHER_FACT_VERSION, kind: "weather",
      parser: WEATHER_PARSER_VERSION, reject: "нет отсчётов" }));
  assert.deepEqual(reject, { reject: "нет отсчётов" });

  // Всё прочее — null (дыра читателя): битый текст, сырьё, чужой конверт,
  // устаревший parser, конверт без samples и reject.
  assert.equal(parseWeatherFact("не json"), null);
  assert.equal(parseWeatherFact(JSON.stringify([{ date: "2030-05-03T10:00:00Z" }])), null);
  assert.equal(parseWeatherFact(JSON.stringify({ ...fact, kind: "racecontrol" })), null);
  assert.equal(parseWeatherFact(JSON.stringify({ ...fact, parser: WEATHER_PARSER_VERSION + 1 })),
    null, "устаревший факт = дыра — так бамп парсера сам зовёт добор");
  assert.equal(parseWeatherFact(JSON.stringify({ ...fact, samples: undefined })), null);
});

test("race_control (R1): массив, версия парсера — пер-строчным ключом", () => {
  const dir = sandbox();
  const manifest = manifestWith({ race_control: { parser: RACECONTROL_PARSER_VERSION } });
  const row = { parser: RACECONTROL_PARSER_VERSION, kind: "flag", flag: "YELLOW",
    category: "Flag", message: "Yellow flag" };
  put(dir, "race_control?session_key=1", [row, row]);
  assert.equal(factComplete(dir, manifest, "race_control?session_key=1"), true);

  // Амендмент 1: после бампа частично мигрированный файл непредставим одной
  // семейной версией — строка со старым parser делает файл устаревшим.
  put(dir, "race_control?session_key=2", [row, { ...row, parser: RACECONTROL_PARSER_VERSION - 1 }]);
  assert.equal(factComplete(dir, manifest, "race_control?session_key=2"), false);

  // Конверт-объект сломал бы Swift-декод [RaceControlEvent] каскада 2023–24.
  assert.match(String(factTextError("race_control",
    { parser: RACECONTROL_PARSER_VERSION }, JSON.stringify({ v: 1, rows: [] }))), /не массив/);

  // Пустых фактов не бывает (решение этапа 3): сессия без событий пишется
  // строкой-маркером с parser — пустой массив нечем версионировать пер-строчно.
  assert.match(String(factTextError("race_control",
    { parser: RACECONTROL_PARSER_VERSION }, "[]")), /маркер/);
  rmSync(dir, { recursive: true, force: true });
});

// MARK: - Экстракция race_control (этап 3, R1)

test("extractRaceControlFact: классификация+синтез на записи, шум долой, пусто — маркер", () => {
  const raw = [
    { meeting_key: 1219, session_key: 9158, date: "2023-09-15T09:15:06+00:00",
      driver_number: null, lap_number: 12, category: "Flag", flag: "YELLOW",
      scope: "Sector", sector: 7, qualifying_phase: null,
      message: "YELLOW IN TRACK SECTOR 7" },
    { category: "SafetyCar", message: "VIRTUAL SAFETY CAR DEPLOYED",
      date: "2023-09-15T10:00:00+00:00", session_key: 9158 },
    { message: "PINK HEAD PADDING MATERIAL MUST BE USED" },   // шум — не сохраняется
  ];
  const text = extractRaceControlFact(raw);
  assert.equal(text,
    `[{"parser":${RACECONTROL_PARSER_VERSION},"kind":"flag","lap":12,` +
    `"flag":"YELLOW","scope":"Sector","sector":7,"category":"Flag",` +
    `"lap_number":12,"message":"Yellow flag in sector 7"},` +
    `{"parser":${RACECONTROL_PARSER_VERSION},"kind":"safety_car",` +
    `"virtual":true,"deployed":true,"category":"SafetyCar",` +
    `"message":"Virtual safety car deployed"}]\n`,
    "R1-строка: parser + факт-ключи порядком классификатора + legacy + синтез");
  // Выход проходит оракул формы — писатель, конвертер и walk-тест смотрят
  // одной проверкой; вербатим FIA из сырья в текст не перенёсся.
  assert.equal(factTextError("race_control", { parser: RACECONTROL_PARSER_VERSION }, text), null);
  assert.ok(!text.includes("YELLOW IN TRACK SECTOR"), "вербатим пролез в запись");

  // Сессия целиком из шума и пустая сессия — маркер с parser (амендмент 11).
  const markerText = `[{"parser":${RACECONTROL_PARSER_VERSION},"kind":"empty"}]\n`;
  assert.equal(extractRaceControlFact([]), markerText);
  assert.equal(extractRaceControlFact([{ message: "PINK HEAD PADDING MATERIAL MUST BE USED" }]),
    markerText);
  assert.equal(factTextError("race_control", { parser: RACECONTROL_PARSER_VERSION }, markerText), null);

  // Сторож-throw: не-массив и строка-не-объект — громко, не тихий пропуск.
  assert.throws(() => extractRaceControlFact({ rows: [] }), /не массив/);
  assert.throws(() => extractRaceControlFact([42]), /не объект/);
});

/// Сторожа R1 в оракуле (§2.4 п.3): именно они делают walk-тест «ни одного
/// вербатима» — сырьё краснеет ключами, чужой текст — шаблонами.
test("оракул race_control: сырьё, чужой kind и не-шаблонный message — не факт", () => {
  const entry = { parser: RACECONTROL_PARSER_VERSION };
  const ok = { parser: RACECONTROL_PARSER_VERSION, kind: "flag", flag: "RED",
    category: "Flag", message: "Red flag" };
  assert.equal(factTextError("race_control", entry, JSON.stringify([ok])), null);

  // Сырьё вернулось: ключи источника (date/session_key) вне белого списка.
  const rawish = { ...ok, date: "2023-09-15T09:15:06+00:00", session_key: 9158 };
  assert.match(String(factTextError("race_control", entry, JSON.stringify([rawish]))),
    /сырьё вернулось/);

  // kind вне закрытого множества классификатора.
  assert.match(String(factTextError("race_control", entry,
    JSON.stringify([{ parser: RACECONTROL_PARSER_VERSION, kind: "chatter" }]))),
    /kind вне закрытого множества/);

  // message не из шаблонов синтезатора — вербатим не переживает walk-тест.
  assert.match(String(factTextError("race_control", entry,
    JSON.stringify([{ ...ok, message: "RED FLAG DUE TO DEBRIS ON THE MAIN STRAIGHT" }]))),
    /не из шаблонов/);

  // Маркер валиден только ОДИН и ОДИН ЕДИНСТВЕННЫЙ: маркер рядом с событиями —
  // ошибка писателя, а не «пустая сессия».
  const marker = { parser: RACECONTROL_PARSER_VERSION, kind: "empty" };
  assert.equal(factTextError("race_control", entry, JSON.stringify([marker])), null);
  assert.match(String(factTextError("race_control", entry, JSON.stringify([marker, ok]))),
    /не единственная строка/);
  assert.match(String(factTextError("race_control", entry, JSON.stringify(["строка"]))),
    /не объект/);
});

// MARK: - Матрица полноты митинга

const LISTING = [
  { session_key: 11, session_name: "Practice 1", date_start: "2030-05-03T10:00:00Z" },
  { session_key: 12, session_name: "Race", date_start: "2030-05-05T13:00:00Z" },
];

/// Полный набор файлов митинга фикстуры (лежат все).
function putCompleteMeeting(dir: string) {
  put(dir, "meetings?year=2030", [{ meeting_key: 7, meeting_name: "Testland GP",
    date_start: "2030-05-03T10:00:00Z", date_end: "2030-05-05T15:00:00Z" }]);
  put(dir, "sessions?meeting_key=7", LISTING);
  put(dir, "drivers?meeting_key=7", [{ driver_number: 1 }]);
  for (const sk of [11, 12]) {
    put(dir, `session_result?session_key=${sk}`, [{ driver_number: 1, position: 1 }]);
    put(dir, `stints?session_key=${sk}`, []);
    put(dir, `race_control?session_key=${sk}`, []);
    put(dir, `weather?session_key=${sk}`, [{ date: "2030-05-03T10:00:00Z" }]);
  }
  put(dir, "pit?session_key=12", [{ driver_number: 1, stop_duration: 2.4 }]);
}

test("матрица: pit ожидается только у race-like, drivers — у митинга", () => {
  const dir = sandbox();
  put(dir, "sessions?meeting_key=7", LISTING);
  const handles = expectedMeetingHandles(dir, 7);
  assert.deepEqual(handles.sort(), [
    "drivers?meeting_key=7",
    "pit?session_key=12",
    "race_control?session_key=11", "race_control?session_key=12",
    "session_result?session_key=11", "session_result?session_key=12",
    "sessions?meeting_key=7",
    "stints?session_key=11", "stints?session_key=12",
    "weather?session_key=11", "weather?session_key=12",
  ].sort());
  // Листинга нет — состав сессий неизвестен, но листинг и drivers ожидаемы.
  assert.deepEqual(expectedMeetingHandles(dir, 8).sort(),
    ["drivers?meeting_key=8", "sessions?meeting_key=8"]);
  rmSync(dir, { recursive: true, force: true });
});

test("полнота митинга: только дыры файлов; больной пит полноту НЕ рушит", () => {
  const dir = sandbox();
  putCompleteMeeting(dir);
  assert.equal(frozenMeetingComplete(dir, null, 7), true);

  // Больной пит (регрессия stop_duration) — ОТДЕЛЬНЫЙ канал лечения, не
  // неполнота: иначе 40 вечно больных архивных питов 2023–25 держали бы свои
  // митинги в «не полон» навсегда (36/90 полных вместо 73/87 по замеру 07.09).
  put(dir, "pit?session_key=12", [{ driver_number: 1, stop_duration: null }]);
  assert.equal(pitNeedsHeal(JSON.parse(
    readFileSync(join(dir, mirrorSlug("pit?session_key=12")), "utf8"))), true);
  assert.equal(frozenMeetingComplete(dir, null, 7), true,
    "полнота = только дыры/устарелость файлов; лечение — healMeetingPits");
  // Лечение гейтится сезоном регрессии — архив 2023–25 источник не дозаполняет.
  assert.equal(PIT_HEAL_SINCE_SEASON, 2026);

  rmSync(join(dir, mirrorSlug("weather?session_key=11")));
  assert.equal(frozenMeetingComplete(dir, null, 7), false);
  rmSync(dir, { recursive: true, force: true });
});

// MARK: - Счёт дыр и предполёт

const NOW_2031 = Date.parse("2031-01-01T00:00:00Z");

test("дыры: только отсутствие файла; незамороженные и отменённые — вне счёта", () => {
  const dir = sandbox();
  putCompleteMeeting(dir);
  assert.deepEqual(countOpenf1Holes(dir, NOW_2031).holes, []);

  // Свежий митинг без единого файла — не дыры: уик-энд ещё «оседает».
  // Отменённый — вне матрицы ЦЕЛИКОМ (решение по отменённым): его сессий
  // источник не отдаёт никогда, «вечные» дыры голодали бы кап добора.
  put(dir, "meetings?year=2030", [
    { meeting_key: 7, meeting_name: "Testland GP",
      date_start: "2030-05-03T10:00:00Z", date_end: "2030-05-05T15:00:00Z" },
    { meeting_key: 8, meeting_name: "Fresh GP",
      date_start: "2030-12-29T10:00:00Z", date_end: "2030-12-31T15:00:00Z" },
    { meeting_key: 9, meeting_name: "Cancelled GP", is_cancelled: true,
      date_start: "2030-04-01T10:00:00Z", date_end: "2030-04-03T15:00:00Z" },
  ]);
  const report = countOpenf1Holes(dir, NOW_2031);
  assert.deepEqual(report.holes, []);
  assert.equal(report.frozenMeetings, 1);
  assert.equal(report.unfrozenMeetings, 1);
  assert.equal(report.cancelledMeetings, 1);
  assert.deepEqual(report.perMeeting, { "7": 0 });
  assert.deepEqual(report.frozenPerYear, { "2030": 1 });
  assert.deepEqual(report.listingMissing, []);
  assert.ok(!isFrozen(Date.parse("2030-12-31T15:00:00Z"), NOW_2031), "фикстура: 8 должен быть свежим");

  // Пропавшие файлы замороженного митинга — дыры, пофайлово и по-митингово.
  rmSync(join(dir, mirrorSlug("stints?session_key=11")));
  rmSync(join(dir, mirrorSlug("drivers?meeting_key=7")));
  const holed = countOpenf1Holes(dir, NOW_2031);
  assert.deepEqual(holed.holes.sort(), ["drivers_meeting_key_7", "stints_session_key_11"]);
  assert.deepEqual(holed.perMeeting, { "7": 2 });

  // Пропавший листинг схлопывает матрицу (дыр «меньше») — отдельный флаг,
  // которым предполёт отличает улучшение от отравления.
  rmSync(join(dir, mirrorSlug("sessions?meeting_key=7")));
  const collapsed = countOpenf1Holes(dir, NOW_2031);
  assert.deepEqual(collapsed.listingMissing, ["7"]);
  assert.deepEqual(collapsed.perMeeting, { "7": 2 },
    "матрица без листинга: дыры — сам листинг и drivers");
  rmSync(dir, { recursive: true, force: true });
});

test("индекс митингов: год из имени файла, отменённость из строки", () => {
  const dir = sandbox();
  put(dir, "meetings?year=2030", [
    { meeting_key: 7, meeting_name: "Testland GP" },
    { meeting_key: 9, meeting_name: "Cancelled GP", is_cancelled: true },
  ]);
  const index = openf1MeetingIndex(dir);
  assert.deepEqual(index.get(7), { year: 2030, cancelled: false });
  assert.deepEqual(index.get(9), { year: 2030, cancelled: true });
  assert.equal(index.get(8), undefined);
  rmSync(dir, { recursive: true, force: true });
});

/// Амендмент 4 дословно: staleness — НЕ дыра. Устаревший факт стоит в очереди
/// добора (с капом GET), но предполёт из-за него не тревожится — иначе
/// массовый бамп парсера красил бы каждый прогон до конца перекачки.
test("устаревший факт — не дыра предполёта, но «не полон» для добора", () => {
  const dir = sandbox();
  putCompleteMeeting(dir);
  const bumped = manifestWith({ stints: { parser: OPENF1_FACTS_SCHEMA_VERSION + 1 } });
  writeOpenf1Manifest(dir, bumped);
  assert.equal(factComplete(dir, bumped, "stints?session_key=11"), false, "очередь добора");
  assert.equal(frozenMeetingComplete(dir, bumped, 7), false);
  assert.deepEqual(countOpenf1Holes(dir, NOW_2031).holes, [], "а дыр — ноль");
  assert.equal(preflightOpenf1Holes(dir, NOW_2031).holes.length, 0);
  rmSync(dir, { recursive: true, force: true });
});

test("предполёт: грандфазеринг картой, храповик вниз, тревога сверх карты", () => {
  const dir = sandbox();
  putCompleteMeeting(dir);
  rmSync(join(dir, mirrorSlug("weather?session_key=11")));
  rmSync(join(dir, mirrorSlug("weather?session_key=12")));

  // Первый прогон: существующие дыры грандфазерятся по-митинговой картой.
  const first = preflightOpenf1Holes(dir, NOW_2031);
  assert.equal(first.initialized, true);
  assert.deepEqual(first.baseline, { perMeeting: { "7": 2 }, frozenPerYear: { "2030": 1 } });
  assert.deepEqual(readOpenf1Manifest(dir)?.holesBaseline, first.baseline);

  // Дыр у митинга стало больше — тревога, карта не перезаписана.
  rmSync(join(dir, mirrorSlug("race_control?session_key=11")));
  assert.throws(() => preflightOpenf1Holes(dir, NOW_2031), /3 дыр при карте 2/);
  assert.deepEqual(readOpenf1Manifest(dir)?.holesBaseline?.perMeeting, { "7": 2 },
    "тревога подняла карту");

  // Добор закрыл часть дыр — карта опускается по-митингово: назад дороги нет.
  put(dir, "race_control?session_key=11", []);
  put(dir, "weather?session_key=11", []);
  const shrunk = preflightOpenf1Holes(dir, NOW_2031);
  assert.deepEqual(shrunk.baseline.perMeeting, { "7": 1 });

  // Закрыто всё — запись митинга уходит из карты; новая дыра после этого —
  // снова тревога (карта не помнит «когда-то было можно»).
  put(dir, "weather?session_key=12", []);
  assert.deepEqual(preflightOpenf1Holes(dir, NOW_2031).baseline.perMeeting, {});
  rmSync(join(dir, mirrorSlug("weather?session_key=12")));
  assert.throws(() => preflightOpenf1Holes(dir, NOW_2031), /1 дыр при карте 0/);
  rmSync(dir, { recursive: true, force: true });
});

/// Симуляция отравления, из-за которой бейслайн перестал быть скаляром:
/// пропажа листинга схлопывает матрицу митинга до [листинг, drivers], счёт
/// дыр ПАДАЕТ (2 → 1), скалярный храповик молча опустился бы — а вернувшийся
/// листинг дал бы «новые» дыры поверх заниженного бейслайна. По-митинговая
/// карта + флаг listingMissing превращают это в тревогу.
test("предполёт: пропажа листинга/митинга/года — тревога, не «улучшение»", () => {
  const dir = sandbox();
  putCompleteMeeting(dir);
  rmSync(join(dir, mirrorSlug("weather?session_key=11")));
  rmSync(join(dir, mirrorSlug("weather?session_key=12")));
  preflightOpenf1Holes(dir, NOW_2031);   // карта: {7: 2}

  const listing = readFileSync(join(dir, mirrorSlug("sessions?meeting_key=7")), "utf8");
  rmSync(join(dir, mirrorSlug("sessions?meeting_key=7")));
  assert.throws(() => preflightOpenf1Holes(dir, NOW_2031), /листинг сессий пропал/);
  writeFileSync(join(dir, mirrorSlug("sessions?meeting_key=7")), listing);

  // Митинг исчез из meetings_year_* → и по-митинговая, и годовая тревоги.
  put(dir, "meetings?year=2030", []);
  assert.throws(() => preflightOpenf1Holes(dir, NOW_2031), /пропал из матрицы/);
  assert.throws(() => preflightOpenf1Holes(dir, NOW_2031), /бит или усох/);
  rmSync(dir, { recursive: true, force: true });
});

/// Вторая симуляция отравления — ПОРЧА (не удаление) листинга у ПОЛНОГО
/// митинга: записи в карте дыр у него нет (0 дыр), existsSync листинг
/// «видит», матрица схлопнута — без спецобработки порча проходила бы молча,
/// добор бы не переснимал, а «полный» митинг вечно пропускался писателем.
/// Битый листинг = дыра + тревога по каждому ключу listingMissing.
test("предполёт: битый листинг ПОЛНОГО митинга — дыра и тревога, не молчание", () => {
  const dir = sandbox();
  putCompleteMeeting(dir);
  preflightOpenf1Holes(dir, NOW_2031);   // карта: {} — митинг полон

  writeFileSync(join(dir, mirrorSlug("sessions?meeting_key=7")), "{битый json");
  const report = countOpenf1Holes(dir, NOW_2031);
  assert.deepEqual(report.listingMissing, ["7"]);
  assert.deepEqual(report.holes, [mirrorSlug("sessions?meeting_key=7")],
    "битый-но-существующий листинг обязан считаться дырой");
  assert.equal(report.perMeeting["7"], 1);
  assert.equal(frozenMeetingComplete(dir, null, 7), false,
    "митинг с битым листингом не может быть «полон» — писатель обязан переснять");
  assert.throws(() => preflightOpenf1Holes(dir, NOW_2031), /листинг сессий пропал\/бит/);
  rmSync(dir, { recursive: true, force: true });
});

/// Явный путь принятия новых «вечных» дыр — OPENF1_ACCEPT_HOLES=1: осознанный
/// разовый локальный прогон (источник навсегда потерял файлы отгонявшегося
/// этапа; митинг легально ушёл из матрицы). Не переменная крона.
test("предполёт: OPENF1_ACCEPT_HOLES=1 принимает состояние новой картой", () => {
  const dir = sandbox();
  putCompleteMeeting(dir);
  preflightOpenf1Holes(dir, NOW_2031);   // карта: {} — дыр нет
  rmSync(join(dir, mirrorSlug("weather?session_key=11")));
  assert.throws(() => preflightOpenf1Holes(dir, NOW_2031), /1 дыр при карте 0/);
  process.env.OPENF1_ACCEPT_HOLES = "1";
  try {
    const accepted = preflightOpenf1Holes(dir, NOW_2031);
    assert.deepEqual(accepted.baseline.perMeeting, { "7": 1 });
    assert.equal(accepted.initialized, false);
  } finally {
    delete process.env.OPENF1_ACCEPT_HOLES;
  }
  // Принятая карта держит: тот же прогон без переменной больше не тревожится.
  assert.deepEqual(preflightOpenf1Holes(dir, NOW_2031).baseline.perMeeting, { "7": 1 });
  rmSync(dir, { recursive: true, force: true });
});

// MARK: - Warning-канал «keep-поле сплошь null» (амендмент 2)

test("сплошной null keep-поля по семейству — предупреждение, не тревога", () => {
  const dir = sandbox();
  put(dir, "stints?session_key=1", [
    { driver_number: 1, stint_number: 1, compound: null },
    { driver_number: 2, stint_number: 1, compound: null },
  ]);
  // Неконвертированное семейство не сканируется — на этапе 0 канал молчит.
  assert.deepEqual(openf1NullFieldWarnings(dir, manifestWith({})), []);
  const manifest = manifestWith({ stints: { parser: OPENF1_FACTS_SCHEMA_VERSION } });
  const warnings = openf1NullFieldWarnings(dir, manifest);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /stints.*«compound» сплошь null/);
  // Одно ненулевое значение в ЛЮБОМ файле семейства снимает предупреждение.
  put(dir, "stints?session_key=2", [{ driver_number: 3, stint_number: 1, compound: "SOFT" }]);
  assert.deepEqual(openf1NullFieldWarnings(dir, manifest), []);
  // Предполёт ДОНОСИТ предупреждения в отчёте, не роняя прогон тревогой.
  rmSync(join(dir, mirrorSlug("stints?session_key=2")));
  writeOpenf1Manifest(dir, manifest);
  put(dir, "meetings?year=2030", []);
  assert.deepEqual(preflightOpenf1Holes(dir, NOW_2031).warnings, warnings);
  rmSync(dir, { recursive: true, force: true });
});

// MARK: - Walk-тест CI по боевому корпусу

/// Красный флаг судьи №1: оракул, считающий сегодняшнее сырьё «не фактом»,
/// отправил бы ВЕСЬ замороженный архив в добор — тысячи GET. Поэтому прямо
/// проверяем: каждый файл конвертированного семейства проходит оракул формы
/// (включая сторожа строки и байтов), а сегодня (манифеста нет / семейств в
/// нём нет) любой файл валиден по переходной семантике. Заодно: чужих имён в
/// каталоге нет.
test("walk: боевой корпус проходит оракул формы (сырьё зелёное до конвертации)", () => {
  const manifest = readOpenf1Manifest(DATA_DIR);
  const offenders: string[] = [];
  for (const name of readdirSync(DATA_DIR)) {
    if (name === OPENF1_MANIFEST_NAME) continue;
    const family = familyOfFile(name);
    if (family === null) {
      offenders.push(`${name}: файл вне восьми семейств зеркала`);
      continue;
    }
    const entry = manifest?.families?.[family];
    const err = factTextError(family, entry, readFileSync(join(DATA_DIR, name), "utf8"));
    if (err) offenders.push(`${name}: ${err}`);
  }
  assert.deepEqual(offenders, [], "конвертированное семейство откатилось в сырьё (или чужак в каталоге)");
});

/// Поведенческая приёмка этапа 0: «прогон не хочет сети по замороженному
/// архиву». Для каждого замороженного НЕотменённого митинга БЕЗ дыр каждый
/// ожидаемый файл полон по оракулу — значит гейт «заморожен И полон» пропустит
/// митинг, не дёрнув ни mirror(), ни добор. Пит в полноту НЕ входит (лечение —
/// отдельный канал), поэтому полнота обязана совпадать с матрицей файлов
/// в точности. Замер 07.09.2026: 73 полных из 87 замороженных — «полон →
/// пропуск» покрывает подавляющее большинство архива (с питом было 36/90).
test("боевой корпус: замороженные митинги без дыр полны по оракулу", () => {
  const manifest = readOpenf1Manifest(DATA_DIR);
  const now = Date.now();
  let frozenComplete = 0;
  for (const yearFile of readdirSync(DATA_DIR).filter((f) => familyOfFile(f) === "meetings")) {
    for (const m of JSON.parse(readFileSync(join(DATA_DIR, yearFile), "utf8"))) {
      if (m?.is_cancelled === true) continue;   // вне матрицы целиком
      const finish = Date.parse(m?.date_end ?? m?.date_start ?? "");
      if (!isFrozen(Number.isNaN(finish) ? null : finish, now)) continue;
      const handles = expectedMeetingHandles(DATA_DIR, m.meeting_key);
      if (handles.some((rel) => !existsSync(join(DATA_DIR, mirrorSlug(rel))))) continue;   // дыряв — ему в добор можно
      for (const rel of handles) {
        assert.equal(factComplete(DATA_DIR, manifest, rel), true,
          `${m.meeting_key} «${m.meeting_name}»: ${rel} есть на диске, но оракул зовёт добор — это перекачка архива`);
      }
      assert.equal(frozenMeetingComplete(DATA_DIR, manifest, m.meeting_key), true,
        `${m.meeting_key} «${m.meeting_name}»: полнота разошлась с матрицей файлов`);
      frozenComplete++;
    }
  }
  assert.ok(frozenComplete >= 70, `«заморожен и полон → пропуск» покрывает подозрительно мало: ${frozenComplete}`);
});

/// Грандфазеринг: дыр не больше замера 07.09.2026. Добор закрывает — законно
/// (карта манифеста опустится сама), новые дыры — красный CI ещё до крона.
test("боевой корпус: дыры не превышают замер грандфазеринга", () => {
  const report = countOpenf1Holes(DATA_DIR);
  assert.ok(report.holes.length <= MEASURED_HOLES_2026_09_07,
    `${report.holes.length} дыр против ${MEASURED_HOLES_2026_09_07} в замере: ` +
    `новые — ${report.holes.slice(0, 12).join(", ")}`);
  assert.ok(report.frozenMeetings >= 80,
    `замер строился на 87 замороженных митингах, тут ${report.frozenMeetings}`);
  assert.ok(report.cancelledMeetings >= 3,
    `в корпусе 3 отменённых (Эмилия-2023, Бахрейн и Сауди-2026), найдено ${report.cancelledMeetings} — ` +
    `исключение отменённых из матрицы перестало работать?`);
  // Карта из манифеста (когда предполёт её уже записал) не выше замера.
  const recorded = readOpenf1Manifest(DATA_DIR)?.holesBaseline;
  if (recorded) {
    const total = Object.values(recorded.perMeeting).reduce((a, b) => a + b, 0);
    assert.ok(total <= MEASURED_HOLES_2026_09_07);
  }
});

/// Решение по drivers в матрице, зафиксированное замером: у замороженных
/// НЕотменённых митингов drivers-дыр нет вовсе — единственная была у
/// отменённой Эмилии-Романьи-2023 (1209), а отменённые теперь вне матрицы
/// целиком. Появилась drivers-дыра — это новый класс потери (у drivers есть
/// читатель entrylist), решение надо пересматривать, а не молча грандфазерить.
test("боевой корпус: drivers-дыр у замороженных митингов нет", () => {
  const missing = countOpenf1Holes(DATA_DIR).holes
    .filter((h) => familyOfFile(h) === "drivers");
  assert.deepEqual(missing, [], `неожиданные drivers-дыры: ${missing.join(", ")}`);
});
