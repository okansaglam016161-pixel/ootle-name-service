// Retrying the indexer when it says "busy" (Ootle 0.43) — and only in ways that cannot pay twice.
//
// Same rules as Caravel's crypto/indexerRetry.ts + submitGuard.ts, kept here so this client stays
// dependency-free:
//
//   busy       429 / 503 — the indexer refused before doing anything. Wait (Retry-After if given)
//              and ask again. Reads and dry runs may move to another indexer.
//   transient  no answer, or another 5xx — worth another try for a READ or DRY RUN only.
//   definite   2xx, 404, 400, other 4xx — returned as-is, never retried.
//
// A SUBMIT is retried only on a busy refusal, only with the SAME sealed envelope, and only after a
// landed check says the refused attempt did not land. Anything ambiguous (timeout, dropped
// connection, another 5xx) is never resubmitted — the transaction may already be on its way.

/** Shown while a busy indexer is being waited out. */
export const RETRYING_MESSAGE = "Network busy, retrying…";

/** Shown when it stayed busy. A busy answer is a refusal, so nothing was sent. */
export const NETWORK_BUSY_MESSAGE = "The Tari network is busy right now. Nothing was sent — try again in a minute.";

/** Thrown when every attempt was answered "busy". */
export class IndexerBusyError extends Error {
  constructor() {
    super(NETWORK_BUSY_MESSAGE);
    this.name = "IndexerBusyError";
  }
}

/** Thrown when a busy refusal was followed by evidence the transaction may have landed anyway. */
export class SubmitMaybeLandedError extends Error {
  constructor() {
    super("The network was busy, and this transaction may already have gone through. Check Activity before trying again.");
    this.name = "SubmitMaybeLandedError";
  }
}

/** Timing in one mutable place, so tests can make waits instant. */
export const retryTiming = {
  baseMs: 500,
  capMs: 8_000,
  retryAfterCapMs: 10_000,
  sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
};

export type AnswerKind = "busy" | "transient" | "definite";

export function classifyStatus(status: number): AnswerKind {
  if (status === 429 || status === 503) return "busy";
  if (status >= 500) return "transient";
  return "definite";
}

/** True for the indexer saying "busy". The SDK transport throws `Error("HTTP 503: …")`. */
export function isBusyError(e: unknown): boolean {
  if (e instanceof IndexerBusyError) return true;
  const msg = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  return /\bHTTP (429|503)\b/.test(msg);
}

/** A Retry-After header (delta-seconds or HTTP date) as ms, capped; null if absent/unreadable. */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | null {
  if (value == null) return null;
  const v = value.trim();
  if (v === "") return null;
  let ms: number;
  if (/^\d+$/.test(v)) ms = Number(v) * 1000;
  else {
    const at = Date.parse(v);
    if (Number.isNaN(at)) return null;
    ms = at - now;
  }
  return Math.min(Math.max(0, ms), retryTiming.retryAfterCapMs);
}

/** Wait before attempt `attempt + 1`: Retry-After if given, else exponential backoff with full jitter. */
export function backoffMs(attempt: number, retryAfterMs: number | null, random = Math.random): number {
  if (retryAfterMs !== null) return retryAfterMs;
  const ceiling = Math.min(retryTiming.capMs, retryTiming.baseMs * 2 ** (attempt - 1));
  return Math.floor(random() * ceiling);
}

function retryAfterOf(res: Response): number | null {
  const get = (res as { headers?: { get?: (k: string) => string | null } }).headers?.get;
  return typeof get === "function" ? parseRetryAfter(get.call(res.headers, "retry-after")) : null;
}

/**
 * fetch with retry, for requests that CHANGE NOTHING (reads, dry runs). Returns the first definite
 * response; throws IndexerBusyError if it stayed busy, or the last transient error.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  opts: { attempts: number; timeoutMs: number; onBusyRetry?: () => void },
): Promise<Response> {
  let lastKind: AnswerKind = "transient";
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= opts.attempts; attempt++) {
    let retryAfter: number | null = null;
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(opts.timeoutMs) });
      const kind = classifyStatus(res.status);
      if (kind === "definite" || res.ok) return res;
      lastKind = kind;
      lastErr = new Error(`indexer HTTP ${res.status}`);
      retryAfter = retryAfterOf(res);
    } catch (e) {
      lastKind = "transient";
      lastErr = e;
    }
    if (attempt < opts.attempts) {
      if (lastKind === "busy") opts.onBusyRetry?.();
      await retryTiming.sleep(backoffMs(attempt, lastKind === "busy" ? retryAfter : null));
    }
  }
  if (lastKind === "busy") throw new IndexerBusyError();
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** Run an SDK call that CHANGES NOTHING, retrying only a busy answer. Anything else rethrows at once. */
export async function withBusyRetry<T>(
  fn: () => Promise<T>,
  opts: { attempts: number; onBusyRetry?: () => void },
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (!isBusyError(e)) throw e;
      if (attempt >= opts.attempts) throw new IndexerBusyError();
      opts.onBusyRetry?.();
      await retryTiming.sleep(backoffMs(attempt, null));
    }
  }
}

/** Total submit attempts, the first included. */
export const SUBMIT_ATTEMPTS = 3;

/**
 * Submit with the busy-only, same-envelope, landed-checked retry described above. `submit` must
 * close over ONE sealed envelope; `landed` must answer "not-landed" only on positive evidence.
 */
export async function submitOnce<R>(
  submit: () => Promise<R>,
  opts: { landed: () => Promise<"not-landed" | "maybe-landed">; onBusyRetry?: () => void },
): Promise<R> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await submit();
    } catch (e) {
      if (!isBusyError(e)) throw e;
      if (attempt >= SUBMIT_ATTEMPTS) throw new IndexerBusyError();
      opts.onBusyRetry?.();
      await retryTiming.sleep(backoffMs(attempt, null));
      if ((await opts.landed()) !== "not-landed") throw new SubmitMaybeLandedError();
    }
  }
}
