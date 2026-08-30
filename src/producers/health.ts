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
// 3. Ведёт СВЕЖЕСТЬ по реестру (src/lib/producers.ts): `lastSuccess` — день
//    последнего успешного прогона каждого продьюсера, с переносом из прошлого
//    health.json; `firstSeen` — точка отсчёта для тех, кто не отработал ни
//    разу; `stale` — кто вышел за свой бюджет. Это ответ на вопрос, на который
//    `producers` не отвечает: тот показывает исход шага ЭТОГО прогона, а у
//    продьюсера, которого в воркфлоу вообще нет, шага не существует, и он
//    молчит вечно (инцидент f1teams: 17 суток простоя заметил владелец, а не
//    система).
//
// Продьюсеры в workflow помечены `continue-on-error: true` + `id`, их реальный
// результат приходит сюда через env (`steps.<id>.outcome`) и попадает в
// health.json. Так один сломанный источник не блокирует остальные и коммит.
// Отдельные YAML-гейты после коммита валят job (→ письмо GitHub) на `failure`
// и на непустой `stale` — этот скрипт только ПИШЕТ факты, решение об алерте
// не его.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { writeIfChanged } from "../lib/mirror.js";
import { PRODUCERS, envKeyFor } from "../lib/producers.js";
import {
  computeFreshness, normalizeOutcome, readStamps, utcDay, type Outcome, type Stamps,
} from "../lib/freshness.js";

const DATA_DIR = join(process.cwd(), "data");
const HEALTH_PATH = join(DATA_DIR, "health.json");

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

