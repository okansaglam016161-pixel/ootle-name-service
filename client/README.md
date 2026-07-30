# @ootle/name-service

TypeScript client for the [Ootle Name Service](../README.md) (ONS) registry.

- **Reads** (name resolution) go through the public Ootle **indexer** — **no wallet, no key, no fee**.
  Zero runtime dependencies; runs in the browser or Node. This is all a resolver (e.g. Caravel) needs.
- **Writes** (`register`, `setRecord`) go through a **wallet daemon**, which seals the transaction
  server-side with the account key. Only reachable after you attach a signer, and only then is the
  `@tari-project/ootle` peer dependency loaded.

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

## Record-key convention

The contract stores records as opaque strings and does not interpret keys. By convention:

| key       | value                                                    | used by |
|-----------|----------------------------------------------------------|---------|
| `nostr`   | a Nostr public key (npub bech32 or 64-char hex)          | Caravel |
| `tari`    | an `otl_esm_…` Tari address (optional)                   | wallets |
| *(other)* | open — any project may define its own keys               | anyone  |

## Develop

```bash
npm run typecheck   # tsc --noEmit
npm run build       # emit dist/ (js + d.ts)
npm run demo        # live keyless read proof against the deployed registry
```
