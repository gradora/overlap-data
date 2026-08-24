// Экран команды. Три предохранителя, каждый заведён по своему инциденту:
//
//  1. carryStale/assembleSeason — прогон ДОПОЛНЯЕТ файл. 429 от Jolpica на
//     любой странице выборки давал `?? []`, и обнулённая команда (пустая
//     форма → в приложении нет блока «On graph») уезжала в коммит зелёным
//     шагом. Теперь несобранное берётся из прежнего файла, а если брать
//     неоткуда — файл не переписывается вовсе.
//  2. buildPits — пит считается только на этапах СВОЕЙ команды: номер машины
//     переезжает вместе с пилотом, и пит Лоусона в Китае (тогда rb) лежал
//     в карточках и rb, и red_bull.
//  3. buildComebacks — камбэк только у доехавшего: `position` есть и у
//     сошедшего (R12 2026: Боттас grid 21 → position 18, positionText «R»).

import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  assembleSeason, buildComebacks, buildPits, carryStale, emptiedSelections,
  isClassifiedFinish, roundsByDriver, type SeasonRound, type TeamDriverForm,
  type TeamPage,
} from "./producers/f1teams.js";

// ── Фикстуры ────────────────────────────────────────────────────────────────

const driver = (
  driverId: string, number: string, rounds: number[],
  over: Partial<TeamDriverForm> = {},
): TeamDriverForm => ({
  driverId,
  code: driverId.slice(0, 3).toUpperCase(),
  number,
  name: driverId,
  results: rounds.map((round) => ({ round, race: `R${round}`, position: 5, status: "Finished" })),
  sprintWins: 0,
  qualiWins: 0,
  ...over,
});

const page = (over: Partial<TeamPage> = {}): TeamPage => ({
  constructorId: "rb",
  name: "Racing Bulls",
  position: 5,
  points: 66,
  gp: { starts: 24, wins: 0, podiums: 1, poles: 0, fastestLaps: 1, points: 66 },
  sprint: { starts: 4, wins: 0, podiums: 0, poles: 0, fastestLaps: 0, points: 3 },
  form: [driver("lawson", "30", [1, 2]), driver("arvid_lindblad", "37", [1, 2])],
  alsoIn: [],
  firstSeason: 1985,
  allTime: { wins: 2, titles: 0 },
  driverRecords: [{ driverId: "lawson", name: "lawson", wins: 1 }],
  comebacks: [{ driverId: "lawson", code: "LAW", name: "lawson", value: "P14 → P7", detail: "7", event: "R2" }],
  pits: [{ driverId: "lawson", code: "LAW", name: "lawson", value: "2.500", event: "R2" }],
  ...over,
});

/// Пустая карточка — ровно то, что собиралось из `?? []` при отказе выборки.
const zeroed = (): TeamPage => page({
  gp: { starts: 0, wins: 0, podiums: 0, poles: 0, fastestLaps: 0, points: 0 },
  sprint: { starts: 0, wins: 0, podiums: 0, poles: 0, fastestLaps: 0, points: 0 },
  form: [], comebacks: [], pits: [], driverRecords: [],
});

const result = (over: Record<string, unknown> = {}) => ({
  grid: "21", position: "18", positionText: "18", status: "Finished",
  Driver: { driverId: "bottas" },
  ...over,
});

const race = (round: number, results: any[]) =>
  ({ round: String(round), raceName: `R${round}`, Results: results });

// ── Дефект 1: отказ выборки не обнуляет команду ─────────────────────────────

test("carryStale: отказ выборки результатов возвращает прежний сезонный блок", () => {
  const prev = page();
  const { page: out, carried, missing } = carryStale(zeroed(), prev, { results: true });

  assert.deepEqual(missing, []);
  assert.equal(carried.length, 1);
  assert.match(carried[0], /сезонный блок/);
  // Главное: не нули. Форма на месте (иначе экран теряет «On graph»),
  // свод, камбэки, питы и рекорды пилотов — тоже.
  assert.deepEqual(out.gp, prev.gp);
  assert.deepEqual(out.sprint, prev.sprint);
  assert.deepEqual(out.form, prev.form);
  assert.deepEqual(out.comebacks, prev.comebacks);
  assert.deepEqual(out.pits, prev.pits);
  assert.deepEqual(out.driverRecords, prev.driverRecords);
  // Команда остаётся в выдаче — иначе экран теряет секцию целиком.
  assert.equal(out.constructorId, "rb");
});

