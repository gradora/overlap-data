// Слой фактов WEC (lib/wecfacts.ts + lib/wecextract.ts). Проверяется то, из-за
// чего слой вообще заведён, и то, чем за него платим.
//
// Контекст: до 31.08.2026 продьюсеры сохраняли страницы fiawec целиком — 24 МБ
// чужого выражения в открытом репозитории. Теперь на диск уходит извлечённое.
// Цена перехода: парсер стал несущим В МОМЕНТ ЗАПИСИ, и промах отравляет
// сохранённое. Отсюда версия схемы, сторож длины строки и парный тест имени.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mirrorSlug } from "./lib/mirror.js";
import { extractFacts, putPage } from "./lib/wecextract.js";
import {
  MAX_FACT_STRING, WEC_FACTS_SCHEMA_VERSION, expectedRaceFiles, isRaceFileOfSeason,
  longStringIn, orphanRaceFiles, pruneOrphans, readFacts, wecFactsFile, wecRacePath,
  wecResultsPath, wecSeasonPath, wecSessionsPath, writeFacts,
} from "./lib/wecfacts.js";

const sandbox = () => mkdtempSync(join(tmpdir(), "wecfacts-"));

const seasonPage = (year: number) => `
  <a href="/en/race/6-hours-of-imola-${year}">Imola</a>
  <a href="/en/race/24-hours-of-le-mans-${year}-1">Le Mans</a>
  <a href="/en/race/official-prologue-imola-${year}">Prologue</a>`;

// MARK: - Ключ файла

/// САМАЯ ДОРОГАЯ ловушка перехода, и она тихая. GC осиротевших опознаёт файлы
/// выбывших этапов предикатом «год в КОНЦЕ имени». Добавь факту расширение
/// `.json` — предикат перестаёт совпадать, GC ничего не удаляет и ничего не
/// печатает, файлы уехавших этапов (Катар и Бахрейн-2026 уже уезжали в 2027)
/// копятся вечно, а прогон зелёный. Прототип слоя такую форму имени содержал.
///
/// Тест ПАРНЫЙ намеренно: имя генерирует та же функция, что пишет файл, и
/// проверяет тот же предикат, что удаляет. Разъехаться им негде.
test("имя файла факта и предикат уборки — одно и то же", () => {
  const root = sandbox();
  for (const slug of ["6-hours-of-imola-2031", "24-hours-of-le-mans-2031-1",
                      "official-prologue-imola-2031"]) {
    const file = wecFactsFile(root, wecRacePath(slug)).split("/").pop()!;
    assert.doesNotMatch(file, /\.[a-z]+$/, `${file}: расширение выключает уборку`);
    assert.ok(isRaceFileOfSeason(file, 2031), `${file} не опознан как файл сезона 2031`);
    assert.ok(!isRaceFileOfSeason(file, 2030), `${file} ошибочно приписан чужому сезону`);
    assert.ok(expectedRaceFiles([slug]).has(file), "ожидаемое и записанное разошлись");
  }
  rmSync(root, { recursive: true, force: true });
});

test("уборка сносит выбывший этап и не трогает свои и чужие", () => {
  const root = sandbox();
  const slugs = ["6-hours-of-imola-2031", "official-prologue-imola-2031"];
  for (const s of [...slugs, "6-hours-of-qatar-2031"]) {
    putPage(root, wecRacePath(s), "<html></html>");
  }
  putPage(root, wecRacePath("6-hours-of-imola-2030"), "<html></html>"); // чужой сезон
  putPage(root, wecSeasonPath(2031), seasonPage(2031));

  assert.deepEqual(orphanRaceFiles(root, 2031, slugs),
                   [mirrorSlug(wecRacePath("6-hours-of-qatar-2031"))],
                   "выбывший этап не найден, либо под нож пошло лишнее");
  // Пролог обязан быть в ожидаемом наборе: он тоже en_race_*_<год>, и без него
  // уборка сносила бы его страницу на каждом прогоне.
  assert.deepEqual(orphanRaceFiles(root, 2031, [...slugs, "6-hours-of-qatar-2031"]), []);
  rmSync(root, { recursive: true, force: true });
});

// MARK: - Граница «факт против выражения»

