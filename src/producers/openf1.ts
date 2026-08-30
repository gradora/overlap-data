// Зеркало OpenF1 (детали протокола F1: сессии, классификации, шины) —
// кэширующий прокси. Тянет ТЕ ЖЕ URL, что приложение (OpenF1Service), и кладёт
// JSON как есть под f1/openf1/<slug>. Приложение (SnapshotMirror.openF1Path)
// читает их первым, при промахе — прямой OpenF1.
//
// OpenF1 без ключа троттлит ~5 rps → строго последовательно, пауза 0.9с (как в
// приложении). Завершённые раунды ЗАМОРАЖИВАЕМ (их сессии неизменны) — иначе
// каждый прогон долбил бы OpenF1 по всему сезону.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { isFrozen } from "../lib/freeze.js";
import { fetchText, mirrorSlug, writeIfChanged } from "../lib/mirror.js";

const YEAR = Number(process.env.SEASON ?? new Date().getUTCFullYear());
const OPENF1 = "https://api.openf1.org/v1";
const OUT_DIR = join(process.cwd(), "data", "f1", "openf1");
const JOLPICA_DIR = join(process.cwd(), "data", "f1", "jolpica");
const NOW = Date.now();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Тянем OpenF1-относительный путь (после /v1/), кладём под f1/openf1/<slug>.
// Базовая пауза 1.2с; на 429 (рейт-лимит) — ретрай с backoff. Возвращает JSON
// или null (тогда приложение падает на прямой OpenF1 для этого файла).
async function mirror(relative: string): Promise<any | null> {
  for (let attempt = 0; attempt <= 3; attempt++) {
    await sleep(attempt === 0 ? 1200 : 8000 * attempt); // 1.2с; backoff 8/16/24с
    const res = await fetchText(`${OPENF1}/${relative}`);
    if (res?.status === 200) {
      writeIfChanged(join(OUT_DIR, mirrorSlug(relative)), res.text);
      try {
        return JSON.parse(res.text);
      } catch {
        return null;
      }
    }
    if (res?.status !== 429) {
      console.log(`  MISS ${relative} (${res?.status ?? "net"})`);
      return null;
    }
    console.log(`  429 ${relative} — retry ${attempt + 1}`);
  }
  console.log(`  MISS ${relative} (429 после ретраев)`);
  return null;
}

// Раунды, чьи сессии стоит зеркалить: завершённые гонки + ТЕКУЩИЙ уже
// стартовавший уик-энд. У текущего раунда гонка впереди, но его ранее
// завершившиеся сессии (FP1..FP3, квала) уже надо снять — иначе они попадут в
// зеркало только ПОСЛЕ гонки, и приложение до конца гонки не увидит, скажем,
// FP3 (свалившись на 401/429-хрупкий прямой OpenF1). Уик-энд F1 стартует ~3 дня
// до гонки (FP1 в пятницу); условие `raceEnd - LEAD < NOW` покрывает и прошедшие
// гонки (raceEnd < NOW), и текущий уик-энд, а будущие раунды дальше 3 дней —
// отсекает (следующий подхватится за ~3 дня до своей гонки).
const WEEKEND_LEAD_MS = 3 * 24 * 3600 * 1000;

// Чистое ядро: даты активных раундов из распарсенного расписания Jolpica.
// Раунд активен, если конец дня гонки минус lead уже позади now — покрывает и
// прошедшие гонки, и текущий стартовавший уик-энд; будущие дальше 3 дней
// отсекаются (следующий подхватится за ~3 дня до своей гонки).
export function activeRoundsFrom(schedule: any, now: number): string[] {
  const races = schedule?.MRData?.RaceTable?.Races ?? [];
  return races
    .filter((r: any) => r.date && Date.parse(`${r.date}T23:59:59Z`) - WEEKEND_LEAD_MS < now)
    .map((r: any) => String(r.date));
}

