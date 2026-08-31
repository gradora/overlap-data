// Проводка продьюсеров: код есть → npm-скрипт есть → воркфлоу зовёт его ПО
// КРОНУ → падение видно в алерт-гейте и health. Рвётся эта цепочка молча,
// поэтому на каждое звено здесь свой тест:
//  1. шаг в snapshot.yml обязан быть в алерт-гейте и health-env (кейс records:
//     продьюсер без записи в гейте может падать вечно молча);
//  2. каждый npm-скрипт-продьюсер обязан запускаться воркфлоу С РАСПИСАНИЕМ
//     (кейс f1teams, см. ниже);
//  3. у каждого файла в src/producers обязан быть npm-скрипт.
// Все три парсят YAML и package.json текстово — без зависимостей.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PRODUCERS } from "./lib/producers.js";

const WORKFLOWS_DIR = ".github/workflows";
const PRODUCERS_DIR = "src/producers";

/// Скрипты package.json, которые НЕ продьюсеры: проверки кода, а не сбор
/// данных. Им место в ci.yml, но требовать `npm run <имя>` от них нельзя —
/// тесты запускаются как `npm test`, без `run`.
const NOT_PRODUCERS = new Set(["test", "typecheck"]);

/// Продьюсеры, которые ОСОЗНАННО запускаются только руками. Сейчас пуст —
/// все до одного стоят в кроне. Добавляя сюда имя, оставь рядом причину:
/// «ручной» без объяснения — это ровно тот случай, из-за которого f1teams
/// простоял вне крона 17 дней и уронил экран команды.
/// Ручные продьюсеры берутся ИЗ РЕЕСТРА (ProducerSpec.manual), а не из второго
/// списка здесь: два источника правды про одно и то же разъезжались бы молча —
/// продьюсер, убранный из крона, оставался бы «ручным» только в одном месте.
const MANUAL_ONLY = new Map<string, string>(
  PRODUCERS.filter((p) => p.manual && p.script).map((p) => [p.script!, p.manual!]),
);

interface Workflow { name: string; text: string }

function allWorkflows(): Workflow[] {
  return readdirSync(WORKFLOWS_DIR)
    .filter((f) => /\.ya?ml$/.test(f))
    .map((f) => ({ name: f, text: readFileSync(join(WORKFLOWS_DIR, f), "utf8") }));
}

