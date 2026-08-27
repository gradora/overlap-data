// Сигнал протухания: реестр продьюсеров + бюджет суток без успешного прогона.
//
// Что здесь защищается, по инцидентам:
//  * f1teams не был подключён ни к одному воркфлоу и простоял 17 суток — его
//    заметил владелец, а не система. Гейт по outcome такого не видит: у
//    неподключённого продьюсера нет шага, и падать нечему. Ловит только реестр,
//    объявленный НЕЗАВИСИМО от проводки, — тест «продьюсера нет в воркфлоу»
//    воспроизводит инцидент буквально, вырезая шаг из настоящего snapshot.yml.
//  * health.json пишется через writeIfChanged и держит ДНЕВНУЮ гранулярность
//    (≤1 коммит в сутки — иначе часовой крон превращается в коммит-спам, а
//    heartbeat-коммит нужен, чтобы GitHub не выключил scheduled workflow через
//    60 дней). Отсюда тест на идемпотентность в пределах суток.
//  * локальный `npm run health` даёт unknown по всем продьюсерам — он не имеет
//    права ни стереть накопленное, ни поднять тревогу.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import {
  addDays, computeFreshness, daysBetween, normalizeOutcome, readStamps, staleProducers, utcDay,
  type Outcome, type Stamps,
} from "./lib/freshness.js";
import { PRODUCERS, byKey, envKeyFor, type ProducerSpec } from "./lib/producers.js";

const SNAPSHOT_YML = ".github/workflows/snapshot.yml";
const DAY = "2026-08-24";

/// Игрушечный реестр: бюджеты малы, чтобы границы проверялись явными числами.
const REG: ProducerSpec[] = [
  { key: "alpha", script: "alpha", budgetDays: 3, workflow: "w.yml" },
  { key: "beta", script: "beta", budgetDays: 3, workflow: "w.yml" },
  { key: "weekly", script: "weekly", budgetDays: 14, workflow: "weekly.yml", marker: "weekly/_health.json" },
];

const all = (v: Outcome, registry = REG): Record<string, Outcome> =>
  Object.fromEntries(registry.map((p) => [p.key, v]));

const staleKeys = (f: { stale: { producer: string }[] }): string[] =>
  f.stale.map((s) => s.producer);

// MARK: - Перенос отметки

test("lastSuccess переносится из прошлого health.json, когда успеха не было", () => {
  const prev = { lastSuccess: { alpha: "2026-08-20", beta: "2026-08-22" }, firstSeen: {} };
  const f = computeFreshness(prev, all("failure"), {}, DAY, REG);
  assert.equal(f.lastSuccess.alpha, "2026-08-20", "упавший продьюсер сохраняет прежнюю отметку");
  assert.equal(f.lastSuccess.beta, "2026-08-22");
});

test("успех в этом прогоне двигает отметку на сегодня, остальные не трогает", () => {
  const prev = { lastSuccess: { alpha: "2026-08-20", beta: "2026-08-20" }, firstSeen: {} };
  const f = computeFreshness(prev, { alpha: "success", beta: "failure" }, {}, DAY, REG);
  assert.equal(f.lastSuccess.alpha, DAY);
  assert.equal(f.lastSuccess.beta, "2026-08-20");
});

test("отметка не едет назад: прошлое значение новее кандидата — берём прошлое", () => {
  // Часы раннера уехали, файл починили руками, маркер откатили — свежесть
  // обязана быть монотонной, иначе тревогу можно случайно «вылечить» назад.
  const prev = { lastSuccess: { weekly: "2026-08-22" }, firstSeen: {} };
  const f = computeFreshness(prev, all("unknown"), { weekly: "2026-08-01" }, DAY, REG);
  assert.equal(f.lastSuccess.weekly, "2026-08-22");
});

test("маркер чужого воркфлоу становится отметкой", () => {
  // tracks бежит в своём воркфлоу: health.ts его outcome не видит и читает
  // файл-отметку, которую продьюсер оставил рядом со своими данными.
  const f = computeFreshness(undefined, all("unknown"), { weekly: "2026-08-24" }, DAY, REG);
  assert.equal(f.lastSuccess.weekly, "2026-08-24");
  assert.equal(f.firstSeen.weekly, undefined, "успех был — точка отсчёта больше не нужна");
});