test("carryStale: первый сбор — переносить неоткуда, и это видно вызывающему", () => {
  const { carried, missing } = carryStale(zeroed(), undefined, { results: true });
  assert.deepEqual(carried, []);
  assert.equal(missing.length, 1);

  // Прежняя карточка есть, но пустая (её саму собрали в отказ) — то же самое.
  const empty = carryStale(zeroed(), zeroed(), { results: true });
  assert.deepEqual(empty.carried, []);
  assert.equal(empty.missing.length, 1);
});

test("carryStale: первый сбор без зеркала зачёта не блокирует файл", () => {
  // Январь на переходе сезона: файла нет, зеркало зачёта ещё про прошлый год.
  // `position: null` + `points: 0` — «зачёт ещё не открыт», это честно и
  // записывается; блокировать ими первый сбор значит не создать файл вовсе.
  const fresh = page({ position: null, points: 0 });
  const first = carryStale(fresh, undefined, { standings: true });
  assert.deepEqual(first.missing, [], "место и очки первый сбор не блокируют");
  assert.deepEqual(first.carried, []);
  assert.equal(first.page.position, null);
  assert.equal(first.page.points, 0);

  const rounds: SeasonRound[] = [{ round: 1, code: "AUS", race: "Australian Grand Prix" }];
  const season = assembleSeason(2027, rounds, [first]);
  assert.ok(season.file, "файл первого сбора обязан создаться");
  assert.equal(season.file!.teams[0].position, null);
  assert.equal(season.file!.teams[0].points, 0);

  // Прежнее значение точнее «не знаем» — пока оно есть, берём его.
  const withPrev = carryStale(fresh, page({ position: 4, points: 200 }), { standings: true });
  assert.equal(withPrev.page.points, 200);
  assert.deepEqual(withPrev.missing, []);

  // Послабление ровно одно: всё, что читается с экрана как факт, первый сбор
  // по-прежнему блокирует — «0 побед» от правды не отличить.
  for (const stale of [{ results: true }, { allTime: true }, { driverWins: true }, { facts: true }]) {
    assert.equal(assembleSeason(2027, rounds, [carryStale(fresh, undefined, stale)]).file, null,
      `${JSON.stringify(stale)} обязан блокировать первый сбор`);
  }
});

test("carryStale: у каждого источника свой набор полей", () => {
  const prev = page({
    position: 4, points: 200,
    gp: { starts: 24, wins: 3, podiums: 9, poles: 5, fastestLaps: 2, points: 200 },
    sprint: { starts: 4, wins: 1, podiums: 2, poles: 1, fastestLaps: 0, points: 12 },
    form: [driver("lawson", "30", [1, 2], { sprintWins: 1, qualiWins: 2 })],
    firstSeason: 1985,
    allTime: { wins: 77, titles: 4 },
    driverRecords: [{ driverId: "lawson", name: "lawson", wins: 9 }],
    home: { circuitId: "monza", name: "Monza", wins: 6, poles: 3 },
  });
  const fresh = page({
    form: [driver("lawson", "30", [1, 2, 3])],
    firstSeason: null,
    allTime: { wins: 0, titles: 0 },
    driverRecords: [{ driverId: "lawson", name: "lawson", wins: 0 }],
    home: { circuitId: "monza", name: "Monza", wins: 0, poles: 0 },
  });

  const sprints = carryStale(fresh, prev, { sprints: true }).page;
  assert.deepEqual(sprints.sprint, prev.sprint);
  assert.equal(sprints.form[0].sprintWins, 1);
  // Свежая часть не тронута: у отказавших спринтов своя зона ответственности.
  assert.equal(sprints.form[0].results.length, 3);
  assert.equal(sprints.form[0].qualiWins, 0);

  const quali = carryStale(fresh, prev, { quali: true }).page;
  assert.equal(quali.gp.poles, 5);
  assert.equal(quali.form[0].qualiWins, 2);
  assert.equal(quali.gp.wins, fresh.gp.wins);

  assert.equal(carryStale(fresh, prev, { allTime: true }).page.allTime.wins, 77);
  assert.equal(carryStale(fresh, prev, { titles: true }).page.allTime.titles, 4);
  assert.equal(carryStale(fresh, prev, { firstSeason: true }).page.firstSeason, 1985);
  assert.deepEqual(carryStale(fresh, prev, { home: true }).page.home,
    { circuitId: "monza", name: "Monza", wins: 6, poles: 3 });
  assert.equal(carryStale(fresh, prev, { driverWins: true }).page.driverRecords[0].wins, 9);
  assert.deepEqual(carryStale(fresh, prev, { pits: true }).page.pits, prev.pits);

  const standings = carryStale(page({ position: null, points: 0 }), prev, { standings: true }).page;
  assert.equal(standings.position, 4);
  assert.equal(standings.points, 200);
});

