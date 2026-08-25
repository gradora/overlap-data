// Тесты парсера справочника трасс на РЕАЛЬНОЙ фикстуре wikitext (таблица Lap
// records + проза History). Запуск: npm test (node:test через tsx).

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  bucketFor,
  timeToSeconds,
  cleanCell,
  parseLapRecords,
  wikitextToPlain,
  extractNotable,
  parseLongestRace,
  buildTrack,
  enoughLoaded,
} from "./producers/tracks.js";

// --- Фрагмент реального wikitext Spa: секция Lap records + два лейаута ---
const SPA_WT = `Some intro text about the circuit.

==Lap records==
The official lap record for the current circuit layout is 1:44.701.<ref name=x/>

{| class=wikitable style="font-size:90%",
! Category !! Time !! Driver !! Vehicle !! Event
|-
! colspan=5 | Modern Grand Prix Circuit (2007–present): {{cvt|7.004|km|mi|abbr=on}}
|-
| [[Formula One]] || '''1:44.701''' || [[Sergio Pérez]] || [[Red Bull Racing RB20]] || [[2024 Belgian Grand Prix]]
|-
| [[FIA Formula 2 Championship|FIA F2]] || '''1:59.029'''<ref name=y/> || [[Paul Aron]] || [[Dallara F2 2024]] || [[2024 Spa Formula 2 round|2024 Spa F2]]
|-
| [[Le Mans Prototype#LMP1|LMP1]] || '''1:57.394''' || [[Mike Conway]] || [[Toyota TS050 Hybrid]] || [[2019 6 Hours of Spa-Francorchamps|2019 6H Spa]]
|-
! colspan=5 | Old Circuit (1979–2006): {{cvt|6.968|km}}
|-
| [[Formula One]] || '''1:45.108''' || [[Kimi Räikkönen]] || [[McLaren MP4-20]] || [[2004 Belgian Grand Prix]]
|}

==History==
The circuit opened in 1921. In 2019, Formula 2 driver Anthoine Hubert was killed in a crash on the Kemmel Straight. This leads to the tight corner which is followed by a straight.
`;

test("bucketFor раскладывает категории по группам", () => {
  assert.equal(bucketFor("Formula One"), "formula");
  assert.equal(bucketFor("FIA F2"), "formula");
  assert.equal(bucketFor("LMP1"), "endurance");
  assert.equal(bucketFor("LMH"), "endurance");
  assert.equal(bucketFor("LM GTE"), "gt");
  assert.equal(bucketFor("Class 1 Touring Cars"), "touring");
  assert.equal(bucketFor("MotoGP"), "other");
});

test("timeToSeconds парсит время круга", () => {
  assert.equal(timeToSeconds("1:44.701"), 104.701);
  assert.equal(timeToSeconds("44.701"), 44.701);
  assert.ok(Number.isNaN(timeToSeconds("2024")));
});

test("cleanCell снимает вики-разметку, сноски и cvt", () => {
  assert.equal(cleanCell("[[Sergio Pérez]]"), "Sergio Pérez");
  assert.equal(cleanCell("[[Le Mans Prototype#LMP1|LMP1]]"), "LMP1");
  assert.equal(cleanCell("'''1:57.394'''<ref name=y/>"), "1:57.394");
  assert.equal(cleanCell("{{cvt|7.004|km|mi|abbr=on}}"), "7.004");
});

test("parseLapRecords берёт только текущий лейаут", () => {
  const { layout, records } = parseLapRecords(SPA_WT);
  assert.match(layout ?? "", /Modern Grand Prix Circuit/);
  // Три записи текущего лейаута; исторический Old Circuit (1979–2006) отброшен.
  assert.equal(records.length, 3);
  assert.ok(!records.some((r) => r.year === 2004), "историч. рекорд не должен попасть");
  const f1 = records.find((r) => r.category === "Formula One")!;
  assert.equal(f1.time, "1:44.701");
  assert.equal(f1.driver, "Sergio Pérez");
  assert.equal(f1.year, 2024);
  assert.equal(f1.bucket, "formula");
});

test("buildTrack: самый быстрый в группе + notable из прозы", () => {
  const t = buildTrack("spa-francorchamps", "Circuit de Spa-Francorchamps", SPA_WT);
  assert.equal(t.fastest.formula?.category, "Formula One");
  assert.equal(t.fastest.endurance?.category, "LMP1");
  // Records отсортированы по времени (быстрые первыми).
  assert.ok(t.records[0].seconds <= t.records[1].seconds);
  // Notable: событие Hubert 2019 попадает; описание геометрии — нет.
  const hubert = t.notable.find((n) => n.year === 2019);
  assert.ok(hubert, "событие 2019 должно быть в notable");
  assert.ok(!t.notable.some((n) => /leads to the tight corner/i.test(n.text)), "геометрия отфильтрована");
});

test("wikitextToPlain снимает таблицы и шаблоны", () => {
  const plain = wikitextToPlain(SPA_WT);
  assert.ok(!plain.includes("{|"), "таблица снята");
  assert.ok(!plain.includes("{{"), "шаблоны сняты");
  assert.match(plain, /circuit opened in 1921/i);
});