test("мусор в накопленном файле не считается отметкой и не роняет прогон", () => {
  const prev = { lastSuccess: { alpha: "вчера", beta: 20260820, weekly: null }, firstSeen: "сломано" };
  const f = computeFreshness(prev as never, all("unknown"), {}, DAY, REG);
  assert.deepEqual(f.lastSuccess, {}, "битые значения отброшены");
  // Точка отсчёта заводится заново — сегодня, залпа тревог нет.
  assert.deepEqual(f.firstSeen, { alpha: DAY, beta: DAY, weekly: DAY });
  assert.deepEqual(staleKeys(f), []);
});

test("ключи вне реестра выпадают — переименование не тащит мёртвую запись", () => {
  const prev = { lastSuccess: { alpha: "2026-08-24", ушёл: "2026-01-01" }, firstSeen: {} };
  const f = computeFreshness(prev, all("unknown"), {}, DAY, REG);
  assert.deepEqual(Object.keys(f.lastSuccess), ["alpha"]);
});

// MARK: - unknown (локальный прогон)

test("unknown не обновляет отметку и не теряет её", () => {
  const prev = { lastSuccess: { alpha: "2026-08-20", beta: "2026-08-20", weekly: "2026-08-19" }, firstSeen: {} };
  const f = computeFreshness(prev, all("unknown"), {}, DAY, REG);
  assert.deepEqual(f.lastSuccess, prev.lastSuccess, "локальный прогон оставляет накопленное как есть");
});

test("локальный прогон подряд ничего не меняет и не поднимает тревогу", () => {
  // `npm run health` без env: все outcome=unknown. Ограничение — такой прогон
  // не имеет права ни портить lastSuccess, ни начинать кричать.
  let state: { lastSuccess: Stamps; firstSeen: Stamps } =
    { lastSuccess: { alpha: DAY, beta: DAY, weekly: DAY }, firstSeen: {} };
  for (let i = 0; i < 5; i++) {
    const f = computeFreshness(state, all("unknown"), {}, DAY, REG);
    assert.deepEqual(f.lastSuccess, state.lastSuccess);
    assert.deepEqual(f.firstSeen, state.firstSeen);
    assert.deepEqual(f.stale, []);
    state = { lastSuccess: f.lastSuccess, firstSeen: f.firstSeen };
  }
});

test("не-success статусы GitHub отметку не двигают", () => {
  for (const o of ["failure", "cancelled", "skipped", "unknown"] as Outcome[]) {
    const f = computeFreshness({ lastSuccess: { alpha: "2026-08-20" } }, { alpha: o }, {}, DAY, REG);
    assert.equal(f.lastSuccess.alpha, "2026-08-20", `${o} не должен считаться успехом`);
  }
});

test("skipped считается успехом ТОЛЬКО у шага, который штатно пропускается", () => {
  // Суточный шаг «Сезон N+1» на ежечасных прогонах штатно skipped. Не считать
  // это успехом — значит переворачивать его отметку в 03:37, тогда как `date`
  // переворачивается в первом прогоне после полуночи: гарантированный ВТОРОЙ
  // коммит health.json каждые сутки, то есть регресс дневной гранулярности.
  const daily = byKey("nextseason")!;
  const hourly = byKey("f1")!;
  assert.equal(normalizeOutcome(daily, "skipped"), "success");
  assert.equal(normalizeOutcome(hourly, "skipped"), "skipped", "у обычного шага skipped — не успех");
  for (const o of ["failure", "cancelled", "unknown"] as Outcome[]) {
    assert.equal(normalizeOutcome(daily, o), o, `${o} флаг подменять не должен`);
  }
});

// MARK: - Границы бюджета

