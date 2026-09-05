// Сторож фазы A «прятать хвосты»: в клиентской витрине и справочниках нет
// текстовых маркеров источников данных. Ревьюер стора и третьи лица видят
// только наши файлы — происхождение остаётся кухонной заботой (приватный
// репо после фазы C). Лицензионные источники НЕ прячутся, а называются в
// About приложения — сюда относятся только машинные маркеры в данных.
//
// Исключения ниже — поимённые и с причиной; каждое обязано срабатывать,
// иначе оно протухло и его пора снять.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { DATA_FAMILIES } from "./lib/databoundary.js";

const DATA = join(process.cwd(), "data");

const MARKERS =
  /jolpica|openf1|open-?meteo|al\s*kamel|fiawec|\bdhl\b|formula1|flagcdn|ergast|wikipedia|wikimedia/i;

/// Поимённые исключения: regex пути → причина. Совпавший файл проверяется
/// лишь на то, что маркер действительно есть (страховка от протухания).
const ALLOWED: { path: RegExp; reason: string }[] = [
  { path: /^f1\/calendar\/\d{4}\.json$/,
    reason: "sourceIds jolpica/openf1 — сшивка клиента; уходит опаковыми id в фазе D" },
  { path: /^wec\/\d{4}\/.*\.json$/,
    reason: "sourceIds.fiawec — живое окно клиента; уходит в фазе D" },
  { path: /^(f1|wec|imsa)\/fia\/.*\.json$/,
    reason: "url официальных PDF решений — осознанная фича «открыть документ»" },
  { path: /^(wec|imsa)\/events\/.*\.json$/,
    reason: "проекция событий несёт те же url официальных PDF, что fia/" },
  { path: /^tracks\/index\.json$/,
    reason: "wikiURL/wikiTitle — лицензионный источник, кнопка-атрибуция в UI" },
  { path: /^f1\/history\/moments\.json$/,
    reason: "sourceUrl верификации фактов — вход сборки, уезжает в фазе C" },
  { path: /^refs\/matching\.json$/,
    reason: "пространства имён карты читают только продьюсеры; уезжает в фазе C" },
];

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (name.endsWith(".json")) yield p;
  }
}

/// Каталоги клиентской поверхности из databoundary (плейсхолдер <год> —
/// разворачивается по реальным каталогам).
function clientDirs(): string[] {
  const out: string[] = [];
  for (const f of DATA_FAMILIES) {
    if (f.zone !== "витрина" && f.zone !== "справочник") continue;
    if (!f.clientReads) continue;
    if (f.path.includes("<год>")) {
      const base = f.path.split("/")[0];
      if (!existsSync(join(DATA, base))) continue;
      for (const name of readdirSync(join(DATA, base))) {
        if (/^\d{4}$/.test(name)) out.push(`${base}/${name}`);
      }
    } else if (existsSync(join(DATA, f.path))) {
      out.push(f.path);
    }
  }
  return out;
}

test("витрина не выдаёт источники текстовыми маркерами", () => {
  const hits: string[] = [];
  const matchedAllowed = new Set<number>();
  for (const dir of clientDirs()) {
    for (const file of walk(join(DATA, dir))) {
      const rel = file.slice(DATA.length + 1);
      const body = readFileSync(file, "utf8");
      const m = MARKERS.exec(body);
      if (!m) continue;
      const allowed = ALLOWED.findIndex((a) => a.path.test(rel));
      if (allowed >= 0) {
        matchedAllowed.add(allowed);
      } else {
        hits.push(`${rel}: «${m[0]}»`);
      }
    }
  }
  assert.deepEqual(hits, [], "маркеры источников в клиентской витрине:\n" + hits.join("\n"));
  // Страховка от протухших исключений: каждое обязано срабатывать хоть раз.
  for (const [i, a] of ALLOWED.entries()) {
    assert.ok(matchedAllowed.has(i),
      `исключение «${a.path}» не сработало ни разу — ${a.reason}; сними его`);
  }
});