/// YAML без комментариев. `#` открывает комментарий, только если стоит в начале
/// строки или после пробела, — `image: alpine#3.20` комментарием не является.
/// Тот же приём и по той же причине уже стоит в стороже freeze.test.ts: сторож,
/// читающий сырой текст, верит закомментированному коду. Здесь это ровно способ
/// повторить инцидент: шаг убирают «на время», строку `npm run f1teams`
/// оставляют в комментарии — и продьюсер снова вне крона при зелёных тестах.
/// Оговорка: `#` внутри кавычек тоже съедаем. В воркфлоу таких строк нет, а
/// цена ошибки несимметрична — лишнее «не проведён» чинится за минуту,
/// пропущенный крон стоил экрану семнадцати дней.
export function stripComments(text: string): string {
  return text.replace(/(^|\s)#[^\n]*/g, "$1");
}

/// Есть ли у воркфлоу расписание. `schedule:` живёт ТОЛЬКО под `on:` (в jobs
/// такого ключа нет), а строка расписания — всегда `- cron: "…"`, поэтому
/// текстовой пары ключей достаточно и YAML-парсер не нужен. Закомментированное
/// расписание расписанием не считается.
export function hasSchedule(text: string): boolean {
  const code = stripComments(text);
  return /^\s+schedule:\s*$/m.test(code) && /^\s*-\s*cron:\s*\S/m.test(code);
}

/// Продьюсеры, которых воркфлоу зовёт ПО РАСПИСАНИЮ. Ловит и `run: npm run f1`,
/// и `SEASON=$NEXT npm run wec` из шага «Сезон N+1».
///
/// Считать по всем воркфлоу без разбора триггера нельзя: воркфлоу с одним
/// workflow_dispatch удовлетворил бы сторожа, оставив продьюсера вне крона —
/// то есть ровно исходный инцидент прошёл бы мимо. Кнопка «запустить» не
/// заменяет расписания: данные обновляет крон, а не человек.
export function scheduledScripts(workflows: Workflow[]): Set<string> {
  const wired = new Set<string>();
  for (const w of workflows) {
    // По КОДУ, а не по тексту: `npm run` в комментарии шага не запускает.
    const code = stripComments(w.text);
    if (!hasSchedule(code)) continue;
    for (const m of code.matchAll(/npm run ([\w-]+)/g)) wired.add(m[1]);
  }
  return wired;
}

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

// Инцидент 2026-08: f1teams был написан, обзавёлся npm-скриптом и данными —
// но его забыли вписать в единственное место, где продьюсеры реально
// запускаются. Тестов на это не было: гейт выше проверяет только шаги, УЖЕ
// стоящие в snapshot.yml, а продьюсера, которого там нет, он не видит по
// построению. Экран команды простоял 17 дней на данных R11.
test("каждый npm-скрипт-продьюсер запускается воркфлоу с расписанием", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  const wired = scheduledScripts(allWorkflows());

  for (const script of Object.keys(pkg.scripts ?? {})) {
    if (NOT_PRODUCERS.has(script)) continue;
    const manual = MANUAL_ONLY.get(script);
    if (manual) {
      assert.ok(
        !wired.has(script),
        `«${script}» помечен ручным («${manual}»), но стоит в кроне — убери из MANUAL_ONLY`,
      );
      continue;
    }
    assert.ok(
      wired.has(script),
      `продьюсер «${script}» есть в package.json, но ни один воркфлоу С РАСПИСАНИЕМ его не зовёт: ` +
      `добавь шаг в ${WORKFLOWS_DIR}/snapshot.yml (плюс алерт-гейт и health-env) ` +
      `или внеси в MANUAL_ONLY с причиной. Воркфлоу с одним workflow_dispatch не считается — ` +
      `кнопку никто не нажмёт, а данные протухнут молча`,
    );
  }
});

test("сторож крона: воркфлоу по кнопке продьюсера не проводит", () => {
  const step = `      - name: Экран команды\n        run: npm run f1teams\n`;
  const dispatch = `name: manual\non:\n  workflow_dispatch: {}\njobs:\n  build:\n    steps:\n${step}`;
  const cron = `name: snapshot\non:\n  schedule:\n    - cron: "17 * * * *"\n  workflow_dispatch: {}\njobs:\n  build:\n    steps:\n${step}`;

  assert.equal(hasSchedule(dispatch), false);
  assert.equal(hasSchedule(cron), true);
  // Ровно исходный инцидент: продьюсер в файле есть, крона нет — не проведён.
  assert.equal(scheduledScripts([{ name: "manual.yml", text: dispatch }]).has("f1teams"), false);
  assert.equal(scheduledScripts([{ name: "snapshot.yml", text: cron }]).has("f1teams"), true);
  // Шаг «Сезон N+1» зовёт продьюсера через переменную окружения в той же строке.
  const inline = cron.replace("run: npm run f1teams", "run: SEASON=$NEXT npm run f1teams");
  assert.equal(scheduledScripts([{ name: "snapshot.yml", text: inline }]).has("f1teams"), true);
});

/// Витрина календаря сезона N+1 собирается из ДВУХ зеркал: расписание берётся
/// у jolpica, а тесты и отмены существуют ТОЛЬКО в листинге митингов OpenF1.
/// Шаг «Сезон N+1» звал три продьюсера из четырёх, и следующий год приезжал в
/// приложение без предсезонных тестов — молча, без единой строки в логе.
test("сторож крона: шаг «Сезон N+1» зовёт все зеркала витрины следующего года", () => {
  const code = stripComments(readFileSync(join(WORKFLOWS_DIR, "snapshot.yml"), "utf8"));
  const step = code.split(/^\s+- name: Сезон N\+1/m)[1] ?? "";
  assert.notEqual(step, "", "шаг «Сезон N+1» пропал из snapshot.yml");
  const block = step.split(/^\s+- name: /m)[0];
  for (const producer of ["f1", "openf1", "wec", "imsa"]) {
    assert.match(block, new RegExp(`SEASON=\\$NEXT npm run ${producer}\\b`),
      `сезон N+1 собирается без ${producer}`);
  }
});

