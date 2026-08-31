// Слияние и докач решений стюардов WEC/IMSA — mergeStewardsPenalties и
// planStewardsFetches (lib/fiadocs.ts). Это перенос политики mergeFiaEvent на
// серии с ДРУГИМИ ключами решений: WEC нумерует доки внутри раунда (ключ doc),
// у IMSA нумерация TP и SP сквозная по сезону и независимая — «TP 26-11» и
// «SP 26-11» это разные нотисы одного уик-энда (ключ session#doc).
//
// Класс защищаемых инцидентов тот же, что чинили у F1 в Зандфорте (11 решений
// → 2 от одной осечки PDF): до слияния wecfia/imsafia ПЕРЕЗАПИСЫВАЛИ файл
// итогом прогона, и на этапах WEC со 140 штрафными PDF (Ле-Ман) это была не
// гипотеза. Плюс их собственный шрам: wec/fia/2025_1.json — файл Катара с
// бахрейнскими решениями (перенумерация календаря без guard).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mergeStewardsPenalties, planStewardsFetches,
  type FiaPenalty, type StewardsListedDoc,
} from "./lib/fiadocs.js";
import { WEC_PENALTY_PARSER_VERSION } from "./producers/wecfia.js";
import { IMSA_PENALTY_PARSER_VERSION } from "./producers/imsafia.js";

const V = 3; // версия парсера в тестах — нарочно не 1, чтобы не совпасть случайно

const pen = (doc: number, over: Partial<FiaPenalty> = {}): FiaPenalty => ({
  doc,
  parser: V,
  car: 7,
  driver: "Kevin Estre",
  session: "Race",
  type: "time",
  seconds: 10,
  appliesTo: "race",
  corrected: false,
  url: `https://nb.example/doc-${doc}.pdf`,
  publishedAt: `2026-08-${String(10 + doc).padStart(2, "0")}T10:00:00.000Z`,
  ...over,
});

const listed = (p: FiaPenalty, over: Partial<StewardsListedDoc> = {}): StewardsListedDoc => ({
  key: String(p.doc),
  url: p.url,
  corrected: p.corrected,
  ...over,
});

const byDoc = (p: FiaPenalty) => String(p.doc);
// Композитное пространство IMSA: TP и SP нумеруются независимо.
const bySessionDoc = (p: FiaPenalty) => `${p.session}#${p.doc}`;

// MARK: слияние — файл только накапливается

test("merge: прогон без единого разобранного PDF не теряет решений", () => {
  // Инвариант, ради которого всё: осечка сети/парсера → файл как был.
  const prev = [pen(1), pen(2), pen(3)];
  const m = mergeStewardsPenalties(prev, [], prev.map(byDoc), byDoc);
  assert.equal(m.penalties.length, 3, "решения потеряны при пустом прогоне");
  assert.equal(m.kept, 3);
  assert.deepEqual(m.missing, []);
});

test("merge: урезанный листинг не удаляет решения — только громкий missing", () => {
  // Notice Board отдал 1 док из 3 (деградация/смена вёрстки). Автоудалений
  // нет ВООБЩЕ: у F1 проверено историей, что настоящих отзывов не бывает,
  // а листинг, севший наполовину, стирал бы файл без единой закачки.
  const prev = [pen(1), pen(2), pen(3)];
  const m = mergeStewardsPenalties(prev, [], ["2"], byDoc);
  assert.equal(m.penalties.length, 3, "урезанный листинг стёр решения");
  assert.deepEqual(m.missing, ["1", "3"], "пропажа обязана быть видна для ручного разбора");
});

test("merge: свежий разбор побеждает для того же ключа, прочее — из файла", () => {
  const prev = [pen(1), pen(2, { seconds: 5 })];
  const fresh = [pen(2, { seconds: 30 }), pen(3)];
  const m = mergeStewardsPenalties(prev, fresh, ["1", "2", "3"], byDoc);
  assert.equal(m.penalties.length, 3);
  assert.equal(m.penalties.find((p) => p.doc === 2)!.seconds, 30, "свежий разбор не победил");
  assert.equal(m.kept, 1, "kept — это выжившие «как были», здесь doc 1");
});

