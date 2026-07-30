//   ONS client — shared types. Deliberately free of any SDK import so the read path stays
//   zero-dependency (only the write path pulls @tari-project/ootle).

/** A resolved ONS name: its owner and its open set of string key→value records. */
export interface NameRecord {
  /** The name that was resolved. */
  name: string;
  /** Owner identity — the registrant's Ristretto public key, hex-encoded (unforgeable). */
  owner: string;
  /** Open string records, e.g. `{ nostr: "npub1…" }`. The contract does not interpret keys. */
  records: Record<string, string>;
}

/**
 * ONS client configuration. Component address, network and URLs are all explicit — no hardcoding —
 * so a different deployment (or mainnet later) reuses the same library.
 */
export interface OnsConfig {
  /** The ONS registry component address (`component_…`). */
  component: string;
  /** Indexer base URL for keyless reads. Defaults to the esmeralda public indexer. */
  indexerUrl?: string;
  /** Network id, used only for writes (Esmeralda = 38). Defaults to 38. */
  network?: number;
}

/**
 * Wallet-daemon connection used for writes. The daemon seals the transaction server-side with the
 * account's key, so no private key is handled client-side.
 */
export interface DaemonSigner {
  /** Daemon JSON-RPC URL, e.g. `http://127.0.0.1:5100/json_rpc`. */
  url: string;
  /** Daemon API key (bearer). Supply from the environment — never hardcode or commit it. */
  apiKey: string;
  /** Name of a daemon account that signs & pays, e.g. `"Okz61"`. */
  account: string;
}

/** Result of a write (register / setRecord). */
export interface WriteResult {
  /** The submitted transaction id. */
  transactionId: string;
  /** Fee actually paid, in µtTARI. */
  fee: bigint;
}
