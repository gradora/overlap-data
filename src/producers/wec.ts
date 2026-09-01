// Продьюсер WEC. Тянет страницы fiawec.com, разбирает их В ПАМЯТИ и кладёт на
// диск не страницу, а извлечённые ФАКТЫ (wec/facts/<slug(path)>). HTML этого
// источника не существует в репозитории ни секунды — почему именно так, см.
// шапку lib/wecfacts.ts. Перечисление URL повторяет парсеры: slugs из
// /en/season, raceId со страницы события, sessionId из resultats-1?raceId=.
//
// Тем же прогоном (без своего шага воркфлоу и записи в реестре свежести) из
// снятого зеркала собирается витрина WEC — фазы 3a и 3b DATA-PLAN:
//   wec/<год>/index.json + standings.json      — buildWecSnapshot,
//   wec/<год>/<NN>_<слаг>.json (сессии события) — buildWecEventFiles
// (порядок обязателен: файлы событий строятся из index.json этого прогона).

import { join } from "node:path";
import { isFrozen } from "../lib/freeze.js";
import { fetchText } from "../lib/mirror.js";
import { stripCountdown } from "../lib/fiawecsite.js";
import { seasonStarted } from "../lib/fiawecsite.js";
import { extractFacts } from "../lib/wecextract.js";
import {
  MAX_PRUNE_PER_RUN, pruneOrphans, readFacts, writeFacts,
  wecIndexPath, wecRacePath, wecResultsPath, wecSeasonPath, wecSessionsPath,
  wecStandingsPath, type WecFacts,
} from "../lib/wecfacts.js";
import { buildWecEventFiles } from "../lib/wecevents.js";
import { buildWecSnapshot } from "../lib/wecsnapshot.js";

const YEAR = Number(process.env.SEASON ?? new Date().getUTCFullYear());
const FIAWEC = "https://www.fiawec.com";
const DATA_DIR = join(process.cwd(), "data");
const NOW = Date.now();

/// Итог одного обращения к странице. `ok` и `facts` разведены НАМЕРЕННО:
/// у индекса результатов ветки извлечения нет вовсе, и по одному лишь
/// «фактов нет» гейт полного отказа принял бы живой сайт за мёртвый и слал
/// владельцу письмо на каждом прогоне.
interface Fetch { ok: boolean; facts: WecFacts | null; }

/// Скачать страницу, извлечь факты, записать. HTML дальше этой функции не
/// уходит — в этом и весь смысл слоя.
async function mirror(path: string): Promise<Fetch> {
  const res = await fetchText(`${FIAWEC}${path}`);
  if (!res || res.status !== 200 || !res.text) {
    console.log(`  MISS  ${path} (${res?.status ?? "net"})`);
    return { ok: false, facts: null };
  }
  const facts = extractFacts(path, stripCountdown(res.text));
  if (!facts) {
    console.log(`  ok    ${path} (без читателей — на диск не кладём)`);
    return { ok: true, facts: null };
  }
  const changed = writeFacts(DATA_DIR, path, facts);
  console.log(`  ${changed ? "write" : "same "} ${path}`);
  return { ok: true, facts };
}

// Каркасный запрос с ретраем: разовый блип fiawec (сеть/502) не должен слать
// ложный алерт-письмо через exit(1) — валим прогон только при устойчивом
// отказе (все попытки впустую).
async function mirrorFramework(path: string, attempts = 3): Promise<Fetch> {
  let last: Fetch = { ok: false, facts: null };
  for (let i = 0; i < attempts; i++) {
    last = await mirror(path);
    if (last.ok) return last;
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, 5000));
  }
  return last;
}

/// Факты страницы события, уже лежащие на диске. Заменяет прежнее чтение
/// сохранённого HTML: решение о заморозке принимается по ним же.
const raceFacts = (slug: string) => readFacts(DATA_DIR, wecRacePath(slug), "race");

