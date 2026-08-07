// Сборка карточек блока SPORT MILESTONES: курируемые углы (milestone /
// firstPast / rate / chase), автоскан решётки и взятые на днях рубежи.
// Главное, что проверяем — автоматика показа и скрытия: догнал цель, взял
// рубеж, ушёл из решётки, наследник погони.

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { buildCards, groupById, type RecordEvent, type Subject } from "./producers/f1records.js";

const sub = (code: string, teamId: string, number: string | null = "1",
             family?: string, given?: string): Subject => ({
  code, driver: `${code[0]}. ${code}`, number, teamId, family, given,
});
const team = (id: string, name: string): Subject => ({
  code: id, driver: name, number: null, teamId: id, family: name, team: true,
});

const NOW = Date.parse("2026-08-07T12:00:00Z");
const opts = (extra: Record<string, unknown> = {}) => ({ now: NOW, ...extra });

test("вау-углы держателей + погони", () => {
  const S: Record<string, Subject | null> = {
    alonso: sub("ALO", "aston_martin", "14", "Alonso"),
    hamilton: sub("HAM", "ferrari", "44", "Hamilton"),
    max_verstappen: sub("VER", "red_bull", "3", "Verstappen"),
  };
  const V: Record<string, number | null> = {
    "alonso:starts": 438,
    "hamilton:wins": 106,
    "hamilton:podiums": 207,
    "hamilton:starts": 390,
    "max_verstappen:wins": 71,
    "max_verstappen:podiums": 130,
  };
  const cards = buildCards(V, S, opts());
  const by = (id: string) => cards.find((c) => c.id === id)!;

  // milestone — цифры по углам (438 слева, 450 справа), имя в шапке.
  const gp = by("held-alonso-Grands Prix");
  assert.equal(gp.header, "MILESTONE");
  assert.equal(gp.driver, "#14 A. ALO");
  assert.equal(gp.title, "438 GRANDS PRIX");
  assert.match(gp.note, /12 more for a landmark 450/);
  assert.equal(gp.barLeft, "438");
  assert.equal(gp.barRight, "450");
  // Ключ против дубля с юбилейной карточкой f1milestones на тот же старт.
  assert.equal(gp.dedupKey, "gp-450-alonso");

  // firstPast — единственный за порогом, имя в шапке.
  const wins = by("held-hamilton-wins");
  assert.equal(wins.header, "RECORD");
  assert.equal(wins.driver, "#44 H. HAM"); // sub строит «H. HAM» из кода
  assert.match(wins.note, /only driver.*pass 100 wins/i);

  // rate — доля подиумных гонок > половины.
  const pod = by("held-hamilton-podiums");
  assert.match(pod.note, /more than half/i);
  assert.equal(pod.barRight, "207/390");
  assert.ok(pod.progress > 0.5 && pod.progress < 0.6);

  // chase — цифры по углам (71 → 91), имя в шапке.
  const chase = by("chase-max_verstappen-wins");
  assert.equal(chase.header, "CHASING");
  assert.equal(chase.driver, "#3 V. VER");
  assert.match(chase.note, /20 wins from passing Michael Schumacher’s 91/);
  assert.equal(chase.barLeft, "71");
  assert.equal(chase.barRight, "91");

  // Погоня за живым рекордом ждёт своей очереди: пока цела зафиксированная,
  // второй карточки по той же метрике у того же пилота нет.
  assert.equal(cards.filter((c) => c.id.startsWith("chase-max_verstappen-wins")).length, 1);

  // Все id уникальны — иначе ForEach в карусели ведёт себя непредсказуемо.
  assert.equal(new Set(cards.map((c) => c.id)).size, cards.length);
});

test("погоня достигнута/пройдена — карточки нет", () => {
  const S = { max_verstappen: sub("VER", "red_bull", "3", "Verstappen") };
  const V = { "max_verstappen:wins": 91, "max_verstappen:podiums": 200 };
  const cards = buildCards(V, S, opts()).filter((c) => c.id.startsWith("chase"));
  assert.equal(cards.length, 0);
});

