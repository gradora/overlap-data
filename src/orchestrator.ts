// CLI-оркестратор групп продьюсеров — замена шести GitHub-воркфлоу для фазы C
// (приватный репо без Actions, кроны на Railway). Запуск из корня репо:
//
//   tsx src/orchestrator.ts <группа> [--run | --push]
//
// Группы: snapshot, snapshot-daily, f1live, fia, weclive, tracks. Каждая
// повторяет семантику СВОЕГО yml один в один: порядок шагов, continue-on-error,
// `if: always()` у health/коммита/гейтов, env `<KEY>_OUTCOME` для health.ts.
// snapshot-daily — тот же snapshot, но с шагом «Сезон N+1» (в YAML это одно
// расписание `37 3 * * *` внутри одного воркфлоу; Railway-кроны различать
// расписания внутри джоба не умеют, поэтому различие вынесено в имя группы).
//
// Три ступени, от безобидной к боевой:
//  - без флагов — только план: НИ ОДНОГО спавна, ни сети, ни записи на диск.
//    Дефолт обязан быть безопасным: «посмотреть, что сделает крон» не должно
//    само ходить в fia.com и переписывать трекнутые файлы в data/;
//  - --run — продьюсеры и гейты бегут по-настоящему (данные на диске
//    обновляются, как и в CI), но git не трогается — репетиция до появления
//    Railway-аккаунта, ловит расхождения с YAML заранее;
//  - --push — то же плюс git add/commit/push, боевой режим крона.
//
// Что здесь ОСОЗНАННО не живёт (придёт со связкой Railway, см. DATA-PLAN):
//  - межгрупповой lock — замена concurrency-групп GitHub («snapshot+f1live+
//    tracks сериализуются, fia и weclive бегут независимо, лишний pending
//    дропается»); локально и в одиночном кроне он не нужен, а городить flock
//    без общего volume — гадание;
//  - алертинг: в CI гейт валил job и GitHub слал письмо, на Railway падение
//    крона само по себе письма не шлёт — нотификатор будет отдельным шагом.
//    Гейты здесь честно выходят ненулём, канал доставки — забота обёртки;
//  - push в отдельный serve-репо по deploy key с нейтральным «data update» —
//    пока push идёт туда же, откуда чекаут, с теми же префиксами, что в YAML.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { byKey, envKeyFor } from "./lib/producers.js";

/// Порядок snapshot-цепочки — ДОСЛОВНО последовательность `id:`-шагов
/// snapshot.yml. Порядок несёт смысл, а не историю: проекции (wecevents,
/// imsaevents, f1events) стоят строго после своих семейств, f1teams — после
/// f1 и openf1, f1overrides — после зеркал (GC до витрины), f1weather и
/// f1entrylist — после обоих зеркал, f1events — последним из содержательных.
/// Расхождение со snapshot.yml ловит src/orchestrator.test.ts: пока живы оба
/// способа запуска, порядок обязан быть одним — иначе derived-файлы двух
/// каналов собирались бы из данных разной свежести.
export const SNAPSHOT_CHAIN: string[] = [
  "imsa",
  "f1",
  "openf1",
  "wec",
  "wecfia",
  "wechighlights",
  "wecwinners",
  "wecevents",
  "imsafia",
  "imsahighlights",
  "imsawinners",
  "imsaevents",
  "fia",
  "winners",
  "highlights",
  "milestones",
  "f1history",
  "beasts",
  "records",
  "f1teams",
  "nextseason",
  "f1overrides",
  "f1weather",
  "f1entrylist",
  "f1events",
];

/// Группа-одноимённый-воркфлоу без health и гейтов: линейные шаги БЕЗ
/// continue-on-error (первый упавший останавливает остальные, как в YAML),
/// затем коммит `if: always()`.
export interface SimpleGroup {
  /// npm-скрипты в порядке запуска — ровно шаги своего yml.
  scripts: string[];
  /// Аргумент git add — дословно `paths:` шага коммита своего yml.
  commitPaths: string;
  messagePrefix: string;
  /// Группа ДОСНИМАЕТ ключи, принадлежащие snapshot-каналу (уик-эндовый темп
  /// поверх часового), — своих ключей реестра у неё нет, и за свежесть этих
  /// продьюсеров отвечает snapshot. Тест «каждый неручной ключ покрыт ровно
  /// одним каналом» такие группы пропускает.
  resnap?: boolean;
}