async function main() {
  console.log(`WEC mirror, season ${YEAR}`);

  // Каркас: сезон (slugs), индекс результатов (нужен только как признак
  // живости сайта для гейта полного отказа — на диск не пишется), зачёт
  // производителей. raceId с индекса больше не берём —
  // он всегда отдаёт ТЕКУЩИЙ сезон, id лежат на страницах самих гонок.
  // С ретраем — от гейта exit(1) зависит алерт владельцу, разовый блип не в счёт.
  const season = await mirrorFramework(wecSeasonPath(YEAR));
  const index = await mirrorFramework(wecIndexPath());
  // Оба каркасных запроса впустую → полный отказ fiawec: валим прогон (exit 1),
  // иначе продьюсер завершится «success» при пустом входе и алерт-гейт
  // промолчит при реальном аутэйдже. Спрашивается ИМЕННО `ok`: у индекса
  // фактов не бывает по построению, и по ним гейт врал бы каждый прогон.
  if (!season.ok && !index.ok) {
    console.error("fiawec season+index недоступны — весь прогон бесполезен");
    process.exit(1);
  }
  await mirror(wecStandingsPath());

  // Слаги берём из фактов, а не из свежего HTML: страница сезона могла не
  // ответить в этом прогоне, и тогда работаем по последнему известному составу.
  const seasonFacts = season.facts?.kind === "season"
    ? season.facts
    : readFacts(DATA_DIR, wecSeasonPath(YEAR), "season");
  const slugs = seasonFacts?.races ?? [];
  // Прологи — отдельный список: в нумерацию раундов они не входят, но их
  // страницы разбираются так же.
  const tests = seasonFacts?.tests ?? [];

  // GC осиротевших race-зеркал ТЕКУЩЕГО сезона: этап выпал из страницы сезона
  // (перенос в другой год) → его файл больше никто не обновит и не прочитает.
  // Только при живой странице сезона: без неё истинный состав неизвестен.
  if (season.ok && slugs.length > 0) {
    // Прологи тоже en_race_*_<год> — без них в ожидаемом наборе GC сносил бы
    // их страницу на каждом прогоне.
    const removed = pruneOrphans(DATA_DIR, YEAR, [...slugs, ...tests]);
    if (removed === null) {
      console.warn(`::warning::wec: сирот больше ${MAX_PRUNE_PER_RUN} — похоже, ` +
        "страница сезона пришла битой; уборка пропущена, файлы не тронуты");
    } else {
      for (const f of removed) console.log(`  prune ${f} (этап выбыл из сезона ${YEAR})`);
    }
  }

  // E3 (race-страница, JSON-LD): событие с endDate+7д в прошлом ЗАМОРОЖЕНО —
  // не рескрейпим, читаем из зеркала; попутно снимаем raceId и endMs САМОГО
  // события — дальше всё считается по слагу, без матчинга по стране.
  const raceIdBySlug: Record<string, number> = {};
  const endBySlug: Record<string, number | null> = {};
  let frozenEvents = 0;
  for (const slug of slugs) {
    const existing = raceFacts(slug);
    const frozen = existing ? isFrozen(existing.info.endMs, NOW) : false;
    if (frozen) frozenEvents++;
    const fresh = frozen ? null : await mirror(wecRacePath(slug));
    const facts = (fresh?.facts?.kind === "race" ? fresh.facts : null) ?? existing;
    endBySlug[slug] = facts?.info.endMs ?? null;
    if (facts?.raceId != null) raceIdBySlug[slug] = facts.raceId;
  }

  // Страницы прологов: только расписание уик-энда (протоколов у теста нет).
  for (const slug of tests) {
    const existing = raceFacts(slug);
    if (!(existing && isFrozen(existing.info.endMs, NOW))) await mirror(wecRacePath(slug));
  }

  // Per-race результаты (E5 дропдаун сессий) + per-session (E6). Freeze по
  // endDate события (страна E2-лейбла → endMs). Сыгранное окно уже отстоялось →
  // E5/E6 не трогаем. E6 fiawec рендерит только для сыгранных сессий (будущие —
  // пустой HTML): храним только с <table.
  const started = Object.values(endBySlug).filter((v): v is number => v !== null);
  if (!seasonStarted(started, NOW)) {
    // Витрина (фазы 3a/3b) собирается и в пред-сезонье: календарь и расписания
    // уик-эндов публикуются до первого этапа (протоколов там просто нет), а
    // зачёт сам отсечётся season-guard'ом.
    console.log(`  ${buildWecSnapshot(YEAR, NOW)}`);
    console.log(`  ${buildWecEventFiles(YEAR, NOW)}`);
    console.log(
      `Done. ${slugs.length} events (${frozenEvents} frozen E3); сезон ${YEAR} не начался — E5/E6 пропущены`,
    );
    return;
  }
  let e6 = 0;
  let frozenRaces = 0;
  let skipped = 0;
  for (const slug of slugs) {
    // Всё по слагу: id гонки — со страницы события, endMs — оттуда же. Умерли
    // три подпорки под матчинг по стране: карта ISO2, ординальный фолбэк и
    // отсечка хвоста дропдауна (в нём лежали raceId чужих сезонов).
    const raceId = raceIdBySlug[slug];
    if (raceId === undefined) {
      skipped++;                       // страница события недоступна — нечего звать
      continue;
    }
    const endMs = endBySlug[slug] ?? null;
    // Заморозка = «сыграно И уже снято»: одного возраста мало, иначе архивный
    // сезон, зеркала которого ещё не снимали, никогда бы не догрузился.
    // Заморозка = «сыграно И снято ПОЛНОСТЬЮ». Полнота — это наличие МЕТКИ
    // ГОНКИ в дропдауне, а не просто непустой список: у сыгранного этапа RACE
    // есть всегда, а частично отрендеренная страница с одной практикой иначе
    // заморозила бы этап навсегда — и уик-энд молча исчез бы из витрины.
    const known = readFacts(DATA_DIR, wecSessionsPath(raceId), "sessions");
    const complete = known?.sessions.some((x) => x.label.toUpperCase().startsWith("RACE")) ?? false;
    if (isFrozen(endMs, NOW) && complete) {
      frozenRaces++;
      continue;
    }
    const e5 = await mirror(wecSessionsPath(raceId));
    const sessions = e5.facts?.kind === "sessions" ? e5.facts.sessions : (known?.sessions ?? []);
    for (const { id: sessionId } of sessions) {
      const path = wecResultsPath(raceId, sessionId);
      const res = await fetchText(`${FIAWEC}${path}`);
      // Гейт на <table — предохранитель, а не экономия трафика: будущую сессию
      // fiawec отдаёт пустой страницей, и без него мы бы записали факт с нулём
      // строк поверх настоящего протокола.
      if (res?.status === 200 && res.text.includes("<table")) {
        const facts = extractFacts(path, stripCountdown(res.text));
        if (facts?.kind === "results" && facts.rows.length > 0) {
          if (writeFacts(DATA_DIR, path, facts)) e6++;
        }
      }
    }
  }

  // Витрина фаз 3a/3b — из только что снятого зеркала, тем же прогоном (нового
  // шага воркфлоу и записи в реестре свежести НЕ появляется).
  console.log(`  ${buildWecSnapshot(YEAR, NOW)}`);
  console.log(`  ${buildWecEventFiles(YEAR, NOW)}`);

  console.log(`Done. ${slugs.length} events, ${tests.length} tests (${frozenEvents} frozen E3), ${Object.keys(raceIdBySlug).length} raceIds (${frozenRaces} frozen, ${skipped} without page), ${e6} session results updated.`);
}

// Запуск только как продьюсер (не при импорте из теста).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
