// Health/heartbeat снапшот-бэкенда. Запускается ПОСЛЕДНИМ в cron (шаг `if:
// always()`), после всех продьюсеров. Делает три вещи:
//
// 1. Пишет `data/health.json` с ДНЕВНЫМ heartbeat (`date`) + статусами
//    продьюсеров + счётчиками файлов. Дневная гранулярность → ≤1 коммит в день,
//    даже когда данные заморожены и не меняются. Это КРИТИЧНО: GitHub
//    автоотключает scheduled workflow после 60 дней без активности репозитория —
//    ежедневный heartbeat-коммит держит крон живым в межсезонье.
// 2. Даёт приложению машиночитаемый сигнал устаревания: `date` (бэкенд бежал
//    в этот день) + `producers` (какой источник сломался).
// Продьюсеры в workflow помечены `continue-on-error: true` + `id`, их реальный
// результат приходит сюда через env (`steps.<id>.outcome`) и попадает в
// health.json. Так один сломанный источник не блокирует остальные и коммит.
// Отдельный YAML-гейт после коммита валит job (→ письмо GitHub) на любой
// `failure` — этот скрипт только ПИШЕТ health.json, решение об алерте не его.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { writeIfChanged } from "../lib/mirror.js";

const DATA_DIR = join(process.cwd(), "data");

// Рекурсивно считаем файлы под поддеревом (пропущенное/несуществующее → 0).
function countFiles(rel: string): number {
  const root = join(DATA_DIR, rel);
  let n = 0;
  const walk = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return; // нет каталога — 0
    }
    for (const name of entries) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else n++;
    }
  };
  walk(root);
  return n;
}

// Экран команды — единственный fail-closed продьюсер: при непокрытом отказе он
// НЕ переписывает data/f1/teams/<год>.json и выходит нулём. Шаг зелёный,
// outcome=success, алерт-гейт молчит — и устойчивый отказ по одной команде
// (файл заморожен для всех одиннадцати) виден только строкой в логе прогона.
// Продьюсер оставляет след в своём же состоянии — читаем оттуда число
// заблокированных команд. Смотрим ТОЛЬКО текущий сезон: состояние сезона N+1
// в межсезонье законно неполное, и его блокировки — не инцидент.
function blockedTeams(): number {
  const year = new Date().getUTCFullYear();
  try {
    const s = JSON.parse(readFileSync(join(DATA_DIR, "f1", "teams", `_state_${year}.json`), "utf8"));
    return Array.isArray(s?.blocked) ? s.blocked.length : 0;
  } catch {
    return 0; // нет состояния (первый прогон сезона) — не о чем сообщать
  }
}

// Нормализуем env-статус шага GitHub (success|failure|cancelled|skipped) —
// незаданное (локальный прогон) → "unknown".
type Outcome = "success" | "failure" | "cancelled" | "skipped" | "unknown";
function outcome(envKey: string): Outcome {
  const v = (process.env[envKey] ?? "").toLowerCase();
  if (v === "success" || v === "failure" || v === "cancelled" || v === "skipped") return v;
  return "unknown";
}

// Дата UTC в формате YYYY-MM-DD — дневной heartbeat.
function utcDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function main() {
  // ВСЕ продьюсеры snapshot.yml (приложение декодит словарём — ключи свободные).
  // Список обязан совпадать с гейтом «Проверка продьюсеров» в snapshot.yml:
  // продьюсер без записи здесь и в гейте может падать вечно молча (кейс records).
  const producers = {
    imsa: outcome("IMSA_OUTCOME"),
    f1: outcome("F1_OUTCOME"),
    openf1: outcome("OPENF1_OUTCOME"),
    wec: outcome("WEC_OUTCOME"),
    fia: outcome("FIA_OUTCOME"),
    wecfia: outcome("WECFIA_OUTCOME"),
    wechighlights: outcome("WECHIGHLIGHTS_OUTCOME"),
    wecwinners: outcome("WECWINNERS_OUTCOME"),
    imsafia: outcome("IMSAFIA_OUTCOME"),
    imsahighlights: outcome("IMSAHIGHLIGHTS_OUTCOME"),
    imsawinners: outcome("IMSAWINNERS_OUTCOME"),
    winners: outcome("WINNERS_OUTCOME"),
    highlights: outcome("HIGHLIGHTS_OUTCOME"),
    milestones: outcome("MILESTONES_OUTCOME"),
    f1history: outcome("F1HISTORY_OUTCOME"),
    beasts: outcome("BEASTS_OUTCOME"),
    records: outcome("RECORDS_OUTCOME"),
    f1teams: outcome("F1TEAMS_OUTCOME"),
    f1overrides: outcome("F1OVERRIDES_OUTCOME"),
    // Суточный шаг (второй cron): на ежечасных прогонах штатно skipped —
    // это не сбой, приводим к success, чтобы дебаг-меню не мигало каждый час.
    nextseason: outcome("NEXTSEASON_OUTCOME") === "skipped"
      ? "success" as const : outcome("NEXTSEASON_OUTCOME"),
  };

  const health = {
    schemaVersion: 1,
    // Дневной heartbeat: меняется раз в сутки → держит крон живым, не спамит.
    date: utcDate(),
    producers,
    counts: {
      imsa: countFiles("imsa"),
      f1Jolpica: countFiles("f1/jolpica"),
      f1OpenF1: countFiles("f1/openf1"),
      f1Fia: countFiles("f1/fia"),
      f1Winners: countFiles("f1/winners"),
      f1Highlights: countFiles("f1/highlights"),
      f1Milestones: countFiles("f1/milestones"),
      f1History: countFiles("f1/history"),
      f1Beasts: countFiles("f1/beasts"),
      f1Records: countFiles("f1/records"),
      f1Overrides: countFiles("f1/overrides"),
      f1Teams: countFiles("f1/teams"),
      wec: countFiles("wec"),
      tracks: countFiles("tracks"),
    },
    // Продьюсеры, которые отработали без исключения, но данные НЕ обновили
    // (fail-closed). Ноль — штатное состояние; ненулевое держится, пока
    // источник не отдаст поле, и не сбрасывается сменой суток.
    blocked: {
      f1teams: blockedTeams(),
    },
  };

  const changed = writeIfChanged(
    join(DATA_DIR, "health.json"),
    JSON.stringify(health, null, 1) + "\n"
  );
  console.log(`health.json ${changed ? "written" : "unchanged"}: ${JSON.stringify(health)}`);
}

main();
