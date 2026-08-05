# @ootle/name-service

TypeScript client for the [Ootle Name Service](../README.md) (ONS) registry.

- **Reads** (name resolution) go through the public Ootle **indexer** — **no wallet, no key, no fee**.
  Zero runtime dependencies; runs in the browser or Node. This is all a resolver (e.g. Caravel) needs.
- **Writes** (`register`, `setRecord`) go through a signer — **either** a wallet daemon
  (`withSigner`, sealed server-side with the account key) **or** a self-custodial browser wallet
  (`withBrowserSigner`, signed client-side; the path Caravel uses). Only reachable after you attach a
  signer, and only then is the `@tari-project/ootle` peer dependency loaded.

## Install

Not published to npm yet — consume via local path or git:

```jsonc
// package.json
"dependencies": {
  "@ootle/name-service": "file:../ootle-name-service/client"
  // or: "github:<you>/ootle-name-service#main" with the package at /client
}
```

`@tari-project/ootle` is an **optional peer dependency** — install it only if you do writes.

## Configure

Nothing is hardcoded; component address, network and URLs are all config, so another deployment
(or mainnet later) reuses the same library.

```ts
import { createOnsClient } from "@ootle/name-service";

const ons = createOnsClient({
  component: "component_0e70f16ad20e1c1b92f035d1e6f4b69c6c4c774ed309c2eb9e2c42c01279994a",
  // indexerUrl defaults to the esmeralda public indexer, https://ootle-indexer-a.tari.com
  // network defaults to 38 (Esmeralda), used only for writes
});
```

## Reads (keyless)

```ts
await ons.resolveToNostr("okz");   // "npub1f80…"  — the common Caravel case, or null
await ons.getRecord("okz", "nostr"); // "npub1f80…" or null
await ons.isRegistered("okz");     // true / false
await ons.resolveName("okz");      // { name, owner, records } or null
```

`resolveName` returns:

```ts
interface NameRecord {
  name: string;
  owner: string;                    // registrant's Ristretto public key, hex (unforgeable)
  records: Record<string, string>;  // e.g. { nostr: "npub1…" }
}
```

## Writes (need a wallet daemon)

Writes are gated behind `withSigner()` — a read-only consumer never imports the signing code.

```ts
const signer = {
  url: "http://127.0.0.1:5100/json_rpc",
  apiKey: process.env.TARI_WALLET_DAEMON_API_KEY!, // from env — never hardcode or commit
  account: "Okz61",                                // a daemon account that signs & pays
};

const writer = await ons.withSigner(signer);
const r1 = await writer.register("alice");                 // { transactionId, fee }
const r2 = await writer.setRecord("alice", "nostr", "npub1…");
```

Each write is **dry-run first (free)** to validate and estimate the fee before it spends anything;
the daemon seals server-side (no private key is handled here).

## Browser (self-custodial) writes

For a browser wallet that holds its own keys (no daemon), use `withBrowserSigner` instead of
`withSigner`. The client signs and submits directly from the browser and pays the fee from a
confidential UTXO. This is the path [Caravel](https://github.com/okansaglam016161-pixel/caravel) uses.

```ts
const writer = await ons.withBrowserSigner({
  wallet,          // a self-custodial SecretKeyWallet (client-side keys)
  senderAddress,   // the wallet's otl_esm_… address (fee source + change destination)
  // indexerUrl?   // defaults to the esmeralda public indexer
});
```

Registration is an **estimate → confirm → submit** flow, so the user sees the real fee before
anything is spent:

```ts
// 1. Estimate — a dry-run against the indexer's /transactions/dry-run endpoint. Nothing is committed
//    or spent; returns the true required fee.
const { feeMicroTari } = await writer.estimateRegisterWithNostr("alice", "npub1…");

// 2. Show feeMicroTari to the user; on their confirmation, submit with the approved budget.
const { transactionId, fee } = await writer.submitRegisterWithNostr("alice", "npub1…", feeMicroTari);
```

`registerWithNostr(name, npub)` is a one-call convenience (estimate + submit with a small margin) for
callers that don't need a confirm gate; `register` / `setRecord` work the same way.

**Honest result gate:** a transaction that is merely *recorded* on-chain (`final_decision: "Commit"`)
is treated as success **only** when its execution result is `Accept`. A fee-only commit — where the
fee is paid but execution is rejected (e.g. the revealed budget fell short) — **throws** with the
reason, instead of falsely reporting the name as registered.

## Record-key convention

The contract stores records as opaque strings and does not interpret keys. By convention:

| key       | value                                                    | used by |
|-----------|----------------------------------------------------------|---------|
| `nostr`   | a Nostr public key (npub bech32 or 64-char hex)          | Caravel |
| `tari`    | an `otl_esm_…` Tari address (optional)                   | wallets |
| *(other)* | open — any project may define its own keys               | anyone  |

## Develop

```bash
npm install         # deps (typescript, tsx; + the @tari-project/ootle peer dep for writes)
npm run typecheck   # tsc --noEmit
npm run build       # emit dist/ (js + d.ts)
npm run demo        # live keyless read proof against the deployed registry
```
