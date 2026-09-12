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
// Поверх паритета с YAML при --push живут два шага фазы C (docs/railway.md):
//  - serve-шаг: после пуша в origin — экспорт витрины exportserve-механикой в
//    клон serve-репо по env SERVE_REPO_URL и push нейтральным «data update»;
//  - нотификатор: после гейтов, при провале — POST в env NOTIFY_WEBHOOK_URL.
// Оба выключены отсутствием своего env — локальный --push без переменных
// ведёт себя как раньше.
//
// Что здесь ОСОЗНАННО не живёт (придёт со связкой Railway, см. DATA-PLAN):
//  - межгрупповой lock — замена concurrency-групп GitHub («snapshot+f1live+
//    tracks сериализуются, fia и weclive бегут независимо, лишний pending
//    дропается»); локально и в одиночном кроне он не нужен, а городить flock
//    без общего volume — гадание.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { byKey, envKeyFor } from "./lib/producers.js";
import { buildManifest, writeServe } from "./exportserve.js";
import { acquireCronLock } from "./lib/cronlock.js";
import { publishR2, r2ConfigFromEnv } from "./lib/publishr2.js";

/// Порядок snapshot-цепочки — ДОСЛОВНО последовательность `id:`-шагов
/// snapshot.yml. Порядок несёт смысл, а не историю: проекции (wecevents,
/// imsaevents, f1events) стоят строго после своих семейств, f1teams — после
/// f1 и openf1, f1overrides — после зеркал (GC до витрины), f1weather и
/// f1entrylist — после обоих зеркал, forecast — после f1overrides (читает
/// витрину календаря), f1events — последним из содержательных.
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
  "forecast",
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

/// Доп-env шага поверх наследуемого окружения — паритет с `env:` шагов
/// snapshot.yml. Суточный слот включает климатологию прогноза
/// (FORECAST_TYPICAL=1): в YAML флаг зажигает расписание `37 3 * * *`, здесь —
/// имя группы snapshot-daily (тот же приём, что SEASON у шага «Сезон N+1»).
export function stepExtraEnv(key: string, daily: boolean): Record<string, string> {
  return key === "forecast" && daily ? { FORECAST_TYPICAL: "1" } : {};
}

/// Зеркала шага «Сезон N+1». Витрина календаря N+1 собирается из ДВУХ зеркал
/// (тесты и отмены есть только в листинге OpenF1) — неполный список ломал бы
/// следующий год молча. Экспорт — ради сторожа в orchestrator.test.ts: после
/// сплита yml-половина этого инварианта (workflows.test.ts) умирает вместе с
/// snapshot.yml, а «убрали зеркало на время» должен ловить хоть кто-то.
export const NEXTSEASON_SCRIPTS = ["f1", "openf1", "wec", "imsa"];

