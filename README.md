# ONS — Ootle Name Service

> ### Version pin (must match the deployed Tari Ootle engine)
> ```toml
> tari_template_lib = "0.29"   # resolves to 0.29.0 (crates.io)
> ```
> This is the exact `tari_template_lib` dependency validated by ONS-0: it compiles to `wasm32`
> and matches esmeralda's current engine line (tari-ootle v0.36/v0.37 → template_lib 0.29.0), which
> is also the newest `tari_template_lib` published. **Do not** bump this or switch to a
> `git`/`branch = "development"` pin without re-validating against the live engine — a template built
> against a version ahead of the network will fail to publish. Companion pins from the same toolchain:
> `tari_template_test_tooling = "0.36"`, `tari_ootle_template_build = "0.7"`, `edition = "2024"`.

A decentralised **username registry** on the [Tari Ootle](https://ootle.tari.com). A short name maps
to an **owner** and an **open set of string key→value records**. It is a standalone Tari ecosystem
contribution, designed to be reused by any Tari project;
[Caravel](https://github.com/okansaglam016161-pixel/caravel) is its first consumer.

Names are **bound (non-transferable) for now** — there is no transfer, fee, or pricing logic. Only
the base network transaction fee applies.

## Repository layout

| path | what |
|------|------|
| [`template/`](template/) | the Rust smart contract (`#[template]`), its local tests, and the WASM build |
| [`client/`](client/) | `@ootle/name-service` — a TypeScript client any app imports to resolve/register names ([client/README](client/README.md)) |

Resolution is **permissionless**: the client reads names through the public indexer with no wallet,
no key and no fee. Writes go through a signer — **either** a wallet daemon (`withSigner`) **or** a
self-custodial browser wallet (`withBrowserSigner`, the path Caravel uses). See
[client/README.md](client/README.md).

## What it does

- **`register(name)`** — claim a name. The caller becomes the owner. Fails if the name is invalid or
  already taken. Uniqueness is enforced atomically inside a single shared component.
- **`set_record(name, key, value)`** — set/overwrite an arbitrary string record on a name. **Only the
  owner** (the exact identity that registered it) may do this.
- **`get_record(name, key) -> Option<String>`** — public read of one record.
- **`lookup(name) -> Option<(owner, records)>`** — public read of a name's owner + all records.
- **`is_registered(name) -> bool`** — public existence check.

## Security model

Ownership is the **transaction signer's Ristretto public key**
(`CallerContext::transaction_signer_public_key()`), captured at registration and checked on every
write. The signer **cannot be forged**, so:

- Nobody can register a name pointing at *someone else's* identity — you can only register as
  yourself.
- Nobody can modify a name they don't own — `set_record` requires `caller == owner`.

For **bound names this is the strongest model**: the owner's keypair *is* the ownership credential,
with nothing transferable to steal or mis-assign. The stored `owner` field means a badge/transfer
model can be layered on later (mint an ownership NFT, gate `set_record` on holding it) **without
redesign** — that belongs with the transfer feature, not with bound names.

> Note: ONS authenticates *who* owns a name (the Ootle signer). It does **not** verify that the
> string values are truly the owner's keys — e.g. the `"nostr"` value is a claim. Cross-key proof
> (a secp256k1 Nostr key is a different curve from Ristretto and can't be verified in-template) is an
> application-layer concern; Caravel establishes the Nostr↔Tari binding over its own authenticated
> channel.

## Record-key convention (interoperability spec)

The contract stores records as opaque strings and **does not interpret keys**. These keys are
**conventions**, not enforced by the contract, so ecosystem projects interoperate:

| key       | value                                                        | used by |
|-----------|-------------------------------------------------------------|---------|
| `nostr`   | a Nostr public key (npub bech32 or 64-char hex)             | Caravel |
| `tari`    | an `otl_esm_…` Tari address (optional)                      | wallets |
| *(other)* | open — any project may define and populate its own keys     | anyone  |

## Guardrails (bounded on-chain state)

A permissionless registry lives in one shared component, so every field is capped to prevent state
bloat / griefing:

| limit                   | value | why |
|-------------------------|-------|-----|
| max name length         | 32    | names are the map keys; short keeps the shared component small |
| name charset            | `a-z 0-9 _ -` (ASCII lowercase) | one canonical form per name — no case/homoglyph impersonation |
| max record key length   | 64    | keys are short conventions |
| max record value length | 512   | fits a hex Nostr key (64), an npub (~63), or an `otl_esm_` address (~66) with headroom |
| max records per name     | 16    | covers `nostr` + `tari` + a dozen app records; caps per-name growth |

## Build & test

The contract (in [`template/`](template/)):

```bash
cd template
cargo build-wasm        # compile the template to wasm32-unknown-unknown (alias in .cargo/config.toml)
cargo test              # local logic tests via tari_template_test_tooling
```

The client (in [`client/`](client/)):

```bash
cd client
npm run typecheck       # tsc, no emit
npm run demo            # live keyless read proof against the deployed registry (no key, no fee)
```

No credentials live in this repo — `tari-cli` authenticates to the wallet daemon via an API key
passed at publish time (`--api-key` / `TARI_WALLET_DAEMON_API_KEY`), never written to disk here.

## Deployment (esmeralda testnet)

Local logic proven (ONS-1), then published and exercised end-to-end on-chain (ONS-2).

| what | address |
|------|---------|
| **Template** (`OotleNameService`, ABI v0) | `template_4af4c620d1585eaf50b6c82b2f14f2ccc6a70a908b227ca46f1a1121070a69d1` |
| **Registry component** (shared, `new()`) | `component_0e70f16ad20e1c1b92f035d1e6f4b69c6c4c774ed309c2eb9e2c42c01279994a` |

First registered name: **`okz`** → owner `c00a40049fa8382a411e40a0d95f2a1231b1fb18d4ccb13c1eb284024c03242d`
(Okz61's Ootle signer), record `nostr = npub1f80mhkkj8hw2ay8xpqwn3c742ptuldvpxlk68k92el5hs22xllpqsknttt`.

Transactions were built with the tari.js `TransactionBuilder` and **sealed server-side by the wallet
daemon** (`seal_signer = the account's owner key`), so the on-chain owner is the real account identity,
not an ephemeral client key. Each mutating call was dry-run first (free) to validate and estimate the fee.

| step | tx id | fee (µtTARI) |
|------|-------|--------------|
| `new()` instantiate | `99fc365cf07c3e782e94e34ebe25ab7f898796d868871e58335d6b116b1b7298` | 601 |
| `register("okz")` | `01d23f899210c093ba19f217e98689366d2f58d49c645246f83191de96a13f98` | 658 |
| `set_record("okz","nostr",…)` | `2a1e9aabeef628790766b329c6c96c2f16dc898d0097a217b95ce8877557cf99` | 769 |

On-chain call fees total **2 028 µtTARI (~0.002 tTARI)**, plus the one-time template publish fee.
