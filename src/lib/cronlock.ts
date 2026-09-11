// Межсервисный лок кронов — замена concurrency-групп GitHub Actions.
//
// ЗАЧЕМ. На Railway шесть сервисов бегут независимо и пишут в один репозиторий,
// причём часть файлов у них ОБЩАЯ (fia входит и в свой сервис, и в цепочку
// snapshot; weclive и snapshot оба пересобирают события WEC). Конверт данных
// держит generatedAt в третьей строке, поэтому два писателя одного файла
// конфликтуют при rebase гарантированно, а пять попыток дают тот же конфликт —
// прогон целиком (у snapshot это 26 продьюсеров) уходит в мусор.
//
// ПОЧЕМУ ЛОК С ОЖИДАНИЕМ, А НЕ С ПРОПУСКОМ. Отдельные сервисы fia и weclive
// появились именно потому, что в Actions 15-минутные прогоны вставали в очередь
// за часовым snapshot и МОЛЧА ДРОПАЛИСЬ — ровно в гоночный уик-энд. Лок,
// пропускающий тик, вернул бы ту же болезнь. Поэтому здесь прогон ЖДЁТ: при
// замеренной длительности snapshot 2–4 минуты ожидание укладывается в
// 15-минутный слот, и тик смещается, а не исчезает.
//
// ПОЧЕМУ ЛОК — ОПТИМИЗАЦИЯ, А НЕ КРИТИЧЕСКАЯ ЗАВИСИМОСТЬ. Не дождались,
// сеть отказала, ref испорчен — прогон идёт БЕЗ лока, то есть худший случай
// равен сегодняшнему поведению. Лок не имеет права стать новым способом
// потерять данные.
//
// Примитив: ref в самом репозитории и атомарный CAS средствами git.
// `--force-with-lease=<ref>:<ожидаемое>` — это compare-and-swap на стороне
// сервера: пустое ожидаемое значение означает «ref не существует», то есть
// захват создаёт ref ровно у одного претендента, остальные получают отказ.

import { spawnSync } from "node:child_process";

/// Не под refs/heads: ветка с локом попадала бы в листинги, клоны и UI
/// репозитория, а служебному рефу там делать нечего.
export const LOCK_REF = "refs/cron/lock";

/// Держатель старше этого считается мёртвым, и лок крадётся. Порог выбран с
/// запасом к самой длинной группе (snapshot-daily: вся цепочка + сезон N+1):
/// украсть лок у ЖИВОГО прогона хуже, чем подождать лишнее.
const ttlSec = (): number => Number(process.env.CRON_LOCK_TTL_SEC ?? 1800);

/// Сколько ждать освобождения, прежде чем идти без лока. Меньше слота самого
/// частого сервиса (15 минут), иначе ожидание съедало бы следующий тик.
const waitSec = (): number => Number(process.env.CRON_LOCK_WAIT_SEC ?? 420);

/// Пауза между опросами. Значения читаются в РАНТАЙМЕ, а не при импорте:
/// иначе тест не смог бы подменить их до первого обращения к модулю.
const pollSec = (): number => Number(process.env.CRON_LOCK_POLL_SEC ?? 15);

const IDENT = ["-c", "user.name=overlap-bot", "-c", "user.email=overlap-bot@users.noreply.github.com"];

function git(cwd: string, args: string[]): { code: number; out: string } {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return { code: r.status ?? 1, out: (r.stdout ?? "").trim() };
}

/// sha текущего держателя, либо null, если лок свободен.
function holderSha(cwd: string, remote: string): string | null {
  const r = git(cwd, ["ls-remote", remote, LOCK_REF]);
  if (r.code !== 0 || r.out === "") return null;
  return r.out.split(/\s+/)[0] ?? null;
}

