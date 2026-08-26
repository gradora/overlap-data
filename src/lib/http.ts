// Общий HTTP-слой продьюсеров: единый User-Agent, fetchText с таймаутом и
// fetchJSON с ретраем на 429/5xx. Раньше UA был скопирован в 10 файлов, а
// retry-политика Jolpica существовала в пяти несовместимых вариантах (и у
// f1.ts не существовала вовсе — единичный 429 на current.json ронял прогон
// и слал ложный алерт).

export const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15";

export interface Fetched {
  status: number;
  text: string;
}

export async function fetchText(url: string, timeoutMs = 20000): Promise<Fetched | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA }, signal: ctrl.signal });
    const text = await res.text();
    return { status: res.status, text };
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

export interface RetryOpts {
  attempts?: number;   // всего попыток (включая первую)
  backoffMs?: number;  // пауза перед n-й повторной = backoffMs * n
}

/// Текст с ретраем на 429/5xx/сетевую ошибку. null — устойчивый отказ.
export async function fetchTextRetry(url: string, opts: RetryOpts = {}): Promise<Fetched | null> {
  const attempts = opts.attempts ?? 3;
  const backoff = opts.backoffMs ?? 30000;
  for (let i = 0; i < attempts; i++) {
    const res = await fetchText(url);
    if (res && res.status !== 429 && res.status < 500) return res;
    if (i < attempts - 1) {
      console.log(`  retry ${i + 1}/${attempts - 1} (${res?.status ?? "net"}) ${url}`);
      await new Promise((r) => setTimeout(r, backoff * (i + 1)));
    }
  }
  return null;
}

/// JSON с тем же ретраем. null — не-200 после попыток или битый JSON.
export async function fetchJSON(url: string, opts: RetryOpts = {}): Promise<any | null> {
  const res = await fetchTextRetry(url, opts);
  if (!res || res.status !== 200) return null;
  try {
    return JSON.parse(res.text);
  } catch {
    return null;
  }
}

// ---- Ретрай с внятной пер-документной диагностикой (политика fia.ts) ----

// Общий null был слепым: в логе крона «PDF недоступен» одинаково значило 404
// (документа ещё нет), таймаут и обрыв связи — разбирать сбой уик-энда было
// не по чему. Здесь причина отказа попадает в лог под подписью документа, а
// повтор делается только там, где имеет шанс пройти со второй попытки (сеть,
// таймаут, 429/5xx): на 4xx на сервере ничего нет. Механика родилась в
// producers/fia.ts (fetchWithRetry) — это её общая копия для wecfia/imsafia;
// сам fia.ts остаётся на своей вместе с её тестами в fia.test.ts (чужая зона
// фазы 0), унификация — отдельной уборкой.

export interface RetryLogOpts {
  label: string;      // как отказ подписан в логе («Doc 52», «листинг 18_Penalties»)
  timeoutMs: number;
  attempts: number;   // всего попыток, включая первую
  pauseMs?: number;
}

/// Выхлоп причины устойчивого отказа для вызывающего: HTTP-код последнего
/// ответа, если он был (404 у листинга IMSA — штатное «папки нет», а не
/// осечка); отсутствие status — сеть/таймаут, то есть заведомо возвратное.
export interface RetryLogFail {
  status?: number;
}

const RETRY_LOG_PAUSE_MS = 1500;
const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/// Чтение ответа с ретраем и внятным логом. null — устойчивый отказ.
export async function fetchWithRetryLog<T>(
  url: string,
  read: (res: Response) => Promise<T>,
  opts: RetryLogOpts,
  fail?: RetryLogFail,
): Promise<T | null> {
  const { label, timeoutMs, attempts, pauseMs = RETRY_LOG_PAUSE_MS } = opts;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    let retriable = false;
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA }, signal: ctrl.signal });
      if (res.ok) return await read(res);
      if (fail) fail.status = res.status;
      retriable = res.status === 429 || res.status >= 500;
      console.warn(`  ${label}: HTTP ${res.status}${retriable ? "" : " — повтор не поможет"}`);
    } catch (e) {
      // Сработал наш AbortController → это таймаут, иначе — обрыв связи/DNS.
      if (fail) delete fail.status;
      retriable = true;
      console.warn(
        `  ${label}: ${ctrl.signal.aborted ? `таймаут ${timeoutMs / 1000}с` : `сеть — ${errText(e)}`}`,
      );
    } finally {
      clearTimeout(t);
    }
    if (!retriable || attempt === attempts) return null;
    console.log(`  ${label}: повтор ${attempt}/${attempts - 1} через ${pauseMs / 1000}с`);
    await sleepMs(pauseMs);
  }
  return null;
}

/// Last-Modified → ISO-инстант для publishedAt. Единая нормализация для
/// wecfia/imsafia: раньше один защищался от битой даты, другой — нет (падение
/// на «Invalid Date»), а суффикс приводили к «.000Z» двумя разными способами.
export function lastModifiedISO(res: Response): string | undefined {
  const lm = res.headers.get("last-modified");
  return lm && !Number.isNaN(Date.parse(lm)) ? new Date(lm).toISOString() : undefined;
}
