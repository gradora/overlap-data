// Граница «кухня / витрина» (lib/databoundary.ts) — подготовка репо-сплита.
//
// Главный тест здесь — СТОРОЖ ОХВАТА: каждый каталог в `data/` обязан иметь
// зону. Новое семейство появится и без него, но тогда решение «сырьё это или
// контракт» будет принято молчанием, а перед публикацией именно это решение
// стоит дороже всего.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";

/// Точечные имена в обходе не участвуют: Finder кладёт .DS_Store в любой
/// открытый каталог, и сторож охвата краснел бы «новое семейство без зоны» —
/// шум ровно на том тесте, который единственный ловит возврат кухни.
const visible = (dir: string) => readdirSync(dir).filter((n) => !n.startsWith("."));
import { join } from "node:path";
import {
  DATA_FAMILIES, DATA_FILES, classify, matchesFamily, readyToMove, splitBlockers,
} from "./lib/databoundary.js";

const DATA_DIR = join(process.cwd(), "data");

/// Пути семейств: каталоги второго уровня (f1/openf1) и первого (refs), плюс
/// файлы верхнего уровня. Глубже не спускаемся — зона у семейства, а не у
/// каждого файла.
function actualPaths(): string[] {
  const out: string[] = [];
  for (const top of visible(DATA_DIR)) {
    const topPath = join(DATA_DIR, top);
    if (!statSync(topPath).isDirectory()) { out.push(top); continue; }
    const inner = visible(topPath);
    const dirs = inner.filter((n) => statSync(join(topPath, n)).isDirectory());
    if (!dirs.length) { out.push(top); continue; }
    for (const n of inner) out.push(`${top}/${n}`);
  }
  return out;
}

test("СТОРОЖ ОХВАТА: у каждого пути в data/ есть зона", () => {
  const missing = actualPaths().filter((p) => classify(p) == null);
  assert.deepEqual(missing, [],
    "новое семейство без зоны: реши осознанно, сырьё это или публичный контракт, " +
    "и добавь запись в src/lib/databoundary.ts — перед репо-сплитом молчаливое " +
    "решение стоит дороже всего");
});

test("обратная сторона: описанное семейство существует на диске", () => {
  // Иначе таблица тихо протухает: путь переименовали, запись осталась, и
  // сторож охвата зелёный при неверной карте.
  const actual = actualPaths();
  const orphan = DATA_FAMILIES
    .filter((f) => !actual.some((p) => matchesFamily(p, f.path)))
    .map((f) => f.path);
  assert.deepEqual(orphan, [], "запись есть, каталога нет — карта разошлась с диском");
});

test("плейсхолдер года совпадает только с годом", () => {
  assert.ok(matchesFamily("wec/2026", "wec/<год>"));
  assert.ok(matchesFamily("imsa/2027", "imsa/<год>"));
  assert.equal(matchesFamily("wec/fiawec", "wec/<год>"), false);
  assert.equal(matchesFamily("wec/26", "wec/<год>"), false);
  assert.equal(matchesFamily("wec/2026/x", "wec/<год>"), false, "глубина обязана совпадать");
});

/// То, ради чего таблица заведена: список того, что мешает унести сырьё.
/// Он обязан быть коротким и осознанным — если сюда попадёт новая кухня,
/// которую читает клиент, сплит отодвинется, и это должно быть видно.
test("блокеры сплита названы поимённо", () => {
  const blockers = splitBlockers().map((f) => f.path).sort();
  assert.deepEqual(blockers, ["f1/jolpica", "f1/openf1"],
    "изменился список кухни, которую читает приложение — это прямо двигает срок " +
    "репо-сплита, и менять его можно только осознанно");
  for (const f of splitBlockers()) {
    assert.ok(f.note && f.note.length > 20,
              `${f.path}: блокер сплита обязан объяснять, чем он держится`);
  }
});

test("зоны не пересекаются и заданы у всех записей", () => {
  const zones = new Set(["кухня", "заготовка", "витрина", "справочник"]);
  for (const f of [...DATA_FAMILIES, ...DATA_FILES]) {
    assert.ok(zones.has(f.zone), `${f.path}: неизвестная зона «${f.zone}»`);
  }
  const paths = [...DATA_FAMILIES, ...DATA_FILES].map((f) => f.path);
  assert.equal(paths.length, new Set(paths).size, "путь описан дважды");
});

/// Кухня, которую не читает НИКТО — ни приложение, ни сборка. Снимок статики
/// FOM таким был и переехал 31.08.2026; на сегодня таких путей не осталось.
/// Тест не требует, чтобы список был непустым: он фиксирует ФАКТ, и любое
/// его изменение должно быть осознанным.
test("готовность кухни к переезду названа поимённо", () => {
  assert.deepEqual(readyToMove().map((f) => f.path).sort(), [],
    "появилась (или исчезла) кухня без читателей — это прямо двигает план сплита");
  // А то, что держится сборкой, обязано объяснять чем.
  for (const f of DATA_FAMILIES.filter((x) => x.zone === "кухня" && x.producerReads)) {
    assert.ok(f.note && f.note.length > 20,
              `${f.path}: держится сборкой — запись обязана называть продьюсеров`);
  }
});

/// СТОРОЖ ГРАНИЦЫ ФАКТА. До 31.08.2026 в data/ лежали 154 сохранённые страницы
/// fiawec — 24 МБ чужого выражения в открытом репозитории. Их там больше нет, и
/// вернуться они могут ровно одним способом: кто-то откатит правку продьюсера
/// или напишет нового, который снова сохранит страницу целиком.
///
/// Этот сторож ловит КЛАСС, а не случай: любой файл в data/, который выглядит
/// как разметка, роняет тесты. Он дешёвый (обход всех файлов) и точный —
/// сегодня совпадений ноль.
test("СТОРОЖ ГРАНИЦЫ: в data/ нет разметки", () => {
  const offenders: string[] = [];
  const walk = (dir: string, rel: string) => {
    for (const name of readdirSync(dir).filter((n) => !n.startsWith("."))) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) { walk(full, `${rel}${name}/`); continue; }
      const head = readFileSync(full, "utf8").slice(0, 400).trimStart();
      if (head.startsWith("<") || /<(!doctype|html|script|table)\b/i.test(head)) {
        offenders.push(`${rel}${name}`);
      }
    }
  };
  walk("data", "");
  assert.deepEqual(offenders, [],
    "в data/ появилась разметка: сохранять страницы источника целиком — " +
    "редистрибуция чужого выражения, из-за которой и заводился слой фактов");
});
