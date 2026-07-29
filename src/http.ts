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