// Обёртка: читает зеркалированное расписание Jolpica с диска и зовёт ядро.
function activeRounds(): string[] {
  try {
    const d = JSON.parse(readFileSync(join(JOLPICA_DIR, "current.json"), "utf8"));
    return activeRoundsFrom(d, NOW);
  } catch {
    return [];
  }
}

// ВСЕ даты гонок сезона из расписания Jolpica — для оверлей-критерия (e):
// митинг, не сматченный ни с одной, в Jolpica отсутствует вовсе.
export function allRoundDatesFrom(schedule: any): string[] {
  const races = schedule?.MRData?.RaceTable?.Races ?? [];
  return races.filter((r: any) => r.date).map((r: any) => String(r.date));
}

function seasonRoundDates(): string[] {
  try {
    const d = JSON.parse(readFileSync(join(JOLPICA_DIR, "current.json"), "utf8"));
    return allRoundDatesFrom(d);
  } catch {
    return [];
  }
}

// Митинг, чей интервал [date_start, date_end] пересекает день гонки (порт
// OpenF1Service.matchMeeting — Лас-Вегас гонится в ночь между датами).
export function matchMeeting(meetings: any[], raceDate: string): any | undefined {
  const dayStart = Date.parse(`${raceDate}T00:00:00Z`);
  const dayEnd = dayStart + 86400000;
  return meetings.find((m) => {
    const s = Date.parse(m.date_start);
    const e = Date.parse(m.date_end ?? m.date_start);
    if (Number.isNaN(s)) return String(m.date_start ?? "").startsWith(raceDate);
    return s < dayEnd && (Number.isNaN(e) ? s : e) > dayStart;
  });
}

// Событие, которого ещё нет в Jolpica (новый этап / перенос): OpenF1 уже отдаёт
// его meeting и листинг сессий, а Jolpica-current отстаёт. Снимаем, если старт в
// окне ±14 дней от now — покрывает уик-энд с запасом и не тянет весь будущий
// календарь (у далёких этапов сессий ещё нет либо они пусты).
const NEW_EVENT_WINDOW_MS = 14 * 24 * 3600 * 1000;

export interface SnapshotTarget {
  meeting: any;
  // Инстант «финиша» для freeze/weekend-гейта: у раунда — конец дня гонки из
  // Jolpica, у прочих категорий — date_end (или date_start) самого митинга.
  finishMs: number;
  reason: "round" | "testing" | "cancelled" | "overlay" | "new";
}

// Чистый селектор: какие митинги зеркалить. Объединение (dedup по meeting_key,
// первая причина побеждает): (a) сматченные на активный раунд Jolpica; (b) тесты
// (в имени «Testing», регистр неважен); (c) отменённые (is_cancelled === true);
// (e) оверлей-этапы — не сматченные НИ С ОДНИМ раундом Jolpica (перенос/новый
// этап, кейс Sepang-2026); (d) ещё не в Jolpica, но со стартом в окне ±14 дней.
// Приоритет причин: round > testing > cancelled > overlay > new.
export function meetingsToSnapshot(
  meetings: any[],
  activeRoundDates: string[],
  now: number,
  allRoundDates: string[] = [],
): SnapshotTarget[] {
  const byKey = new Map<any, SnapshotTarget>();
  const add = (meeting: any, finishMs: number, reason: SnapshotTarget["reason"]) => {
    const key = meeting?.meeting_key;
    if (key == null || byKey.has(key)) return;
    byKey.set(key, { meeting, finishMs, reason });
  };

  // (a) как раньше: митинг под каждый активный раунд Jolpica (finish = конец дня
  // гонки из Jolpica, чтобы freeze/weekend-гейт совпали с прежним поведением).
  for (const date of activeRoundDates) {
    const m = matchMeeting(meetings, date);
    if (m) add(m, Date.parse(`${date}T23:59:59Z`), "round");
  }

  for (const m of meetings) {
    const finishMs = Date.parse(m?.date_end ?? m?.date_start ?? "");
    if (String(m?.meeting_name ?? "").toLowerCase().includes("testing")) {
      add(m, finishMs, "testing");   // (b)
      continue;
    }
    if (m?.is_cancelled === true) {
      add(m, finishMs, "cancelled");   // (c)
      continue;
    }
    // (e) оверлей-этап: в OpenF1 есть, в Jolpica нет ВООБЩЕ. Клиент показывает
    // такой митинг оверлей-итемом и читает листинг его сессий задолго до
    // уик-энда — зеркалим сразу, не дожидаясь окна (d): живой OpenF1 401-ится
    // в каждый чужой гоночный уик-энд. Гард на пустое расписание (январь до
    // публикации Jolpica): иначе «не в Jolpica» — весь календарь разом.
    if (allRoundDates.length > 0 && !allRoundDates.some((d) => matchMeeting([m], d))) {
      add(m, finishMs, "overlay");
      continue;
    }
    const start = Date.parse(m?.date_start ?? "");
    if (!Number.isNaN(start) && Math.abs(start - now) <= NEW_EVENT_WINDOW_MS) {
      add(m, finishMs, "new");   // (d)
    }
  }
  return [...byKey.values()];
}