test("наследник: рекорд пал — включается погоня за живым держателем", () => {
  const S: Record<string, Subject | null> = {
    max_verstappen: sub("VER", "red_bull", "3", "Verstappen"),
    hamilton: sub("HAM", "ferrari", "44", "Hamilton"),
  };
  const V = { "max_verstappen:wins": 92, "hamilton:wins": 106 };
  const chase = buildCards(V, S, opts()).find((c) => c.id === "chase-max_verstappen-wins")!;
  assert.ok(chase, "после 91-й победы должна включиться следующая погоня");
  assert.match(chase.note, /14 wins behind Lewis Hamilton/);
  assert.equal(chase.barRight, "106");
});

test("автоскан: цифры на полоске, смысл в подписи", () => {
  // Заголовок и полоска уже говорят «9 из 10» — подпись обязана добавлять
  // то, чего в них нет, и оставаться про ТУ ЖЕ метрику.
  const S = { leclerc: sub("LEC", "ferrari", "16", "Leclerc", "Charles") };
  const V = { "leclerc:wins": 9 };
  const card = buildCards(V, S, opts({
    season: 2026,
    tempo: { "leclerc:wins": { thisSeason: 1, firstSeason: 2019, lastSeason: 2026 } },
  })).find((c) => c.id === "near-leclerc-wins")!;
  assert.equal(card.header, "CLOSING IN");
  assert.equal(card.title, "9 WINS");
  assert.equal(card.barLeft, "9");
  assert.equal(card.barRight, "10");
  assert.ok(Math.abs(card.progress - 0.9) < 1e-9);
  assert.equal(card.note,
    "One of Charles Leclerc’s nine wins came this season — the first of them back in 2019.");
  assert.ok(!card.note.includes("10"), "разрыв до рубежа уже нарисован полоской");
});

test("подпись: засуха считается только от двух сезонов", () => {
  const S = { alonso: sub("ALO", "aston_martin", "14", "Alonso", "Fernando") };
  const V = { "alonso:poles": 23 };
  const dry = buildCards(V, S, opts({
    season: 2026,
    tempo: { "alonso:poles": { thisSeason: 0, firstSeason: 2003, lastSeason: 2012 } },
  }))[0];
  assert.equal(dry.note,
    "Fernando Alonso has gone 14 seasons without one — number 25 has been waiting since 2012.");

  // Прошлый сезон — это не ожидание: подавать его драмой нечестно, уходим
  // на запасной угол (место на решётке; конкурентов нет → он первый).
  const fresh = buildCards(V, S, opts({
    season: 2026,
    tempo: { "alonso:poles": { thisSeason: 0, firstSeason: 2003, lastSeason: 2025 } },
  }))[0];
  assert.ok(!fresh.note.includes("without one"));
  assert.match(fresh.note, /more poles than anyone else on the current grid/);
});

test("подпись: место на решётке считается по строго большим", () => {
  const S: Record<string, Subject | null> = {
    hamilton: sub("HAM", "ferrari", "44", "Hamilton", "Lewis"),
    max_verstappen: sub("VER", "red_bull", "3", "Verstappen", "Max"),
    leclerc: sub("LEC", "ferrari", "16", "Leclerc", "Charles"),
    piastri: sub("PIA", "mclaren", "81", "Piastri", "Oscar"),
  };
  // У Пиастри столько же поулов, сколько у Леклера: равный счёт «впереди» не
  // ставит — иначе вышло бы «отстаёт на 0 поулов».
  const V = {
    "hamilton:poles": 107, "max_verstappen:poles": 51,
    "leclerc:poles": 24, "piastri:poles": 24,
  };
  const cards = buildCards(V, S, opts({ season: 2026 }));
  const lec = cards.find((c) => c.id === "near-leclerc-poles")!;
  assert.equal(lec.note,
    "Only Lewis Hamilton and Max Verstappen have more poles on the current grid: 107 and 51.");
  const pia = cards.find((c) => c.id === "near-piastri-poles")!;
  assert.ok(!pia.note.includes("behind"), "равный счёт — не отставание");
});

test("автоскан молчит, пока цель далеко", () => {
  const S = { norris: sub("NOR", "mclaren", "4", "Norris") };
  const V = { "norris:wins": 12, "norris:podiums": 47, "norris:poles": 20 };
  const ids = buildCards(V, S, opts()).map((c) => c.id);
  assert.ok(!ids.includes("near-norris-wins"), "12 побед — до 25 далеко");
  assert.ok(!ids.includes("near-norris-poles"), "20 поулов — до 25 далеко");
  assert.ok(ids.includes("near-norris-podiums"), "47 подиумов — 3 до полусотни");
});

