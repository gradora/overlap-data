// Тесты парсера справочника трасс на РЕАЛЬНОЙ фикстуре wikitext (таблица Lap
// records + проза History). Запуск: npm test (node:test через tsx).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bucketFor,
  timeToSeconds,
  cleanCell,
  parseLapRecords,
  wikitextToPlain,
  extractNotable,
  buildTrack,
} from "./tracks.js";

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
  const t = buildTrack("Circuit de Spa-Francorchamps", SPA_WT);
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
