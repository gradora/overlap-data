// Сторож паритета оркестратора с YAML: пока живы оба способа запуска (Actions
// в публичном репо, оркестратор на Railway), их проводка обязана совпадать —
// иначе derived-файлы двух каналов собираются из данных разной свежести, и
// расхождение никто не видит. Парсинг yml — текстовый, теми же паттернами, что
// src/workflows.test.ts (id-шаги, npm run, срез комментариев).

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { PRODUCERS } from "./lib/producers.js";
import {
  NEXTSEASON_SCRIPTS, SNAPSHOT_CHAIN, SIMPLE_GROUPS,
  notifyFailure, pushServe, stepExtraEnv, type FailureReport,
} from "./orchestrator.js";

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

// Климатология прогноза — паритет каналов: в YAML env-флаг FORECAST_TYPICAL
// зажигает суточное расписание, в оркестраторе — имя группы snapshot-daily.
// Разъезд молчалив в обе стороны: без флага typical-файлы канала перестают
// пересобираться, с флагом на часовом прогоне — 5 archive-запросов на каждое
// дальнее событие каждый час.
test("оркестратор: суточная группа включает климатологию прогноза, часовая — нет", () => {
  assert.deepEqual(stepExtraEnv("forecast", true), { FORECAST_TYPICAL: "1" });
  assert.deepEqual(stepExtraEnv("forecast", false), {});
  assert.deepEqual(stepExtraEnv("f1", true), {}, "флаг адресован только шагу forecast");
  // Вторая сторона паритета — сам yml (детали держит workflows.test.ts).
  const code = workflowCode("snapshot.yml");
  const step = (code.split(/^\s+id: forecast$/m)[1] ?? "").split(/^\s+- name: /m)[0];
  assert.match(step, /FORECAST_TYPICAL/, "в snapshot.yml у шага forecast нет флага климатологии");
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

// ---------------------------------------------------------------------------
// Сторожа «жизни после сплита»: тесты выше сверяют оркестратор с yml и умрут
// вместе с .github/workflows штатно (паритет существует, «пока живы оба
// способа запуска»). Тесты ниже yml не читают — они и есть то покрытие,
// которое остаётся, когда workflows.test.ts удалится (railway.md §6).
// ---------------------------------------------------------------------------

// Замыкание цепочки «файл продьюсера → npm-скрипт → реестр» без yml. Вместе с
// тестом «группы покрывают все неручные ключи реестра ровно по разу» это даёт
// сквозной инвариант класса f1teams: написанный продьюсер не может остаться
// вне канала свежести молча. Обратное направление (скрипт реестра есть в
// package.json) держит freshness.test.ts.
test("оркестратор: каждый продьюсер доходит до реестра без участия yml", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  const scripts = new Set(Object.keys(pkg.scripts ?? {}));
  // Не продьюсеры: проверки кода и heartbeat (health зовётся оркестратором
  // напрямую в runSnapshot, записи в реестре у него нет по построению).
  const notProducers = new Set(["test", "typecheck", "health"]);

  for (const file of readdirSync("src/producers").filter((f) => f.endsWith(".ts"))) {
    const name = file.replace(/\.ts$/, "");
    assert.ok(scripts.has(name), `src/producers/${file} без npm-скрипта «${name}»`);
  }

  const registryScripts = new Set(PRODUCERS.filter((p) => p.script).map((p) => p.script!));
  for (const script of scripts) {
    if (notProducers.has(script)) continue;
    assert.ok(registryScripts.has(script),
      `скрипт «${script}» есть в package.json, но не в реестре PRODUCERS — ` +
      "он вне каналов свежести и групп оркестратора, класс инцидента f1teams");
  }
});

// yml-половина этого сторожа («Сезон N+1 зовёт все зеркала») живёт в
// workflows.test.ts и умрёт со snapshot.yml — эта половина остаётся: «убрали
// зеркало на время» ломает календарь следующего года молча.
test("оркестратор: шаг «Сезон N+1» зовёт все четыре зеркала витрины", () => {
  assert.deepEqual(NEXTSEASON_SCRIPTS, ["f1", "openf1", "wec", "imsa"]);
});

// ---------------------------------------------------------------------------
// serve-шаг: юнит-репетиция БЕЗ СЕТИ — bare-репо по file:// в темпе играет
// роль публичного serve-репо. Витрина берётся из настоящего data/ через
// настоящую exportserve-механику: репетируется ровно боевой путь.
// ---------------------------------------------------------------------------

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

test("serve-шаг: экспорт в bare file://-репо, «data update», README жив, кухни нет", () => {
  const tmp = mkdtempSync(join(tmpdir(), "serve-rehearsal-"));
  try {
    const bare = join(tmp, "serve.git");
    execFileSync("git", ["init", "--quiet", "--bare", "--initial-branch=main", bare]);
    // README подкладывается заранее, как в настоящем serve-репо: экспорт
    // обязан его пережить (--write-семантика хранит .git и README.md).
    const seed = join(tmp, "seed");
    execFileSync("git", ["clone", "--quiet", bare, seed], { stdio: "ignore" });
    writeFileSync(join(seed, "README.md"), "витрина\n");
    // LICENSE — та же судьба: атрибуции (Open-Meteo CC-BY) владелец добавит
    // в serve первым делом, и крон не имеет права снести их «data update»-ом.
    writeFileSync(join(seed, "LICENSE"), "attributions\n");
    git(seed, "add", "README.md", "LICENSE");
    git(seed, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init");
    git(seed, "push", "-q", "origin", "HEAD");

    assert.equal(pushServe(`file://${bare}`), true, "serve-пуш не удался");

    assert.deepEqual(git(bare, "log", "--format=%s").split("\n"), ["data update", "init"],
      "в bare нет ровно одного нового коммита «data update»");
    const tree = git(bare, "ls-tree", "-r", "--name-only", "HEAD").split("\n");
    assert.ok(tree.includes("README.md"), "README.md serve-репо затёрт экспортом");
    assert.ok(tree.includes("LICENSE"), "LICENSE serve-репо затёрт экспортом");
    assert.ok(tree.includes("refs/brands.json"), "витрина не доехала до serve");
    // Кухня: те же маркеры, что в exportserve.test.ts, но на РЕАЛЬНО
    // записанном дереве — сторож самого шага, а не только манифеста.
    assert.ok(!tree.includes("health.json"), "health.json уехал в serve");
    assert.ok(!tree.includes("refs/matching.json"), "refs/matching.json уехал в serve");
    assert.deepEqual(tree.filter((p) => /(^|\/)_[^/]*$/.test(p)), [], "служебные _* уехали в serve");

    // Идемпотентность: без новых данных — тихий успех и НОЛЬ новых коммитов
    // (публичная история не должна пухнуть пустыми «data update»).
    assert.equal(pushServe(`file://${bare}`), true);
    assert.deepEqual(git(bare, "log", "--format=%s").split("\n"), ["data update", "init"]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Нотификатор: провал доезжает POST-ом, осечка вебхука не создаёт второй
// провал — функция возвращает false и не бросает.
// ---------------------------------------------------------------------------

const REPORT: FailureReport = {
  group: "snapshot",
  failed: ["f1"],
  stale: ["f1teams: молчит 3 сут при бюджете 2"],
  serve: true,
  commit: true,
  health: true,
  at: "2026-09-09T00:00:00.000Z",
};

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`);
  }));
}

test("нотификатор: провал прогона приходит POST-ом с ожидаемым телом", async () => {
  const bodies: string[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      bodies.push(body);
      res.writeHead(200).end();
    });
  });
  const url = await listen(server);
  try {
    assert.equal(await notifyFailure(url, REPORT), true);
    assert.equal(bodies.length, 1);
    assert.deepEqual(JSON.parse(bodies[0]!), REPORT);
  } finally {
    server.close();
  }
  // Порт закрыт — недоставка возвращает false, но не бросает: алерт не имеет
  // права ронять прогон, о котором алертит.
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(await notifyFailure(url, REPORT), false);
});

test("нотификатор: молчащий вебхук отрезается таймаутом и не вешает прогон", async () => {
  // Сервер принимает соединение и никогда не отвечает — таймаут fetch
  // единственный выход, и он обязан дать false, а не исключение.
  const server = createServer(() => { /* намеренно без ответа */ });
  const url = await listen(server);
  try {
    assert.equal(await notifyFailure(url, REPORT, 200), false);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