test("автоскан видит команды", () => {
  const S = {
    "team:mclaren": team("mclaren", "McLaren"),
    "team:ferrari": team("ferrari", "Ferrari"),
  };
  const V = { "team:mclaren:wins": 199, "team:ferrari:wins": 251 };
  const card = buildCards(V, S, opts({ season: 2026 })).find((c) => c.id === "near-team:mclaren-wins")!;
  assert.equal(card.driver, "McLaren");     // у команды нет номера — без «#»
  assert.equal(card.title, "199 WINS");
  // У команды свой оборот: «на решётке» — про команды, не про пилотов.
  assert.equal(card.note,
    "Only Ferrari has more wins among the teams on the grid, with 251.");
});

test("взятый рубеж живёт 14 дней и вытесняет карточку погони за той же целью", () => {
  const S = { "team:mclaren": team("mclaren", "McLaren") };
  const V = { "team:mclaren:wins": 200 };
  const e: RecordEvent = {
    subject: "team:mclaren", metric: "wins", stat: "wins", n: 200, value: 200,
    kind: "landmark", date: "2026-07-26", race: "Hungarian Grand Prix", by: "Lando Norris",
  };
  const cards = buildCards(V, S, opts({ events: [e] }));
  const card = cards.find((c) => c.id === "event-landmark-team:mclaren-wins-200")!;
  assert.equal(card.header, "LANDMARK");
  assert.equal(card.title, "200 WINS");
  assert.equal(card.note, "McLaren’s 200th win came from Lando Norris at the Hungarian Grand Prix.");
  assert.equal(cards[0].id, card.id, "свежее событие идёт первым в карусели");

  // Та же метрика вторым голосом (near к следующей цели) — не показываем.
  assert.ok(!cards.some((c) => c.id === "near-team:mclaren-wins"));

  // Вечером самой гонки карточка уже должна быть: результаты приезжают через
  // пару часов после финиша, а не назавтра.
  const raceDay = buildCards(V, S, { now: Date.parse("2026-07-26T18:00:00Z"), events: [e] });
  assert.equal(raceDay[0].id, card.id);

  // Через две недели новость протухает и уступает место следующей цели.
  const later = buildCards(V, S, { now: Date.parse("2026-08-20T12:00:00Z"), events: [e] });
  assert.ok(!later.some((c) => c.id.startsWith("event-")));
});

test("павший рекорд подписан гонкой, на которой это случилось", () => {
  const S = { max_verstappen: sub("VER", "red_bull", "3", "Verstappen") };
  const V = { "max_verstappen:wins": 92 };
  const e: RecordEvent = {
    subject: "max_verstappen", metric: "wins", stat: "wins", n: 91, value: 92,
    kind: "chase", date: "2026-08-02", race: "Belgian Grand Prix",
    holder: "Michael Schumacher", matched: false,
  };
  const card = buildCards(V, S, opts({ events: [e] }))[0];
  assert.equal(card.header, "RECORD BROKEN");
  assert.equal(card.title, "92 WINS");
  assert.equal(card.note, "Verstappen passed Michael Schumacher’s 91 at the Belgian Grand Prix.");
});

test("юбилейный старт подписан этапом календаря", () => {
  const S = { alonso: sub("ALO", "aston_martin", "14", "Alonso") };
  const V = { "alonso:starts": 439 };
  const schedule = {
    completedRounds: 11,
    races: Array.from({ length: 23 }, (_, i) => ({ round: i + 1, raceName: `Race ${i + 1}` }))
      .map((r) => (r.round === 22 ? { round: 22, raceName: "Qatar Grand Prix" } : r)),
  };
  const card = buildCards(V, S, opts({ schedule })).find((c) => c.id === "held-alonso-Grands Prix")!;
  assert.equal(card.note, "11 more for a landmark 450, due at the Qatar Grand Prix.");
});

