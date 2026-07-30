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
const MAX_FEE = 10_000n; // µtTARI ceiling; actual ONS calls cost ~600–800

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

/** Poll the indexer for the final decision + fee (up to ~30s). */
async function pollResult(indexerUrl: string, txId: string): Promise<{ outcome: "Commit" | "Reject" | "Timeout"; fee: bigint }> {
  for (let i = 0; i < 6; i++) {
    await new Promise<void>((r) => setTimeout(r, 5_000));
    try {
      const res = await fetch(`${indexerUrl}/transactions/${txId}/result`);
      if (!res.ok) continue;
      const json = (await res.json()) as {
        result?: { Finalized?: { final_decision?: string; finalize?: { fee_receipt?: { total_fees_paid?: number | string } } } };
      };
      const fin = json.result?.Finalized;
      const decision = fin?.final_decision;
      const fee = BigInt(fin?.finalize?.fee_receipt?.total_fees_paid ?? 0);
      if (decision === "Commit") return { outcome: "Commit", fee };
      if (decision) return { outcome: "Reject", fee };
    } catch {
      /* transient */
    }
  }
  return { outcome: "Timeout", fee: 0n };
}

/** ONS writes signed by a self-custodial browser wallet. Obtain via `createOnsClient(cfg).withBrowserSigner(signer)`. */
export class OnsBrowserWriter {
  private readonly component: string;
  private readonly indexerUrl: string;

  constructor(config: OnsConfig, private readonly signer: BrowserSigner) {
    this.component = config.component;
    this.indexerUrl = (signer.indexerUrl ?? config.indexerUrl ?? DEFAULT_INDEXER_URL).replace(/\/+$/, "");
  }

  /** Register a name; the signing wallet becomes its owner. */
  register(name: string): Promise<WriteResult> {
    return this.run([{ methodName: "register", args: [stringLiteral(name)] }]);
  }

  /** Set (or overwrite) a record on a name this wallet owns. */
  setRecord(name: string, key: string, value: string): Promise<WriteResult> {
    return this.run([{ methodName: "set_record", args: [stringLiteral(name), stringLiteral(key), stringLiteral(value)] }]);
  }

  /**
   * Register a name AND set its `nostr` record in a single atomic transaction (one fee, no
   * read-after-write lag): register runs first, then set_record sees the just-created owner==self.
   */
  registerWithNostr(name: string, nostrPubkey: string): Promise<WriteResult> {
    return this.run([
      { methodName: "register", args: [stringLiteral(name)] },
      { methodName: "set_record", args: [stringLiteral(name), stringLiteral("nostr"), stringLiteral(nostrPubkey)] },
    ]);
  }

  /** Build the fee (reveal MAX_FEE from one UTXO, change to self) + the ONS method call(s), sign, submit. */
  private async run(calls: { methodName: string; args: unknown[] }[]): Promise<WriteResult> {
    const { wallet, senderAddress } = this.signer;
    const provider = await IndexerProvider.connect({ url: this.indexerUrl, network: Network.Esmeralda });
    const crypto = new WasmStealthCrypto(Network.Esmeralda);
    const viewSecret = await wallet.getViewSecret();

    const utxos = await scanUtxos(this.indexerUrl, crypto, viewSecret);
    if (utxos.length === 0) throw new Error("No confidential UTXOs found — this wallet needs a balance to pay the fee.");
    const candidates = utxos.filter((u) => u.value > MAX_FEE).sort((a, b) => Number(a.value - b.value));
    if (candidates.length === 0) {
      const total = utxos.reduce((s, u) => s + u.value, 0n);
      throw new Error(`Insufficient funds to pay the fee. Need > ${MAX_FEE} µtTARI in one UTXO; wallet has ${total} µtTARI total.`);
    }
    const utxo = candidates[0]!;
    const changeAmount = utxo.value - MAX_FEE;

    // Reveal MAX_FEE for the fee; send the rest back to self as change.
    const { statement: outsStmt, outputMask } = await crypto.generateOutputsStatement(
      [createOutput({ destination: senderAddress, amount: changeAmount, resourceAddress: TARI_RESOURCE_ADDRESS })],
      MAX_FEE,
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
    const sealKP = generateSealKeypair();
    const unsignedJson = serializeUnsignedTx(unsignedTx);
    const oneTimeSig = await wallet.addStealthSignature(unsignedJson, utxo.nonce, sealKP.public_key, { crypto });

    const ootleWallet = new OotleWallet().registerKeyProvider(senderAddress, wallet).setDefaultSigner(senderAddress);
    const signed = await signTransaction([ootleWallet, new StaticSigner([oneTimeSig])], unsignedTx, sealKP);
    const envelope = sealTransaction(signed);

    const sub = await provider.submitTransaction(envelope);
    const txId = sub.transaction_id as string;
    const { outcome, fee } = await pollResult(this.indexerUrl, txId);
    provider.stopWatcher?.();
    if (outcome !== "Commit") {
      const label = calls.map((c) => c.methodName).join("+");
      throw new Error(`ONS ${label} ${outcome} on-chain (tx ${txId}). If a name was just taken by someone else, it may already be registered.`);
    }
    return { transactionId: txId, fee };
  }
}