test("просрочка ровно за бюджетом: бюджет−1 и бюджет молчат, бюджет+1 кричит", () => {
  const budget = REG[0].budgetDays;
  assert.equal(budget, 3);
  for (const [days, expected] of [[budget - 1, false], [budget, false], [budget + 1, true]] as const) {
    const since = addDays(DAY, -days);
    const stale = staleProducers({ alpha: since }, {}, DAY, [REG[0]]);
    assert.equal(
      stale.length > 0, expected,
      `${days} сут молчания при бюджете ${budget}: ожидалось ${expected ? "тревога" : "тишина"}`,
    );
    if (expected) {
      assert.deepEqual(stale[0], {
        producer: "alpha", days, budgetDays: budget, since, everRan: true, workflow: "w.yml",
      });
    }
  }
});

test("границы бюджета одинаковы для отметки и для точки отсчёта", () => {
  // «Ни разу не отработал» считается от firstSeen тем же бюджетом — иначе
  // неподключённый продьюсер получал бы другой (и, скорее всего, вечный) срок.
  const budget = 3;
  for (const days of [budget, budget + 1]) {
    const since = addDays(DAY, -days);
    const stale = staleProducers({}, { alpha: since }, DAY, [REG[0]]);
    assert.equal(stale.length > 0, days > budget);
    if (days > budget) assert.equal(stale[0].everRan, false);
  }
});

test("недельный бюджет терпит один потерянный понедельник", () => {
  const weekly = byKey("tracks")!;
  assert.equal(weekly.budgetDays, 14);
  const quiet = (days: number) =>
    staleProducers({ tracks: addDays(DAY, -days) }, {}, DAY, [weekly]).length === 0;
  assert.equal(quiet(7), true, "штатный максимум перед понедельничным прогоном");
  assert.equal(quiet(14), true, "один пропущенный понедельник — ещё не повод будить владельца");
  assert.equal(quiet(15), false, "пропуск, который не починился следующим понедельником");
});

test("daysBetween считает целые сутки UTC через границу месяца и года", () => {
  assert.equal(daysBetween("2026-08-24", "2026-08-24"), 0);
  assert.equal(daysBetween("2026-07-31", "2026-08-01"), 1);
  assert.equal(daysBetween("2025-12-31", "2026-01-01"), 1);
  assert.equal(daysBetween("2026-03-28", "2026-03-30"), 2, "перевод часов не должен влиять");
});

// MARK: - Первый прогон и «ни разу не запускался»

test("первый прогон без истории не даёт залпа тревог", () => {
  const f = computeFreshness(undefined, all("unknown"), {}, DAY, REG);
  assert.deepEqual(f.stale, [], "выкатка реестра не будит владельца на пустом месте");
  assert.deepEqual(f.firstSeen, { alpha: DAY, beta: DAY, weekly: DAY });
  assert.deepEqual(f.lastSuccess, {}, "успеха не было — врать про него нельзя");
});

test("точка отсчёта не переставляется на каждый прогон, а стареет", () => {
  // Если бы firstSeen переписывался сегодняшним днём, «ни разу не запускался»
  // не всплыл бы НИКОГДА — ровно та дыра, из-за которой f1teams жил 17 суток.
  const born = "2026-08-01";
  let state: { lastSuccess: Stamps; firstSeen: Stamps } = { lastSuccess: {}, firstSeen: { alpha: born } };
  for (let d = 1; d <= 5; d++) {
    const f = computeFreshness(state, { alpha: "unknown" }, {}, addDays(born, d), [REG[0]]);
    assert.equal(f.firstSeen.alpha, born);
    state = { lastSuccess: f.lastSuccess, firstSeen: f.firstSeen };
  }
  assert.equal(staleProducers({}, state.firstSeen, addDays(born, 3), [REG[0]]).length, 0);
  assert.equal(staleProducers({}, state.firstSeen, addDays(born, 4), [REG[0]]).length, 1);
});

test("после первого успеха точка отсчёта вычёркивается", () => {
  const born = { lastSuccess: {}, firstSeen: { alpha: "2026-08-01" } };
  const f = computeFreshness(born, { alpha: "success" }, {}, DAY, [REG[0]]);
  assert.deepEqual(f.firstSeen, {}, "firstSeen — только про тех, кто не отработал ни разу");
  assert.equal(f.lastSuccess.alpha, DAY);
});

