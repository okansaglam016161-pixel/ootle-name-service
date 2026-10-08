//   Reverse lookup across owner keys — namesForOwners / namesForOwner — against a stubbed registry
//   read. The registry is the component's state[0]: name → [owner bytes, records].

import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { OnsReader } from "./reader.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const A = "aa".repeat(32);
const B = "bb".repeat(32);
const C = "cc".repeat(32);

function serveRegistry(registry: Record<string, unknown>) {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response(JSON.stringify({ substate: { Component: { body: { state: [registry] } } } }), { status: 200 });
  }) as typeof fetch;
  return () => calls;
}

const reader = () => new OnsReader({ component: "component_test", indexerUrl: "https://indexer.test" });
const owned = (owner: string, nostr: string) => [{ "@cbor": "bytes", hex: owner }, { nostr }];

describe("namesForOwners", () => {
  it("returns every name held by any of the keys, sorted by name, with its owner, in one read", async () => {
    const calls = serveRegistry({ zed: owned(A, "z"), alpha: owned(B, "a"), mid: owned(A, "m"), other: owned(C, "o") });
    const names = await reader().namesForOwners([A, B]);
    assert.deepEqual(names.map((n) => [n.name, n.owner]), [["alpha", B], ["mid", A], ["zed", A]]);
    assert.equal(calls(), 1);
  });

  it("matches keys case-insensitively and ignores blanks", async () => {
    serveRegistry({ one: owned(A, "x") });
    assert.deepEqual((await reader().namesForOwners([A.toUpperCase(), "  "])).map((n) => n.name), ["one"]);
  });

  it("no keys is no names, without a read", async () => {
    const calls = serveRegistry({ one: owned(A, "x") });
    assert.deepEqual(await reader().namesForOwners([]), []);
    assert.equal(calls(), 0);
  });

  it("namesForOwner is the one-key case", async () => {
    serveRegistry({ one: owned(A, "x"), two: owned(B, "y") });
    assert.deepEqual((await reader().namesForOwner(B)).map((n) => n.name), ["two"]);
  });
});
