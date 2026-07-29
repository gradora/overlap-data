// Зеркало WEC (fiawec.com) — кэширующий прокси. Тянет ТЕ ЖЕ пути, что приложение
// (WECDataService.loadHTML), и кладёт HTML как есть под wec/fiawec/<slug(path)>.
// Приложение (SnapshotMirror.wecPath) читает их первым, при промахе — прямой
// fiawec. Перечисление URL повторяет парсеры приложения: slugs из /en/season,
// raceId из /en/page/resultats-1, sessionId из resultats-1?raceId=.

import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { isFrozen } from "../lib/freeze.js";
import { fetchText, mirrorSlug, writeIfChanged } from "../lib/mirror.js";
import {
  COUNTRY_NAME_TO_ISO2, eventInfo, expectedRaceMirrors, raceOptions,
  raceSlugs, seasonStarted, sessionOptions, stripCountdown,
} from "../lib/fiawecsite.js";

const YEAR = Number(process.env.SEASON ?? new Date().getUTCFullYear());
const FIAWEC = "https://www.fiawec.com";
const OUT_DIR = join(process.cwd(), "data", "wec", "fiawec");
const NOW = Date.now();

// Уже снятый mirror-файл (для freeze-решения без рескрейпа).
function readMirror(path: string): string | null {
  const f = join(OUT_DIR, mirrorSlug(path));
  try {
    return existsSync(f) ? readFileSync(f, "utf8") : null;
  } catch {
    return null;
  }
}

// Тянем fiawec-относительный путь, кладём под wec/fiawec/<slug(path)>
// (нормализовав отсчёт). HTML или null.
async function mirror(path: string): Promise<string | null> {
  const res = await fetchText(`${FIAWEC}${path}`);
  if (!res || res.status !== 200 || !res.text) {
    console.log(`  MISS  ${path} (${res?.status ?? "net"})`);
    return null;
  }
  const text = stripCountdown(res.text);
  const changed = writeIfChanged(join(OUT_DIR, mirrorSlug(path)), text);
  console.log(`  ${changed ? "write" : "same "} ${path}`);
  return text;
}

// Каркасный запрос с ретраем: разовый блип fiawec (сеть/502) не должен слать
// ложный алерт-письмо через exit(1) — валим прогон только при устойчивом
// отказе (все попытки впустую).
async function mirrorFramework(path: string, attempts = 3): Promise<string | null> {
  for (let i = 0; i < attempts; i++) {
    const html = await mirror(path);
    if (html) return html;
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, 5000));
  }
  return null;
}

async function main() {
  console.log(`WEC mirror, season ${YEAR}`);

  // Каркас: сезон (slugs), индекс результатов (raceId), зачёт производителей.
  // С ретраем — от гейта exit(1) зависит алерт владельцу, разовый блип не в счёт.
  const season = await mirrorFramework(`/en/season/${YEAR}`);
  const index = await mirrorFramework(`/en/page/resultats-1`);
  // Оба каркасных запроса null → полный отказ fiawec: валим прогон (exit 1),
  // иначе продьюсер завершится «success» при пустом зеркале и алерт-гейт
  // промолчит при реальном аутэйдже.
  if (!season && !index) {
    console.error("fiawec season+index недоступны — весь прогон бесполезен");
    process.exit(1);
  }
  await mirror(`/en/page/manufacturers-classification`);

  const slugs = season ? raceSlugs(season, YEAR) : [];

  // GC осиротевших race-зеркал ТЕКУЩЕГО сезона: этап выпал из страницы сезона
  // (перенос в другой год) → его файл больше никто не обновит и не прочитает.
  // Только при живой странице сезона: без неё истинный состав неизвестен.
  if (season && slugs.length > 0) {
    const expected = expectedRaceMirrors(slugs);
    for (const f of readdirSync(OUT_DIR)) {
      if (f.startsWith("en_race_") && f.endsWith(`_${YEAR}`) && !expected.has(f)) {
        rmSync(join(OUT_DIR, f));
        console.log(`  prune ${f} (этап выбыл из сезона ${YEAR})`);
      }
    }
  }

  // E3 (race-страница, JSON-LD): событие с endDate+7д в прошлом ЗАМОРОЖЕНО —
  // не рескрейпим, читаем из зеркала; собираем карту страна(ISO2) → endMs.
  const endByCountry: Record<string, number> = {};
  const endByOrdinal: (number | null)[] = [];   // endMs в ПОРЯДКЕ slugs (== порядок раундов)
  let frozenEvents = 0;
  for (const slug of slugs) {
    const existing = readMirror(`/en/race/${slug}`);
    const frozen = existing ? isFrozen(eventInfo(existing).endMs, NOW) : false;
    if (frozen) frozenEvents++;
    const html = frozen ? existing! : (await mirror(`/en/race/${slug}`)) ?? existing;
    const info = html ? eventInfo(html) : { startMs: null, endMs: null, iso2: null };
    endByOrdinal.push(info.endMs);
    if (info.iso2 && info.endMs !== null) endByCountry[info.iso2] = info.endMs;
  }

  // Per-race результаты (E5 дропдаун сессий) + per-session (E6). Freeze по
  // endDate события (страна E2-лейбла → endMs). Сыгранное окно уже отстоялось →
  // E5/E6 не трогаем. E6 fiawec рендерит только для сыгранных сессий (будущие —
  // пустой HTML): храним только с <table.
  const raceOpts = index ? raceOptions(index) : [];
  if (!seasonStarted(Object.values(endByCountry), NOW)) {
    console.log(
      `Done. ${slugs.length} events (${frozenEvents} frozen E3); сезон ${YEAR} не начался — E5/E6 пропущены`,
    );
    return;
  }
  let e6 = 0;
  let frozenRaces = 0;
  let skipped = 0;
  for (const [i, o] of raceOpts.entries()) {
    // endMs: страна E2-лейбла → карта ISO2; фолбэк — ординал (дропдаун и
    // страница сезона идут в одном порядке раундов). Раньше raceId без
    // country-матча (чужой сезон, страна вне карты) НИКОГДА не замерзал и
    // перескрейпливался каждый час вечно (~144 холостых запроса в день).
    const iso2 = COUNTRY_NAME_TO_ISO2[o.label.toUpperCase()] ?? null;
    const endMs = (iso2 ? endByCountry[iso2] : null) ?? (i < endByOrdinal.length ? endByOrdinal[i] : null);
    if (endMs === null && i >= slugs.length) {
      // Хвост дропдауна за пределами списка сезона (raceId прошлых/будущих
      // сезонов) — не скрейпим: сессий у них нет, а холостые E5 копились.
      skipped++;
      continue;
    }
    if (isFrozen(endMs, NOW)) {
      frozenRaces++;
      continue;
    }
    const e5 = await mirror(`/en/page/resultats-1?raceId=${o.id}`);
    const sessionIds = e5 ? sessionOptions(e5).map((s) => s.id) : [];
    for (const sessionId of sessionIds) {
      const path = `/en/page/resultats-1?raceId=${o.id}&sessionId=${sessionId}`;
      const res = await fetchText(`${FIAWEC}${path}`);
      if (res?.status === 200 && res.text.includes("<table")) {
        if (writeIfChanged(join(OUT_DIR, mirrorSlug(path)), stripCountdown(res.text))) e6++;
      }
    }
  }

  console.log(`Done. ${slugs.length} events (${frozenEvents} frozen E3), ${raceOpts.length} raceIds (${frozenRaces} frozen, ${skipped} off-season skipped), ${e6} session results updated.`);
}

// Запуск только как продьюсер (не при импорте из теста).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
