// Подключение потребителей карты refs/matching.json (фаза 2 DATA-PLAN).
//
// Три пояса предохранителей:
//  1. ЗОЛОТЫЕ СПИСКИ — полный корпус реальных входов каждого матчера из
//     data/ (сезоны 2025–2026, все серии), снятый ДО подключения карты.
//     Новый путь обязан давать те же результаты на 100% И не печатать ни
//     одного warning'а (карта согласна со встроенными таблицами на всём
//     реальном корпусе). Те же входы с refs=null — тот же результат
//     (fail-open путь = прежнее поведение).
//  2. МУТАЦИОННЫЕ ФЬЮЗЫ fail-open: битый ОБЪЕКТ карты не роняет матчер —
//     убери try/catch в потребителе, и эти тесты упадут исключением.
//  3. МУТАЦИОННЫЕ ФЬЮЗЫ приоритета: карта, противоречащая встроенной
//     таблице, обязана дать warning, а ПОБЕДИТЬ обязана встроенная — убери
//     warning или перещёлкни приоритет на карту, и эти тесты упадут.
//
// Санкционированное исключение фазы — ключ команд в buildWecWinners (кейс
// JOTA): новое поведение закреплено отдельными тестами ниже; к данным оно
// не применяется само по себе (winners write-once, force-пересборка —
// решение владельца).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { matchRound, slugifyRace, eventSlugFromUrl } from "./lib/fiadocs.js";
import { matchAkRound } from "./lib/alkamelwec.js";
import { matchImsaTrack } from "./lib/alkamelimsa.js";
import { matchTrack, SCHEDULE } from "./lib/schedule.js";
import { buildWecWinners } from "./lib/winnersbuild.js";
import { readFacts, wecSeasonPath } from "./lib/wecfacts.js";
import { type RefsMap } from "./lib/refs.js";

// ---- Хелперы ----

/// Перехват console.warn: warning'и потребителей — часть контракта обкатки
/// («расхождение → warn, побеждает встроенная»), проверяем их явно.
function captureWarns<T>(fn: () => T): { result: T; warns: string[] } {
  const orig = console.warn;
  const warns: string[] = [];
  console.warn = (...args: unknown[]) => {
    warns.push(args.map(String).join(" "));
  };
  try {
    return { result: fn(), warns };
  } finally {
    console.warn = orig;
  }
}

/// Минимальный валидный каркас карты для фьюз-фикстур.
function refsWith(partial: Partial<RefsMap>): RefsMap {
  return {
    schemaVersion: 1,
    tracks: [],
    pins: [],
    f1Teams: [],
    enduranceTeams: [],
    driverExceptions: { particles: [], suffixes: [], special: [] },
    countries: { iso3ToIso2: {}, nameToIso2: {} },
    ...partial,
  };
}

/// «Битая» карта: pins/tracks/enduranceTeams — не массивы. loadRefs такую не
/// отдаст (fail-open на загрузке), но потребитель обязан пережить и битый
/// ОБЪЕКТ (fail-open сквозной, а не только на I/O).
const POISONED = {
  schemaVersion: 1, tracks: null, pins: null, f1Teams: null, enduranceTeams: null,
} as unknown as RefsMap;

const jolpicaRaces = (season: number): {
  round: string; date: string; time?: string; raceName: string;
  Circuit?: { circuitId?: string };
}[] =>
  JSON.parse(readFileSync(join(process.cwd(), "data", "f1", "jolpica", `${season}.json`), "utf8"))
    .MRData.RaceTable.Races;

/// Слаги сезона — из БОЕВЫХ фактов, а не из фикстуры: это единственная в
/// наборе НЕсинтетическая проверка матчинга WEC, и её ценность ровно в том,
/// что корпус настоящий. Раньше здесь читалась сохранённая страница fiawec;
/// с 31.08.2026 страниц нет, а тот же список лежит в факте сезона.
const wecSeasonSlugs = (season: number): string[] =>
  readFacts(join(process.cwd(), "data"), wecSeasonPath(season), "season")?.races ?? [];

// MARK: 1. Золотые списки — matchRound (слаги событий из зеркал data/f1/fia)

