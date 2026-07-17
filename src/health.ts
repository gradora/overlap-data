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

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { writeIfChanged } from "./mirror.js";

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
  const producers = {
    imsa: outcome("IMSA_OUTCOME"),
    f1: outcome("F1_OUTCOME"),
    openf1: outcome("OPENF1_OUTCOME"),
    wec: outcome("WEC_OUTCOME"),
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
      wec: countFiles("wec"),
    },
  };

  const changed = writeIfChanged(
    join(DATA_DIR, "health.json"),
    JSON.stringify(health, null, 1) + "\n"
  );
  console.log(`health.json ${changed ? "written" : "unchanged"}: ${JSON.stringify(health)}`);
}

main();