test("carryStale: сменившаяся домашняя трасса прежние цифры не берёт", () => {
  const prev = page({ home: { circuitId: "ricard", name: "Paul Ricard", wins: 2, poles: 1 } });
  const fresh = page({ home: { circuitId: "silverstone", name: "Silverstone", wins: 0, poles: 0 } });
  const { page: out, missing } = carryStale(fresh, prev, { home: true });
  // Цифры чужой трассы — хуже, чем не записать файл: их не отличить от правды.
  assert.equal(missing.length, 1);
  assert.equal(out.home!.wins, 0);
});

test("carryStale: новый пилот в составе — рекорды перенести нельзя", () => {
  const prev = page({ driverRecords: [{ driverId: "lawson", name: "lawson", wins: 1 }] });
  const fresh = page({
    driverRecords: [
      { driverId: "lawson", name: "lawson", wins: 0 },
      { driverId: "tsunoda", name: "tsunoda", wins: 0 },
    ],
  });
  assert.equal(carryStale(fresh, prev, { driverWins: true }).missing.length, 1);
});

test("carryStale: без отказов карточка не меняется вовсе", () => {
  const fresh = page();
  const { page: out, carried, missing } = carryStale(fresh, page({ points: 1 }), {});
  assert.deepEqual(out, fresh);
  assert.deepEqual(carried, []);
  assert.deepEqual(missing, []);
});

// ── Дефект 1б: отказ приходит и пустым 200 ──────────────────────────────────

test("emptiedSelections: пустая выборка при непустом прежнем — отказ, а не факт", () => {
  const prev = page({
    sprint: { starts: 4, wins: 0, podiums: 0, poles: 0, fastestLaps: 0, points: 3 },
    gp: { starts: 24, wins: 0, podiums: 1, poles: 2, fastestLaps: 1, points: 66 },
  });
  const all = { results: [], sprints: [], quali: [] };

  const empty = emptiedSelections(all, prev);
  assert.deepEqual(empty, {
    results: true, sprints: true, quali: true,
    labels: ["результаты", "спринты", "квалификации"],
  });

  // Ровно воспроизведённый сценарий: пустой 200 по rb/results не имеет права
  // обнулить 24 старта и 62 очка — carryStale обязан вернуть прежний блок.
  const { page: out, missing } = carryStale(zeroed(), prev, { results: empty.results });
  assert.deepEqual(missing, []);
  assert.deepEqual(out.gp, prev.gp);
  assert.equal(out.form.length, prev.form.length);

  // …и то же по mercedes/qualifying: поулы и дуэль прежние.
  const q = carryStale(page({ gp: { ...prev.gp, poles: 0 } }), prev, { quali: empty.quali }).page;
  assert.equal(q.gp.poles, 2);
});

test("emptiedSelections: у новой команды и в начале сезона пустая выборка законна", () => {
  const all = { results: [], sprints: [], quali: [] };
  // Команды нет в прежнем файле (пришла по ходу сезона) — ноль честен.
  assert.deepEqual(emptiedSelections(all, undefined).labels, []);
  // Начало сезона: прежний файл есть, но и в нём пусто.
  assert.deepEqual(emptiedSelections(all, zeroed()).labels, []);
  // Спринтов ещё не было, а гонки уже есть: отказом считается только выборка,
  // чей след в прежней карточке непустой.
  const noSprintsYet = page({ sprint: { starts: 0, wins: 0, podiums: 0, poles: 0, fastestLaps: 0, points: 0 } });
  const partial = emptiedSelections(all, noSprintsYet);
  assert.equal(partial.results, true);
  assert.equal(partial.sprints, false);
  // Поулов у команды нет ни одного, но квали-дуэль ездилась — это тоже след.
  const noPoles = page({
    gp: { starts: 24, wins: 0, podiums: 1, poles: 0, fastestLaps: 1, points: 66 },
    form: [driver("lawson", "30", [1, 2], { qualiWins: 1 })],
  });
  assert.equal(emptiedSelections(all, noPoles).quali, true);
  assert.equal(emptiedSelections(all, zeroed()).quali, false);
});

