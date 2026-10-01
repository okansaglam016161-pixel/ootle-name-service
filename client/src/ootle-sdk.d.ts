//   BUILD-TIME type stubs for the slice of the tari.js packages the write paths use.
//
//   These packages are OPTIONAL peer dependencies (only writes need them); a consumer that does
//   writes installs the real builds (Caravel aliases the patched local dist). This stub lets the
//   client type-check standalone without vendoring the SDK. Types are deliberately permissive — the
//   write code mirrors Caravel's proven runtime usage (confidentialSend.ts), so the stub's job is
//   only to let correct code compile, not to re-type the SDK. None of it leaks into ONS's public API
//   (writer methods return this package's own WriteResult, etc.).
//
//   THE COST OF THIS FILE, learned the hard way at Ootle 0.39. Because the client compiles against
//   these stubs and not the real packages, an SDK breaking change cannot surface here as a type
//   error — `TransactionBuilder`'s new mandatory `maxEpoch` argument was declared away by the stub
//   and only failed at runtime. Anything declared here MUST be corrected whenever the SDK moves, or
//   it silently lies. The durable fix is to drop the stubs and depend on the real
//   `@tari-project/ootle` (published since 0.3.0, which the stubs predate) so the compiler checks
//   these calls for real; this file is the cheap fix, not the right one.

declare module "@tari-project/ootle" {
  export const TARI_RESOURCE_ADDRESS: string;
  export const Network: { Esmeralda: number; [k: string]: number };

  export class TransactionBuilder {
    /**
     * Ootle 0.39 made `maxEpoch` a REQUIRED constructor parameter — the builder throws
     * `maxEpoch must be a non-negative integer epoch` without it.
     *
     * This stub previously declared the 1-argument form, which is how the break stayed INVISIBLE:
     * the client type-checks against this file and not the real SDK, so both call sites compiled
     * cleanly and failed only at runtime, with no compiler in this repo or in Caravel able to say
     * so. Keeping the signature honest is the whole point of the stub existing at all.
     */
    constructor(network: number, maxEpoch: number);
    feeTransactionPayFromComponent(componentAddress: string, maxFee: bigint): this;
    callFunction(target: { templateAddress: string; functionName: string }, args: unknown[]): this;
    callMethod(target: { componentAddress: string; methodName: string }, args: unknown[]): this;
    addFeeInstruction(instruction: unknown): this;
    addInput(input: { substate_id: string; version: number | null }): this;
    buildUnsignedTransaction(): unknown;
  }

  export class WasmStealthCrypto {
    constructor(network: number);
    /**
     * Ootle 0.42 (SDK 0.6) replaced the bare revealed amount with `{ amount, receiver }`: the engine
     * creates the revealed bucket only if `receiver`'s badge is in the transaction's auth scope.
     * The old `bigint` form is what this stub declared before, and it would have compiled cleanly.
     */
    generateOutputsStatement(
      outputs: unknown[],
      revealed: { amount: bigint; receiver: Uint8Array } | null,
    ): Promise<{ statement: unknown; outputMask: unknown }>;
    buildInputsStatement(inputs: unknown[], revealed: bigint): Promise<unknown>;
  }

  export class OotleWallet {
    registerKeyProvider(address: string, wallet: unknown): OotleWallet;
    setDefaultSigner(address: string): OotleWallet;
  }

  export class StealthInput {
    constructor(commitment: Uint8Array);
  }
  export class StealthTransferStatement {
    constructor(inputs: unknown, outputs: unknown, proof: unknown);
  }

  export function createOutput(opts: {
    destination: string;
    amount: bigint;
    resourceAddress: string;
    memo?: unknown;
  }): unknown;
  export function decryptOwnedUtxo(
    crypto: WasmStealthCrypto,
    viewSecret: Uint8Array,
    response: unknown,
    substateId: string,
  ): Promise<{ value: bigint; mask: unknown } | null>;
  export function generateSealKeypair(): { public_key: Uint8Array };
  export function resolveTransaction(provider: unknown, unsigned: unknown): Promise<unknown>;
  /** Chain tip + `leadEpochs` (default 10), for the mandatory `max_epoch`. */
  export function resolveMaxEpoch(provider: unknown, leadEpochs?: number): Promise<number>;
  export function sealTransaction(signed: unknown): unknown;
  export function serializeUnsignedTx(unsigned: unknown): unknown;
  export function signBalanceProof(
    crypto: WasmStealthCrypto,
    inputMask: unknown,
    outputMask: unknown,
    inputsStatement: unknown,
    outputsStatement: unknown,
  ): Promise<unknown>;
  export function signTransaction(signers: unknown[], unsigned: unknown, sealKeypair: unknown): Promise<unknown>;
  export function stealthTransferInstruction(
    opts: { resourceAddress: string; revealedInputBucket: unknown; statement: unknown },
    bucketRef: () => { id: number; offset: number | null },
  ): unknown;
  export function stealthUtxoSubstateId(resourceAddress: string, commitment: Uint8Array): string;
  export function stringLiteral(value: string): unknown;

  export type Mask = unknown;
  export interface Signer {
    getAddress(): Promise<string>;
    getPublicKey(): Promise<Uint8Array>;
    signTransaction(tx: unknown, key: Uint8Array): Promise<unknown>;
  }
}

declare module "@tari-project/ootle-indexer" {
  export class IndexerProvider {
    static connect(opts: { url: string; network: number }): Promise<IndexerProvider>;
    getCurrentEpoch(): Promise<number>;
    submitTransaction(envelope: unknown): Promise<{ transaction_id: string }>;
    getSubstate(id: string): Promise<unknown>;
    stopWatcher?(): void;
  }
}

declare module "@tari-project/ootle-secret-key-wallet" {
  export interface SecretKeyWallet {
    getViewSecret(): Promise<Uint8Array>;
    /** The owner public key — the 0.42 revealed-output receiver. */
    getPublicKey(): Promise<Uint8Array>;
    addStealthSignature(
      unsignedJson: unknown,
      nonce: Uint8Array,
      sealPublicKey: Uint8Array,
      opts: { crypto: unknown },
    ): Promise<unknown>;
  }
}
