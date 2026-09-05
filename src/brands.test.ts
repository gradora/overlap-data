// Валидатор справочника марок (data/refs/brands.json) — по прецеденту
// refs/matching: справочник правится руками без продьюсера, и единственный
// сторож от опечатки — тест в CI. Наполнение — веб-ресёрч с перекрёстной
// верификацией (сентябрь 2026); семантика чисел: победы в ОБЩЕМ ЗАЧЁТЕ и
// манифактурные титулы top class В ЭРЕ серии (WEC с 2012, IMSA WSC с 2014).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const doc = JSON.parse(
  readFileSync(join(process.cwd(), "data", "refs", "brands.json"), "utf8"));

/// Слаги — эталон клиентских реестров (WECManufacturer/IMSAManufacturer):
/// экран адресует справочник ИХ слагами, чужой ключ не найдётся никогда.
const KNOWN = {
  wec: ["toyota", "bmw", "cadillac", "ferrari", "genesis", "peugeot",
        "alpine", "aston-martin", "porsche"],
  imsa: ["cadillac", "porsche", "acura", "bmw", "aston-martin", "lamborghini"],
};
const ERA = { wec: 2012, imsa: 2014 };

test("brands.json: конверт, серии и слаги — из известных реестров", () => {
  assert.equal(doc.schemaVersion, 1);
  const series = Object.keys(doc.brands).sort();
  assert.deepEqual(series, ["imsa", "wec"]);
  for (const [s, brands] of Object.entries(doc.brands)) {
    for (const slug of Object.keys(brands as object)) {
      assert.ok((KNOWN as any)[s].includes(slug),
        `${s}/${slug}: слаг вне клиентского реестра — экран его не найдёт`);
    }
  }
});

test("brands.json: числа в физических границах эры серии", () => {
  const year = new Date().getUTCFullYear();
  for (const [s, brands] of Object.entries(doc.brands)) {
    for (const [slug, f] of Object.entries(brands as Record<string, any>)) {
      const at = `${s}/${slug}`;
      assert.ok(Number.isInteger(f.wins) && f.wins >= 0, `${at}: wins`);
      assert.ok(Number.isInteger(f.titles) && f.titles >= 0, `${at}: titles`);
      assert.ok(f.firstSeason >= (ERA as any)[s] && f.firstSeason <= year,
        `${at}: firstSeason ${f.firstSeason} вне эры серии`);
      // Титулов больше, чем сезонов участия, не бывает.
      assert.ok(f.titles <= year - f.firstSeason + 1, `${at}: titles > сезонов`);
    }
  }
});

test("brands.json: разбивка по годам сходится с итогом и не врёт нулями", () => {
  for (const [s, brands] of Object.entries(doc.brands)) {
    for (const [slug, f] of Object.entries(brands as Record<string, any>)) {
      const at = `${s}/${slug}`;
      if (f.winsByYear == null) continue;
      const values = Object.values(f.winsByYear) as number[];
      assert.equal(values.reduce((a, b) => a + b, 0), f.wins,
        `${at}: сумма winsByYear ≠ wins`);
      // Нулевые сезоны в разбивку не пишутся — ячейка «×0» в UI не рисуется.
      assert.ok(values.every((v) => Number.isInteger(v) && v > 0), `${at}: нули в winsByYear`);
      for (const key of Object.keys(f.winsByYear)) {
        assert.match(key, /^\d{4}(-\d{2})?$/, `${at}: ключ сезона «${key}»`);
      }
    }
  }
});