// Историческая загрузка (SEASON=прошлый год): обычный путь не работает для
// прошлых сезонов — activeRounds() читает jolpica-расписание ТЕКУЩЕГО сезона,
// матчей с прошлогодними митингами нет, и снимались только тесты/отмены
// (так и возник полу-бэкфилл 2023–25). Здесь весь сезон завершён — снимаем ВСЕ
// митинги целиком, resume-safe: существующие файлы не перекачиваем. Разовый
// ручной прогон: SEASON=2023 npm run openf1 (и т.д.); крон трогает только
// текущий сезон.
const HISTORIC = YEAR < new Date().getUTCFullYear();

/// Режим прогона по соотношению сезона и календарного года. Выведен ИЗ ГОДА, а
/// не из отдельного флага: перепутать нечего, и симметрично HISTORIC.
///
/// «future» — сезон N+1 в межсезонье. Ради него мы сюда и ходим: тесты и
/// отмены следующего года есть ТОЛЬКО в OpenF1 (jolpica отдаёт голое
/// расписание), и без зеркала листинга витрина календаря N+1 собиралась без
/// них молча. Но снимать сессии будущего сезона нельзя: activeRounds() читает
/// current.json ТЕКУЩЕГО года, ни одна дата N+1 с ним не матчится, и критерий
/// «оверлей» записал бы в цель ВЕСЬ календарь следующего года — сотни пустых
/// запросов за уик-энды, которых ещё не было. Поэтому зеркалим листинг и
/// выходим.
export function snapshotMode(year: number, currentYear: number): "historic" | "future" | "current" {
  if (year < currentYear) return "historic";
  if (year > currentYear) return "future";
  return "current";
}

const FUTURE = snapshotMode(YEAR, new Date().getUTCFullYear()) === "future";

// Как mirror(), но при уже существующем файле читает его с диска без сети.
async function mirrorIfMissing(relative: string): Promise<any | null> {
  const f = join(OUT_DIR, mirrorSlug(relative));
  if (existsSync(f)) {
    try {
      return JSON.parse(readFileSync(f, "utf8"));
    } catch {
      return null;
    }
  }
  return mirror(relative);
}

async function historicBackfill(meetings: any[]) {
  for (const m of meetings) {
    const key = m.meeting_key;
    const sessions = await mirrorIfMissing(`sessions?meeting_key=${key}`);
    await mirrorIfMissing(`drivers?meeting_key=${key}`);
    for (const s of Array.isArray(sessions) ? sessions : []) {
      const sk = s.session_key;
      await mirrorIfMissing(`session_result?session_key=${sk}`);
      await mirrorIfMissing(`stints?session_key=${sk}`);
      if (isRaceLike(s.session_name)) await mirrorIfMissing(`pit?session_key=${sk}`);
      await mirrorIfMissing(`race_control?session_key=${sk}`);
    }
    console.log(`  historic meeting ${key} (${m.meeting_name ?? "?"}): ${Array.isArray(sessions) ? sessions.length : 0} sessions`);
  }
  console.log("Done (historic backfill).");
}