// MARK: - Главное свойство: продьюсер вне воркфлоу

/// Как health.ts узнаёт исход шага: через `<KEY>_OUTCOME` в env шага health.
/// Нет шага — нет переменной — outcome "unknown". Читаем это из НАСТОЯЩЕГО
/// snapshot.yml, чтобы тест ловил реальную проводку, а не её копию.
function outcomesFromWorkflow(yml: string, registry: ProducerSpec[]): Record<string, Outcome> {
  const wired = new Set(
    [...yml.matchAll(/(\w+)_OUTCOME: \$\{\{ steps\.(\w+)\.outcome \}\}/g)].map((m) => m[2]),
  );
  const out: Record<string, Outcome> = {};
  for (const p of registry) {
    if (p.marker) continue; // отметка приходит из своего маркера, не из env
    out[p.key] = wired.has(p.key) ? "success" : "unknown";
  }
  return out;
}

test("продьюсер, которого нет в snapshot.yml, попадает в просроченные", () => {
  // Воспроизводим инцидент буквально: берём живой snapshot.yml и вырезаем из
  // него f1teams (шаг + строку гейта + строку health-env) — ровно то состояние,
  // в котором репозиторий прожил 17 суток с зелёными прогонами.
  const yml = readFileSync(SNAPSHOT_YML, "utf8")
    .replace(/^.*steps\.f1teams\.outcome.*$/gm, "")
    .replace(/^ +- name: Экран команды[\s\S]*?run: npm run f1teams$/m, "");
  const outcomes = outcomesFromWorkflow(yml, PRODUCERS);
  assert.equal(outcomes.f1teams, "unknown", "шаг вырезан — исход приходить неоткуда");
  assert.equal(outcomes.f1, "success", "остальные шаги на месте");

  const budget = byKey("f1teams")!.budgetDays;
  const start = "2026-08-07"; // день, когда f1teams появился в репозитории
  let state: { lastSuccess: Stamps; firstSeen: Stamps } | undefined;
  const seen: number[] = [];

  for (let d = 0; d <= budget + 2; d++) {
    const today = addDays(start, d);
    const f = computeFreshness(state, outcomes, markerStamps(today), today);
    state = { lastSuccess: f.lastSuccess, firstSeen: f.firstSeen };
    if (staleKeys(f).includes("f1teams")) seen.push(d);
    // Пока бюджет не вышел — тишина; и НИКОГДА не должен всплыть кто-то ещё.
    assert.deepEqual(
      staleKeys(f).filter((k) => k !== "f1teams"), [],
      `на ${d}-е сутки закричал кто-то помимо f1teams`,
    );
  }

  assert.deepEqual(seen, [budget + 1, budget + 2], `тревога должна начаться на ${budget + 1}-е сутки`);
  assert.equal(state!.firstSeen.f1teams, start, "неподключённый живёт по точке отсчёта");
  assert.equal(state!.lastSuccess.f1teams, undefined, "успеха у него не было");
});

/// Отметки ВСЕХ продьюсеров с маркером на указанный день. Литеральный
/// `{ tracks: DAY }` ломался при появлении второго такого продьюсера (weclive):
/// тест валился не на регрессии, а на расширении реестра.
function markerStamps(day: string): Stamps {
  const out: Stamps = {};
  for (const p of PRODUCERS) if (p.marker) out[p.key] = day;
  return out;
}

test("живой snapshot.yml + маркеры чужих воркфлоу: просроченных нет", () => {
  // Обратная сторона того же теста — на реальной проводке сигнал молчит,
  // иначе он был бы бесполезен.
  const yml = readFileSync(SNAPSHOT_YML, "utf8");
  const f = computeFreshness(undefined, outcomesFromWorkflow(yml, PRODUCERS), markerStamps(DAY), DAY);
  assert.deepEqual(f.stale, []);
  assert.deepEqual(f.firstSeen, {}, "все продьюсеры реестра отметились в первый же прогон");
  assert.equal(Object.keys(f.lastSuccess).length, PRODUCERS.length);
});