/// Механический сторож, а не вкусовой: во всём боевом корпусе медиана строки
/// 8 символов, максимум 58 (состав экипажа). Абзац стюардского вердикта или
/// новостной анонс — 200+. Без него будущая правка парсера могла бы затащить
/// вербатим обратно, и заметили бы это уже в публичной истории.
test("длинная строка или разметка в фактах — отказ записи, а не тихая запись", () => {
  const root = sandbox();
  const long = "я".repeat(MAX_FACT_STRING + 1);
  assert.equal(longStringIn({ a: { b: [{ c: long }] } }), long, "обход не дошёл до вложенного поля");
  assert.equal(longStringIn({ a: "8", b: ["B. HARTLEY, R. HIRAKAWA"] }), null);
  assert.equal(longStringIn("<table><tr>"), "<table><tr>", "разметка любой длины — не факт");
  assert.equal(longStringIn({ n: 42, ok: null, arr: [] }), null);

  assert.throws(
    () => writeFacts(root, wecSeasonPath(2031), { kind: "season", races: [long], tests: [] }),
    /не факт, а выражение/);
  assert.equal(existsSync(wecFactsFile(root, wecSeasonPath(2031))), false,
               "отказ всё равно что-то записал");
  rmSync(root, { recursive: true, force: true });
});

// MARK: - Версия схемы

/// Плата за переход, названная вслух. При хранении HTML правка парсера чинила
/// и архив: разбор шёл на каждом прогоне. Теперь разбор в момент записи, и
/// замороженный этап не перечитался бы НИКОГДА. Версия — единственный рычаг:
/// подняли её — старые факты считаются отсутствующими, и архив подтягивается.
test("факт чужой версии схемы читается как отсутствующий", () => {
  const root = sandbox();
  putPage(root, wecSeasonPath(2031), seasonPage(2031));
  const file = wecFactsFile(root, wecSeasonPath(2031));
  const doc = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(doc.schemaVersion, WEC_FACTS_SCHEMA_VERSION, "конверт не записан");
  assert.equal(doc.payload.kind, "season");

  writeFileSync(file, JSON.stringify({ ...doc, schemaVersion: doc.schemaVersion + 1 }));
  assert.equal(readFacts(root, wecSeasonPath(2031), "season"), null,
    "факт будущей версии принят как свой — правка парсера не дошла бы до архива");

  // Чужой ВИД факта по своему адресу — тоже null, а не приведение типа.
  writeFileSync(file, JSON.stringify(
    { schemaVersion: WEC_FACTS_SCHEMA_VERSION, payload: { kind: "sessions", sessions: [] } }));
  assert.equal(readFacts(root, wecSeasonPath(2031), "season"), null);
  // Мусор вместо JSON не роняет чтение: продьюсер должен переснять, а не упасть.
  writeFileSync(file, "не json");
  assert.equal(readFacts(root, wecSeasonPath(2031), "season"), null);
  rmSync(root, { recursive: true, force: true });
});

// MARK: - Извлечение

test("страница без читателей на диск не ложится вовсе", () => {
  const root = sandbox();
  // Индекс результатов: приложение его не читает с шага 3c, продьюсеру он
  // нужен только как признак живости сайта. Раньше лежал в репо целиком.
  assert.equal(extractFacts("/en/page/resultats-1", "<html>что угодно</html>"), null);
  assert.equal(putPage(root, "/en/page/resultats-1", "<html></html>"), false);
  assert.equal(extractFacts("/en/unknown", "<html></html>"), null);
  rmSync(root, { recursive: true, force: true });
});

/// Год берётся ИЗ ПУТИ. Страница сезона несёт слаги нескольких лет сразу, и
/// рассинхрон пути с отдельным аргументом года дал бы не ошибку, а пустой
/// список слагов — то есть тихо опустевший сезон в витрине.
test("год слагов берётся из адреса страницы, а не со стороны", () => {
  const html = seasonPage(2031) + seasonPage(2032);
  const y31 = extractFacts(wecSeasonPath(2031), html);
  const y32 = extractFacts(wecSeasonPath(2032), html);
  assert.equal(y31?.kind, "season");
  assert.deepEqual(y31.kind === "season" ? y31.races : [],
                   ["6-hours-of-imola-2031", "24-hours-of-le-mans-2031-1"]);
  assert.deepEqual(y31.kind === "season" ? y31.tests : [], ["official-prologue-imola-2031"]);
  assert.deepEqual(y32?.kind === "season" ? y32.races : [],
                   ["6-hours-of-imola-2032", "24-hours-of-le-mans-2032-1"]);
});

