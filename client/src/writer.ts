//   ONS client — writes (register / set_record) signed & paid by a wallet-daemon account.
//
//   Reuses the ONS-2 daemon-seal recipe: build instructions with the tari.js TransactionBuilder,
//   then hand the unsigned transaction to the wallet daemon, which SEALS it server-side with the
//   account's key (`seal_signer = account.owner_key_id`). No private key is handled here. Every
//   mutating call is dry-run first (free) to validate + estimate the fee before spending.
//
//   This module is the ONLY one that imports @tari-project/ootle; the read path stays dependency-free.
//   It is loaded lazily by `OnsClient.withSigner()`, so read-only consumers never pull it in.

import { TransactionBuilder, stringLiteral } from "@tari-project/ootle";
import type { DaemonSigner, OnsConfig, WriteResult } from "./types.js";

const DEFAULT_NETWORK = 38; // Esmeralda
const DEFAULT_INDEXER_URL = "https://ootle-indexer-a.tari.com";
const MAX_FEE = 200_000n; // µtTARI ceiling; account-paid fees refund any overcharge
const WAIT_SECS = 30;

// Epochs of validity a transaction we build now should carry (Ootle 0.39: `max_epoch` is mandatory
// and the builder throws without it). Same value as browser-writer.ts and Caravel's crypto/epoch.ts.
const MAX_EPOCH_LEAD = 10;

/** What a dry run returns when nothing is submitted. */
export interface DryRunResult {
  dryRun: true;
  /** The engine's fee receipt for the simulation, as the daemon returned it. */
  feeReceipt: Record<string, unknown> | null;
  /** Components the simulation created (excluding the fee account). */
  newComponents: string[];
}

/** Component ids an Accept diff created or touched, excluding the fee account. */
function createdComponents(result: Record<string, unknown>, feeAccount: string): string[] {
  const ups = ((result.Accept as { up_substates?: unknown[] } | undefined)?.up_substates ?? []) as unknown[];
  return ups
    .map((u) => (Array.isArray(u) ? u[0] : undefined))
    .filter((id): id is string => typeof id === "string" && id.startsWith("component_") && id !== feeAccount);
}

/** ONS writes via a wallet daemon. Obtain one with `createOnsClient(cfg).withSigner(signer)`. */
export class OnsWriter {
  private readonly component: string;
  private readonly network: number;
  private readonly indexerUrl: string;
  private rpcId = 0;

  constructor(config: OnsConfig, private readonly signer: DaemonSigner) {
    this.component = config.component;
    this.network = config.network ?? DEFAULT_NETWORK;
    // Needed only for the chain-tip read below. The daemon exposes no epoch method (checked against
    // walletd 0.39.0), so `max_epoch` has to come from the indexer even on the daemon-signed path.
    this.indexerUrl = (config.indexerUrl ?? DEFAULT_INDEXER_URL).replace(/\/+$/, "");
  }

  /**
   * `max_epoch` for a transaction built now: the chain tip plus MAX_EPOCH_LEAD.
   *
   * Read straight from the indexer with `fetch` rather than through an SDK provider, to keep this
   * module's dependency surface as it was — it imports two symbols from @tari-project/ootle and
   * otherwise talks HTTP.
   */
  private async maxEpoch(): Promise<number> {
    const resp = await fetch(`${this.indexerUrl}/epoch-manager/stats`);
    if (!resp.ok) throw new Error(`ONS: could not read the chain tip for max_epoch (indexer HTTP ${resp.status})`);
    const body = (await resp.json()) as { current_epoch?: number | string };
    const current = Number(body?.current_epoch);
    if (!Number.isSafeInteger(current) || current < 0) {
      throw new Error(`ONS: indexer returned an unusable current_epoch (${String(body?.current_epoch)})`);
    }
    return current + MAX_EPOCH_LEAD;
  }