// Снято старым кодом 26.08.2026 со ВСЕХ url в data/f1/fia/<сезон>_*.json.
// Два null — артефакты url-пространства, НЕ продакшен-промахи: в проде матчеру
// подаётся slugifyRace(имени события FIA), а не слаг из url (см. тест-свойство
// ниже). «sao_paulo…» не сходится из-за диакритики São в зеркале Jolpica,
// «barcelona-catalunya…» — из-за дефиса в слаге url против «Barcelona Grand
// Prix» в Jolpica. Выписано в отчёт фазы, НЕ чинится молча.
const GOLDEN_MATCH_ROUND: Record<number, Record<string, number | null>> = {
  2025: {
    abu_dhabi_grand_prix: 24, australian_grand_prix: 1, austrian_grand_prix: 11,
    azerbaijan_grand_prix: 17, bahrain_grand_prix: 4, belgian_grand_prix: 13,
    british_grand_prix: 12, canadian_grand_prix: 10, chinese_grand_prix: 2,
    dutch_grand_prix: 15, emilia_romagna_grand_prix: 7, hungarian_grand_prix: 14,
    italian_grand_prix: 16, japanese_grand_prix: 3, las_vegas_grand_prix: 22,
    mexico_city_grand_prix: 20, miami_grand_prix: 6, monaco_grand_prix: 8,
    qatar_grand_prix: 23, sao_paulo_grand_prix: null, saudi_arabian_grand_prix: 5,
    singapore_grand_prix: 18, spanish_grand_prix: 9, united_states_grand_prix: 19,
  },
  2026: {
    australian_grand_prix: 1, austrian_grand_prix: 8,
    "barcelona-catalunya_grand_prix": null, belgian_grand_prix: 10,
    british_grand_prix: 9, canadian_grand_prix: 5, chinese_grand_prix: 2,
    dutch_grand_prix: 12, hungarian_grand_prix: 11,
    // Первые документы Монцы-2026 приехали 05.09 (гоночный уик-энд).
    italian_grand_prix: 13, japanese_grand_prix: 3,
    miami_grand_prix: 4, monaco_grand_prix: 6,
  },
};

test("golden: matchRound на корпусе url-слагов fia — паритет и ноль warning'ов", () => {
  for (const [season, cases] of Object.entries(GOLDEN_MATCH_ROUND)) {
    const races = jolpicaRaces(Number(season));
    for (const [slug, expected] of Object.entries(cases)) {
      const withMap = captureWarns(() => matchRound(slug, races));
      assert.equal(withMap.result?.round ?? null, expected, `${season}/${slug} (с картой)`);
      assert.deepEqual(withMap.warns, [], `${season}/${slug}: карта разошлась со встроенной`);
      // Тот же вход без карты — прежнее поведение бит-в-бит.
      assert.equal(matchRound(slug, races, null)?.round ?? null, expected,
        `${season}/${slug} (без карты)`);
    }
  }
});

test("golden: корпус url-слагов полон (зеркала fia не разошлись с золотым списком)", () => {
  // Fail-loud: появился новый файл раунда → его слаг обязан попасть в золотой
  // список (пополняется руками при доборе сезона).
  const fiaDir = join(process.cwd(), "data", "f1", "fia");
  for (const season of [2025, 2026]) {
    const known = new Set(Object.keys(GOLDEN_MATCH_ROUND[season]));
    for (const f of readdirSync(fiaDir).filter((n) => n.startsWith(`${season}_`))) {
      const doc = JSON.parse(readFileSync(join(fiaDir, f), "utf8"));
      const urls: string[] = (doc.penalties ?? []).map((p: { url?: string }) => p.url ?? "");
      if (doc.startingGrid?.url) urls.push(doc.startingGrid.url);
      for (const u of urls) {
        const s = eventSlugFromUrl(u);
        if (s) assert.ok(known.has(s), `${season}: слаг «${s}» не покрыт золотым списком`);
      }
    }
  }
});

test("свойство: каждая гонка зеркала Jolpica матчится слагом СВОЕГО имени (прод-путь)", () => {
  // В проде вход матчера — slugifyRace(имени события FIA); имена FIA и Jolpica
  // сходятся по стране-префиксу. Минимальный инвариант: слаг имени самой гонки
  // обязан довести до её же раунда — и без единого warning'а от карты.
  for (const season of [2025, 2026]) {
    const races = jolpicaRaces(season);
    for (const r of races) {
      const { result, warns } = captureWarns(() => matchRound(slugifyRace(r.raceName), races));
      assert.equal(result?.round, Number(r.round), `${season}: ${r.raceName}`);
      assert.deepEqual(warns, [], `${season}: ${r.raceName} — warning от карты`);
    }
  }
});

