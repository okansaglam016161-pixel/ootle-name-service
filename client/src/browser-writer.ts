//   ONS client — browser (self-custodial) write path.
//
//   Reuses the PROVEN Caravel signing flow (TransactionBuilder → signTransaction → sealTransaction
//   → indexer submit; see caravel-app/src/crypto/confidentialSend.ts), swapping the confidential
//   *transfer* for a template *method call* (register / set_record). A self-custodial Ootle wallet
//   holds confidential UTXOs and has no account component, so the fee is paid the same way
//   confidentialSend pays it: reveal MAX_FEE out of one UTXO via a StealthTransfer, PayFeeFromBucket,
//   change back to self — then run the ONS method call as a normal instruction.
//
//   This makes ONS registrable by ANY self-custodial browser wallet, not just Caravel. It depends on
//   @tari-project/ootle (+ -indexer, + -secret-key-wallet) — optional peer deps loaded only for writes.

import {
  OotleWallet,
  Network,
  TARI_RESOURCE_ADDRESS,
  StealthInput,
  StealthTransferStatement,
  TransactionBuilder,
  WasmStealthCrypto,
  createOutput,
  decryptOwnedUtxo,
  generateSealKeypair,
  resolveTransaction,
  sealTransaction,
  serializeUnsignedTx,
  signBalanceProof,
  signTransaction,
  stealthTransferInstruction,
  stealthUtxoSubstateId,
  stringLiteral,
  type Signer,
  type Mask,
} from "@tari-project/ootle";
import { IndexerProvider } from "@tari-project/ootle-indexer";
import type { SecretKeyWallet } from "@tari-project/ootle-secret-key-wallet";
import type { OnsConfig, WriteResult } from "./types.js";

const DEFAULT_INDEXER_URL = "https://ootle-indexer-a.tari.com";
const RESOURCE_HEX = TARI_RESOURCE_ADDRESS.replace(/^resource_/, "");
const PAGE_SIZE = 200;

// Fee budget revealed for the *estimation* dry-run. Deliberately GENEROUS — comfortably above any
// ONS write's real cost. The confidential fee path consumes the whole revealed budget, so the true
// cost is `total_fee_payment − total_fee_overcharge`, and that identity only holds when the budget
// exceeds the real cost (otherwise the overcharge floors at 0 and the receipt just echoes the
// budget back). A dry-run is simulated — never committed — so this large reveal is never spent, and
// the real submit reveals only the estimate + a small margin. The wallet needs one UTXO larger than
// this to *estimate* (registration itself needs far less).
const DRY_RUN_REVEAL = 50_000n;

// Safety margin added over the estimate when actually submitting. The whole revealed budget is
// consumed on-chain (the fee overcharge is NOT refunded), so keep this small — it exists only to
// absorb tiny fee drift between the dry-run and the real submit.
function withFeeMargin(required: bigint): bigint {
  const margin = (required * 2n) / 100n; // +2%
  return required + (margin > 100n ? margin : 100n);
}

/** A self-custodial browser signer: the user's own secret-key wallet + its owner address. */
export interface BrowserSigner {
  /** The self-custodial wallet (client-side keys). */
  wallet: SecretKeyWallet;
  /** The wallet's owner address (`otl_esm_…`), the change destination. */
  senderAddress: string;
  /** Indexer base URL. Defaults to the esmeralda public indexer. */
  indexerUrl?: string;
}

function fromHex(h: string): Uint8Array {
  const bytes = new Uint8Array(h.length / 2);
  for (let i = 0; i < h.length; i += 2) bytes[i / 2] = parseInt(h.slice(i, i + 2), 16);
  return bytes;
}

type SignedTxArr = Awaited<ReturnType<Signer["signTransaction"]>>;

/** Returns pre-computed signatures (the one-time stealth signature) as a Signer. From confidentialSend. */
class StaticSigner implements Signer {
  constructor(private sigs: SignedTxArr) {}
  async getAddress() {
    return "";
  }
  async getPublicKey() {
    return new Uint8Array(32);
  }
  async signTransaction(_t: Parameters<Signer["signTransaction"]>[0], _k: Uint8Array): Promise<SignedTxArr> {
    return this.sigs;
  }
}

interface OwnedUtxo {
  substateId: string;
  commitment: Uint8Array;
  nonce: Uint8Array;
  value: bigint;
  mask: Mask;
}

