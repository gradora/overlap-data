// Экспорт витрины в serve-репо (exportserve.ts) — фаза C репо-сплита.
//
// Проверяется ГРАНИЦА, а не механика копирования: состав манифеста обязан
// (а) быть живым — семейства реестра реально развёрнуты по диску, и
// (б) не выносить наружу ничего кухонного. Ошибка здесь — не баг, а
// публикация: снятый с serve файл из истории публичного репо не удалить.

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildManifest } from "./exportserve.js";
import { classify } from "./lib/databoundary.js";

const manifest = buildManifest();
const files = manifest.flatMap((e) => e.files.map((f) => f.path));
const bytes = manifest.flatMap((e) => e.files).reduce((s, f) => s + f.bytes, 0);

test("dry-run отдаёт непустой состав", () => {
  assert.ok(manifest.length > 0, "манифест пуст — реестр не дал ни одного семейства");
  assert.ok(files.length > 0 && bytes > 0, "в манифесте нет файлов");
  // Плейсхолдер <год> развёрнут по диску, а не захардкожен: у каждой серии
  // в составе есть хотя бы один годовой каталог.
  for (const series of ["f1", "wec", "imsa"]) {
    assert.ok(files.some((p) => new RegExp(`^${series}/\\d{4}/`).test(p)),
      `${series}/<год> не развернулся ни в один каталог`);
  }
  // Справочники едут вместе с витриной.
  assert.ok(files.includes("refs/brands.json"), "refs не попал в состав");
});

/// Производный от реестра сторож: каждый префикс каждого пути манифеста
/// прогоняется через classify — кухня и заготовка не перечислены поимённо,
/// поэтому новое кухонное семейство проверяется само, без правки теста.
test("в составе нет путей зон кухня/заготовка", () => {
  for (const p of files) {
    const seg = p.split("/");
    for (let n = 1; n <= seg.length; n++) {
      const hit = classify(seg.slice(0, n).join("/"));
      if (!hit) continue;
      assert.ok(hit.zone !== "кухня" && hit.zone !== "заготовка",
        `${p}: путь из зоны «${hit.zone}» уехал бы в публичный serve`);
    }
  }
  // Витрина с clientReads=false тоже не едет: клиент получает состав через
  // блок entry файла события, прямых GET к f1/entrylist у него нет.
  assert.ok(files.every((p) => !p.startsWith("f1/entrylist/")),
    "f1/entrylist (clientReads=false) попал в состав");
});

test("health.json и refs/matching.json не попадают", () => {
  // health.json — ловушка союза DATA_FAMILIES∪DATA_FILES: в реестре он
  // «витрина, clientReads», но это ops-телеметрия с именами продьюсеров,
  // меняющаяся каждым прогоном, — наружу ей нельзя.
  assert.ok(!files.includes("health.json"), "health.json попал в состав");
  // Вход сборки внутри экспортируемого справочника: пространства имён карты
  // называют источники, читают её только продьюсеры.
  assert.ok(!files.includes("refs/matching.json"), "refs/matching.json попал в состав");
  // Служебная конвенция `_*` (маркеры свежести, _state_<год>, манифест
  // экстракции f1/openf1/_extractor — БЕЗ расширения) — кухня, где бы файл
  // ни лежал: манифест с картой дыр не должен уехать в serve при флипе зоны.
  assert.deepEqual(files.filter((p) => /(^|\/)_[^/]*$/.test(p)), [],
    "служебные _* попали в состав");
  assert.ok(!files.includes("f1/history/moments.json"),
    "вход сборки f1history попал в состав");
});
