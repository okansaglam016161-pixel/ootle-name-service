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

The Tari SDK is an **optional peer dependency** — install it only if you do writes:
`@tari-project/ootle`, `-indexer` and `-secret-key-wallet` 0.8, and `@tari-project/ootle-wasm` 0.45
(Ootle 0.45, protocol V1, on esmeralda testnet).

## Configure

Nothing is hardcoded; component address, network and URLs are all config, so another deployment
(or mainnet later) reuses the same library.

```ts
import { createOnsClient } from "@ootle/name-service";

const ons = createOnsClient({
  component: "component_0109d5287493affc06ec8902fcbf85bd2362832580feeac2a70cba7e5ac6da4d", // the live esmeralda registry
  // indexerUrl defaults to the esmeralda public indexer, https://ootle-indexer-a.tari.com
  // network defaults to 38 (Esmeralda), used only for writes
});
```

## Reads (keyless)

```ts
await ons.resolveToNostr("alice");   // "npub1…" — the common Caravel case, or null
await ons.getRecord("alice", "nostr"); // "npub1…" or null
await ons.isRegistered("alice");     // true / false
await ons.resolveName("alice");      // { name, owner, records } or null
await ons.namesForOwners([keyA, keyB]); // every name either key owns, sorted; each record names its owner
```

`resolveName` returns:

```ts
interface NameRecord {
  name: string;
  owner: string;                    // registrant's Ristretto public key, hex (unforgeable)
  records: Record<string, string>;  // e.g. { nostr: "npub1…" }
}
```

## Writes with a wallet daemon

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
  // nameOwner?    // the key that owns the names written (default: wallet) — see below
  // indexerUrl?   // defaults to the esmeralda public indexer
});
```

A name's owner is the transaction's **first signer**, and the registry records it publicly. A wallet
that keeps a separate key for its names, rather than registering them under its account's owner key,
passes that key as `nameOwner`: it signs first, owns what it registers, and receives the revealed
fee. To edit a name, attach the key that owns it (`NameRecord.owner` says which).

Registration is a **prepare → confirm → submit** flow, so the user sees the exact fee before
anything is spent — and the transaction they confirm is the one that is sent:

```ts
// 1. Prepare — pick the fee input once, dry-run against /transactions/dry-run to learn the cost, and
//    build + seal the REAL transaction at the fee you choose. Nothing is committed or spent.
const prepared = await writer.prepareRegisterWithNostr("alice", "npub1…", cost => cost + cost / 50n)

// 2. Show prepared.feeMicroTari — the whole revealed budget, which is exactly what is charged (the
//    overcharge is not refunded on this path). Optionally re-check just before sending: a free dry
//    run of a twin at the same fee, accepted only if the network's required fee is within it.
const check = await prepared.simulate()

// 3. On confirmation, send THAT envelope — no rescan, no reselection, no rebuild. Once only.
const { transactionId, fee } = await prepared.submit()
```

`estimateRegisterWithNostr` / `submitRegisterWithNostr(name, npub, budget)` remain for callers that
already hold a budget; the latter now prepares at that budget and submits what it prepared.

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
npm run demo        # keyless read demo — resolves testname4 on the live registry
```
