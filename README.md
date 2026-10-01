# ONS — Ootle Name Service

> ### Version pin (must TRACK the deployed Tari Ootle engine)
> ```toml
> tari_template_lib = "0.33"           # esmeralda / tari-ootle v0.42.x
> tari_ootle_template_build = "0.13"
> tari_template_test_tooling = "0.42"
> # edition = "2024"
> ```
> **The pin has to match the network in BOTH directions.** A template built against a lib *ahead* of
> the engine fails to publish; one built against a lib *behind* it fails at runtime. The second half
> is the one that bites, because it is silent: the crate still compiles and `cargo build-wasm` still
> succeeds, so nothing warns you. Only the deployed template misbehaves.
>
> That is exactly what happened at **tari-ootle 0.39.0**. `Amount`'s wire format changed to minicbor's
> native integer encoding (it was a two-element digit array), so a template built on the old lib
> cannot decode an `Amount` from the engine, or produce one the engine can read. The 0.39 release
> notes put it plainly: *"Templates must be rebuilt and republished against the latest
> `tari_template_lib`."* The testnet reset wiped the deployment at the same time, so ONS needed a
> rebuild and a fresh publish regardless.
>
> **Cargo will not do this for you.** `"0.31"` means `>=0.31.0, <0.32.0` — a new minor from a network
> upgrade is never picked up by `cargo update` alone. Bumping is a deliberate edit, and the three
> pins move together as one toolchain set.
>
> **To check what the network is on before you publish:**
> ```bash
> curl -s https://ootle-indexer-a.tari.com/network     # -> {"network":"esmeralda","epoch":…}
> ```
> then match that engine version against the crate versions in the corresponding
> [tari-ootle release](https://github.com/tari-project/tari-ootle/releases) — the template crates are
> published alongside it, on their own version lines (engine 0.42 → `template_lib` 0.33,
> `template_build` 0.13, `test_tooling` 0.42; engine 0.39 was 0.31 / 0.11 / 0.39). Re-validate with `cargo build-wasm && cargo test`
> after any bump, and republish: a rebuilt template gets a NEW `template_address`, so every consumer
> pinning the old one (see [Deployment](#deployment-esmeralda-testnet)) has to be updated too.

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

### Current — Ootle 0.42 (published 2026-10-01, epoch 11714)

Built from `793428f` (`tari_template_lib` 0.33, `tari_ootle_template_build` 0.13, `tari_template_test_tooling`
0.42) and published with `tari-ootle-cli` 0.28 against `tari_ootle_walletd` 0.42, paid from the `deployer`
account's revealed balance. The CLI runs `wasm-opt` before publishing, so the on-chain binary (97 983 bytes)
is the optimised form of the 111 900-byte `cargo build` output.

| what | value |
|------|-------|
| **Template** (`OotleNameService`) | `template_ceb0ef6b0ae298cbc412fd7e1054c2bf2e7204a1d58bfe979976e6918ae6536f` |
| Publish tx | `a1a8fa9ec087e4a58e9c6210e0f0913aeeb56eecfe8bb6e59176a4e4ded59ac4` — Commit / Accept, fee 727 428 µtTARI |
| Template author (deployer owner key) | `20db90bffb62905d14b75369de9de8523d859bdec5f75e36929fbf9099781661` |
| Metadata hash | `122048ed57f9b572b028d42c8db1e04ad8d9467d2630c48faa53302a01be8f4c68b9` (commit_hash `793428f`) |
| On-chain binary sha256 | `9c5c2f94999a6a9953b6e2019b9fd9d4be9cb9126c87bea76bf42382349e1dc0` |
| **Registry component** (shared, `new()`) | `component_0109d5287493affc06ec8902fcbf85bd2362832580feeac2a70cba7e5ac6da4d` |

The registry was instantiated with `OnsWriter.instantiate()` (client/src/writer.ts): daemon-sealed by the
`deployer` account, fee from its revealed balance, dry-run first, final Accept required. Both public
indexers read the component back as version 0 of the template above, access rules `AllowAll`, empty
registry; its component owner rule is the deployer key.

| step | tx id | result | fee (µtTARI) |
|------|-------|--------|--------------|
| `new()` instantiate | `6e4c2a8c4a1140196fc08a07e833b7205cd04de1997b6cebc56e064b735fb8ef` | Commit / Accept | 1 581 |
| `register("cns042test")` — throwaway test name | `c6da1ced2d5d0d75f94ab8959162a7a638f60b5bb859c31d72a8621fafe5dbdc` | Commit / Accept | 1 761 |

`cns042test` resolves through the keyless reader (`createOnsClient({ component }).resolveName`, no key) to
owner `20db90bf…1661`, the deployer, with no records. Names are bound to their registrant and cannot be
transferred, so this test name stays owned by the deployer.

### Previous — ONS-2 (wiped by a testnet reset; kept for history)

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
