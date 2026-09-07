// Экспорт витрины в serve-репо (фаза C репо-сплита).
//
// ЗАЧЕМ. Код и сырьё уезжают в приватный репозиторий, наружу публикуется только
// клиентский контракт — витрина и справочники. Этот скрипт и есть граница:
// состав экспорта собирается из реестра DATA_FAMILIES (зоны «витрина» и
// «справочник» с clientReads), руками здесь не перечислен НИ ОДИН каталог.
// Новое семейство попадает в экспорт в момент заведения записи в
// src/lib/databoundary.ts — второй правки «а ещё добавь в экспорт» не
// существует, поэтому и разъехаться реестру со скриптом не из-за чего.
//
// Раскладка — 1:1 к data/: клиентский SnapshotMirror ходит по относительным
// путям вида f1/2026/standings.json, значит корень serve = корень бывшего
// data/. Плейсхолдер <год> разворачивается по реальным каталогам диска через
// matchesFamily — годы не хардкодятся, заготовка следующего сезона
// (wec/2027, imsa/2027) уезжает сама.
//
// Почему состав — только DATA_FAMILIES, без DATA_FILES. Наивный фильтр
// «зона+clientReads по союзу» включил бы health.json (в реестре он «витрина,
// clientReads: true»), а ему наружу нельзя: (а) единственный читатель — дебаг-
// экран, не продуктовый путь; (б) файл перечисляет имена продьюсеров — прямой
// sourceleak; (в) он меняется каждым прогоном даже без новых данных, то есть
// каждый крон-ран становился бы коммитом в публичном serve и вскрывал каденс
// кронов, убивая нейтральность «data update». Ops-телеметрия целиком остаётся
// в привате.
//
// Git-операций здесь нет по построению: скрипт только раскладывает файлы,
// коммит «data update» (и только при непустом diff) — забота обвязки крона.
// Поэтому dry-run работает локально без Railway и без serve-репо.

import { copyFileSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import {
  DATA_FAMILIES, DATA_FILES, classify, matchesFamily,
} from "./lib/databoundary.js";

const DATA_DIR = join(process.cwd(), "data");

/// Известный шум macOS/git — тот же NOISE-сет, что в databoundary.test.ts:
/// скипается молча. Любое ДРУГОЕ точечное имя — аборт, а не скип: скрытый
/// каталог со страницами не должен ни уехать наружу молча, ни молча пропасть.
const NOISE = new Set([".DS_Store", ".gitkeep"]);

/// Служебные файлы продьюсеров по конвенции имени `_*`: маркеры свежести
/// (tracks/_health.json), состояние инкрементальных продьюсеров
/// (_state_<год>.json у records/teams/milestones) и манифест экстракции
/// зеркала openf1 (`f1/openf1/_extractor` — БЕЗ расширения: у файлов зеркала
/// его нет по mirrorSlug, поэтому маска не требует `.json`). Зона в реестре
/// задаётся на СЕМЕЙСТВО, не на файл, поэтому внутри витринных каталогов
/// такие файлы законны — но это кухонная телеметрия, а не контракт, наружу
/// ей нельзя: манифест с картой дыр уехал бы в serve на этапе 4 флипа зоны.
const SERVICE_FILE = /^_/;

/// Поимённые входы сборки внутри клиентских семейств. Оба помечены в
/// sourceleak.test.ts как «уезжает в фазе C» — до физического переезда в
/// приват их держит отсюда этот список. По образцу тех же исключений каждое
/// ОБЯЗАНО срабатывать: файл пропал с диска — значит переезд случился,
/// запись протухла и её пора снять (см. проверку в buildManifest).
const BUILD_INPUTS: { path: string; reason: string }[] = [
  { path: "refs/matching.json",
    reason: "пространства имён карты (jolpica/openf1/fiaDocPrefix) читают " +
      "только продьюсеры — в serve это был бы sourceleak" },
  { path: "f1/history/moments.json",
    reason: "sourceUrl верификации фактов — вход сборки f1history; клиент " +
      "читает только index.json" },
];

export interface ExportFile { path: string; bytes: number }
export interface ExportEntry {
  /// Запись реестра (с плейсхолдером), из которой каталог попал в состав.
  family: string;
  /// Конкретный каталог относительно data/ (f1/2026, refs, …).
  dir: string;
  files: ExportFile[];
}

const visible = (dir: string) => readdirSync(dir).filter((n) => !NOISE.has(n));

/// Тот же обход, что actualPaths() в databoundary.test.ts: семейства первого и
/// второго уровня плюс файлы верхнего уровня. Дублируется ОСОЗНАННО: сторож
/// охвата обязан срабатывать и в кроне, где тесты не бегут, — неклассифици-
/// рованное семейство должно ронять экспорт, а не молча уезжать наружу.
function actualPaths(): string[] {
  const out: string[] = [];
  for (const top of visible(DATA_DIR)) {
    const topPath = join(DATA_DIR, top);
    if (!statSync(topPath).isDirectory()) { out.push(top); continue; }
    const inner = visible(topPath);
    const dirs = inner.filter((n) => statSync(join(topPath, n)).isDirectory());
    if (!dirs.length) { out.push(top); continue; }
    for (const n of inner) out.push(`${top}/${n}`);
  }
  return out;
}

function collect(abs: string, rel: string, out: ExportFile[], used: Set<string>): void {
  for (const name of [...readdirSync(abs)].sort()) {
    if (NOISE.has(name)) continue;
    const childRel = `${rel}/${name}`;
    if (name.startsWith(".")) {
      throw new Error(`${childRel}: неизвестное точечное имя в экспортируемом ` +
        "семействе — скрытое содержимое не должно молча уехать наружу; " +
        "известный шум добавляется в NOISE осознанно");
    }
    const childAbs = join(abs, name);
    const st = statSync(childAbs);
    if (st.isDirectory()) { collect(childAbs, childRel, out, used); continue; }
    if (SERVICE_FILE.test(name)) continue;
    const input = BUILD_INPUTS.find((b) => b.path === childRel);
    if (input) { used.add(input.path); continue; }
    out.push({ path: childRel, bytes: st.size });
  }
}

export function buildManifest(): ExportEntry[] {
  const paths = actualPaths();

  // Сторож охвата: путь без зоны — это семейство, чью судьбу перед публикацией
  // никто не решил, и экспорт с таким состоянием не имеет права состояться.
  const missing = paths.filter((p) => classify(p) == null);
  if (missing.length) {
    throw new Error(`в data/ есть пути без зоны: ${missing.join(", ")} — ` +
      "заведи запись в src/lib/databoundary.ts, экспорт остановлен");
  }

  const used = new Set<string>();
  const entries: ExportEntry[] = [];
  const exported = DATA_FAMILIES.filter(
    (f) => (f.zone === "витрина" || f.zone === "справочник") && f.clientReads);

  for (const fam of exported) {
    const dirs = paths.filter((p) =>
      matchesFamily(p, fam.path) && statSync(join(DATA_DIR, p)).isDirectory());
    // Пустое семейство — не «нечего копировать», а разъезд карты с диском:
    // при --write оно исчезло бы из serve, и клиент ослеп бы по ошибке карты.
    if (!dirs.length) {
      throw new Error(`${fam.path}: экспортируемое семейство не нашлось на ` +
        "диске — карта разошлась с data/, экспорт остановлен");
    }
    for (const dir of dirs) {
      // Развёрнутый каталог обязан классифицироваться в ту же запись, из
      // которой пришёл, — страховка от ошибки разворачивания плейсхолдера.
      if (classify(dir) !== fam) {
        throw new Error(`${dir}: развёрнут из «${fam.path}», но классифици` +
          `руется иначе — плейсхолдер зацепил чужое семейство`);
      }
      const files: ExportFile[] = [];
      collect(join(DATA_DIR, dir), dir, files, used);
      entries.push({ family: fam.path, dir, files });
    }
  }

  for (const b of BUILD_INPUTS) {
    if (!used.has(b.path)) {
      throw new Error(`${b.path}: исключение входа сборки не сработало — файл ` +
        "переехал или переименован, запись в BUILD_INPUTS протухла, сними её");
    }
  }

  // Последний рубеж: ни один файл манифеста не из кухни/заготовки и не из
  // DATA_FILES (wec/_live_health.json лежит файлом прямо в data/wec/ — при
  // пофамильном копировании не цепляется, но полагаться на это молча нельзя).
  for (const e of entries) {
    for (const f of e.files) {
      const hit = classify(f.path);
      if (hit && (hit.zone === "кухня" || hit.zone === "заготовка")) {
        throw new Error(`${f.path}: путь зоны «${hit.zone}» попал в манифест`);
      }
      if (DATA_FILES.some((d) => d.path === f.path)) {
        throw new Error(`${f.path}: файл из DATA_FILES попал в манифест — ` +
          "ops-файлы остаются в привате целиком");
      }
    }
  }

  return entries;
}

/// Сторож направления: dest внутри data/ (или наоборот, data/ внутри dest)
/// означает перепутанный аргумент, а очистка такого dest снесла бы исходные
/// данные. Проверяется и в main (fail-fast, до сборки манифеста), и в
/// writeServe — на случай вызова из будущей обвязки крона напрямую.
function assertSafeDest(dest: string): void {
  if (dest === DATA_DIR || dest.startsWith(DATA_DIR + sep)
      || DATA_DIR.startsWith(dest + sep)) {
    throw new Error(`--dest ${dest} пересекается с ${DATA_DIR} — так можно ` +
      "стереть исходные данные, укажи каталог вне репо");
  }
}

/// Полная очистка dest (кроме .git и README.md serve-репо) + копирование
/// состава = rsync -a --delete на весь манифест разом: исчезнувший год или
/// событие исчезает и из serve, каталоги, переставшие проходить критерий,
/// prune-ятся сами — отдельной логики удаления не нужно.
export function writeServe(destArg: string, entries: ExportEntry[]): void {
  const dest = resolve(destArg);
  assertSafeDest(dest);
  mkdirSync(dest, { recursive: true });
  const keep = new Set([".git", "README.md"]);
  for (const name of readdirSync(dest)) {
    if (keep.has(name)) continue;
    rmSync(join(dest, name), { recursive: true });
  }
  for (const e of entries) {
    for (const f of e.files) {
      const to = join(dest, f.path);
      mkdirSync(dirname(to), { recursive: true });
      copyFileSync(join(DATA_DIR, f.path), to);
    }
  }
}

function fmt(bytes: number): string {
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} МБ`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} КБ`;
  return `${bytes} Б`;
}