test("субъект ушёл из решётки — его карточек нет", () => {
  const cards = buildCards({ "alonso:starts": 438 }, {}, opts());
  assert.equal(cards.length, 0);
});

test("нет знаменателя — карточки доли нет, а не «половина из 0 гонок»", () => {
  const S = { hamilton: sub("HAM", "ferrari", "44", "Hamilton") };
  // Запрос стартов не ответил: подиумы есть, делить не на что.
  const cards = buildCards({ "hamilton:podiums": 207, "hamilton:starts": null }, S, opts());
  assert.ok(!cards.some((c) => c.note.includes("of his 0")), "нельзя печатать «0 Grands Prix»");
  assert.ok(!cards.some((c) => c.id === "held-hamilton-podiums"));
});

test("мелкий рубеж команды не проходит и как новость", () => {
  const S = { "team:cadillac": team("cadillac", "Cadillac") };
  const V = { "team:cadillac:wins": 10 };
  const e: RecordEvent = {
    subject: "team:cadillac", metric: "wins", stat: "wins", n: 10, value: 10,
    kind: "landmark", date: "2026-08-02", race: "Belgian Grand Prix", by: "A. Driver",
  };
  // Порог значимости у команд — 50 побед: и в автоскане, и в новостях.
  assert.equal(buildCards(V, S, opts({ events: [e] })).length, 0);
});

test("мелкие рубежи команд не показываем — у бренда история длиннее сущности", () => {
  // Jolpica считает подиумы Aston Martin с 2021-го (до этого Racing Point):
  // «десятый подиум» формально верен, а читается как неправда.
  const S = { "team:aston_martin": team("aston_martin", "Aston Martin") };
  const V = { "team:aston_martin:podiums": 9 };
  assert.equal(buildCards(V, S, opts()).length, 0);

  // У пилота та же цифра — нормальная веха.
  const driver = buildCards({ "piastri:wins": 9 }, { piastri: sub("PIA", "mclaren", "81", "Piastri") }, opts());
  assert.equal(driver.length, 1);
});

test("квота автоскана и потолок блока", () => {
  const S: Record<string, Subject | null> = {};
  const V: Record<string, number | null> = {};
  for (let i = 0; i < 20; i++) {
    S[`d${i}`] = sub(`D${i}`, "ferrari", `${i + 1}`, `D${i}`);
    V[`d${i}:wins`] = 9;                     // все в одном шаге от десятки
  }
  // Каталог проекта держит квоту автоскана: карусель не должна выродиться в
  // десяток одинаковых «вот-вот».
  assert.equal(buildCards(V, S, opts()).length, 5);

  const scan = { metrics: ["wins"] as const, maxNear: 20, maxCards: 10 };
  const catalog = { held: [], chases: [], scan: { ...scan, metrics: ["wins" as const] } };
  assert.equal(buildCards(V, S, opts({ catalog })).length, 10);
  assert.equal(buildCards(V, S, opts({ catalog, maxCards: 3 })).length, 3);
});

test("поулы — только пилотам: квалификаций до 1994 в базе нет", () => {
  // У команды цифра была бы обрезана втрое (у Феррари 105 вместо ~250),
  // поэтому poles в её наборе метрик отсутствует.
  const S = { "team:ferrari": team("ferrari", "Ferrari") };
  const cards = buildCards({ "team:ferrari:poles": 105 }, S, opts());
  assert.ok(!cards.some((c) => c.id.includes("poles")));

  // У пилота — считаем: вся карьера внутри окна данных.
  const driver = buildCards({ "leclerc:poles": 24 },
                            { leclerc: sub("LEC", "ferrari", "16", "Leclerc") }, opts());
  assert.equal(driver[0].id, "near-leclerc-poles");
});

test("исторические id команды склеиваются по префиксу", () => {
  // «McLaren-Ford» 1970-х — та же McLaren: без склейки 200 побед вместо 204.
  const g = groupById(["mclaren", "mclaren-ford", "mclaren-brm", "ferrari", "red_bull"]);
  assert.deepEqual(g["mclaren"], ["mclaren", "mclaren-ford", "mclaren-brm"]);
  assert.ok(!("ferrari" in g), "одиночный id группой не становится");
  assert.ok(!("mclaren-ford" in g), "id-с-мотором сам группу не образует");
});
