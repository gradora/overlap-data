// Сетевая гигиена Al Kamel (DATA-PLAN 0.4): ретраи fetchHTML/fetchJSON по
// классам отказов (fetch подменяем — образец fia.test.ts), прогонный мемо-кэш
// листингов и правила пересборки highlights в окне оседания (settleAction).

import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchHTML, fetchJSON } from "./lib/alkamel.js";
import { fillMissingFacts, settleAction } from "./lib/winnersbuild.js";

// Пауза и таймаут в тестах — миллисекунды: проверяем политику, а не часы.
const NET = { timeoutMs: 50, attempts: 3, pauseMs: 1 };

async function withFetch<T>(
  handler: (url: string, init: RequestInit) => Promise<Response>,
  body: () => Promise<T>,
): Promise<{ result: T; calls: number }> {
  const real = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async (url: any, init: any) => {
    calls++;
    return handler(String(url), init);
  }) as typeof fetch;
  try {
    return { result: await body(), calls };
  } finally {
    globalThis.fetch = real;
  }
}

// Сегменты в каждом тесте УНИКАЛЬНЫ: мемо-кэш fetchHTML живёт время процесса,
// и повторный путь отдал бы закэшированный ответ соседнего теста.

test("alkamel: 404 не ретраится (в дереве этого нет) и НЕ кэшируется", async () => {
  const first = await withFetch(
    async () => new Response("nope", { status: 404 }),
    () => fetchHTML(["nn_404", "round"], NET),
  );
  assert.equal(first.result, null);
  assert.equal(first.calls, 1);
  // Отказ не отравляет прогон: следующий вызов снова идёт в сеть.
  const second = await withFetch(
    async () => new Response("<a href=\"x/\">x/</a>"),
    () => fetchHTML(["nn_404", "round"], NET),
  );
  assert.equal(second.result, "<a href=\"x/\">x/</a>");
  assert.equal(second.calls, 1);
});

test("alkamel: 503 и 429 ретраятся, успех со второй-третьей попытки", async () => {
  const codes = [503, 429];
  const { result, calls } = await withFetch(
    async () => {
      const code = codes.shift();
      return code ? new Response("busy", { status: code }) : new Response("ok");
    },
    () => fetchHTML(["nn_retry"], NET),
  );
  assert.equal(result, "ok");
  assert.equal(calls, 3); // 503 → 429 → 200, ровно в пределах attempts
});

test("alkamel: сетевой отказ ретраится, после attempts — null", async () => {
  const { result, calls } = await withFetch(
    async () => { throw new TypeError("fetch failed"); },
    () => fetchHTML(["nn_net"], NET),
  );
  assert.equal(result, null);
  assert.equal(calls, 3);
});

test("alkamel: таймаут обрывает попытку и ретраится", async () => {
  const { result, calls } = await withFetch(
    (_url, init) =>
      new Promise((_resolve, reject) => {
        // Висящий ответ: обрывается нашим AbortController по timeoutMs.
        (init as any).signal.addEventListener("abort", () => reject(new Error("aborted")));
      }),
    () => fetchHTML(["nn_hang"], { ...NET, attempts: 2 }),
  );
  assert.equal(result, null);
  assert.equal(calls, 2);
});

test("alkamel: мемо-кэш — повторный fetchHTML того же пути не ходит в сеть", async () => {
  const { result, calls } = await withFetch(
    async () => new Response("<html>листинг</html>"),
    async () => {
      const a = await fetchHTML(["nn_memo", "round"], NET);
      const b = await fetchHTML(["nn_memo", "round"], NET); // из кэша
      const c = await fetchHTML(["nn_memo", "другой раунд"], NET); // другой путь — сеть
      return [a, b, c];
    },
  );
  assert.deepEqual(result, ["<html>листинг</html>", "<html>листинг</html>", "<html>листинг</html>"]);
  assert.equal(calls, 2);
});

test("alkamel: fetchJSON не кэшируется (файлы тяжёлые, нужны один раз) и режет BOM", async () => {
  const { result, calls } = await withFetch(
    async () => new Response("﻿{\"session\":{}}"),
    async () => [
      await fetchJSON(["nn_json", "03_Results_Race.JSON"], NET),
      await fetchJSON(["nn_json", "03_Results_Race.JSON"], NET),
    ],
  );
  assert.deepEqual(result, [{ session: {} }, { session: {} }]);
  assert.equal(calls, 2);
});

// ---- Правила пересборки highlights (две закачки вместо ежечасной) ----

test("settleAction: окно оседания — файл есть, перекачки нет", () => {
  // Главный кейс экономии: ~168 ежечасных перекачек за freeze-неделю → skip.
  assert.equal(settleAction(true, false, false, false), "skip");
  // Файла ещё нет (первый прогон после финиша) — качаем без пометки.
  assert.equal(settleAction(false, false, false, false), "fetch");
});

test("settleAction: граница freeze — одна запечатывающая перекачка, потом вечность", () => {
  // Файл окна не запечатан, граница пройдена → финальная перекачка.
  assert.equal(settleAction(true, false, true, false), "seal");
  // Поздний бэкфилл: файла нет, этап давно осел → сразу запечатываем.
  assert.equal(settleAction(false, false, true, false), "seal");
  // Запечатанный файл не трогаем никогда.
  assert.equal(settleAction(true, true, true, false), "skip");
  assert.equal(settleAction(true, true, false, false), "skip");
});

test("settleAction: форс перечитывает всегда, пометка — по окну", () => {
  assert.equal(settleAction(true, false, false, true), "fetch");
  assert.equal(settleAction(true, true, true, true), "seal");
});

test("fillMissingFacts: дыры свежего разбора закрываются файлом, свежее — в приоритете", () => {
  const fresh: { a?: number; b?: number; c?: number } = { a: 1 };
  fillMissingFacts(fresh, { a: 9, b: 2 }, ["a", "b", "c"]);
  // a — свежий разбор, b — из файла, c — не было нигде.
  assert.deepEqual(fresh, { a: 1, b: 2 });
  // Файла нет (первый разбор) — no-op.
  const solo: { a?: number } = { a: 1 };
  fillMissingFacts(solo, null, ["a"]);
  assert.deepEqual(solo, { a: 1 });
});