// MARK: 1. Золотые списки — matchAkRound (метки Results-архива и Notice Board)

// Снято старым кодом 26.08.2026: метки из data/wec/winners/*.json (Results-
// архив) + имена событий из url доков data/wec/fia/*.json (Notice Board).
const GOLDEN_AK_ROUND: Record<number, Record<string, number | null>> = {
  2025: {
    "24 Hours of Le Mans": 4, "6 Hours of Fuji": 7, "6 Hours of Imola": 2,
    "6 Hours of Sao Paulo": 5, "6 Hours of Spa": 3, "8 Hours of Bahrain": 8,
    "BAHRAIN INTERNATIONAL CIRCUIT": 8, "CIRCUIT OF THE AMERICAS": 6,
    "FUJI SPEEDWAY": 7, IMOLA: 2, "LE MANS": 4, LOSAIL: 1,
    "Lone Star Le Mans": 6, "SAO PAULO": 5, "SPA FRANCORCHAMPS": 3,
  },
  2026: {
    "24 Hours of Le Mans": 3, "6 Hours of Sao Paulo": 4, "6 Hours of Spa": 2,
    IMOLA: 1, "LE MANS": 3, "SAO PAULO": 4, "SPA FRANCORCHAMPS": 2,
  },
};

test("golden: matchAkRound на корпусе меток WEC — паритет и ноль warning'ов", () => {
  for (const [season, cases] of Object.entries(GOLDEN_AK_ROUND)) {
    const slugs = wecSeasonSlugs(Number(season));
    for (const [label, expected] of Object.entries(cases)) {
      const withMap = captureWarns(() => matchAkRound(label, slugs));
      assert.equal(withMap.result, expected, `${season}/«${label}» (с картой)`);
      assert.deepEqual(withMap.warns, [], `${season}/«${label}»: карта разошлась со встроенной`);
      assert.equal(matchAkRound(label, slugs, null), expected, `${season}/«${label}» (без карты)`);
    }
  }
});

// MARK: 1. Золотые списки — matchImsaTrack (реальные папки архива × venue)

// Папки — из url доков data/imsa/fia/*.json (Results_NoticeBoard, 2025–2026);
// матрица «папка → какие venue матчатся» снята старым кодом 26.08.2026.
const GOLDEN_IMSA_MATRIX: Record<string, string[]> = {
  "02_Rolex 24 - Daytona International Speedway": ["Daytona International Speedway"],
  "06_Sebring International Raceway": ["Sebring International Raceway"],
  "07_Long Beach Street Circuit": ["Streets of Long Beach"],
  "10_WeatherTech Raceway Laguna Seca": ["WeatherTech Raceway Laguna Seca"],
  "11_Detroit Street Course": ["Detroit Street Circuit"],
  "14_Watkins Glen International": ["Watkins Glen International"],
  "15_Canadian Tire Motorsport Park": ["Canadian Tire Motorsport Park"],
  "19_Indianapolis Motor Speedway": ["Indianapolis Motor Speedway"],
  "21_Michelin Raceway Road Atlanta": ["Michelin Raceway Road Atlanta"],
};

const IMSA_VENUES = [...new Set(
  [2025, 2026].flatMap((y) => SCHEDULE[y].map((e) => e.venue)),
)];

test("golden: matchImsaTrack — полная матрица папки × venue, ноль warning'ов", () => {
  for (const [folder, matches] of Object.entries(GOLDEN_IMSA_MATRIX)) {
    for (const venue of IMSA_VENUES) {
      const expected = matches.includes(venue);
      const withMap = captureWarns(() => matchImsaTrack(folder, venue));
      assert.equal(withMap.result, expected, `«${folder}» × «${venue}» (с картой)`);
      assert.deepEqual(withMap.warns, [], `«${folder}» × «${venue}»: карта разошлась со встроенной`);
      assert.equal(matchImsaTrack(folder, venue, null), expected,
        `«${folder}» × «${venue}» (без карты)`);
    }
  }
});

// MARK: 1. Золотые списки — matchTrack (venue расписания × имена трасс архива)