test("emptiedSelections: непустая выборка и полный отказ — не наш случай", () => {
  const prev = page();
  // Данные пришли — ничего не подменяем.
  assert.deepEqual(emptiedSelections(
    { results: [{}], sprints: [{}], quali: [{}] }, prev).labels, []);
  // null — это отказ allRaces, у него свой флаг; дважды его считать нельзя,
  // иначе в логе будет два разных объяснения одному событию.
  assert.deepEqual(emptiedSelections(
    { results: null, sprints: null, quali: null }, prev).labels, []);
});

test("assembleSeason: непокрытый отказ у одной команды отменяет запись файла", () => {
  const rounds: SeasonRound[] = [{ round: 1, code: "AUS", race: "Australian Grand Prix" }];
  const ok = carryStale(page(), page(), {});
  const blind = carryStale(zeroed(), undefined, { results: true });

  const bad = assembleSeason(2026, rounds, [ok, blind]);
  assert.equal(bad.file, null, "файл с обнулённой командой писать нельзя");
  assert.equal(bad.blocked.length, 1);
  assert.match(bad.blocked[0], /^rb: /);

  const good = assembleSeason(2026, rounds, [ok, carryStale(zeroed(), page(), { results: true })]);
  assert.ok(good.file, "перенос закрыл отказ — файл пишем");
  assert.equal(good.file!.teams.length, 2);
  assert.deepEqual(good.file!.rounds, rounds);
  assert.equal(good.blocked.length, 0);
  // Перенос обязан быть в логе прогона, иначе тихо протухнет.
  assert.equal(good.carried.length, 1);
  assert.match(good.carried[0], /^rb: сезонный блок/);

  assert.equal(assembleSeason(2026, rounds, []).file, null);
});

// ── Дефект 2: чужие этапы ───────────────────────────────────────────────────

const OPENF1: Record<string, any> = {
  "meetings?year=2026": [
    { meeting_key: 1280, date_start: "2026-03-13T03:30:00+00:00", date_end: "2026-03-15T09:00:00+00:00" },
    { meeting_key: 1292, date_start: "2026-08-21T10:30:00+00:00", date_end: "2026-08-23T16:00:00+00:00" },
  ],
  "sessions?meeting_key=1280": [
    { session_key: 11235, session_name: "Practice 1" },
    { session_key: 11245, session_name: "Race" },
  ],
  "sessions?meeting_key=1292": [{ session_key: 11390, session_name: "Race" }],
  // Китай: Лоусон (30) ехал за rb.
  "pit?session_key=11245": [
    { driver_number: 30, stop_duration: 2.5 },
    { driver_number: 37, stop_duration: 2.4 },
  ],
  // Зандворт: Лоусон уже за red_bull.
  "pit?session_key=11390": [{ driver_number: 30, stop_duration: 2.9 }],
  "pit?session_key=11235": [{ driver_number: 30, stop_duration: 1.9 }],
};

const ROUNDS: SeasonRound[] = [
  { round: 2, code: "CHN", race: "Chinese Grand Prix" },
  { round: 12, code: "NED", race: "Dutch Grand Prix" },
];
const DATES = new Map([[2, "2026-03-15"], [12, "2026-08-23"]]);
const read = (key: string) => OPENF1[key] ?? null;