export const SIMPLE_GROUPS: Record<string, SimpleGroup> = {
  // Уик-эндовое доснятие F1: сетевой openf1, затем бессетевые деривации в том
  // же прогоне (резервист пятницы обязан связаться сразу, f1events забирает и
  // хайлайты этого прогона, и штрафы, доснятые группой fia).
  f1live: {
    scripts: ["openf1", "f1highlights", "f1entrylist", "f1events"],
    // Не `data/f1` целиком: data/f1/fia принадлежит группе fia, захват чужого
    // файла — гонка за него. racecontrol в списке есть, хотя шага под него
    // нет, — его пишет openf1.
    commitPaths: "data/f1/openf1 data/f1/highlights data/f1/entrylist data/f1/events data/f1/racecontrol",
    messagePrefix: "f1live",
    resnap: true,
  },
  // Штрафы стюардов в уик-энд: свой канал, чтобы не вставать в очередь за
  // часовым snapshot (в CI это была отдельная concurrency-группа).
  fia: {
    scripts: ["fia"],
    commitPaths: "data/f1/fia",
    messagePrefix: "fia",
    resnap: true,
  },
  weclive: {
    scripts: ["weclive"],
    commitPaths: "data/wec",
    messagePrefix: "weclive",
  },
  tracks: {
    scripts: ["tracks"],
    commitPaths: "data/tracks",
    messagePrefix: "tracks",
  },
};

/// Тройка исходов GitHub, которую понимает health.ts (плюс cancelled, который
/// оркестратору взять неоткуда). skipped — штатный исход nextseason в часовом
/// прогоне: health приводит его к success по skippedIsSuccess, а гейт
/// продьюсеров падением не считает.
type StepOutcome = "success" | "failure" | "skipped";

function run(cmd: string, args: string[], extraEnv: Record<string, string> = {}): number {
  const r = spawnSync(cmd, args, {
    stdio: "inherit",
    env: { ...process.env, ...extraEnv },
  });
  // null — процесс убит сигналом; для гейтов это то же падение.
  return r.status ?? 1;
}

/// Составной шаг «Сезон N+1» — дословно скрипт из snapshot.yml: те же четыре
/// зеркала с SEASON=N+1, каждый под `|| FAIL=1` (упавший не мешает остальным,
/// но шаг в целом отчитывается failure).
function runNextSeason(): StepOutcome {
  const next = String(new Date().getUTCFullYear() + 1);
  let fail = false;
  for (const script of ["f1", "openf1", "wec", "imsa"]) {
    if (run("npm", ["run", script], { SEASON: next }) !== 0) fail = true;
  }
  return fail ? "failure" : "success";
}

// ---------------------------------------------------------------------------
// commit-push: перенос composite action .github/actions/commit-push. Retry с
// rebase остаётся нужным: крон-джобы Railway могут перекрываться так же, как
// перекрывались воркфлоу fia/weclive со snapshot.
// ---------------------------------------------------------------------------

/// Идентичность бота — через `-c`, а не `git config`: локальный dry-run не
/// имеет права молча переписать конфиг репозитория владельца; в контейнере
/// разницы нет.
const GIT_IDENT = ["-c", "user.name=overlap-bot", "-c", "user.email=overlap-bot@users.noreply.github.com"];

function commitPush(paths: string, messagePrefix: string): boolean {
  // Код возврата add проверяется, как проверял бы bash -e в composite action:
  // упавший add (index.lock соседнего прогона, битый индекс) при пустом
  // индексе выглядел бы как «нет изменений» — тихий зелёный прогон без
  // публикации данных, ровно класс отказа, против которого стоит гейт свежести.
  if (run("git", ["add", ...paths.split(" ")]) !== 0) return false;
  if (spawnSync("git", ["diff", "--cached", "--quiet"]).status === 0) {
    console.log("нет изменений");
    return true;
  }
  // Тот же формат, что `date -u +%FT%TZ` в composite action.
  const stamp = new Date().toISOString().slice(0, 19) + "Z";
  if (run("git", [...GIT_IDENT, "commit", "-m", `${messagePrefix} ${stamp}`]) !== 0) return false;
  for (let attempt = 1; attempt <= 5; attempt++) {
    spawnSync("git", ["rebase", "--abort"], { stdio: "ignore" });
    // Идентичность нужна и rebase: replay коммита на уехавший remote — это
    // новый коммит, и контейнер без глобального user.email падал бы здесь
    // «Please tell me who you are» все 5 попыток (на машине владельца
    // глобальный конфиг маскирует это — локальная репетиция не ловит).
    if (
      run("git", [...GIT_IDENT, "pull", "--rebase", "--autostash", "origin", "main"]) === 0 &&
      run("git", ["push"]) === 0
    ) {
      console.log(`push ок с попытки ${attempt}`);
      return true;
    }
    console.warn(`push не удался (попытка ${attempt}/5), повтор через 10с`);
    spawnSync("sleep", ["10"]);
  }
  console.error("push не удался после 5 попыток");
  return false;
}

