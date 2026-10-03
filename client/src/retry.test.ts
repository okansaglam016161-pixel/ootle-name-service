// The busy-indexer retry rules (Ootle 0.43). Run with `npm test` (node:test via tsx).
//
// What these pin: busy is retried and announced, definite answers never are, Retry-After is
// honoured, and a SUBMIT is resubmitted only after a busy refusal that provably did not land —
// never after an ambiguous failure, which could pay twice.

import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  IndexerBusyError,
  NETWORK_BUSY_MESSAGE,
  SUBMIT_ATTEMPTS,
  SubmitMaybeLandedError,
  backoffMs,
  classifyStatus,
  fetchWithRetry,
  isBusyError,
  parseRetryAfter,
  retryTiming,
  submitOnce,
  withBusyRetry,
} from "./retry.js";

const saved = { ...retryTiming };
const realFetch = globalThis.fetch;
let slept: number[] = [];

beforeEach(() => {
  slept = [];
  retryTiming.sleep = async (ms: number) => {
    slept.push(ms);
  };
});
afterEach(() => {
  Object.assign(retryTiming, saved);
  globalThis.fetch = realFetch;
});

/** Script fetch answers: a status, `{ status, retryAfter }`, or an Error to throw. */
function scripted(answers: Array<number | Error | { status: number; retryAfter?: string }>): { calls: () => number } {
  let n = 0;
  globalThis.fetch = (async () => {
    n++;
    const next = answers.shift();
    if (next === undefined) throw new Error("script exhausted");
    if (next instanceof Error) throw next;
    const { status, retryAfter } = typeof next === "number" ? { status: next, retryAfter: undefined } : next;
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (k: string) => (k.toLowerCase() === "retry-after" ? (retryAfter ?? null) : null) },
    } as unknown as Response;
  }) as typeof fetch;
  return { calls: () => n };
}

const opts = { attempts: 4, timeoutMs: 1_000 };

describe("classification", () => {
  it("429/503 busy, other 5xx transient, the rest definite", () => {
    assert.equal(classifyStatus(429), "busy");
    assert.equal(classifyStatus(503), "busy");
    assert.equal(classifyStatus(502), "transient");
    for (const s of [200, 400, 404]) assert.equal(classifyStatus(s), "definite");
  });

  it("recognises the SDK's busy errors and nothing else", () => {
    assert.equal(isBusyError(new Error("HTTP 503: Service Unavailable")), true);
    assert.equal(isBusyError(new Error("HTTP 429: Too Many Requests")), true);
    assert.equal(isBusyError(new IndexerBusyError()), true);
    assert.equal(isBusyError(new Error("HTTP 500: Internal Server Error")), false);
    assert.equal(isBusyError(new Error("fetch failed")), false);
  });

  it("parses Retry-After as seconds or a date, capped, never negative", () => {
    assert.equal(parseRetryAfter("3"), 3_000);
    const now = Date.parse("2026-10-03T12:00:00Z");
    assert.equal(parseRetryAfter("Sat, 03 Oct 2026 12:00:04 GMT", now), 4_000);
    assert.equal(parseRetryAfter("Sat, 03 Oct 2026 11:00:00 GMT", now), 0);
    assert.equal(parseRetryAfter("3600"), retryTiming.retryAfterCapMs);
    assert.equal(parseRetryAfter(null), null);
    assert.equal(parseRetryAfter("soon"), null);
  });

  it("prefers Retry-After, else jittered exponential backoff under the cap", () => {
    assert.equal(backoffMs(1, 2_500), 2_500);
    assert.ok(backoffMs(3, null, () => 0.999) < retryTiming.baseMs * 4);
    assert.ok(backoffMs(30, null, () => 0.999) < retryTiming.capMs);
  });
});

describe("fetchWithRetry (reads and dry runs)", () => {
  it("waits out busy answers, announces them, and returns the success", async () => {
    scripted([503, { status: 429, retryAfter: "2" }, 200]);
    let announced = 0;
    const res = await fetchWithRetry("https://i.test/x", {}, { ...opts, onBusyRetry: () => announced++ });
    assert.equal(res.status, 200);
    assert.equal(announced, 2);
    assert.equal(slept[1], 2_000);
  });

  it("never retries a definite answer", async () => {
    const s = scripted([400]);
    assert.equal((await fetchWithRetry("https://i.test/x", {}, opts)).status, 400);
    assert.equal(s.calls(), 1);
  });

  it("stays busy → IndexerBusyError with the plain message", async () => {
    scripted([503, 503, 503, 503]);
    await assert.rejects(fetchWithRetry("https://i.test/x", {}, opts), (e: Error) => {
      assert.ok(e instanceof IndexerBusyError);
      assert.equal(e.message, NETWORK_BUSY_MESSAGE);
      return true;
    });
  });
});

describe("withBusyRetry (SDK calls)", () => {
  it("retries busy, rethrows anything else at once", async () => {
    let n = 0;
    assert.equal(
      await withBusyRetry(async () => {
        if (n++ < 1) throw new Error("HTTP 503: x");
        return "ok";
      }, { attempts: 3 }),
      "ok",
    );
    let m = 0;
    await assert.rejects(
      withBusyRetry(async () => {
        m++;
        throw new Error("HTTP 404: nope");
      }, { attempts: 3 }),
      /HTTP 404/,
    );
    assert.equal(m, 1);
  });
});

describe("submitOnce (real submits)", () => {
  const busy = () => new Error("HTTP 503: Service Unavailable");

  it("resubmits the same envelope after a busy refusal that did not land", async () => {
    const envelope = { sealed: 1 };
    const seen: unknown[] = [];
    const script: Array<Error | "ok"> = [busy(), "ok"];
    const r = await submitOnce(
      async () => {
        seen.push(envelope);
        const next = script.shift();
        if (next instanceof Error) throw next;
        return { transaction_id: "tx" };
      },
      { landed: async () => "not-landed" },
    );
    assert.equal(r.transaction_id, "tx");
    assert.equal(seen.length, 2);
    assert.equal(seen[0], seen[1]);
  });

  it("does not resubmit when it may have landed", async () => {
    let n = 0;
    await assert.rejects(
      submitOnce(async () => {
        n++;
        throw busy();
      }, { landed: async () => "maybe-landed" }),
      (e: Error) => e instanceof SubmitMaybeLandedError,
    );
    assert.equal(n, 1);
  });

  for (const err of [new Error("The operation was aborted due to timeout"), new TypeError("fetch failed"), new Error("HTTP 502: Bad Gateway")]) {
    it(`never resubmits after an ambiguous failure (${err.message})`, async () => {
      let n = 0;
      let checked = false;
      await assert.rejects(
        submitOnce(async () => {
          n++;
          throw err;
        }, { landed: async () => { checked = true; return "not-landed"; } }),
        (e: unknown) => e === err,
      );
      assert.equal(n, 1);
      assert.equal(checked, false);
    });
  }

  it("gives up with the plain busy message after SUBMIT_ATTEMPTS busy refusals", async () => {
    let n = 0;
    await assert.rejects(
      submitOnce(async () => {
        n++;
        throw busy();
      }, { landed: async () => "not-landed" }),
      (e: Error) => e instanceof IndexerBusyError,
    );
    assert.equal(n, SUBMIT_ATTEMPTS);
  });
});