test("merge: updated — максимум publishedAt итогового набора", () => {
  const m = mergeStewardsPenalties([pen(1)], [pen(5)], ["1", "5"], byDoc);
  assert.equal(m.updated, pen(5).publishedAt);
});

test("merge: композитный ключ IMSA — TP и SP с одним номером не затирают друг друга", () => {
  // Ровно причина, по которой ключ параметризован: у IMSA «TP 26-11» и
  // «SP 26-11» — разные нотисы, склейка по одному doc потеряла бы один из них.
  const tp = pen(11, { session: "TP" });
  const sp = pen(11, { session: "SP" });
  const m = mergeStewardsPenalties([tp], [sp], ["TP#11", "SP#11"], bySessionDoc);
  assert.equal(m.penalties.length, 2, "нотисы TP/SP с одним номером схлопнулись");
});

// MARK: докач — качаем только недостающее

test("plan: разобранное текущей версией не перекачивается", () => {
  const prev = [pen(1), pen(2)];
  const docs = prev.map((p) => listed(p));
  const plan = planStewardsFetches(prev, docs, byDoc, V, false);
  assert.deepEqual(plan.fetch, [], "докач перекачивает уже разобранное");
  assert.equal(plan.reused.length, 2);
});

test("plan: новый документ качается, прежние — нет", () => {
  const prev = [pen(1)];
  const fresh = pen(2);
  const plan = planStewardsFetches(prev, [listed(prev[0]), listed(fresh)], byDoc, V, false);
  assert.deepEqual(plan.fetch.map((d) => d.key), ["2"]);
});

test("plan: смена версии парсера снимает пропуск — правка разбора доедет до записей", () => {
  // Без этого улучшение классификатора никогда не дошло бы до собранных
  // решений (у F1 это происходило трижды, и каждый раз было правильным).
  const prev = [pen(1), pen(2)];
  const plan = planStewardsFetches(prev, prev.map((p) => listed(p)), byDoc, V + 1, false);
  assert.equal(plan.fetch.length, 2, "бамп версии не инвалидировал пропуск");
  assert.equal(plan.restamp, 2);
});

test("plan: force перечитывает всё", () => {
  const prev = [pen(1), pen(2)];
  const plan = planStewardsFetches(prev, prev.map((p) => listed(p)), byDoc, V, true);
  assert.equal(plan.fetch.length, 2);
  assert.deepEqual(plan.reused, []);
});

test("plan: смена url или AMENDED-переиздание ловятся отпечатком", () => {
  // Notice Board дат не отдаёт, но имя файла при переиздании меняется, а
  // AMENDED приходит отдельным доком — отпечаток url+corrected это ловит.
  const prev = [pen(1), pen(2)];
  const docs = [
    listed(prev[0], { url: "https://nb.example/doc-1_AMENDED.pdf" }),
    listed(prev[1], { corrected: true }),
  ];
  const plan = planStewardsFetches(prev, docs, byDoc, V, false);
  assert.equal(plan.fetch.length, 2, "подмена документа прошла мимо отпечатка");
});

// MARK: версии парсеров серий — независимые константы

test("версии парсеров WEC и IMSA свои, не F1-шные", () => {
  // Бамп F1-классификатора не должен гнать перекачку 140 PDF Ле-Мана —
  // и наоборот. Существование констант держит это разделение.
  assert.ok(Number.isInteger(WEC_PENALTY_PARSER_VERSION) && WEC_PENALTY_PARSER_VERSION >= 1);
  assert.ok(Number.isInteger(IMSA_PENALTY_PARSER_VERSION) && IMSA_PENALTY_PARSER_VERSION >= 1);
});