/// Разовый проход добора по ВСЕМУ уже снятому зеркалу (`BACKFILL=late`).
///
/// Обычный `backfillLateHandles` вызывается только для митингов, попавших в
/// ЦЕЛИ прогона, а цели — это текущий сезон: активные раунды, тесты, отмены,
/// оверлей. Прошлогодние митинги в них не входят вовсе, поэтому ручка,
/// добавленная сегодня, никогда бы не появилась у архива. Здесь идём от
/// листингов на диске, а не от календаря: что зеркалили, то и дозаполняем.
async function backfillAllMirrored() {
  const listings = readdirSync(OUT_DIR).filter((f: string) => f.startsWith("sessions_meeting_key_"));
  console.log(`Добор поздних ручек по зеркалу: ${listings.length} митингов`);
  let done = 0;
  for (const file of listings) {
    const key = Number(file.replace("sessions_meeting_key_", ""));
    if (!Number.isFinite(key)) continue;
    await backfillLateHandles(key);
    done++;
  }
  console.log(`Done (добор по ${done} митингам).`);
}

async function main() {
  if (process.env.BACKFILL === "late") {
    await backfillAllMirrored();
    return;
  }
  console.log(`OpenF1 mirror, season ${YEAR}` +
    `${HISTORIC ? " (historic backfill)" : FUTURE ? " (листинг митингов)" : ""}`);
  const meetings = HISTORIC
    ? await mirrorIfMissing(`meetings?year=${YEAR}`)
    : await mirror(`meetings?year=${YEAR}`);
  if (!Array.isArray(meetings)) {
    // OpenF1 гейтит анонимный доступ во время ЛАЙВ F1-сессии (401 «Live F1
    // session in progress… restricted to authenticated users»): ожидаемо и
    // временно, вернётся после сессии. OpenF1 — вспомогательный (детали
    // протокола: грид/шины), ядро F1 берётся из Jolpica. Поэтому НЕ валим
    // прогон (exit 0) и не шлём алерт: зеркало остаётся прежним, пропускаем
    // этот прогон. exit(1) здесь спамил бы письмами каждый F1-уик-энд.
    console.warn("OpenF1 meetings недоступны (401 live-gate / сеть) — пропускаем прогон, зеркало без изменений");
    return;
  }
  if (HISTORIC) {
    await historicBackfill(meetings);
    return;
  }
  if (FUTURE) {
    console.log(`  ${meetings.length} митингов сезона ${YEAR} — только листинг, сессии не снимаем`);
    return;
  }
  const roundDates = activeRounds();
  const targets = meetingsToSnapshot(meetings, roundDates, NOW, seasonRoundDates());
  console.log(`  ${roundDates.length} active rounds, ${meetings.length} meetings, ${targets.length} to snapshot`);

  for (const t of targets) {
    const key = t.meeting.meeting_key;
    // Freeze по возрасту финиша (7д): в окне оседания результата ещё тянем
    // (штраф/апелляция могут поменять классификацию), после — не рескрейпим.
    // Исключение — разовый добор pit/race_control из уже зеркалированного
    // листинга (ручки добавили позже основного зеркала): существующие не тянем.
    // «Заморожено» обязано значить «не ПЕРЕскрейпливать», а не «не получить
    // вовсе». Митинг, которого в зеркале нет НИ ОДНОГО файла, не собран ни
    // разу — и гейт по возрасту закрывал ему дорогу навсегда: добор поздних
    // ручек читает УЖЕ зеркалированный листинг, а его нет. Так пропали
    // предсезонные тесты 2026 (митинги 1304/1305, февраль): у источника
    // сессии есть по сей день, а у нас их не было, и приложение показывало
    // прошедший этап как «уточняется».
    const neverMirrored = !existsSync(join(OUT_DIR, mirrorSlug(`sessions?meeting_key=${key}`)));
    const frozen = isFrozen(t.finishMs, NOW);
    if (frozen && !neverMirrored) {
      await backfillLateHandles(key);
      continue;
    }
    if (frozen) {
      console.log(`  митинг ${key} (${t.reason}) не собирался ни разу — разовый добор`);
    }
    // Финиш впереди либо неизвестен → уик-энд ещё идёт: снимаем ТОЛЬКО уже
    // завершившиеся сессии (по date_end), чтобы не дёргать пустой session_result
    // ещё не прошедшей/идущей сессии. (Во время самой ЛАЙВ-сессии OpenF1 401-ит
    // весь API — до сюда прогон не доходит, main() вышел на meetings.) Для
    // завершённого митинга (финиш < NOW) — все сессии, как раньше.
    const weekendInProgress = !(t.finishMs < NOW);
    const sessions = await mirror(`sessions?meeting_key=${key}`);
    await mirror(`drivers?meeting_key=${key}`);
    for (const s of Array.isArray(sessions) ? sessions : []) {
      if (weekendInProgress) {
        const end = Date.parse(s.date_end ?? s.date_start ?? "");
        if (Number.isNaN(end) || end >= NOW) continue;   // сессия ещё не завершилась
      }
      const sk = s.session_key;
      await mirror(`session_result?session_key=${sk}`);
      await mirror(`stints?session_key=${sk}`);
      // Питстопы (stop_duration = стационарное время) — только гонки/спринты:
      // в практиках остановки гаражные, соревновательного смысла нет.
      if (isRaceLike(s.session_name)) await mirror(`pit?session_key=${sk}`);
      // Лента рейс-контрола (флаги/SC/инциденты) — по всем сессиям: recap
      // и в практиках/квалах содержателен.
      await mirror(`race_control?session_key=${sk}`);
      // Погода сессии (шаг 5.3): воздух, трасса, влажность, давление, ветер и
      // бинарный дождь — по всем сессиям. Это ЕДИНСТВЕННЫЙ источник температуры
      // ТРАССЫ: у Open-Meteo, на который клиент падает сегодня, её нет вовсе.
      await mirror(`weather?session_key=${sk}`);
    }
    console.log(`  ${t.reason} meeting ${key} (${t.meeting.meeting_name ?? "?"}): ${Array.isArray(sessions) ? sessions.length : 0} sessions`);
  }
  console.log("Done.");
}

