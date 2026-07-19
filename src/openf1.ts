// Зеркало OpenF1 (детали протокола F1: сессии, классификации, шины) —
// кэширующий прокси. Тянет ТЕ ЖЕ URL, что приложение (OpenF1Service), и кладёт
// JSON как есть под f1/openf1/<slug>. Приложение (SnapshotMirror.openF1Path)
// читает их первым, при промахе — прямой OpenF1.
//
// OpenF1 без ключа троттлит ~5 rps → строго последовательно, пауза 0.9с (как в
// приложении). Завершённые раунды ЗАМОРАЖИВАЕМ (их сессии неизменны) — иначе
// каждый прогон долбил бы OpenF1 по всему сезону.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isFrozen } from "./freeze.js";
import { fetchText, mirrorSlug, writeIfChanged } from "./mirror.js";

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
function activeRounds(): { round: string; date: string }[] {
  try {
    const d = JSON.parse(readFileSync(join(JOLPICA_DIR, "current.json"), "utf8"));
    const races = d?.MRData?.RaceTable?.Races ?? [];
    return races
      .filter((r: any) => r.date && Date.parse(`${r.date}T23:59:59Z`) - WEEKEND_LEAD_MS < NOW)
      .map((r: any) => ({ round: String(r.round), date: String(r.date) }));
  } catch {
    return [];
  }
}

// Митинг, чей интервал [date_start, date_end] пересекает день гонки (порт
// OpenF1Service.matchMeeting — Лас-Вегас гонится в ночь между датами).
function matchMeeting(meetings: any[], raceDate: string): any | undefined {
  const dayStart = Date.parse(`${raceDate}T00:00:00Z`);
  const dayEnd = dayStart + 86400000;
  return meetings.find((m) => {
    const s = Date.parse(m.date_start);
    const e = Date.parse(m.date_end ?? m.date_start);
    if (Number.isNaN(s)) return String(m.date_start ?? "").startsWith(raceDate);
    return s < dayEnd && (Number.isNaN(e) ? s : e) > dayStart;
  });
}

async function main() {
  console.log(`OpenF1 mirror, season ${YEAR}`);
  const meetings = await mirror(`meetings?year=${YEAR}`);
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
  const rounds = activeRounds();
  console.log(`  ${rounds.length} active rounds, ${meetings.length} meetings`);

  for (const r of rounds) {
    const m = matchMeeting(meetings, r.date);
    if (!m) {
      console.log(`  R${r.round}: no meeting for ${r.date}`);
      continue;
    }
    const key = m.meeting_key;
    const raceEnd = Date.parse(`${r.date}T23:59:59Z`);
    // Freeze по возрасту дня гонки (7д): в окне оседания результата ещё тянем
    // (штраф/апелляция могут поменять классификацию), после — не рескрейпим.
    // Исключение — разовый добор pit-файлов гонок (ручку /pit добавили позже
    // основного зеркала): существующие файлы не перетягиваем.
    if (isFrozen(raceEnd, NOW)) {
      await backfillPit(key);
      continue;
    }
    // Гонка ещё впереди → это текущий идущий уик-энд: снимаем ТОЛЬКО уже
    // завершившиеся сессии (по date_end), чтобы не дёргать пустой session_result
    // ещё не прошедшей/идущей сессии. (Во время самой ЛАЙВ-сессии OpenF1 401-ит
    // весь API — до сюда прогон не доходит, main() вышел на meetings.) Для
    // завершённого раунда (raceEnd < NOW) — все сессии, как раньше.
    const weekendInProgress = raceEnd >= NOW;
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
    }
    console.log(`  R${r.round}: meeting ${key}, ${Array.isArray(sessions) ? sessions.length : 0} sessions`);
  }
  console.log("Done.");
}

// «Race»/«Sprint» (но не Sprint Qualifying/Shootout).
function isRaceLike(name: unknown): boolean {
  const n = String(name ?? "").toLowerCase();
  if (n.includes("qual") || n.includes("shootout")) return false;
  return n.includes("race") || n.includes("sprint");
}

// Разовый добор pit-файлов для замороженных раундов: сессии читаем из УЖЕ
// зеркалированного листинга (без сети), тянем только отсутствующие файлы.
async function backfillPit(meetingKey: number) {
  let sessions: any[];
  try {
    sessions = JSON.parse(
      readFileSync(join(OUT_DIR, mirrorSlug(`sessions?meeting_key=${meetingKey}`)), "utf8"),
    );
  } catch {
    return;   // листинга нет — раунд не зеркалился вовсе
  }
  for (const s of Array.isArray(sessions) ? sessions : []) {
    if (!isRaceLike(s.session_name)) continue;
    const rel = `pit?session_key=${s.session_key}`;
    if (existsSync(join(OUT_DIR, mirrorSlug(rel)))) continue;
    console.log(`  backfill pit: meeting ${meetingKey}, session ${s.session_key}`);
    await mirror(rel);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
