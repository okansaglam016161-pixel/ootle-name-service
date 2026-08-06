//   ONS client — keyless reads via the public indexer. Zero dependencies (just `fetch`): no wallet,
//   no daemon, no credentials, no fee. Resolution is permissionless and runs in the browser or Node.
//
//   The registry component stores one field, `registry: HashMap<String, NameRecord>`, which the
//   indexer returns as plain JSON at `substate.Component.body.state[0]`:
//       { "okz": [ { "@cbor":"bytes", "hex":"c00a…" }, { "nostr":"npub1…" } ] }
//   i.e. name → [ owner (cbor bytes), records (string→string) ]. No CBOR decoding needed.

import type { NameRecord, OnsConfig } from "./types.js";

const DEFAULT_INDEXER_URL = "https://ootle-indexer-a.tari.com";

/** The bits of the indexer substate response we read. */
interface IndexerSubstateResponse {
  version?: number;
  substate?: { Component?: { body?: { state?: unknown[] } } };
}

/** A registry entry: `[owner, records]`. */
type RegistryEntry = [unknown, Record<string, string>];
/** The registry map: name → entry. */
type RegistryMap = Record<string, RegistryEntry>;

/** Keyless ONS reads via the public indexer. */
export class OnsReader {
  protected readonly component: string;
  protected readonly indexerUrl: string;

  constructor(config: OnsConfig) {
    if (!config?.component || !config.component.startsWith("component_")) {
      throw new Error(`OnsConfig.component must be a 'component_…' address (got ${String(config?.component)})`);
    }
    this.component = config.component;
    this.indexerUrl = (config.indexerUrl ?? DEFAULT_INDEXER_URL).replace(/\/+$/, "");
  }

  /** Fetch the registry map from the component substate. Throws on network / missing-component. */
  private async fetchRegistry(): Promise<RegistryMap> {
    const url = `${this.indexerUrl}/substates/${encodeURIComponent(this.component)}`;
    let resp: Response;
    try {
      resp = await fetch(url);
    } catch (e) {
      throw new Error(`ONS indexer request failed: ${(e as Error).message}`);
    }
    if (resp.status === 404) {
      throw new Error(`ONS registry component not found: ${this.component} (wrong address or network?)`);
    }
    if (!resp.ok) throw new Error(`ONS indexer HTTP ${resp.status}`);

    const body = (await resp.json()) as IndexerSubstateResponse;
    const state = body?.substate?.Component?.body?.state;
    if (!Array.isArray(state) || state.length === 0 || typeof state[0] !== "object" || state[0] === null) {
      throw new Error("ONS: unexpected component state shape from indexer");
    }
    return state[0] as RegistryMap;
  }

  /** Full record for a name (owner + all records), or `null` if the name is unregistered. */
  async resolveName(name: string): Promise<NameRecord | null> {
    const registry = await this.fetchRegistry();
    const entry = registry[name];
    if (!entry) return null;
    return { name, owner: ownerHex(entry[0]), records: { ...(entry[1] ?? {}) } };
  }

  /** One record value for a name, or `null` if the name or key is absent. */
  async getRecord(name: string, key: string): Promise<string | null> {
    const rec = await this.resolveName(name);
    return rec?.records[key] ?? null;
  }

  /** Whether a name is registered. */
  async isRegistered(name: string): Promise<boolean> {
    const registry = await this.fetchRegistry();
    return Object.prototype.hasOwnProperty.call(registry, name);
  }

  /** Convenience for the common case: the `"nostr"` record for a name (what Caravel resolves). */
  async resolveToNostr(name: string): Promise<string | null> {
    return this.getRecord(name, "nostr");
  }

  /**
   * Reverse lookup: every name owned by `ownerHex` (a Ristretto public key, hex). The contract has no
   * owner→names query, but the whole registry is one substate, so we fetch it (the same read every
   * resolution does) and filter by owner. Keyless and authoritative — works identically on any
   * device for the same owner. Returns `[]` if the owner holds no names. Sorted by name.
   */
  async namesForOwner(ownerKeyHex: string): Promise<NameRecord[]> {
    const target = ownerKeyHex.trim().toLowerCase();
    if (!target) return [];
    const registry = await this.fetchRegistry();
    const owned: NameRecord[] = [];
    for (const [name, entry] of Object.entries(registry)) {
      const owner = ownerHex(entry[0]);
      if (owner.toLowerCase() === target) {
        owned.push({ name, owner, records: { ...(entry[1] ?? {}) } });
      }
    }
    owned.sort((a, b) => a.name.localeCompare(b.name));
    return owned;
  }
}

/** Owner is stored as CBOR bytes `{ "@cbor":"bytes", hex:"…" }`; also tolerate a plain hex string. */
function ownerHex(owner: unknown): string {
  if (typeof owner === "string") return owner;
  if (owner && typeof owner === "object" && "hex" in owner) {
    const h = (owner as { hex?: unknown }).hex;
    if (typeof h === "string") return h;
  }
  return "";
}