/// JSON с диска или undefined (нет файла / битый). Свежесть не имеет права
/// падать из-за испорченного накопленного файла — иначе один кривой байт
/// заклинивает heartbeat.
function readJSON(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

// Нормализуем env-статус шага GitHub (success|failure|cancelled|skipped) —
// незаданное (локальный прогон) → "unknown".
function outcome(envKey: string): Outcome {
  const v = (process.env[envKey] ?? "").toLowerCase();
  if (v === "success" || v === "failure" || v === "cancelled" || v === "skipped") return v;
  return "unknown";
}

/// Отметки продьюсеров из ЧУЖИХ воркфлоу: их прогон через env текущего
/// snapshot-прогона не виден, поэтому они оставляют рядом со своими данными
/// файл `{"lastSuccess":"YYYY-MM-DD"}`, а мы его читаем. Нет маркера — не
/// ошибка: значит, чужой воркфлоу ещё не отрабатывал, и рассудит бюджет.
/// Маркеры продьюсеров из ЧУЖИХ воркфлоу. Экспортирована и параметризована
/// каталогом РАДИ ТЕСТОВ: в кроне бежит именно этот код, а не его двойник, и
/// мутация «вернуть пустой объект» иначе проходила мимо всех проверок —
/// превращая сигнал в вечную ложную тревогу по tracks.
export function readMarkerStamps(dataDir: string): Stamps {
  const out: Stamps = {};
  for (const spec of PRODUCERS) {
    if (!spec.marker) continue;
    const raw = readJSON(join(dataDir, spec.marker)) as { lastSuccess?: unknown } | undefined;
    Object.assign(out, readStamps({ [spec.key]: raw?.lastSuccess }));
  }
  return out;
}

/// Прошлый health.json — источник накопленных отметок. Тоже экспортирована:
/// мутация «читать undefined» отключает перенос между прогонами, отметки
/// переставляются на сегодня каждый час, и просрочка не наступает НИКОГДА.
export function readPrevHealth(dataDir: string): unknown {
  return readJSON(join(dataDir, "health.json"));
}

/// Сборка объекта health.json из уже добытых фактов. Чистая — весь ввод-вывод
/// снаружи. Здесь живут два решения, которые ломались мутациями молча:
/// продьюсеры с маркером НЕ попадают в `producers` (иначе вечный "unknown", и
/// приложение красит их в сломанные), и `stale` кладётся вычисленным, а не
/// пустым (иначе канал алерта мёртв целиком при зелёных тестах).
export function assembleHealth(input: {
  today: string;
  outcomeOf: (envKey: string) => Outcome;
  prev: unknown;
  markers: Stamps;
  counts: Record<string, number>;
  blocked: Record<string, number>;
}) {
  const { today, outcomeOf, prev, markers, counts, blocked } = input;

  // Исход шагов ЭТОГО прогона — только по продьюсерам, у которых шаг в
  // snapshot.yml реально есть. Продьюсер из чужого воркфлоу (tracks) сюда не
  // попадает: его outcome был бы вечным "unknown", и приложение красило бы его
  // в сломанные (SnapshotHealthView.failedProducers фильтрует != "success").
  const producers: Record<string, Outcome> = {};
  for (const spec of PRODUCERS) {
    if (spec.marker) continue;
    // Суточный шаг под `if:`: на ежечасных прогонах штатно skipped — это не
    // сбой, приводим к success (см. normalizeOutcome).
    producers[spec.key] = normalizeOutcome(spec, outcomeOf(envKeyFor(spec.key)));
  }

  // Свежесть. Накопленное переносим из ПРОШЛОГО health.json — успех мог быть
  // не в этом прогоне, и отметку нельзя ни потерять, ни подделать.
  const { lastSuccess, firstSeen, stale } = computeFreshness(
    prev as { lastSuccess?: unknown; firstSeen?: unknown } | undefined,
    producers, markers, today,
  );

  return {
    schemaVersion: 1,
    // Дневной heartbeat: меняется раз в сутки → держит крон живым, не спамит.
    date: today,
    producers,
    // День последнего УСПЕШНОГО прогона по каждому продьюсеру реестра. Сутки,
    // не точнее: файл пишется через writeIfChanged (побайтовое сравнение), и
    // метка с часами переворачивала бы health.json каждый час × 21 продьюсер.
    lastSuccess,
    // Продьюсеры, не отработавшие успешно НИ РАЗУ с момента появления в
    // реестре, и день, когда их впервые увидели. Пустой объект — норма.
    firstSeen,
    // Вышли за свой бюджет молчания. Пустой массив — норма; непустой валит
    // job гейтом «Проверка свежести данных» в snapshot.yml (после коммита).
    stale,
    counts,
    // Продьюсеры, которые отработали без исключения, но данные НЕ обновили
    // (fail-closed). Ноль — штатное состояние; ненулевое держится, пока
    // источник не отдаст поле, и не сбрасывается сменой суток.
    blocked,
  };
}

function main() {
  const health = assembleHealth({
    today: utcDay(),
    outcomeOf: outcome,
    prev: readPrevHealth(DATA_DIR),
    markers: readMarkerStamps(DATA_DIR),
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
      f1Events: countFiles("f1/events"),
      // Витрина календаря собирается прогоном f1overrides (фаза 4 DATA-PLAN);
      // своего продьюсера у неё нет, но семейство обязано быть видно в health —
      // иначе пропажу файлов сезона заметит владелец, а не система.
      f1Calendar: countFiles("f1/calendar"),
      f1Teams: countFiles("f1/teams"),
      wec: countFiles("wec"),
      tracks: countFiles("tracks"),
    },
    blocked: { f1teams: blockedTeams() },
  });

  const changed = writeIfChanged(HEALTH_PATH, JSON.stringify(health, null, 1) + "\n");
  console.log(`health.json ${changed ? "written" : "unchanged"}: ${JSON.stringify(health)}`);
  for (const s of health.stale) {
    console.warn(`  ⚠ ${s.producer}: молчит ${s.days} сут при бюджете ${s.budgetDays} (${s.workflow})`);
  }
}

// Как у остальных продьюсеров: main только при прямом запуске. Раньше файл
// никто не импортировал и охраны не имел — а теперь его функции проверяются
// тестами, и без этой строки прогон тестов переписывал бы боевой health.json.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