/** Scan the indexer for confidential UTXOs this wallet owns (same logic as confidentialSend). */
async function scanUtxos(indexerUrl: string, crypto: WasmStealthCrypto, viewSecret: Uint8Array): Promise<OwnedUtxo[]> {
  const owned: OwnedUtxo[] = [];
  let offset = 0;
  for (;;) {
    const url = `${indexerUrl}/utxos?resource_address=${RESOURCE_HEX}&limit=${PAGE_SIZE}&offset=${offset}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`UTXO scan HTTP ${res.status}`);
    const body = (await res.json()) as { utxos?: [string, unknown][] } | [string, unknown][];
    const page = Array.isArray(body) ? body : (body.utxos ?? []);
    if (page.length === 0) break;
    for (const [commitmentHex, utxoBody] of page) {
      const substateId = `utxo_${RESOURCE_HEX}_${commitmentHex}`;
      const fakeResponse = { version: 0, verified: false, substate: { Utxo: utxoBody } };
      const decrypted = await decryptOwnedUtxo(
        crypto,
        viewSecret,
        fakeResponse as Parameters<typeof decryptOwnedUtxo>[2],
        substateId,
      );
      if (decrypted !== null) {
        const output = (utxoBody as { output?: { output?: { public_nonce?: string } } })?.output?.output;
        if (!output?.public_nonce) continue;
        owned.push({
          substateId,
          commitment: fromHex(commitmentHex),
          nonce: fromHex(output.public_nonce),
          value: decrypted.value,
          mask: decrypted.mask,
        });
      }
    }
    if (page.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  return owned;
}

/**
 * The outcome of a submitted (or dry-run) transaction, read from the indexer's execution result.
 *
 * A transaction can be recorded on the ledger (`final_decision: "Commit"`) yet have its execution
 * *rejected* — the fee is still burned. That is `AcceptFeeRejectRest` ("accept the fee, reject the
 * rest"), which the SDK calls `FeeIntentCommit`. The authoritative signal is therefore
 * `execution_result.finalize.result`, NOT `final_decision`: only a genuine `Accept` applied state.
 */
type WriteOutcome = "Accept" | "FeeIntentCommit" | "Reject" | "Timeout";

interface TxResult {
  outcome: WriteOutcome;
  txId: string;
  /** `total_fees_paid` — what actually left the wallet (µtTARI). The whole revealed budget. */
  feePaid: bigint;
  /** `total_fee_payment − total_fee_overcharge` — the true network cost (Accept only). */
  realCost?: bigint;
  /** The exact fee the network demanded, parsed from a "Required fees N" rejection. */
  requiredFee?: bigint;
  /** Human-readable abort/reject detail, for surfacing an honest error. */
  reason?: string;
}

/**
 * Classify a `finalize` object — `{ result, fee_receipt }` — into Accept / fee-only / reject. This
 * is the shape shared by a committed tx (`Finalized.execution_result.finalize`) and a dry-run's raw
 * ExecuteResult (`result.finalize`). `abortDetails`, when present (committed only), carries the
 * reject-reason string. Returns `null` when there's no execution result yet (not final).
 */
function classifyFinalize(finalize: Record<string, unknown> | undefined, abortDetails?: string): Omit<TxResult, "txId"> | null {
  const result = finalize?.result as Record<string, unknown> | undefined;
  const receipt = finalize?.fee_receipt as
    | { total_fee_payment?: number | string; total_fees_paid?: number | string; total_fee_overcharge?: number | string }
    | undefined;
  const feePaid = BigInt(receipt?.total_fees_paid ?? 0);
  const realCost = receipt ? BigInt(receipt.total_fee_payment ?? 0) - BigInt(receipt.total_fee_overcharge ?? 0) : undefined;

  // The network reports the shortfall as "Required fees N" — in the abort detail (committed) or
  // inside the AcceptFeeRejectRest / Reject payload (dry-run). Scan whichever we have.
  const blob = abortDetails ?? (result ? JSON.stringify(result) : "");
  const m = /Required fees (\d+)/.exec(blob);
  const requiredFee = m ? BigInt(m[1]!) : undefined;
  const reason = abortDetails ?? (result ? JSON.stringify(result) : undefined);

  if (result && typeof result === "object") {
    if ("Accept" in result) return { outcome: "Accept", feePaid, realCost };
    if ("AcceptFeeRejectRest" in result) return { outcome: "FeeIntentCommit", feePaid, requiredFee, reason };
    if ("Reject" in result) return { outcome: "Reject", feePaid, requiredFee, reason };
  }
  return null;
}

/**
 * Classify a committed `Finalized` result (from a GET-result poll). We read the authoritative
 * `execution_result.finalize`, NOT `final_decision` — trusting `final_decision === "Commit"` is
 * exactly what falsely reported success for fee-only commits.
 */
function classifyFinalized(fin: Record<string, unknown>): Omit<TxResult, "txId"> | null {
  const finalize = (fin.execution_result as { finalize?: Record<string, unknown> } | undefined)?.finalize;
  const abort = typeof fin.abort_details === "string" ? (fin.abort_details as string) : undefined;
  return classifyFinalize(finalize, abort);
}

/** Poll the indexer for the execution result (up to ~30s), classifying Accept vs fee-only vs reject. */
async function pollResult(indexerUrl: string, txId: string): Promise<Omit<TxResult, "txId">> {
  for (let i = 0; i < 6; i++) {
    await new Promise<void>((r) => setTimeout(r, 5_000));
    try {
      const res = await fetch(`${indexerUrl}/transactions/${txId}/result`);
      if (!res.ok) continue;
      const json = (await res.json()) as { result?: { Finalized?: Record<string, unknown> } };
      const fin = json.result?.Finalized;
      if (!fin) continue; // still pending — keep polling
      const classified = classifyFinalized(fin);
      if (classified) return classified;
    } catch {
      /* transient */
    }
  }
  return { outcome: "Timeout", feePaid: 0n };
}

/**
 * Submit a dry-run (simulated, never committed) to the dedicated `transactions/dry-run` endpoint —
 * the network rejects `dry_run` transactions on the normal submit path. Unlike a committed tx, this
 * endpoint returns the raw `ExecuteResult` SYNCHRONOUSLY: `{ transaction_id, result: { finalize } }`,
 * with no `Finalized` wrapper and no `final_decision`, and it is never recorded at
 * `/transactions/{id}/result`. So we classify the inline `result.finalize` and never poll.
 */
async function dryRunSubmit(provider: IndexerProvider, envelope: unknown): Promise<Omit<TxResult, "txId"> & { txId: string }> {
  // `getTransport()` is present at runtime but absent from the (older) build-time indexer types, so
  // reach it structurally. This is the same transport `submitTransaction` posts through.
  const transport = (provider as unknown as {
    getClient(): { getTransport(): { sendPost(path: string, body: unknown): Promise<unknown> } };
  })
    .getClient()
    .getTransport();
  const resp = (await transport.sendPost("transactions/dry-run", { transaction: envelope })) as {
    transaction_id?: string;
    result?: { finalize?: Record<string, unknown> };
  };
  const txId = resp.transaction_id ?? "(dry-run)";
  const classified = classifyFinalize(resp.result?.finalize);
  if (classified) return { ...classified, txId };
  throw new Error(`Dry-run returned an unrecognised result: ${JSON.stringify(resp)}`);
}

/** Build an honest error message for a non-Accept outcome. */
function rejectMessage(r: TxResult, calls: { methodName: string }[]): string {
  const label = calls.map((c) => c.methodName).join("+");
  if (r.outcome === "FeeIntentCommit") {
    const need = r.requiredFee !== undefined ? ` The network required ${r.requiredFee} µtTARI.` : "";
    return `ONS ${label} was rejected on-chain: the fee was too low, so no name was registered — but the fee was still spent (tx ${r.txId}).${need}`;
  }
  if (r.outcome === "Reject") {
    return `ONS ${label} was rejected on-chain (tx ${r.txId}): ${r.reason ?? "unknown reason"}. If a name was just taken by someone else, it may already be registered.`;
  }
  if (r.outcome === "Timeout") {
    return `ONS ${label} did not confirm in time (tx ${r.txId}). Check Activity before retrying.`;
  }
  return `ONS ${label} failed (tx ${r.txId}).`;
}

/** ONS writes signed by a self-custodial browser wallet. Obtain via `createOnsClient(cfg).withBrowserSigner(signer)`. */
export class OnsBrowserWriter {
  private readonly component: string;
  private readonly indexerUrl: string;

  constructor(config: OnsConfig, private readonly signer: BrowserSigner) {
    this.component = config.component;
    this.indexerUrl = (signer.indexerUrl ?? config.indexerUrl ?? DEFAULT_INDEXER_URL).replace(/\/+$/, "");
  }

  /** Register a name; the signing wallet becomes its owner. Estimates the fee, then submits. */
  register(name: string): Promise<WriteResult> {
    return this.estimateAndSubmit(registerCalls(name));
  }

  /** Set (or overwrite) a record on a name this wallet owns. Estimates the fee, then submits. */
  setRecord(name: string, key: string, value: string): Promise<WriteResult> {
    return this.estimateAndSubmit([{ methodName: "set_record", args: [stringLiteral(name), stringLiteral(key), stringLiteral(value)] }]);
  }

  /**
   * Register a name AND set its `nostr` record in a single atomic transaction (one fee, no
   * read-after-write lag): register runs first, then set_record sees the just-created owner==self.
   * Estimates the fee (dry-run) and submits with a small margin in one call.
   */
  registerWithNostr(name: string, nostrPubkey: string): Promise<WriteResult> {
    return this.estimateAndSubmit(registerWithNostrCalls(name, nostrPubkey));
  }

  /**
   * Estimate — WITHOUT committing — the fee (µtTARI) to register `name` + its `nostr` record. Runs a
   * simulated dry-run on the network; nothing is spent. Pair with {@link submitRegisterWithNostr} to
   * show the user the cost and register only on their confirmation.
   */
  async estimateRegisterWithNostr(name: string, nostrPubkey: string): Promise<{ feeMicroTari: bigint }> {
    const { requiredFee } = await this.estimate(registerWithNostrCalls(name, nostrPubkey));
    return { feeMicroTari: requiredFee };
  }

  /**
   * Register `name` + its `nostr` record, revealing exactly `feeBudget` µtTARI for the fee (from a
   * prior {@link estimateRegisterWithNostr}, plus the caller's chosen margin). Throws an honest error
   * on any non-Accept outcome — including a fee-only commit where the fee was burned but no name set.
   */
  async submitRegisterWithNostr(name: string, nostrPubkey: string, feeBudget: bigint): Promise<WriteResult> {
    const calls = registerWithNostrCalls(name, nostrPubkey);
    const r = await this.buildSubmit(calls, feeBudget, false);
    if (r.outcome !== "Accept") throw new Error(rejectMessage(r, calls));
    return { transactionId: r.txId, fee: r.feePaid };
  }

  /** Convenience: dry-run estimate → submit with a small safety margin. Used by the single-call API. */
  private async estimateAndSubmit(calls: Call[]): Promise<WriteResult> {
    const { requiredFee } = await this.estimate(calls);
    const r = await this.buildSubmit(calls, withFeeMargin(requiredFee), false);
    if (r.outcome !== "Accept") throw new Error(rejectMessage(r, calls));
    return { transactionId: r.txId, fee: r.feePaid };
  }

  /** Dry-run the call(s) to learn the exact required fee (µtTARI). Nothing is committed. */
  private async estimate(calls: Call[]): Promise<{ requiredFee: bigint }> {
    const r = await this.buildSubmit(calls, DRY_RUN_REVEAL, true);
    // Genuine accept: the revealed budget EXCEEDED the real cost, so overcharge > 0 and
    // realCost = payment − overcharge is the true fee. `realCost < DRY_RUN_REVEAL` proves overcharge
    // was positive — guarding against the degenerate case where an under-sized budget floors the
    // overcharge at 0 and the receipt just echoes the budget back.
    if (r.outcome === "Accept" && r.realCost !== undefined && r.realCost > 0n && r.realCost < DRY_RUN_REVEAL) {
      return { requiredFee: r.realCost };
    }
    // Budget was below the real cost — the network told us exactly what it needs.
    if (r.requiredFee !== undefined) return { requiredFee: r.requiredFee };
    // Degenerate accept (fee ≥ dry-run budget, overcharge floored to 0) or a missing receipt.
    throw new Error(
      `Could not estimate the registration fee — the cost may exceed the ${DRY_RUN_REVEAL} µtTARI dry-run budget (outcome: ${r.outcome}).`,
    );
  }

  /**
   * Build the fee (reveal `feeBudget` from one UTXO, change to self) + the ONS method call(s), sign,
   * and submit — or, when `dryRun`, submit a simulated transaction the network won't commit. Returns
   * the classified execution outcome; callers decide whether a non-Accept is fatal.
   */
  private async buildSubmit(calls: Call[], feeBudget: bigint, dryRun: boolean): Promise<TxResult> {
    const { wallet, senderAddress } = this.signer;
    const provider = await IndexerProvider.connect({ url: this.indexerUrl, network: Network.Esmeralda });
    const crypto = new WasmStealthCrypto(Network.Esmeralda);
    const viewSecret = await wallet.getViewSecret();

    const utxos = await scanUtxos(this.indexerUrl, crypto, viewSecret);
    if (utxos.length === 0) throw new Error("No confidential UTXOs found — this wallet needs a balance to pay the fee.");
    const candidates = utxos.filter((u) => u.value > feeBudget).sort((a, b) => Number(a.value - b.value));
    if (candidates.length === 0) {
      const largest = utxos.reduce((m, u) => (u.value > m ? u.value : m), 0n);
      throw new Error(
        `Can't fund the fee from one UTXO: need more than ${feeBudget} µtTARI in a single UTXO, but the largest is ${largest} µtTARI. ` +
          `(Paying a fee from multiple UTXOs isn't supported yet — consolidate first.)`,
      );
    }
    const utxo = candidates[0]!;
    const changeAmount = utxo.value - feeBudget;

    // Reveal feeBudget for the fee; send the rest back to self as change.
    const { statement: outsStmt, outputMask } = await crypto.generateOutputsStatement(
      [createOutput({ destination: senderAddress, amount: changeAmount, resourceAddress: TARI_RESOURCE_ADDRESS })],
      feeBudget,
    );
    const insStmt = await crypto.buildInputsStatement([new StealthInput(utxo.commitment)], 0n);
    const proof = await signBalanceProof(crypto, utxo.mask, outputMask, insStmt, outsStmt);
    const stmt = new StealthTransferStatement(insStmt, outsStmt, proof);

    const builder = new TransactionBuilder(Network.Esmeralda);
    // Fee: StealthTransfer → bucket on workspace → PayFeeFromBucket (identical to confidentialSend).
    builder.addFeeInstruction(
      stealthTransferInstruction({ resourceAddress: TARI_RESOURCE_ADDRESS, revealedInputBucket: null, statement: stmt }, () => ({ id: 0, offset: null })),
    );
    builder.addFeeInstruction({ PutLastInstructionOutputOnWorkspace: { key: 0 } });
    builder.addFeeInstruction({ PayFeeFromBucket: { bucket: { id: 0, offset: null } } });
    builder.addInput({ substate_id: stealthUtxoSubstateId(TARI_RESOURCE_ADDRESS, utxo.commitment), version: null });
    // The ONS registry component must be declared as an input so the method call can lock/access it.
    builder.addInput({ substate_id: this.component, version: null });
    // The ONS call(s) — normal instructions, run in order after the fee is set up.
    for (const c of calls) builder.callMethod({ componentAddress: this.component, methodName: c.methodName }, c.args);

    const unsignedTx = await resolveTransaction(provider, builder.buildUnsignedTransaction());
    // A dry-run asks the network to simulate execution and return the result without committing state
    // (no fee spent). Set it before serialising so the flag is covered by the signature.
    if (dryRun) (unsignedTx as { dry_run?: boolean }).dry_run = true;
    const sealKP = generateSealKeypair();
    const unsignedJson = serializeUnsignedTx(unsignedTx);
    const oneTimeSig = await wallet.addStealthSignature(unsignedJson, utxo.nonce, sealKP.public_key, { crypto });

    const ootleWallet = new OotleWallet().registerKeyProvider(senderAddress, wallet).setDefaultSigner(senderAddress);
    const signed = await signTransaction([ootleWallet, new StaticSigner([oneTimeSig])], unsignedTx, sealKP);
    const envelope = sealTransaction(signed);

    // Dry-runs must go to the dedicated endpoint; the normal submit path rejects `dry_run` txs.
    if (dryRun) {
      const dr = await dryRunSubmit(provider, envelope);
      provider.stopWatcher?.();
      return dr;
    }
    const sub = await provider.submitTransaction(envelope);
    const txId = sub.transaction_id as string;
    const r = await pollResult(this.indexerUrl, txId);
    provider.stopWatcher?.();
    return { ...r, txId };
  }
}

/** An ONS template method call. */
type Call = { methodName: string; args: unknown[] };

function registerCalls(name: string): Call[] {
  return [{ methodName: "register", args: [stringLiteral(name)] }];
}

function registerWithNostrCalls(name: string, nostrPubkey: string): Call[] {
  return [
    { methodName: "register", args: [stringLiteral(name)] },
    { methodName: "set_record", args: [stringLiteral(name), stringLiteral("nostr"), stringLiteral(nostrPubkey)] },
  ];
}
