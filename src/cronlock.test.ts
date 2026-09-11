// Межсервисный лок кронов. Проверяется НЕ «функция вызывается», а сам примитив
// взаимного исключения — на настоящих репозиториях и настоящем git-CAS:
// шесть сервисов Railway пишут в один репозиторий, и цена ошибки здесь —
// потерянный прогон целой группы.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireCronLock, LOCK_REF } from "./lib/cronlock.js";

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

/// Общий bare-репозиторий и два клона — два «сервиса», как snapshot и weclive.
function arena(): { tmp: string; a: string; b: string } {
  const tmp = mkdtempSync(join(tmpdir(), "cron-lock-"));
  const bare = join(tmp, "private.git");
  execFileSync("git", ["init", "--quiet", "--bare", "--initial-branch=main", bare]);
  const seed = join(tmp, "seed");
  execFileSync("git", ["clone", "--quiet", bare, seed], { stdio: "ignore" });
  execFileSync("git", ["-C", seed, "-c", "user.name=t", "-c", "user.email=t@t",
    "commit", "-q", "--allow-empty", "-m", "init"]);
  git(seed, "push", "-q", "origin", "HEAD");
  const a = join(tmp, "a");
  const b = join(tmp, "b");
  execFileSync("git", ["clone", "--quiet", bare, a], { stdio: "ignore" });
  execFileSync("git", ["clone", "--quiet", bare, b], { stdio: "ignore" });
  return { tmp, a, b };
}

/// Ожидание и опрос сбиваются в ноль: тест проверяет ЛОГИКУ исключения, а не
/// терпение — иначе каждый случай «занято» стоил бы минут реального времени.
function withFastLock<T>(body: () => T): T {
  const saved = { ...process.env };
  process.env.CRON_LOCK_WAIT_SEC = "0";
  process.env.CRON_LOCK_POLL_SEC = "0";
  try {
    return body();
  } finally {
    process.env.CRON_LOCK_WAIT_SEC = saved.CRON_LOCK_WAIT_SEC;
    process.env.CRON_LOCK_POLL_SEC = saved.CRON_LOCK_POLL_SEC;
    if (saved.CRON_LOCK_WAIT_SEC === undefined) delete process.env.CRON_LOCK_WAIT_SEC;
    if (saved.CRON_LOCK_POLL_SEC === undefined) delete process.env.CRON_LOCK_POLL_SEC;
  }
}

test("лок: второй претендент не получает занятый лок, после release — получает", () => {
  const { tmp, a, b } = arena();
  try {
    withFastLock(() => {
      const first = acquireCronLock("snapshot", { cwd: a });
      assert.equal(first.held, true, "свободный лок не захватился");
      assert.equal(git(a, "ls-remote", "origin", LOCK_REF) === "", false, "ref лока не создан");

      // Второй сервис в то же окно: ожидание нулевое, значит отказ немедленный.
      const second = acquireCronLock("weclive", { cwd: b });
      assert.equal(second.held, false, "лок выдан ДВОИМ — взаимного исключения нет");

      first.release();
      assert.equal(git(a, "ls-remote", "origin", LOCK_REF), "", "release не снял ref");

      const third = acquireCronLock("weclive", { cwd: b });
      assert.equal(third.held, true, "освобождённый лок не достался ожидающему");
      third.release();
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("лок: протухший держатель забирается по TTL", () => {
  const { tmp, a, b } = arena();
  try {
    withFastLock(() => {
      process.env.CRON_LOCK_TTL_SEC = "60";
      // Первый захватывает «час назад»: контейнер мог быть убит платформой,
      // и без кражи такой лок остался бы вечным для всех шести сервисов.
      const stale = acquireCronLock("snapshot", { cwd: a, now: () => Date.now() - 3600_000 });
      assert.equal(stale.held, true);

      const next = acquireCronLock("weclive", { cwd: b });
      assert.equal(next.held, true, "протухший лок не забран — сервисы встали навсегда");

      // Обворованный держатель НЕ имеет права снести чужой лок: lease на его
      // собственный sha не сойдётся, и вор доработает под защитой.
      stale.release();
      assert.notEqual(git(b, "ls-remote", "origin", LOCK_REF), "",
        "обворованный прогон снёс лок вора — третий сервис влез бы в его окно");
      next.release();
    });
  } finally {
    delete process.env.CRON_LOCK_TTL_SEC;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("лок: недоступный remote не блокирует прогон", () => {
  const { tmp, a } = arena();
  try {
    withFastLock(() => {
      // Деградация — обязательное свойство: лок это оптимизация против гонок,
      // а не право на работу. Сеть отказала → прогон идёт как раньше.
      const lock = acquireCronLock("snapshot", { cwd: a, remote: join(tmp, "нет-такого.git") });
      assert.equal(lock.held, false, "отказ remote выдал держание лока");
      lock.release();
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