/// Шаг коммита обеих веток: с --push — настоящий commit-push, без — печать
/// того, что было бы сделано. Возвращает «шаг зелёный».
function commitStep(push: boolean, paths: string, messagePrefix: string): boolean {
  if (!push) {
    console.log(`dry-run: git add ${paths} + commit «${messagePrefix} <UTC>» + push — пропущено (нет --push)`);
    return true;
  }
  return commitPush(paths, messagePrefix);
}

// ---------------------------------------------------------------------------
// Гейты snapshot — та же логика, что YAML-шаги «Проверка продьюсеров» и
// «Проверка свежести данных», но stderr + ненулевой exit вместо ::error::.
// Оба обязаны отработать даже при падениях выше (эффект `if: always()`),
// поэтому не выходят сами, а возвращают вердикт — exit решает main.
// ---------------------------------------------------------------------------

function producersGate(outcomes: Map<string, StepOutcome>): boolean {
  // skipped падением не считается — это штатный nextseason часового прогона.
  const failed = [...outcomes.entries()].filter(([, o]) => o === "failure").map(([k]) => k);
  if (failed.length > 0) {
    console.error(`упали продьюсеры: ${failed.join(" ")} — см. data/health.json`);
    return false;
  }
  console.log("все продьюсеры ОК");
  return true;
}

/// Строки-нарушения свежести — дословно inline-скрипт YAML-гейта. Гейт судит
/// по ВЕРДИКТУ ИЗ ФАЙЛА, поэтому сперва проверяет, что health.json сегодняшний
/// и нужной схемы: замороженный, но читаемый файл держал бы сторожа вечно
/// зелёным — ровно тот тихий отказ, против которого он поставлен.
export function freshnessViolations(readHealth: () => string): string[] {
  let h: { date?: unknown; stale?: unknown };
  try {
    h = JSON.parse(readHealth());
  } catch (e) {
    return [`health.json не прочитан (${(e as Error).message}) — heartbeat не записался, свежесть неизвестна`];
  }
  const lines: string[] = [];
  const today = new Date().toISOString().slice(0, 10);
  if (h.date !== today) {
    lines.push(`health.json от ${h.date}, сегодня ${today} — heartbeat не обновился в этом прогоне, шаг health не отработал`);
  }
  if (!Array.isArray(h.stale)) {
    lines.push("в health.json нет массива stale — схема разъехалась с гейтом, проверка свежести не работает (src/producers/health.ts)");
  }
  for (const s of Array.isArray(h.stale) ? h.stale : []) {
    lines.push(
      `${s.producer}: молчит ${s.days} сут при бюджете ${s.budgetDays}` +
        (s.everRan
          ? `, последний успешный прогон ${s.since}`
          : `, НИ РАЗУ не отрабатывал успешно, в реестре с ${s.since}`) +
        ` — его канал ${s.workflow}`,
    );
  }
  return lines;
}

function freshnessGate(): boolean {
  const lines = freshnessViolations(() => readFileSync("data/health.json", "utf8"));
  if (lines.length > 0) {
    console.error("проверка свежести не пройдена:");
    for (const line of lines) console.error(`  ${line}`);
    console.error(
      "что делать — проверь, что продьюсер реально вызывается своей группой оркестратора ПО РАСПИСАНИЮ " +
        "(ключ в SNAPSHOT_CHAIN или своя группа в SIMPLE_GROUPS) и что он не падает; " +
        "реестр и бюджеты — src/lib/producers.ts, накопленные отметки — data/health.json → lastSuccess/firstSeen",
    );
    return false;
  }
  console.log("свежесть ОК");
  return true;
}

// ---------------------------------------------------------------------------
// Группы
// ---------------------------------------------------------------------------