// «Race»/«Sprint» (но не Sprint Qualifying/Shootout).
export function isRaceLike(name: unknown): boolean {
  const n = String(name ?? "").toLowerCase();
  if (n.includes("qual") || n.includes("shootout")) return false;
  return n.includes("race") || n.includes("sprint");
}

// Разовый добор файлов для замороженных раундов — ручек, добавленных ПОЗЖЕ
// основного зеркала (pit, race_control, weather). Сессии читаем из УЖЕ
// зеркалированного листинга (без сети), тянем только отсутствующие файлы.
//
// Без этого добора новая ручка появлялась бы только у будущих уик-эндов:
// замороженные митинги основной цикл пропускает целиком, и архив остался бы
// дырявым навсегда.
async function backfillLateHandles(meetingKey: number) {
  let sessions: any[];
  try {
    sessions = JSON.parse(
      readFileSync(join(OUT_DIR, mirrorSlug(`sessions?meeting_key=${meetingKey}`)), "utf8"),
    );
  } catch {
    return;   // листинга нет — раунд не зеркалился вовсе
  }
  for (const s of Array.isArray(sessions) ? sessions : []) {
    const wanted = [
      ...(isRaceLike(s.session_name) ? [`pit?session_key=${s.session_key}`] : []),
      `race_control?session_key=${s.session_key}`,
      `weather?session_key=${s.session_key}`,
    ]
    for (const rel of wanted) {
      if (existsSync(join(OUT_DIR, mirrorSlug(rel)))) continue;
      console.log(`  backfill ${rel.split("?")[0]}: meeting ${meetingKey}, session ${s.session_key}`);
      await mirror(rel);
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