test("extractNotable отбрасывает предложения про рекорд круга", () => {
  const moments = extractNotable(
    "The lap record of 1:44 was set in 2024. In 1960 two drivers were killed at the Grand Prix."
  );
  assert.equal(moments.length, 1);
  assert.equal(moments[0].year, 1960);
});

test("parseLongestRace берёт максимум по часам", () => {
  const plain = "The circuit hosts the 6 Hours of Spa and the famous 24 Hours of Spa. Also a 4 Hours of Spa club event.";
  const lr = parseLongestRace(plain);
  assert.equal(lr?.hours, 24);
  assert.match(lr?.name ?? "", /24 Hours of Spa/);
  assert.equal(parseLongestRace("No endurance racing here, only sprints."), null);
});

test("parseRecordTable отбрасывает мусор нестандартной таблицы (год-диапазон/скорость)", () => {
  // Строка в стиле Le Mans: Years | RecordYear | Distance | AvgSpeed(km/h) | …
  const wt = `==Lap records==
{| class=wikitable
! Years !! Record year !! Distance !! Average race speed
|-
| 1923–1928 || 1928 || 2,669.272 km || 111.219 km/h
|}`;
  const { records } = parseLapRecords(wt);
  assert.equal(records.length, 0, "мусорная строка не должна стать рекордом");
});

// --- Сторож против тихого затирания справочника ---

test("enoughLoaded: массовый отказ вики не даёт записать пустой index", () => {
  // getJSON не бросает — пять неудачных попыток отдают null, страниц нет,
  // index остаётся пустым. Без этого предохранителя writeIfChanged записывал бы
  // `{}`, шаг выходил бы нулём, а воркфлоу коммитил бы уничтожение всех трасс.
  // Ни один бюджет свежести этого не поймает: прогон формально успешен.
  assert.equal(enoughLoaded(0, 39), false, "вики легла целиком");
  assert.equal(enoughLoaded(10, 39), false, "загрузился один батч из двух");
  assert.equal(enoughLoaded(29, 39), false, "порог при 39 трассах — 30");
  assert.equal(enoughLoaded(30, 39), true, "терпим до девяти отвалившихся статей");
  assert.equal(enoughLoaded(39, 39), true, "штатный прогон");
  // TRACKS_ONLY сужает выборку — порог обязан считаться от неё, а не от всех.
  assert.equal(enoughLoaded(1, 1), true);
  assert.equal(enoughLoaded(0, 1), false);
  assert.equal(enoughLoaded(0, 0), false, "пустая выборка успехом не считается");
});

// ---- Сторож против затирания справочника: проверяется ВЫЗОВ, не предикат ----
// enoughLoaded покрыт восемью ассертами, но мутационная проверка показала, что
// снятие самого сторожа в publishTracks не ловилось ничем: прогон записывал
// ПУСТОЙ index.json и вдобавок штамповал маркер свежести — то есть новый сигнал
// ручался за уничтоженные данные. Гоняем в дочернем процессе, потому что при
// срабатывании сторож завершает прогон ненулём.

test("publishTracks: при недоборе страниц не пишет ни индекс, ни маркер", () => {

  const cwd = mkdtempSync(join(tmpdir(), "tracks-"));
  const mod = resolve("src/producers/tracks.ts").replace(/\\/g, "/");
  const script = `
    import { publishTracks } from "${mod}";
    publishTracks({ a: 1 }, 5, 39, 34, false);   // 5 из 39 — далеко ниже порога
    console.log("НЕ ДОЛЖНО ДОЙТИ");
  `;
  writeFileSync(join(cwd, "probe.ts"), script);

  const r = spawnSync("npx", ["tsx", "probe.ts"], { cwd, encoding: "utf8" });
  assert.equal(r.status, 1, "сторож обязан завершить прогон ненулём");
  assert.doesNotMatch(r.stdout ?? "", /НЕ ДОЛЖНО ДОЙТИ/);
  assert.equal(existsSync(join(cwd, "data", "tracks", "index.json")), false,
    "справочник переписан при недоборе — это и есть тихое затирание");
  assert.equal(existsSync(join(cwd, "data", "tracks", "_health.json")), false,
    "маркер свежести поставлен на несобранных данных — сигнал начал врать");
  rmSync(cwd, { recursive: true, force: true });
});

test("publishTracks: при полной загрузке пишет и индекс, и маркер", () => {

  const cwd = mkdtempSync(join(tmpdir(), "tracks-"));
  const mod = resolve("src/producers/tracks.ts").replace(/\\/g, "/");
  writeFileSync(join(cwd, "probe.ts"),
    `import { publishTracks } from "${mod}";\npublishTracks({ a: 1 }, 39, 39, 0, false);\n`);

  const r = spawnSync("npx", ["tsx", "probe.ts"], { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(cwd, "data", "tracks", "index.json")), "индекс не записан");
  const marker = JSON.parse(readFileSync(join(cwd, "data", "tracks", "_health.json"), "utf8"));
  assert.match(marker.lastSuccess, /^\d{4}-\d{2}-\d{2}$/, "маркер обязан нести дату суток");
  rmSync(cwd, { recursive: true, force: true });
});
