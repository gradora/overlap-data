// Точечное обновление ИДУЩЕГО этапа WEC. Отдельно от продьюсера wec.ts, потому
// что у него другая экономика: тот проходит весь сезон раз в час, а этот
// просыпается каждые ~15 минут и в 99% прогонов не делает НИЧЕГО (сети не
// касается вовсе — читает index.json из чекаута).
//
// Зачем понадобился (шаг 3c DATA-PLAN). Пока в приложении жил HTML-каскад, у
// свежей сессии был обходной путь: продьюсер зеркалит страницу сессии ТОЛЬКО
// когда на ней уже есть таблица (`res.text.includes("<table")` в wec.ts), то
// есть только что закончившейся сессии в зеркале нет — и mirror-first транспорт
// клиента промахивался и шёл прямо в fiawec за свежим протоколом. Каскад
// удалён, обходного пути больше нет, и свежесть уик-энда упёрлась ровно в
// каденс крона. А каденс рваный: `snapshot.yml` объявлен как `17 * * * *`, но
// GitHub роняет часть расписаний — 27.08.2026 наблюдались разрывы 4.6 ч и
// 10.25 ч. Пользователь в субботу видел бы карточку сессии со статусом
// «Finished» и пустой таблицей под ней.
//
// Поэтому: в окне этапа ходим часто и только за его страницами. Полный проход
// сезона остаётся за wec.ts — здесь ни календаря, ни зачёта, ни чужих этапов.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { extractFacts } from "./wecextract.js";
import { wecResultsPath, wecSessionsPath, writeFacts } from "./wecfacts.js";
import { fetchText, writeIfChanged } from "./mirror.js";
import { WECLIVE_MARKER } from "./producers.js";
import { utcDay } from "./freshness.js";
import { stripCountdown } from "./fiawecsite.js";
import { buildWecEventFiles } from "./wecevents.js";
import { buildWecSnapshot } from "./wecsnapshot.js";

const FIAWEC = "https://www.fiawec.com";

/// Этап индекса — ровно те поля, что нужны окну и адресации.
export interface LiveCandidate {
  slug: string;
  round: number;
  raceId: number | null;
  startMs: number | null;
  endMs: number | null;
}

/// Окно «этап идёт»: от начала первого дня до конца последнего + сутки — ПАРНО
/// с прежним `WECSnapshotSource.isInLiveWindow` клиента (его сняли в 3c, но
/// определение переехало сюда, а не исчезло). Сутки после конца — хвост, в
/// который доезжают протоколы гонки и правки классификации.
export const LIVE_TAIL_MS = 24 * 60 * 60 * 1000;

export function isLive(event: LiveCandidate, now: number): boolean {
  if (event.startMs == null || event.endMs == null) return false;
  return now >= event.startMs && now < event.endMs + LIVE_TAIL_MS;
}

/// Кандидаты из уже собранного index.json сезона. Читаем ВИТРИНУ, а не зеркало
/// HTML: она уже нормализована, и лишнего парсинга здесь не нужно. Нет файла
/// (первый прогон сезона) — пустой список, и прогон честно ничего не делает.
export function liveCandidates(dataDir: string, year: number): LiveCandidate[] {
  const path = join(dataDir, "wec", String(year), "index.json");
  if (!existsSync(path)) return [];
  let doc: any;
  try {
    doc = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return []; // битый индекс — не наша забота, полный прогон его перепишет
  }
  const events = doc?.payload?.events ?? doc?.events ?? [];
  return (Array.isArray(events) ? events : []).map((e: any) => ({
    slug: String(e?.slug ?? ""),
    round: Number(e?.round ?? 0),
    raceId: e?.sourceIds?.fiawec?.raceId ?? null,
    startMs: e?.start ? Date.parse(e.start) : null,
    endMs: e?.end ? Date.parse(e.end) : null,
  })).filter((e: LiveCandidate) => e.slug !== "");
}

