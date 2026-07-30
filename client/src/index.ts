//   ONS client — public entry point.
//
//   Reads are available out of the box (keyless, zero-dependency). Writes are reachable only after
//   attaching a signer via `withSigner()`, which lazily loads the write module (and its
//   @tari-project/ootle dependency) — so a consumer that only resolves names never touches signing.

import { OnsReader } from "./reader.js";
import type { DaemonSigner, OnsConfig } from "./types.js";
import type { OnsWriter } from "./writer.js";

export type { NameRecord, OnsConfig, DaemonSigner, WriteResult } from "./types.js";
export { OnsReader } from "./reader.js";
export type { OnsWriter } from "./writer.js";

/** An ONS client: keyless reads (inherited from {@link OnsReader}) plus opt-in writes. */
export class OnsClient extends OnsReader {
  private readonly config: OnsConfig;

  constructor(config: OnsConfig) {
    super(config);
    this.config = config;
  }

  /**
   * Attach a wallet-daemon signer to enable writes. Lazily imports the write module so read-only
   * consumers never load the signing code or its SDK dependency.
   */
  async withSigner(signer: DaemonSigner): Promise<OnsWriter> {
    const { OnsWriter } = await import("./writer.js");
    return new OnsWriter(this.config, signer);
  }
}

/** Create an ONS client from configuration. */
export function createOnsClient(config: OnsConfig): OnsClient {
  return new OnsClient(config);
}