// MARK: - Дневная гранулярность

test("в пределах суток повторный прогон ничего не меняет", () => {
  // health.json пишется через writeIfChanged: любое изменение поля — коммит.
  // Крон часовой, значит всё, что зависит от «сейчас» точнее суток, — спам.
  const outcomes = all("success");
  let state: { lastSuccess: Stamps; firstSeen: Stamps } | undefined;
  let first = "";
  for (let i = 0; i < 24; i++) {
    const f = computeFreshness(state, outcomes, { weekly: DAY }, DAY, REG);
    const json = JSON.stringify(f);
    if (i === 0) first = json;
    else assert.equal(json, first, `прогон №${i + 1} за те же сутки изменил свежесть`);
    state = { lastSuccess: f.lastSuccess, firstSeen: f.firstSeen };
  }
});

test("utcDay огрубляет момент до суток — метка не может быть точнее", () => {
  // Единственная точка, где в свежесть попадает «сейчас». Отдай она таймстемп —
  // 21 отметка переписывалась бы каждый час, health.json давал бы ~24 коммита
  // в сутки вместо одного, и heartbeat-дисциплина (GitHub гасит scheduled
  // workflow после 60 дней без активности) превратилась бы в коммит-спам.
  const early = utcDay(new Date("2026-08-25T00:00:01Z"));
  const late = utcDay(new Date("2026-08-25T23:59:59Z"));
  assert.equal(early, "2026-08-25");
  assert.equal(early, late, "любые два момента одних суток дают одну и ту же метку");
  assert.equal(utcDay(new Date("2026-08-26T00:00:00Z")), "2026-08-26", "граница суток UTC");
  assert.equal(addDays("2026-08-25", 1), "2026-08-26");
  assert.equal(addDays("2026-01-01", -1), "2025-12-31");
});

test("отметки хранятся сутками — ни часов, ни производных от «сейчас»", () => {
  const f = computeFreshness(undefined, all("success"), { weekly: DAY }, DAY, REG);
  for (const [k, v] of Object.entries(f.lastSuccess)) {
    assert.match(v, /^\d{4}-\d{2}-\d{2}$/, `${k}: отметка обязана быть днём, а не таймстемпом`);
  }
  // Поля вроде «сколько суток прошло» в stale появляются только у просроченных
  // (норма — пустой массив), поэтому ежечасно меняться им негде.
  assert.deepEqual(f.stale, []);
});

// MARK: - Реестр как единственный источник правды

test("у каждого продьюсера в src/producers есть запись в реестре", () => {
  const files = readdirSync("src/producers")
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "health.ts");
  for (const file of files) {
    const script = file.replace(/\.ts$/, "");
    assert.ok(
      PRODUCERS.some((p) => p.script === script),
      `src/producers/${file} не объявлен в src/lib/producers.ts: без записи в реестре ` +
      `протухание этого продьюсера некому заметить`,
    );
  }
});

test("каждый скрипт реестра есть в package.json", () => {
  const scripts = new Set(Object.keys(JSON.parse(readFileSync("package.json", "utf8")).scripts ?? {}));
  for (const p of PRODUCERS) {
    if (p.script === null) continue; // составной шаг без своего скрипта
    assert.ok(scripts.has(p.script), `реестр ссылается на несуществующий скрипт «${p.script}»`);
  }
});

test("каждый шаг snapshot.yml объявлен в реестре", () => {
  // Обратное направление НЕ проверяем сознательно: запись реестра без шага —
  // это и есть сигнал, ради которого всё затевалось, и требовать здесь
  // равенства значило бы своими руками закрыть единственный детектор
  // «продьюсера забыли подключить».
  const yml = readFileSync(SNAPSHOT_YML, "utf8");
  for (const m of yml.matchAll(/^\s+id: (\w+)$/gm)) {
    assert.ok(byKey(m[1]), `шаг «${m[1]}» из snapshot.yml не объявлен в src/lib/producers.ts`);
  }
});