/// Составной шаг «Сезон N+1» — дословно скрипт из snapshot.yml: те же четыре
/// зеркала с SEASON=N+1, каждый под `|| FAIL=1` (упавший не мешает остальным,
/// но шаг в целом отчитывается failure).
function runNextSeason(): StepOutcome {
  const next = String(new Date().getUTCFullYear() + 1);
  let fail = false;
  for (const script of NEXTSEASON_SCRIPTS) {
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

/// Имя ветки чекаута. Фолбэк `main` — для detached HEAD (у shallow-клона его не
/// бывает, но пустая строка в аргументах git дала бы невнятный отказ).
function currentBranch(): string {
  const r = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" });
  const name = (r.stdout || "").trim();
  return name && name !== "HEAD" ? name : "main";
}

/// Снять незавершённый rebase и вернуть HEAD на ветку.
///
/// ПОЧЕМУ ЭТО ОБЯЗАТЕЛЬНО, а не гигиена: контейнер ПЕРЕИСПОЛЬЗУЕТ каталог клона
/// между тиками (deploy/railway/entrypoint.sh), а `fetch` + `reset --hard` +
/// `clean` не снимают `.git/rebase-merge` и не возвращают отсоединённый HEAD.
/// Клон, брошенный в mid-rebase, отравляет ВСЕ следующие тики: push падает
/// «You are not currently on a branch», а `rebase --abort` в начале цикла
/// сбрасывает дерево на протухший orig-head, молча выбрасывая только что
/// собранные данные. Один конфликт — и сервис мёртв навсегда, причём тихо:
/// полный переклон не триггерится, `.git` не дорастает до GIT_MAX_MB.
export function leaveRebase(branch: string): void {
  spawnSync("git", ["rebase", "--abort"], { stdio: "ignore" });
  // --quit на случай, когда abort не применим (например, rebase уже наполовину
  // разобран): он снимает состояние, не трогая рабочее дерево.
  spawnSync("git", ["rebase", "--quit"], { stdio: "ignore" });
  if (spawnSync("git", ["symbolic-ref", "--quiet", "HEAD"], { stdio: "ignore" }).status !== 0) {
    spawnSync("git", ["switch", "--force", branch], { stdio: "ignore" });
  }
}

export function commitPush(paths: string, messagePrefix: string): boolean {
  // Код возврата add проверяется, как проверял бы bash -e в composite action:
  // упавший add (index.lock соседнего прогона, битый индекс) при пустом
  // индексе выглядел бы как «нет изменений» — тихий зелёный прогон без
  // публикации данных, ровно класс отказа, против которого стоит гейт свежести.
  if (run("git", ["add", ...paths.split(" ")]) !== 0) return false;
  if (spawnSync("git", ["diff", "--cached", "--quiet"]).status === 0) {
    // Коммитить нечего — но дерево всё равно надо довести до origin. Иначе
    // прогон уходит дальше со снимком, сделанным на момент клона, и ПУБЛИКУЕТ
    // его: writeServe — полная перезапись манифеста, так что устаревшее дерево
    // затирает чужую свежую публикацию целиком. Для weclive это не край case, а
    // норма: вне этапа WEC подавляющее большинство тиков идёт именно здесь.
    run("git", [...GIT_IDENT, "pull", "--rebase", "--autostash", "origin", currentBranch()]);
    console.log("нет изменений");
    return true;
  }
  // Тот же формат, что `date -u +%FT%TZ` в composite action.
  const stamp = new Date().toISOString().slice(0, 19) + "Z";
  if (run("git", [...GIT_IDENT, "commit", "-m", `${messagePrefix} ${stamp}`]) !== 0) return false;
  // Ветку снимаем ДО цикла: внутри rebase HEAD отсоединён, и currentBranch()
  // отдал бы фолбэк main вместо настоящей ветки чекаута.
  const branch = currentBranch();
  for (let attempt = 1; attempt <= 5; attempt++) {
    spawnSync("git", ["rebase", "--abort"], { stdio: "ignore" });
    // Идентичность нужна и rebase: replay коммита на уехавший remote — это
    // новый коммит, и контейнер без глобального user.email падал бы здесь
    // «Please tell me who you are» все 5 попыток (на машине владельца
    // глобальный конфиг маскирует это — локальная репетиция не ловит).
    // Ветка — ТЕКУЩАЯ, а не захардкоженный main: контейнер клонирует
    // CLONE_BRANCH (deploy/railway/entrypoint.sh), и `pull --rebase origin main`
    // на обкаточной ветке перебазировал бы её на боевую верхушку, после чего
    // `git push` (push.default=simple) записал бы содержимое main в origin/<ветка>
    // с рапортом «push ок». Ломалось бы ровно на первой гонке пушей — то есть
    // в том единственном случае, ради которого этот retry и написан.
    if (
      run("git", [...GIT_IDENT, "pull", "--rebase", "--autostash", "origin", branch]) === 0 &&
      run("git", ["push"]) === 0
    ) {
      console.log(`push ок с попытки ${attempt}`);
      return true;
    }
    // Пауза из env — ради юнит-репетиции гонки: пять пауз по 10 с сделали бы
    // тест на восстановление после конфликта пятидесятисекундным.
    const sleepSec = process.env.PUSH_RETRY_SLEEP_SEC ?? "10";
    console.warn(`push не удался (попытка ${attempt}/5), повтор через ${sleepSec}с`);
    spawnSync("sleep", [sleepSec]);
  }
  // Выход из цикла = все пять попыток уперлись в один и тот же конфликт.
  // Прогон потерян — это громко и ожидаемо; чего нельзя допустить, так это
  // оставить каталог отравленным для СЛЕДУЮЩИХ тиков (см. leaveRebase).
  leaveRebase(branch);
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
// serve-шаг — публикация витрины в публичный serve-репо (railway.md §2/§7).
// Стоит ПОСЛЕ commit-push в origin и ДО гейтов по той же причине, по которой
// коммит стоит до гейтов: тревога свежести не должна блокировать публикацию
// уже собранных данных. URL приходит из env SERVE_REPO_URL (в контейнере его
// собирает entrypoint из ssh-алиаса github-serve); в НАШИ строки лога ни URL,
// ни ключи не попадают — гигиена railway.md §3.
// ---------------------------------------------------------------------------

/// git serve-шага — с ПЕРЕХВАТОМ stdio: git печатает URL в собственный stderr
/// («fatal: unable to access '<URL>'», «To <URL>» у отбитого push — даже с
/// --quiet), а URL serve-репо в контейнере несёт ssh-алиас и путь. Глушим
/// целиком и печатаем свою строку без URL; цена — потеря git-диагностики в
/// логе, но провал шага и так виден кодом и нотификатором.
function runGitQuiet(dir: string | null, args: string[]): number {
  const full = dir ? ["-C", dir, ...args] : args;
  const r = spawnSync("git", full, { stdio: ["ignore", "ignore", "ignore"] });
  const code = r.status ?? 1;
  if (code !== 0) console.error(`serve: git ${args[0]} — код ${code}`);
  return code;
}

/// Клон serve-репо → экспорт витрины → нейтральный коммит → push с retry.
/// Экспортируется ради юнит-репетиции в orchestrator.test.ts: bare-репо по
/// file:// — легальный URL (голый путь игнорировал бы --depth), поэтому шаг
/// проверяется целиком без сети и без Railway-аккаунта.
export function pushServe(serveUrl: string): boolean {
  const tmp = mkdtempSync(join(tmpdir(), "overlap-serve-"));
  try {
    // --depth 1: истории витрины прогону не нужно, нужен только HEAD.
    if (runGitQuiet(null, ["clone", "--quiet", "--depth", "1", serveUrl, tmp]) !== 0) {
      console.error("serve: клон serve-репо не удался");
      return false;
    }
    // Механика exportserve: состав строго по DATA_FAMILIES, запись с
    // --write-семантикой (keep-набор служебных файлов — в exportserve.ts).
    // Сторожа exportserve БРОСАЮТ по дизайну (путь без зоны, пустое семейство,
    // разъезд карты с диском) — ловим здесь: провал границы данных обязан
    // доехать до гейтов и нотификатора, а не убить прогон unhandled rejection.
    try {
      writeServe(tmp, buildManifest());
    } catch (e) {
      console.error(`serve: экспорт витрины отказал (${(e as Error).name}: ` +
        `${(e as Error).message}) — сторож границы данных`);
      return false;
    }
    if (runGitQuiet(tmp, ["add", "-A"]) !== 0) return false;
    if (spawnSync("git", ["-C", tmp, "diff", "--cached", "--quiet"]).status === 0) {
      console.log("serve: нет изменений");
      return true;
    }
    // Сообщение нейтральное и БЕЗ таймстемпа/имён продьюсеров: публичная
    // история не должна выдавать ни кухню, ни каденс кронов (railway.md).
    if (runGitQuiet(tmp, [...GIT_IDENT, "commit", "-q", "-m", "data update"]) !== 0) return false;
    for (let attempt = 1; attempt <= 5; attempt++) {
      if (runGitQuiet(tmp, ["push", "--quiet", "origin", "HEAD"]) === 0) {
        console.log(`serve: push ок с попытки ${attempt}`);
        return true;
      }
      console.warn(`serve: push не удался (попытка ${attempt}/5), повтор через 10с`);
      // Гонка с другим крон-сервисом: replay нашего «data update» поверх
      // уехавшего remote — тот же rebase-retry, что в commitPush. Идентичность
      // нужна rebase по той же причине (replay = новый коммит).
      spawnSync("git", ["-C", tmp, "rebase", "--abort"], { stdio: "ignore" });
      runGitQuiet(tmp, [...GIT_IDENT, "pull", "--quiet", "--rebase", "origin"]);
      spawnSync("sleep", ["10"]);
    }
    console.error("serve: push не удался после 5 попыток");
    return false;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/// Совпадает ли наше дерево с верхушкой origin.
///
/// Витрина собирается из ЛОКАЛЬНОГО data/, а публикация — полная перезапись,
/// поэтому публиковать имеет право только прогон, чьё дерево = origin. Иначе
/// сервис, стартовавший раньше чужого пуша, откатит публичную витрину назад:
/// коммит «data update» уйдёт fast-forward, без конфликта и без ошибки, а
/// дашборд останется зелёным.
function syncedWithOrigin(): boolean {
  const branch = currentBranch();
  if (spawnSync("git", ["fetch", "--quiet", "--depth", "1", "origin", branch],
    { stdio: "ignore" }).status !== 0) return false;
  const at = (rev: string): string =>
    (spawnSync("git", ["rev-parse", rev], { encoding: "utf8" }).stdout ?? "").trim();
  const head = at("HEAD");
  return head !== "" && head === at("FETCH_HEAD");
}

/// Шаг serve обеих веток. Без --push публикации нет (как и коммита); с --push,
/// но без SERVE_REPO_URL — штатный пропуск: пока serve-репо не создан, кроны
/// наполняют только приват, и это норма, а не провал.
///
/// Гейт на commitOk: публикуем только зафиксированное приватом. Контейнер
/// эфемерен — витрина, ушедшая наружу при провале origin-пуша, существовала бы
/// только в публичном репо и не воспроизводилась бы из приватной истории.
async function serveStep(push: boolean, commitOk: boolean): Promise<boolean> {
  if (!push) return true;
  // Два канала публикации: объектное хранилище (решение по 7b — витрину
  // раздаёт R2) и git-репо (прежний путь, живёт до переезда). Настроен
  // R2 — он и выигрывает; не настроено НИЧЕГО — штатный пропуск, как было.
  const r2 = r2ConfigFromEnv();
  const url = process.env.SERVE_REPO_URL;
  if (!r2 && !url) {
    console.log("serve-шаг пропущен (публикация не настроена)");
    return true;
  }
  if (!commitOk) {
    console.warn("serve-шаг пропущен: пуш в origin не удался — наружу едет только зафиксированное приватом");
    return false;
  }
  // Последний рубеж против отката публичной витрины. Штатный путь дерево уже
  // синхронизировал (успешный push либо pull в ветке «нет изменений»), так что
  // сюда мы попадаем, когда чужой сервис допушил В ЭТОТ ЗАЗОР. Пропуск, а не
  // провал: данные в приват уже уехали, опубликует их следующий тик — любой, у
  // кого дерево актуально. Молчать нельзя: систематический пропуск здесь
  // означал бы застой витрины, и это должно быть видно в логе.
  if (!syncedWithOrigin()) {
    console.warn("serve-шаг пропущен: дерево прогона отстало от origin — публикация откатила бы витрину назад");
    return true;
  }
  if (r2) {
    // Сторожа границы данных бросают по дизайну (путь без зоны, пустое
    // семейство, разъезд карты с диском) — ловим здесь, как и у git-канала:
    // провал границы обязан доехать до гейтов и нотификатора, а не убить
    // прогон unhandled rejection.
    try {
      const r = await publishR2(r2, buildManifest());
      console.log(`serve: R2 — залито ${r.put}, удалено ${r.deleted}, без изменений ${r.unchanged}`);
      return true;
    } catch (e) {
      console.error(`serve: публикация в R2 отказала (${(e as Error).name}: ${(e as Error).message})`);
      return false;
    }
  }
  return pushServe(url as string);
}

// ---------------------------------------------------------------------------
// Нотификатор — слой 2 алертинга railway.md §4: платформонезависимый POST в
// вебхук владельца при провале прогона. Осечка самого вебхука — warning, а не
// второй провал: алерт не имеет права ронять то, о чём алертит, и на exit-код
// не влияет (вердикт уже вынесен гейтами).
// ---------------------------------------------------------------------------

export interface FailureReport {
  group: string;
  /// Ключи упавших продьюсеров (у простой группы — упавший скрипт).
  failed: string[];
  /// Строки-нарушения свежести из freshnessViolations.
  stale: string[];
  /// Исход serve-шага: false — пуш витрины не удался (или пропущен из-за commit).
  serve: boolean;
  /// Исход commit-push в origin: самый вероятный продакшен-отказ (гонка
  /// пушей, протухший deploy key) — ради него retry и существует; провал
  /// ТОЛЬКО этого шага тоже обязан доехать до вебхука.
  commit: boolean;
  /// Исход шага health (heartbeat свежести): у простых групп его нет — true.
  health: boolean;
  /// UTC-таймстемп прогона.
  at: string;
}

export async function notifyFailure(url: string, report: FailureReport, timeoutMs = 10_000): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(report),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      console.warn(`нотификатор: вебхук ответил ${res.status} — алерт не доставлен`);
      return false;
    }
    return true;
  } catch (e) {
    // URL в лог не пишем (гигиена §3) — и ТОЛЬКО ИМЯ КЛАССА ошибки: undici
    // кладёт полный URL в message («Failed to parse URL from <URL>»), а URL
    // вебхука — секрет (токен телеграм-бота живёт в пути).
    console.warn(`нотификатор: вебхук недоступен (${(e as Error).name}) — алерт не доставлен`);
    return false;
  }
}

/// Отправка при заданном env и ЛЮБОМ слагаемом ненулевого exit — продьюсеры,
/// свежесть, health, commit-push в origin, serve-пуш: канал существует, чтобы
/// падение крона не молчало, и не имеет права выбирать «достойные» причины.
async function notifyStep(report: FailureReport): Promise<void> {
  const url = process.env.NOTIFY_WEBHOOK_URL;
  if (!url) return;
  // Кривой URL (лишняя кавычка/пробел из env-UI) отсекаем ДО fetch — иначе
  // undici напечатал бы его целиком в message TypeError.
  try {
    new URL(url);
  } catch {
    console.warn("нотификатор: NOTIFY_WEBHOOK_URL не парсится — алерт не настроен");
    return;
  }
  const green = report.failed.length === 0 && report.stale.length === 0 &&
    report.serve && report.commit && report.health;
  if (green) return;
  await notifyFailure(url, report);
}

/// Сигнал «прогон дошёл до конца и он зелёный» — «мёртвая рука».
///
/// ЗАЧЕМ ОТДЕЛЬНО ОТ НОТИФИКАТОРА. Тот живёт ВНУТРИ прогона и потому нем в
/// самом опасном классе отказов: контейнер не поднялся, испортился ключ, упал
/// клон, платформа не запустила расписание. Молчание в этих случаях
/// неотличимо от «всё хорошо» — за первые сутки на Railway мы дважды узнавали
/// о таких отказах только потому, что владелец смотрел в консоль.
///
/// Поэтому здесь обратная логика: наружу уходит подтверждение УСПЕХА, а
/// тревогу поднимает внешний наблюдатель, когда подтверждения перестают
/// приходить. Он живёт вне Railway, так что переживает смерть всей платформы.
///
/// Формат — GET с именем группы в пути: так устроены все dead-man's-switch
/// сервисы, и такой же приёмник тривиально поднимается свой. Провал сигнала
/// НЕ влияет на вердикт прогона: сторож не имеет права ронять то, что сторожит.
export const heartbeatForTesting = (group: string, green: boolean): Promise<void> =>
  heartbeat(group, green);

async function heartbeat(group: string, green: boolean): Promise<void> {
  const base = process.env.HEARTBEAT_URL;
  if (!base || !green) return;
  try {
    new URL(base);
  } catch {
    console.warn("heartbeat: HEARTBEAT_URL не парсится — сторож не настроен");
    return;
  }
  const url = `${base.replace(/\/$/, "")}/${encodeURIComponent(group)}`;
  try {
    await fetch(url, { method: "GET", signal: AbortSignal.timeout(10_000) });
  } catch (e) {
    // Имя класса, но не сообщение: undici кладёт в message полный URL, а он
    // содержит секрет приёмника у большинства таких сервисов.
    console.warn(`heartbeat: сигнал не ушёл (${(e as Error).name})`);
  }
}

// ---------------------------------------------------------------------------
// Гейты snapshot — та же логика, что YAML-шаги «Проверка продьюсеров» и
// «Проверка свежести данных», но stderr + ненулевой exit вместо ::error::.
// Оба обязаны отработать даже при падениях выше (эффект `if: always()`),
// поэтому не выходят сами, а возвращают вердикт — exit решает main.
// ---------------------------------------------------------------------------

function producersGate(failed: string[]): boolean {
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

/// Возвращает строки-нарушения (пусто = гейт зелёный): их же нотификатор
/// кладёт в поле stale отчёта, второго чтения health.json не нужно.
function freshnessGate(): string[] {
  const lines = freshnessViolations(() => readFileSync("data/health.json", "utf8"));
  if (lines.length > 0) {
    console.error("проверка свежести не пройдена:");
    for (const line of lines) console.error(`  ${line}`);
    console.error(
      "что делать — проверь, что продьюсер реально вызывается своей группой оркестратора ПО РАСПИСАНИЮ " +
        "(ключ в SNAPSHOT_CHAIN или своя группа в SIMPLE_GROUPS) и что он не падает; " +
        "реестр и бюджеты — src/lib/producers.ts, накопленные отметки — data/health.json → lastSuccess/firstSeen",
    );
  } else {
    console.log("свежесть ОК");
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Группы
// ---------------------------------------------------------------------------

/// snapshot / snapshot-daily: продьюсеры с continue-on-error (исход в map, а не
/// в exit) → health с env `<KEY>_OUTCOME` → коммит → serve → оба гейта →
/// нотификатор. Порядок «сначала коммит и serve, потом гейты» намеренный, как
/// в YAML: падение гейтов не задерживает публикацию собранного.
async function runSnapshot(daily: boolean, push: boolean): Promise<number> {
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
    outcomes.set(key, run("npm", ["run", script], stepExtraEnv(key, daily)) === 0 ? "success" : "failure");
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
  const serveOk = await serveStep(push, commitOk);

  // Оба гейта отрабатывают независимо от исходов друг друга (`if: always()`).
  // skipped падением не считается — это штатный nextseason часового прогона.
  const failed = [...outcomes.entries()].filter(([, o]) => o === "failure").map(([k]) => k);
  const gate1Ok = producersGate(failed);
  const stale = freshnessGate();

  await heartbeat(daily ? "snapshot-daily" : "snapshot",
                  healthOk && commitOk && serveOk && gate1Ok && stale.length === 0);
  await notifyStep({
    group: daily ? "snapshot-daily" : "snapshot",
    failed,
    stale,
    serve: serveOk,
    commit: commitOk,
    health: healthOk,
    at: new Date().toISOString(),
  });

  return healthOk && commitOk && serveOk && gate1Ok && stale.length === 0 ? 0 : 1;
}

/// f1live / fia / weclive / tracks: шаги БЕЗ continue-on-error — первый упавший
/// прекращает остальные (в YAML падение шага валит job сразу), но коммит, как
/// `if: always()`, публикует то, что успело собраться до падения.
async function runSimple(name: string, group: SimpleGroup, push: boolean): Promise<number> {
  let failedScript: string | null = null;
  for (const script of group.scripts) {
    if (run("npm", ["run", script]) !== 0) {
      failedScript = script;
      break;
    }
  }
  if (failedScript) console.error(`шаг «npm run ${failedScript}» упал — остальные шаги группы ${name} пропущены`);

  const commitOk = commitStep(push, group.commitPaths, group.messagePrefix);
  const serveOk = await serveStep(push, commitOk);

  await heartbeat(name, failedScript === null && commitOk && serveOk);
  await notifyStep({
    group: name,
    failed: failedScript ? [failedScript] : [],
    stale: [],
    serve: serveOk,
    commit: commitOk,
    health: true,
    at: new Date().toISOString(),
  });

  return failedScript === null && commitOk && serveOk ? 0 : 1;
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

/// «serve» в цепочке плана — с оговоркой: шаг существует только при --push и
/// только с SERVE_REPO_URL, но видеть его в плане обязан и локальный прогон —
/// иначе публикация витрины была бы невидимым шагом крона.
function printPlan(name: string, scripts: string[], mode: "plan" | "run" | "push"): void {
  const label = mode === "plan" ? " (план, ничего не запущено)" : mode === "run" ? " (без git)" : "";
  console.log(`группа ${name}${label}: ${scripts.join(" → ")}`);
}

const SERVE_PLAN_STEP = "serve-шаг (витрина → SERVE_REPO_URL, только при --push)";

/// Прогон под межсервисным локом (src/lib/cronlock.ts).
///
/// Берётся только в боевом режиме: без --push в git никто не пишет, исключать
/// нечего, а лишний сетевой ход в репозиторий на каждой репетиции — вред.
///
/// За флагом CRON_LOCK намеренно: включаем по одному сервису и смотрим, как
/// ожидание ложится на реальные слоты, вместо того чтобы менять поведение всех
/// шести разом в тот же день, когда гасятся GitHub Actions. Выключенный лок —
/// сегодняшнее поведение, а не деградация.
async function underCronLock(
  group: string, push: boolean, body: () => Promise<number>,
): Promise<number> {
  if (!push || process.env.CRON_LOCK !== "1") return body();
  const lock = acquireCronLock(group);
  if (lock.held) console.log("лок: взят");
  try {
    return await body();
  } finally {
    // finally, а не после body(): прогон может уйти исключением (сторож границы
    // данных бросает по дизайну), и невозвращённый лок задержал бы все
    // остальные сервисы до самого TTL.
    if (lock.held) lock.release();
  }
}

async function main(): Promise<number> {
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
    printPlan(group, [...scripts, "health", "commit", SERVE_PLAN_STEP, "гейты"], mode);
    if (mode === "plan") return 0;
    return underCronLock(group, push, () => runSnapshot(daily, push));
  }

  const simple = SIMPLE_GROUPS[group];
  if (!simple) {
    console.error(`неизвестная группа «${group}»`);
    usage();
    return 2;
  }
  printPlan(group, [...simple.scripts, "commit", SERVE_PLAN_STEP], mode);
  if (mode === "plan") return 0;
  return underCronLock(group, push, () => runSimple(group, simple, push));
}

// main только при прямом запуске — иначе импорт из тестов запускал бы
// продьюсеров (тот же приём, что в health.ts). catch обязателен: без него
// исключение (например, сторож exportserve вне пойманного пути) давало бы
// unhandled rejection — exit случайно ненулевой, но гейты и нотификатор
// уже не бегут, и падение молчит в вебхук.
if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