/// Этап, который идёт прямо сейчас. Если их вдруг несколько (наложение дат в
/// источнике) — берём тот, что начался позже: это и есть текущий.
export function liveEvent(dataDir: string, year: number, now: number): LiveCandidate | null {
  const live = liveCandidates(dataDir, year).filter((e) => isLive(e, now));
  if (live.length === 0) return null;
  return live.sort((a, b) => (a.startMs ?? 0) - (b.startMs ?? 0))[live.length - 1];
}

/// Обновление ОДНОГО этапа: дропдаун сессий + каждая сессия с таблицей.
/// Возвращает число переписанных файлов фактов.
///
/// Этот продьюсер бежит каждые 15 минут и до 31.08.2026 был вторым независимым
/// писателем HTML в репозиторий. Перевод на факты обязан идти ОДНИМ коммитом с
/// остальными: перевести только читателей — и живое окно уик-энда продолжило
/// бы капать чужие страницы в публичный репо при зелёном прогоне.
async function refreshEvent(dataDir: string, raceId: number): Promise<number> {
  const indexPath = wecSessionsPath(raceId);
  const res = await fetchText(`${FIAWEC}${indexPath}`);
  if (!res || res.status !== 200 || !res.text) {
    console.log(`  MISS  ${indexPath} (${res?.status ?? "net"})`);
    return 0;
  }
  let written = 0;
  const dropdown = extractFacts(indexPath, stripCountdown(res.text));
  if (dropdown?.kind !== "sessions") return 0;
  if (writeFacts(dataDir, indexPath, dropdown)) written++;

  for (const session of dropdown.sessions) {
    const path = wecResultsPath(raceId, session.id);
    const page = await fetchText(`${FIAWEC}${path}`);
    // Тот же гейт, что у полного продьюсера: страница без таблицы — это
    // сессия, которая ещё не отгонялась, и извлекать там нечего. Без гейта мы
    // бы записали протокол с нулём строк поверх настоящего.
    if (page?.status === 200 && page.text.includes("<table")) {
      const facts = extractFacts(path, stripCountdown(page.text));
      if (facts?.kind === "results" && facts.rows.length > 0 && writeFacts(dataDir, path, facts)) {
        written++;
      }
    }
  }
  return written;
}

/// Один прогон. Возвращает строку для лога. Сети НЕ касается, если живого
/// этапа нет — это главное свойство: 96 прогонов в сутки должны стоить около
/// нуля.
export async function runWecLive(
  now: number, dataDir: string = join(process.cwd(), "data"),
): Promise<string> {
  const year = new Date(now).getUTCFullYear();
  // Маркер свежести — ВСЕГДА, даже вхолостую: «этапов нет» это норма, а не
  // простой, и единственный интересный вопрос — бежит ли воркфлоу вообще.
  // День, а не таймстемп: 96 прогонов в сутки не должны давать 96 коммитов.
  writeIfChanged(join(dataDir, WECLIVE_MARKER),
                 JSON.stringify({ lastSuccess: utcDay(new Date(now)) }) + "\n");
  const event = liveEvent(dataDir, year, now);
  if (!event) return `wec live: идущих этапов нет (${year}) — прогон вхолостую`;
  if (event.raceId == null) {
    return `wec live: ${event.slug} идёт, но raceId ещё нет — ждём полный прогон`;
  }

  const written = await refreshEvent(dataDir, event.raceId);
  // Витрина пересобирается из ТОЛЬКО ЧТО снятых фактов — тем же прогоном и в
  // том же порядке, что у полного продьюсера (index → файлы событий).
  const snapshot = buildWecSnapshot(year, now, dataDir);
  const events = buildWecEventFiles(year, now, dataDir);
  return `wec live: ${event.slug} (raceId ${event.raceId}), факты ${written} файлов; ` +
    `${snapshot}; ${events}`;
}