/// Возраст держателя в секундах. Метка времени лежит В СООБЩЕНИИ коммита, а не
/// в дате коммита: дата подчиняется локальным часам контейнера, а сообщение
/// пишет тот же процесс, что и захватывает, — расхождение часов между
/// сервисами не сделает лок вечным.
function holderAgeSec(cwd: string, remote: string, sha: string, now: number): number | null {
  if (git(cwd, ["fetch", "--quiet", "--depth", "1", remote, `${LOCK_REF}:${LOCK_REF}`]).code !== 0) {
    // Ref мог быть снят между ls-remote и fetch — это не отказ, а гонка.
    return null;
  }
  const msg = git(cwd, ["show", "-s", "--format=%s", sha]);
  if (msg.code !== 0) return null;
  const at = Number(msg.out.split(" ").pop());
  return Number.isFinite(at) ? Math.floor(now / 1000) - at : null;
}

/// Коммит-маркер без дерева и без родителя: лок не должен нести ни файлов, ни
/// истории — только имя держателя и время захвата.
function makeMarker(cwd: string, group: string, now: number): string | null {
  const empty = spawnSync("git", ["-C", cwd, "mktree"], { encoding: "utf8", input: "" });
  const treeSha = (empty.stdout ?? "").trim();
  if (treeSha === "") return null;
  const r = spawnSync("git", ["-C", cwd, ...IDENT, "commit-tree", treeSha, "-m",
    `lock ${group} ${Math.floor(now / 1000)}`], { encoding: "utf8" });
  const sha = (r.stdout ?? "").trim();
  return r.status === 0 && sha !== "" ? sha : null;
}

/// Одна попытка захвата. expected — sha, который мы рассчитываем увидеть в
/// рефе: пустая строка для «лок свободен», чужой sha для кражи протухшего.
function tryGrab(cwd: string, remote: string, sha: string, expected: string): boolean {
  return git(cwd, ["push", "--quiet", remote, `${sha}:${LOCK_REF}`,
    `--force-with-lease=${LOCK_REF}:${expected}`]).code === 0;
}

export interface CronLock {
  /// Держим ли мы лок на самом деле. false — прогон идёт без взаимного
  /// исключения (осознанная деградация, см. шапку).
  readonly held: boolean;
  release(): void;
}

const sleep = (sec: number): void => { if (sec > 0) spawnSync("sleep", [String(sec)]); };

/// Захватить лок, дождавшись освобождения. Никогда не бросает и не возвращает
/// «нельзя работать»: не получилось — вернётся held: false.
export function acquireCronLock(
  group: string,
  opts: { cwd?: string; remote?: string; now?: () => number } = {},
): CronLock {
  const cwd = opts.cwd ?? process.cwd();
  const remote = opts.remote ?? "origin";
  const now = opts.now ?? Date.now;
  const deadline = now() + waitSec() * 1000;

  for (;;) {
    const marker = makeMarker(cwd, group, now());
    if (!marker) {
      console.warn("лок: маркер не создался — прогон идёт без взаимного исключения");
      return { held: false, release() {} };
    }
    const holder = holderSha(cwd, remote);
    if (holder === null) {
      if (tryGrab(cwd, remote, marker, "")) return heldLock(cwd, remote, marker);
    } else {
      const age = holderAgeSec(cwd, remote, holder, now());
      if (age !== null && age > ttlSec()) {
        console.warn(`лок: держатель молчит ${age} с при пороге ${ttlSec()} — забираю`);
        if (tryGrab(cwd, remote, marker, holder)) return heldLock(cwd, remote, marker);
      }
    }
    if (now() >= deadline) {
      console.warn(`лок: не дождался за ${waitSec()} с — прогон идёт без взаимного исключения ` +
        "(возможен конфликт при пуше, прогон тогда потеряется громко)");
      return { held: false, release() {} };
    }
    sleep(pollSec());
  }
}

function heldLock(cwd: string, remote: string, sha: string): CronLock {
  return {
    held: true,
    release(): void {
      // Удаляем ТОЛЬКО свой маркер: lease на наш sha не даст снести лок,
      // который у нас успели украсть по TTL, — иначе обворованный прогон
      // открывал бы дорогу третьему прямо посреди работы вора.
      const r = git(cwd, ["push", "--quiet", remote, `:${LOCK_REF}`,
        `--force-with-lease=${LOCK_REF}:${sha}`]);
      if (r.code !== 0) console.warn("лок: снять не удалось — освободится по TTL");
    },
  };
}