/// snapshot / snapshot-daily: продьюсеры с continue-on-error (исход в map, а не
/// в exit) → health с env `<KEY>_OUTCOME` → коммит → оба гейта. Порядок «сначала
/// коммит, потом гейты» намеренный, как в YAML: падение гейтов не задерживает
/// публикацию собранного.
function runSnapshot(daily: boolean, push: boolean): number {
  const outcomes = new Map<string, StepOutcome>();

  for (const key of SNAPSHOT_CHAIN) {
    if (key === "nextseason") {
      // В YAML шаг стоит под `if: schedule == '37 3 * * *' || inputs.next_season`;
      // здесь то же различение несёт имя группы. skipped обязателен: health
      // считает его success по skippedIsSuccess, а «failure» или «success» на
      // часовом прогоне врали бы в обе стороны.
      outcomes.set(key, daily ? runNextSeason() : "skipped");
      continue;
    }
    const script = byKey(key)?.script;
    if (!script) {
      // Ключ без скрипта в цепочке — рассинхрон с реестром; молча пропускать
      // нельзя, это класс «продьюсер тихо выпал из проводки».
      outcomes.set(key, "failure");
      console.error(`ключ «${key}» из SNAPSHOT_CHAIN не имеет npm-скрипта в реестре`);
      continue;
    }
    outcomes.set(key, run("npm", ["run", script]) === 0 ? "success" : "failure");
  }

  console.log("исходы прогона:");
  for (const [key, o] of outcomes) console.log(`  ${key}: ${o}`);

  // health бежит ВСЕГДА (в YAML — `if: always()`) и получает исходы через тот
  // же контракт имён, что steps.<id>.outcome → <KEY>_OUTCOME.
  const healthEnv: Record<string, string> = {};
  for (const [key, o] of outcomes) healthEnv[envKeyFor(key)] = o;
  const healthOk = run("npm", ["run", "health"], healthEnv) === 0;
  if (!healthOk) console.error("шаг health упал — heartbeat этого прогона не записан");

  const commitOk = commitStep(push, "data", "snapshot");

  // Оба гейта отрабатывают независимо от исходов друг друга (`if: always()`).
  const gate1Ok = producersGate(outcomes);
  const gate2Ok = freshnessGate();

  return healthOk && commitOk && gate1Ok && gate2Ok ? 0 : 1;
}

/// f1live / fia / weclive / tracks: шаги БЕЗ continue-on-error — первый упавший
/// прекращает остальные (в YAML падение шага валит job сразу), но коммит, как
/// `if: always()`, публикует то, что успело собраться до падения.
function runSimple(name: string, group: SimpleGroup, push: boolean): number {
  let failedScript: string | null = null;
  for (const script of group.scripts) {
    if (run("npm", ["run", script]) !== 0) {
      failedScript = script;
      break;
    }
  }
  if (failedScript) console.error(`шаг «npm run ${failedScript}» упал — остальные шаги группы ${name} пропущены`);

  const commitOk = commitStep(push, group.commitPaths, group.messagePrefix);
  return failedScript === null && commitOk ? 0 : 1;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function usage(): void {
  console.error("запуск: tsx src/orchestrator.ts <группа> [--run | --push]");
  console.error("группы: snapshot | snapshot-daily | " + Object.keys(SIMPLE_GROUPS).join(" | "));
  console.error("без флагов — только печать плана (ничего не запускается);");
  console.error("--run — прогнать продьюсеры и гейты без git; --push — то же плюс git add/commit/push");
}

function printPlan(name: string, scripts: string[], mode: "plan" | "run" | "push"): void {
  const label = mode === "plan" ? " (план, ничего не запущено)" : mode === "run" ? " (без git)" : "";
  console.log(`группа ${name}${label}: ${scripts.join(" → ")}`);
}

function main(): number {
  const args = process.argv.slice(2);
  const push = args.includes("--push");
  const mode: "plan" | "run" | "push" = push ? "push" : args.includes("--run") ? "run" : "plan";
  const rest = args.filter((a) => a !== "--push" && a !== "--run");
  const group = rest[0];
  if (rest.length !== 1 || group === undefined) {
    usage();
    return 2;
  }

  if (group === "snapshot" || group === "snapshot-daily") {
    const daily = group === "snapshot-daily";
    const scripts = SNAPSHOT_CHAIN.map((k) =>
      k === "nextseason" ? (daily ? "сезон N+1 (f1/openf1/wec/imsa)" : "сезон N+1 (skipped)") : byKey(k)?.script ?? k,
    );
    printPlan(group, [...scripts, "health", "commit", "гейты"], mode);
    if (mode === "plan") return 0;
    return runSnapshot(daily, push);
  }

  const simple = SIMPLE_GROUPS[group];
  if (!simple) {
    console.error(`неизвестная группа «${group}»`);
    usage();
    return 2;
  }
  printPlan(group, [...simple.scripts, "commit"], mode);
  if (mode === "plan") return 0;
  return runSimple(group, simple, push);
}

// main только при прямом запуске — иначе импорт из тестов запускал бы
// продьюсеров (тот же приём, что в health.ts).
if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