// Самый вероятный способ повторить инцидент — не забыть шаг, а убрать его «на
// время»: закомментировать, оставив рядом строку «раньше здесь было». По сырому
// тексту сторож такой шаг считал проведённым и оставался зелёным.
test("сторож крона: npm run в комментарии проводкой не считается", () => {
  const head = `name: snapshot\non:\n  schedule:\n    - cron: "17 * * * *"\njobs:\n  build:\n    steps:\n`;
  const commented = head
    + `      # временно выключено, раньше здесь было:\n`
    + `      # - name: Экран команды\n      #   run: npm run f1teams\n`
    + `      - name: Зеркало F1\n        run: npm run f1\n`;
  const wired = scheduledScripts([{ name: "snapshot.yml", text: commented }]);
  assert.equal(wired.has("f1teams"), false, "закомментированный шаг продьюсера не проводит");
  assert.equal(wired.has("f1"), true, "живой шаг рядом остаётся проведённым");

  // Закомментированное расписание — тоже не расписание.
  const noCron = `name: manual\non:\n  # schedule:\n  #   - cron: "17 * * * *"\n  workflow_dispatch: {}\n`
    + `jobs:\n  build:\n    steps:\n      - run: npm run f1teams\n`;
  assert.equal(hasSchedule(noCron), false);
  assert.equal(scheduledScripts([{ name: "manual.yml", text: noCron }]).has("f1teams"), false);

  // Решётка не после пробела — часть значения, а не комментарий.
  assert.equal(
    scheduledScripts([{ name: "s.yml", text: head + `      - run: npm run f1teams#job\n` }]).has("f1teams"),
    true,
  );
});

// Обратная сторона той же дыры: продьюсер написан, но без npm-скрипта его
// не за что зацепить ни воркфлоу, ни тесту выше.
test("у каждого продьюсера в src/producers есть npm-скрипт", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  const scripts = new Set(Object.keys(pkg.scripts ?? {}));
  const files = readdirSync(PRODUCERS_DIR).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
  for (const file of files) {
    const name = file.replace(/\.ts$/, "");
    assert.ok(scripts.has(name), `${PRODUCERS_DIR}/${file} без npm-скрипта «${name}»`);
  }
});

/// Обратная проверка к «у каждого продьюсера есть скрипт»: ШАГ, зовущий
/// несуществующий скрипт, падает КАЖДЫЙ прогон и молча — в логе крона это
/// одна строка среди сотни. Опечатка в имени переживала бы недели.
test("каждый npm run в воркфлоу зовёт существующий скрипт", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  const scripts = new Set(Object.keys(pkg.scripts ?? {}));
  for (const wf of allWorkflows()) {
    const code = stripComments(wf.text);
    for (const m of code.matchAll(/npm run ([\w:-]+)/g)) {
      assert.ok(scripts.has(m[1]),
                `${wf.name}: шаг зовёт «npm run ${m[1]}», но такого скрипта в package.json нет`);
    }
  }
});

/// Число продьюсеров в README дрейфует молча: было «20» при 25 шагах, и
/// f1live.yml в таблице не появился вовсе. Таблица — то, по чему разбирают
/// «кто и когда бежит», и врущая таблица уводит ровно там, где нужна точность.
test("README называет верное число продьюсеров и все воркфлоу", () => {
  const readme = readFileSync("README.md", "utf8");
  const inSnapshot = PRODUCERS.filter((p) => p.workflow?.includes("snapshot.yml")).length;
  assert.match(readme, new RegExp(`\\| ${inSnapshot} продьюсеров \\+ health \\|`),
    `в snapshot.yml ${inSnapshot} продьюсеров — README называет другое число`);

  for (const f of readdirSync(WORKFLOWS_DIR)) {
    assert.ok(readme.includes(`\`${f}\``), `${f} не описан в таблице воркфлоу README`);
  }
});
