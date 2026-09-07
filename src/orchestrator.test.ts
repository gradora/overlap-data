// Сторож паритета оркестратора с YAML: пока живы оба способа запуска (Actions
// в публичном репо, оркестратор на Railway), их проводка обязана совпадать —
// иначе derived-файлы двух каналов собираются из данных разной свежести, и
// расхождение никто не видит. Парсинг yml — текстовый, теми же паттернами, что
// src/workflows.test.ts (id-шаги, npm run, срез комментариев).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PRODUCERS } from "./lib/producers.js";
import { SNAPSHOT_CHAIN, SIMPLE_GROUPS } from "./orchestrator.js";

const WORKFLOWS_DIR = ".github/workflows";

/// Копия stripComments из workflows.test.ts, а не импорт: импорт test-файла
/// регистрировал бы его тесты в этом прогоне вторым экземпляром.
function stripComments(text: string): string {
  return text.replace(/(^|\s)#[^\n]*/g, "$1");
}

function workflowCode(name: string): string {
  return stripComments(readFileSync(join(WORKFLOWS_DIR, name), "utf8"));
}

const keyByScript = new Map(PRODUCERS.filter((p) => p.script).map((p) => [p.script!, p.key]));

// Каждый неручной ключ реестра обязан принадлежать ровно ОДНОМУ каналу
// свежести: snapshot-цепочке либо своей группе. Дубль — два канала спорят за
// одну отметку; пропуск — ключ никем не запускается, ровно инцидент f1teams.
// Resnap-группы (f1live, fia) каналами не считаются: они доснимают чужие
// ключи в уик-эндовом темпе и потому обязаны звать ТОЛЬКО то, что уже стоит
// в snapshot-цепочке.
test("оркестратор: группы покрывают все неручные ключи реестра ровно по разу", () => {
  const covered = [...SNAPSHOT_CHAIN];
  const chainScripts = new Set(
    SNAPSHOT_CHAIN.map((k) => PRODUCERS.find((p) => p.key === k)?.script).filter((s) => s),
  );
  for (const [name, group] of Object.entries(SIMPLE_GROUPS)) {
    for (const script of group.scripts) {
      const key = keyByScript.get(script);
      assert.ok(key, `группа ${name} зовёт «${script}», которого нет в реестре PRODUCERS`);
      if (group.resnap) {
        assert.ok(chainScripts.has(script),
          `resnap-группа ${name} зовёт «${script}» вне snapshot-цепочки — у ключа «${key}» нет часового канала`);
      } else {
        covered.push(key);
      }
    }
  }

  assert.equal(new Set(covered).size, covered.length,
    `ключ покрыт двумя каналами: ${covered.filter((k, i) => covered.indexOf(k) !== i).join(" ")}`);
  const nonManual = PRODUCERS.filter((p) => !p.manual).map((p) => p.key);
  assert.deepEqual([...covered].sort(), [...nonManual].sort());
});

// Порядок в snapshot.yml несёт смысл (проекции после семейств, f1overrides
// после зеркал, f1events последним) — цепочка оркестратора обязана совпадать
// с ним ДОСЛОВНО, включая порядок, а не только составом.
test("оркестратор: SNAPSHOT_CHAIN совпадает с последовательностью id-шагов snapshot.yml", () => {
  const code = workflowCode("snapshot.yml");
  const ids = [...code.matchAll(/^\s+id: (\w+)$/gm)].map((m) => m[1]);
  assert.deepEqual(SNAPSHOT_CHAIN, ids,
    "цепочка оркестратора разошлась со snapshot.yml — обнови SNAPSHOT_CHAIN (или yml) и перечитай комментарии о порядке");
});

// Простые группы зовут те же скрипты в том же порядке, что их yml. `npm ci`
// паттерн не ловит (нет «run»), закомментированные шаги срезаны.
test("оркестратор: группы f1live/fia/weclive/tracks зовут те же скрипты, что их yml", () => {
  for (const [name, group] of Object.entries(SIMPLE_GROUPS)) {
    const code = workflowCode(`${name}.yml`);
    const scripts = [...code.matchAll(/npm run ([\w-]+)/g)].map((m) => m[1]);
    assert.deepEqual(group.scripts, scripts,
      `группа ${name} разошлась с ${name}.yml по составу или порядку шагов`);
  }
});