function printManifest(entries: ExportEntry[]): void {
  let files = 0;
  let bytes = 0;
  for (const e of entries) {
    const b = e.files.reduce((sum, f) => sum + f.bytes, 0);
    files += e.files.length;
    bytes += b;
    console.log(`  ${e.dir.padEnd(20)} ${String(e.files.length).padStart(4)} ф. ${fmt(b).padStart(10)}`);
  }
  console.log(`итого: ${entries.length} каталогов, ${files} файлов, ${fmt(bytes)}`);
}

const USAGE = "использование: tsx src/exportserve.ts --dest <каталог> [--write]";

function parseArgs(argv: string[]): { dest: string; write: boolean } {
  let dest: string | undefined;
  let write = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dest") { dest = argv[++i]; }
    else if (argv[i] === "--write") { write = true; }
    else throw new Error(`неизвестный аргумент «${argv[i]}»; ${USAGE}`);
  }
  if (!dest) throw new Error(`--dest обязателен; ${USAGE}`);
  return { dest, write };
}

function main(): void {
  const { dest, write } = parseArgs(process.argv.slice(2));
  assertSafeDest(resolve(dest));
  const entries = buildManifest();
  console.log(write
    ? `экспорт витрины → ${resolve(dest)}`
    : `dry-run (без записи), dest = ${resolve(dest)}`);
  printManifest(entries);
  if (!write) {
    console.log("запись выключена: добавь --write, чтобы разложить состав в dest");
    return;
  }
  writeServe(dest, entries);
  console.log("записано; git-операций не было — коммит делает обвязка крона");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }
}