test("buildPits: пит засчитан только на этапах своей команды", () => {
  // Лоусон в 2026 сменил команду по ходу сезона: R2 — rb, R12 — red_bull.
  const rb = buildPits([driver("lawson", "30", [2]), driver("arvid_lindblad", "37", [2, 12])],
    ROUNDS, 2026, DATES, read);
  const redBull = buildPits([driver("lawson", "30", [12])], ROUNDS, 2026, DATES, read);

  assert.deepEqual(rb!.map((p) => [p.driverId, p.value, p.event]), [
    ["lawson", "2.500", "Chinese Grand Prix"],
    ["arvid_lindblad", "2.400", "Chinese Grand Prix"],
  ]);
  // Тот же номер машины, но этап чужой команды — в карточку не идёт.
  assert.deepEqual(redBull!.map((p) => [p.driverId, p.value, p.event]), [
    ["lawson", "2.900", "Dutch Grand Prix"],
  ]);
  const inBoth = rb!.concat(redBull!).filter((p) => p.event === "Chinese Grand Prix" && p.driverId === "lawson");
  assert.equal(inBoth.length, 1, "пит Китая не должен двоиться по двум командам");
});

test("buildPits: свободные заезды не считаются, зеркала нет — null", () => {
  // 1.900 из «Practice 1» быстрее гоночных 2.500 — но это не пит-стоп гонки.
  const pits = buildPits([driver("lawson", "30", [2])], ROUNDS, 2026, DATES, read);
  assert.equal(pits![0].value, "2.500");

  assert.equal(buildPits([driver("lawson", "30", [2])], ROUNDS, 2026, DATES, () => null), null,
    "недоступное зеркало — «не знаем», а не «питов нет»");
  // Пустой состав — считать нечего, но это не отказ источника.
  assert.deepEqual(buildPits([], ROUNDS, 2026, DATES, read), []);
});

test("roundsByDriver: раунды формы и есть принадлежность пилота команде", () => {
  const map = roundsByDriver([driver("lawson", "30", [1, 2]), driver("tsunoda", "22", [12])]);
  assert.deepEqual([...map.get("lawson")!], [1, 2]);
  assert.deepEqual([...map.get("tsunoda")!], [12]);
});

// ── Дефект 2 (вторая болезнь): камбэк из схода ──────────────────────────────

test("isClassifiedFinish: доехал или нет", () => {
  assert.equal(isClassifiedFinish(result()), true);
  assert.equal(isClassifiedFinish(result({ status: "Lapped" })), true);
  assert.equal(isClassifiedFinish(result({ status: "+1 Lap" })), true);
  assert.equal(isClassifiedFinish(result({ status: "+2 Laps" })), true);
  // Сход: position есть (порядок в протоколе), positionText — «R».
  assert.equal(isClassifiedFinish(result({ positionText: "R", status: "Retired" })), false);
  assert.equal(isClassifiedFinish(result({ positionText: "D", status: "Disqualified" })), false);
  assert.equal(isClassifiedFinish(result({ positionText: "W", status: "Did not start" })), false);
  // Классифицирован с номером, но машина встала — тоже не финиш.
  assert.equal(isClassifiedFinish(result({ positionText: "17", status: "Retired" })), false);
});

test("buildComebacks: сошедший не камбэк, даже с номером в протоколе", () => {
  const form = [driver("bottas", "77", [11, 12])];
  const races = [
    // R11 — настоящий камбэк.
    race(11, [result({ grid: "19", position: "13", positionText: "13", status: "Lapped" })]),
    // R12 — Боттас сошёл: grid 21 → position 18, positionText «R».
    race(12, [result({ grid: "21", position: "18", positionText: "R", status: "Retired" })]),
  ];
  const out = buildComebacks(form, races);
  assert.deepEqual(out.map((b) => [b.value, b.detail, b.event]), [["P19 → P13", "6", "R11"]]);

  // Сход — единственный «прирост» за сезон: карточки просто нет.
  assert.deepEqual(buildComebacks(form, [races[1]]), []);
});

test("buildComebacks: этап чужой команды в карточку не идёт", () => {
  const form = [driver("lawson", "30", [2])];
  const races = [
    race(2, [result({ grid: "14", position: "7", positionText: "7", Driver: { driverId: "lawson" } })]),
    // Строка того же пилота с этапа, где он ехал за другую команду.
    race(12, [result({ grid: "20", position: "5", positionText: "5", Driver: { driverId: "lawson" } })]),
  ];
  assert.deepEqual(buildComebacks(form, races).map((b) => b.event), ["R2"]);
});