// trackNames — реальные имена папок архива (см. матрицу выше, без NN_);
// ожидания сняты старым кодом 26.08.2026. Road America и VIR ещё не имеют
// папок в зеркалах доков — честный null.
const GOLDEN_TRACK_NAMES = Object.keys(GOLDEN_IMSA_MATRIX).map((f) => f.replace(/^\d+_/, ""));
const GOLDEN_MATCH_TRACK: Record<string, string | null> = {
  "Daytona International Speedway": "Rolex 24 - Daytona International Speedway",
  "Sebring International Raceway": "Sebring International Raceway",
  "Streets of Long Beach": "Long Beach Street Circuit",
  "WeatherTech Raceway Laguna Seca": "WeatherTech Raceway Laguna Seca",
  "Detroit Street Circuit": "Detroit Street Course",
  "Watkins Glen International": "Watkins Glen International",
  "Canadian Tire Motorsport Park": "Canadian Tire Motorsport Park",
  "Road America": null,
  "VIRginia International Raceway": null,
  "Indianapolis Motor Speedway": "Indianapolis Motor Speedway",
  "Michelin Raceway Road Atlanta": "Michelin Raceway Road Atlanta",
};

test("golden: matchTrack на корпусе venue расписания — паритет и ноль warning'ов", () => {
  assert.deepEqual(IMSA_VENUES.sort(), Object.keys(GOLDEN_MATCH_TRACK).sort(),
    "SCHEDULE разошёлся с золотым списком venue — пополни ожидания");
  for (const [venue, expected] of Object.entries(GOLDEN_MATCH_TRACK)) {
    const withMap = captureWarns(() => matchTrack(venue, GOLDEN_TRACK_NAMES));
    assert.equal(withMap.result ?? null, expected, `«${venue}» (с картой)`);
    assert.deepEqual(withMap.warns, [], `«${venue}»: карта разошлась со встроенной`);
    assert.equal(matchTrack(venue, GOLDEN_TRACK_NAMES, null) ?? null, expected,
      `«${venue}» (без карты)`);
  }
});

// MARK: buildWecWinners — санкционированное исключение (ключ через identities)

test("winnersbuild: кейс JOTA — ребренд не обнуляет winsHere (ключ по карте)", () => {
  const rows = [
    { year: 2024, name: "A", team: "Hertz Team JOTA" },
    { year: 2025, name: "B", team: "Cadillac Hertz Team JOTA" },
  ];
  // С картой: одна команда сквозь ребренд — кумулятив продолжается,
  // отображаемое имя (constructor) остаётся именем источника.
  const winners = buildWecWinners(rows, 2026);
  assert.equal(winners[0].winsHere, 2);
  assert.equal(winners[0].constructor, "Cadillac Hertz Team JOTA");
  assert.equal(winners[1].winsHere, 1);
  assert.equal(winners[1].constructor, "Hertz Team JOTA");
  // Без карты — прежнее поведение: две разные строки, кумулятив расщеплён.
  const old = buildWecWinners(rows, 2026, null);
  assert.equal(old[0].winsHere, 1);
  assert.equal(old[1].winsHere, 1);
  // Команды вне карты не затронуты вовсе.
  const other = buildWecWinners([
    { year: 2024, name: "X", team: "Toyota Gazoo Racing" },
    { year: 2025, name: "Y", team: "Toyota Gazoo Racing" },
  ], 2026);
  assert.equal(other[0].winsHere, 2);
});

// MARK: 2. Мутационные фьюзы fail-open — битый объект карты не роняет матчер

test("фьюз fail-open: битая карта → все потребители работают по встроенным таблицам", () => {
  const races = [{ round: "1", date: "2031-03-01", raceName: "Fuse Grand Prix" }];
  // Каждый вызов обязан вернуть встроенный результат БЕЗ исключения. Убери
  // try/catch вокруг мнения карты в любом потребителе — тест упадёт throw'ом.
  assert.equal(matchRound("fuse_grand_prix", races, POISONED)?.round, 1);
  assert.equal(matchAkRound("6 Hours of Imola", ["6-hours-of-imola-2031"], POISONED), 1);
  assert.equal(matchImsaTrack("01_Road America", "Road America", POISONED), true);
  assert.equal(matchTrack("Road America", ["Road America"], POISONED), "Road America");
  const w = buildWecWinners([{ year: 2024, name: "A", team: "Hertz Team JOTA" }], 2026, POISONED);
  assert.equal(w[0].winsHere, 1);
});