test("ключ реестра, env-переменная и id шага — одно пространство имён", () => {
  const yml = readFileSync(SNAPSHOT_YML, "utf8");
  for (const p of PRODUCERS) {
    if (p.marker) continue;
    assert.ok(
      yml.includes(`${envKeyFor(p.key)}: \${{ steps.${p.key}.outcome }}`),
      `«${p.key}»: в snapshot.yml нет ${envKeyFor(p.key)} от steps.${p.key} — ` +
      `отметка свежести приходить не будет`,
    );
  }
});

test("оба гейта стоят ПОСЛЕ шага коммита и с if: always()", () => {
  // Падение гейта не должно задерживать публикацию данных и heartbeat-коммит:
  // именно ежедневный коммит держит scheduled workflow живым (GitHub гасит крон
  // после 60 дней без активности репозитория). Гейт, переехавший выше коммита,
  // в межсезонье выключил бы весь бэкенд.
  const yml = readFileSync(SNAPSHOT_YML, "utf8");
  const at = (name: string) => {
    const i = yml.indexOf(`- name: ${name}`);
    assert.ok(i > 0, `шаг «${name}» пропал из snapshot.yml`);
    return i;
  };
  const commit = at("Закоммитить изменения");
  for (const gate of ["Проверка продьюсеров", "Проверка свежести данных"]) {
    assert.ok(at(gate) > commit, `гейт «${gate}» обязан стоять ПОСЛЕ шага коммита`);
    assert.match(
      yml.slice(at(gate), at(gate) + 200), /if: always\(\)/,
      `гейт «${gate}» без if: always() не отработает, когда job уже красный`,
    );
  }
});

test("бюджеты положительные, ключи уникальны, у каждого назван канал", () => {
  const keys = new Set<string>();
  for (const p of PRODUCERS) {
    assert.ok(!keys.has(p.key), `дубль ключа «${p.key}» в реестре`);
    keys.add(p.key);
    assert.ok(p.budgetDays >= 1, `«${p.key}»: бюджет должен быть ≥1 суток`);
    assert.match(p.workflow, /^\.github\/workflows\/[\w-]+\.yml$/, `«${p.key}»: канал указан неверно`);
  }
});

test("маркерные продьюсеры не попадают в producers и коммитятся своим воркфлоу", () => {
  const yml = readFileSync(SNAPSHOT_YML, "utf8");
  for (const p of PRODUCERS) {
    if (!p.marker) continue;
    // Иначе приложение красило бы их в сломанные: SnapshotHealthView
    // фильтрует producers по `!= "success"`, а через env они вечный unknown.
    assert.ok(!yml.includes(`steps.${p.key}.outcome`), `«${p.key}» не должен идти через env snapshot.yml`);
    const own = readFileSync(p.workflow, "utf8");
    assert.ok(own.includes(`npm run ${p.script}`), `${p.workflow} не зовёт «${p.script}»`);
    // Маркер обязан лежать под путём, который этот воркфлоу коммитит.
    const dir = p.marker.split("/")[0];
    assert.ok(own.includes(`paths: data/${dir}`), `${p.workflow} не коммитит data/${dir} — маркер не доедет`);
  }
});

// MARK: - Совместимость с приложением

test("health.json остаётся декодируемым приложением после добавления полей", () => {
  // Swift-модель SnapshotHealthReport — синтезированный Codable по четырём
  // ключам (schemaVersion/date/producers/counts) без CodingKeys: лишние
  // верхнеуровневые ключи он игнорирует, но форму этих четырёх менять нельзя —
  // producers обязан остаться [String: String], иначе `try?` вернёт nil и
  // дебаг-секция молча погаснет.
  const h = JSON.parse(readFileSync("data/health.json", "utf8"));
  assert.equal(h.schemaVersion, 1);
  assert.match(h.date, /^\d{4}-\d{2}-\d{2}$/);
  for (const v of Object.values(h.producers)) assert.equal(typeof v, "string");
  for (const v of Object.values(h.counts)) assert.equal(typeof v, "number");
  assert.deepEqual(readStamps(h.lastSuccess), h.lastSuccess ?? {}, "lastSuccess — только дни UTC");
});