test("вид факта выбирается по адресу: сессии, протокол, зачёт", () => {
  const dropdown = '<option value="50">Free Practice 1</option><option value="51">RACE</option>';
  const sessions = extractFacts(wecSessionsPath(41), dropdown);
  assert.equal(sessions?.kind, "sessions");
  assert.deepEqual(sessions.kind === "sessions" ? sessions.sessions.map((s) => s.id) : [], [50, 51]);

  // sessionId в адресе перевешивает raceId — иначе протокол лёг бы как дропдаун.
  assert.equal(extractFacts(wecResultsPath(41, 51), "<table></table>")?.kind, "results");
  assert.equal(extractFacts("/en/page/manufacturers-classification", "<html></html>")?.kind,
               "standings");
});

/// Пол уборки: оборванный на трети ответ (HTTP 200, полстраницы) даёт
/// усечённый список слагов — без пола уборка снесла бы пол-сезона.
test("уборка отказывается сносить больше MAX_PRUNE_PER_RUN за прогон", () => {
  const root = sandbox();
  const all = ["6-hours-of-imola-2031", "6-hours-of-qatar-2031",
               "6-hours-of-fuji-2031", "6-hours-of-monza-2031"];
  for (const s of all) putPage(root, wecRacePath(s), "<html></html>");
  // «Сезон» внезапно похудел до одного этапа — три сироты, больше предела.
  assert.equal(pruneOrphans(root, 2031, all.slice(0, 1)), null,
               "уборка поверила усечённой странице");
  for (const s of all) {
    assert.ok(existsSync(wecFactsFile(root, wecRacePath(s))), `${s} снесён при отказе`);
  }
  // Один выбывший — штатная перекройка, сносится.
  const removed = pruneOrphans(root, 2031, all.slice(0, 3));
  assert.deepEqual(removed, [mirrorSlug(wecRacePath("6-hours-of-monza-2031"))]);
  rmSync(root, { recursive: true, force: true });
});

/// Подметание по raceId: дропдаун и протоколы выбывшего этапа предикату года
/// не видны (в имени нет года) — без подметания они оставались бы навсегда,
/// как лежали 4947 и 4955.
test("уборка выбывшего этапа сносит и его дропдаун с протоколами", () => {
  const root = sandbox();
  putPage(root, wecRacePath("6-hours-of-imola-2031"), "<html></html>");
  const gone = '<script>{"raceId&quot;:77}</script>';
  putPage(root, wecRacePath("6-hours-of-qatar-2031"), gone);
  putPage(root, wecSessionsPath(77), '<option value="9">RACE</option>');
  putPage(root, wecResultsPath(77, 9), "<table></table>");

  const removed = pruneOrphans(root, 2031, ["6-hours-of-imola-2031"]);
  assert.equal(removed?.length, 3, `снесено ${removed?.length} из 3: ${removed}`);
  assert.ok(!existsSync(wecFactsFile(root, wecSessionsPath(77))), "дропдаун остался");
  assert.ok(!existsSync(wecFactsFile(root, wecResultsPath(77, 9))), "протокол остался");
  rmSync(root, { recursive: true, force: true });
});

/// Обходы границы факта, найденные проверкой: текст в КЛЮЧЕ объекта и потолок
/// объёма (страница, нарезанная кусками по 120, — это всё ещё страница).
test("граница факта: ключи объекта и объём файла тоже под сторожем", () => {
  const root = sandbox();
  const long = "х".repeat(MAX_FACT_STRING + 1);
  assert.equal(longStringIn({ [long]: 1 }), long, "текст в ключе пронесён");
  const chunks = Array.from({ length: 700 }, (_, i) => `кусок ${i} `.repeat(10).slice(0, 110));
  assert.throws(
    () => writeFacts(root, wecSeasonPath(2031), { kind: "season", races: chunks, tests: [] }),
    /это всё ещё страница/);
  rmSync(root, { recursive: true, force: true });
});