  private async jrpc<T = unknown>(method: string, params: unknown): Promise<T> {
    const resp = await fetch(this.signer.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.signer.apiKey}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++this.rpcId, method, params }),
    });
    const body = JSON.parse(await resp.text()) as { result?: T; error?: unknown };
    if (body.error) throw new Error(`${method} JRPC error: ${JSON.stringify(body.error)}`);
    return body.result as T;
  }

  /** Resolve the fee-payer account: its component (fee source) and its seal signer (owner key id). */
  private async account(): Promise<{ component: string; sealSigner: unknown }> {
    const r = await this.jrpc<{ account: { component_address: string; owner_key_id: unknown } }>(
      "accounts.get",
      { name_or_address: { Name: this.signer.account } },
    );
    return { component: r.account.component_address, sealSigner: r.account.owner_key_id };
  }

  private async call(methodName: string, args: unknown[]): Promise<WriteResult> {
    const r = (await this.execute(methodName, (b) =>
      b.callMethod({ componentAddress: this.component as never, methodName }, args as never),
    )) as WriteResult;
    return { transactionId: r.transactionId, fee: r.fee };
  }

  /**
   * One daemon-sealed transaction: fee from the signer account's revealed balance, then whatever
   * `addCalls` adds. Dry-run first (free); a non-Accept stops before spending. With `dryRunOnly`,
   * returns the dry run's outcome and submits nothing.
   */
  private async execute(
    label: string,
    addCalls: (b: TransactionBuilder) => TransactionBuilder,
    opts: { dryRunOnly?: boolean } = {},
  ): Promise<WriteResult | DryRunResult> {
    const acct = await this.account();
    const built = addCalls(
      new TransactionBuilder(this.network, await this.maxEpoch()).feeTransactionPayFromComponent(
        acct.component as never,
        MAX_FEE,
      ),
    ).buildUnsignedTransaction() as Record<string, unknown>;

    const req = {
      transaction: {
        V1: {
          network: (built.network as number) ?? this.network,
          fee_instructions: built.fee_instructions ?? [],
          instructions: built.instructions ?? [],
          inputs: built.inputs ?? [],
          min_epoch: built.min_epoch ?? null,
          // 0.39: always a real value now — the builder cannot be constructed without one.
          max_epoch: built.max_epoch,
          is_seal_signer_authorized: true,
          dry_run: false,
          blobs: built.blobs ?? [],
        },
      },
      seal_signer: acct.sealSigner,
      other_signers: [],
      detect_inputs: true,
      detect_inputs_use_unversioned: false, // resolve inputs to their live version (read-after-write)
      lock_ids: [],
    };

    // Dry-run first (free): validate + estimate the fee. A non-Accept outcome stops before spending.
    const dry = await this.jrpc<{
      result?: { finalize?: { result?: Record<string, unknown>; fee_receipt?: Record<string, unknown> } };
    }>("transactions.submit_dry_run", req);
    const dtr = dry?.result?.finalize?.result;
    if (!dtr || !("Accept" in dtr)) {
      throw new Error(`ONS ${label} dry-run did not commit: ${JSON.stringify(dtr)}`);
    }
    if (opts.dryRunOnly) {
      return {
        dryRun: true,
        feeReceipt: dry?.result?.finalize?.fee_receipt ?? null,
        newComponents: createdComponents(dtr, acct.component),
      };
    }

    const sub = await this.jrpc<{ transaction_id: string }>("transactions.submit", req);
    const txId = sub.transaction_id;
    const wait = await this.jrpc<{
      result?: { result?: Record<string, unknown> };
      final_fee?: number | string;
      timed_out?: boolean;
    }>("transactions.wait_result", { transaction_id: txId, timeout_secs: WAIT_SECS });

    if (wait.timed_out) throw new Error(`ONS ${label} timed out after ${WAIT_SECS}s (tx ${txId})`);
    const wtr = wait?.result?.result;
    if (!wtr || !("Accept" in wtr)) {
      throw new Error(`ONS ${label} rejected on-chain: ${JSON.stringify(wtr)}`);
    }
    return {
      transactionId: txId,
      fee: BigInt(wait.final_fee ?? 0),
      newComponents: createdComponents(wtr, acct.component),
    } as WriteResult;
  }

  /**
   * Deploy the shared registry: call the template's `new()` from a daemon account, which pays the
   * fee from its revealed balance. Same path as every write — dry-run first, then submit, then wait
   * for a final Accept. Returns the new registry component's address.
   *
   * With `dryRunOnly`, nothing is submitted; the address reported is the one the SIMULATION
   * created, and the real one will differ (it is derived from the submitted transaction).
   */
  static async instantiate(
    templateAddress: string,
    signer: DaemonSigner,
    opts: { network?: number; indexerUrl?: string; dryRunOnly?: boolean } = {},
  ): Promise<(WriteResult & { component: string }) | DryRunResult> {
    const writer = new OnsWriter({ component: "", network: opts.network, indexerUrl: opts.indexerUrl }, signer);
    const r = await writer.execute(
      "new",
      (b) => b.callFunction({ templateAddress, functionName: "new" }, []),
      { dryRunOnly: opts.dryRunOnly },
    );
    if ("dryRun" in r) return r;
    const created = (r as WriteResult & { newComponents: string[] }).newComponents;
    if (created.length !== 1) {
      throw new Error(`ONS new: expected exactly one new component, got ${JSON.stringify(created)} (tx ${r.transactionId})`);
    }
    return { ...r, component: created[0]! };
  }

  /** Register a name. The signing account becomes its owner. */
  register(name: string): Promise<WriteResult> {
    return this.call("register", [stringLiteral(name)]);
  }

  /** Set (or overwrite) a record on a name the signing account owns. */
  setRecord(name: string, key: string, value: string): Promise<WriteResult> {
    return this.call("set_record", [stringLiteral(name), stringLiteral(key), stringLiteral(value)]);
  }
}