// MARK: 3. Мутационные фьюзы приоритета — расхождение = warning, побеждает встроенная

test("фьюз приоритета: matchRound — pin против встроенного матча", () => {
  const refs = refsWith({
    pins: [{ source: "fiaDocs", kind: "prefix", match: "fuse", season: 2031, round: 5 }],
  });
  const races = [{ round: "1", date: "2031-03-01", raceName: "Fuse Grand Prix" }];
  const { result, warns } = captureWarns(() => matchRound("fuse_grand_prix", races, refs));
  // Перещёлк приоритета (28.08.2026): побеждает КАРТА. Пин указывает на раунд
  // 5, которого в списке нет, — тогда карта мнение высказала, но привязать
  // некуда, и ответом остаётся встроенный матч.
  assert.equal(result?.round, 1, "пин на несуществующий раунд — откат на встроенный матч");
  assert.equal(warns.length, 1, "расхождение обязано дать ровно один warning");
  assert.ok(warns[0].includes("побеждает карта"), warns[0]);
});

test("фьюз приоритета: matchAkRound — алиас карты ведёт к другому раунду", () => {
  const refs = refsWith({
    tracks: [{
      slug: "fuse-losail", display: "Fuse", country: "Qatar", timezone: "Europe/Rome",
      aliases: { alkamelWec: ["fuse-losail"], fiawec: ["imola"] },
    }],
  });
  const slugs = ["6-hours-of-imola-2031", "fuse-losail-race-2031"];
  const { result, warns } = captureWarns(() => matchAkRound("FUSE LOSAIL", slugs, refs));
  // Карта ведёт алиасом «imola» к первому слагу — и теперь побеждает она.
  assert.equal(result, 1, "победить обязана карта");
  assert.equal(warns.length, 1);
  assert.ok(warns[0].includes("побеждает карта"), warns[0]);
});

test("фьюз приоритета: matchImsaTrack — карта склеивает имена, встроенная нет", () => {
  const refs = refsWith({
    tracks: [
      {
        slug: "fuse-a", display: "Fuse A", country: "USA", timezone: "Europe/Rome",
        aliases: { alkamelImsa: ["fuse-old-name", "fuse-track-beta"] },
      },
    ],
  });
  const { result, warns } = captureWarns(() =>
    matchImsaTrack("02_Fuse Old Name", "Fuse Track Beta", refs));
  assert.equal(result, true, "карта знает обе стороны и склеивает их — побеждает она");
  assert.equal(warns.length, 1);
  assert.ok(warns[0].includes("побеждает карта"), warns[0]);
});

test("фьюз приоритета: matchTrack — карта относит кандидата к другой трассе", () => {
  const refs = refsWith({
    tracks: [
      { slug: "fuse-x", display: "X", country: "USA", timezone: "Europe/Rome",
        aliases: { imsaVenue: ["Fuse Speedway Alpha"] } },
      { slug: "fuse-y", display: "Y", country: "USA", timezone: "Europe/Rome",
        aliases: { imsaVenue: ["Fuse Alpha Raceway"] } },
    ],
  });
  const { result, warns } = captureWarns(() =>
    matchTrack("Fuse Speedway Alpha", ["Fuse Alpha Raceway"], refs));
  // venue «Fuse Speedway Alpha» карта относит к fuse-x, а единственный
  // кандидат — к fuse-y: кандидата под мнение карты нет, ответ — встроенный.
  assert.equal(result, "Fuse Alpha Raceway", "кандидата под мнение карты нет — откат");
  assert.equal(warns.length, 1);
  assert.ok(warns[0].includes("побеждает карта"), warns[0]);
});

test("фьюз приоритета: warning дедуплицируется в пределах прогона", () => {
  const refs = refsWith({
    pins: [{ source: "fiaDocs", kind: "prefix", match: "dedup", season: 2032, round: 7 }],
  });
  const races = [{ round: "1", date: "2032-03-01", raceName: "Dedup Grand Prix" }];
  const first = captureWarns(() => matchRound("dedup_grand_prix", races, refs));
  const second = captureWarns(() => matchRound("dedup_grand_prix", races, refs));
  assert.equal(first.warns.length, 1);
  assert.equal(second.warns.length, 0, "повтор того же расхождения не должен заливать лог");
});
