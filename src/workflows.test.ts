// Гейт «Проверка продьюсеров» в snapshot.yml обязан покрывать ВСЕ шаги
// с continue-on-error (кейс records: продьюсер без записи в гейте может
// падать вечно молча). Тест парсит YAML текстово — без зависимостей.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("snapshot.yml: каждый continue-on-error шаг есть в алерт-гейте и в health-env", () => {
  const yml = readFileSync(".github/workflows/snapshot.yml", "utf8");
  const ids = [...yml.matchAll(/^\s+id: (\w+)$/gm)].map((m) => m[1]);
  const gated = new Set([...yml.matchAll(/"(\w+)=\$\{\{ steps\.\w+\.outcome \}\}"/g)].map((m) => m[1]));
  const healthEnv = new Set([...yml.matchAll(/(\w+)_OUTCOME: \$\{\{ steps\.(\w+)\.outcome \}\}/g)].map((m) => m[2]));
  for (const id of ids) {
    assert.ok(gated.has(id), `шаг «${id}» отсутствует в алерт-гейте snapshot.yml`);
    assert.ok(healthEnv.has(id), `шаг «${id}» отсутствует в env шага health`);
  }
  assert.ok(ids.length >= 17, `ожидалось ≥17 продьюсеров, найдено ${ids.length}`);
});
