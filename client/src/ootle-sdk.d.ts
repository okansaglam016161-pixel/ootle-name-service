//   BUILD-TIME type stubs for the slice of the tari.js packages the write paths use.
//
//   These packages are OPTIONAL peer dependencies (only writes need them); a consumer that does
//   writes installs the real builds (Caravel aliases the patched local dist). This stub lets the
//   client type-check standalone without vendoring the SDK. Types are deliberately permissive — the
//   write code mirrors Caravel's proven runtime usage (confidentialSend.ts), so the stub's job is
//   only to let correct code compile, not to re-type the SDK. None of it leaks into ONS's public API
//   (writer methods return this package's own WriteResult, etc.).

declare module "@tari-project/ootle" {
  export const TARI_RESOURCE_ADDRESS: string;
  export const Network: { Esmeralda: number; [k: string]: number };

  export class TransactionBuilder {
    constructor(network: number);
    feeTransactionPayFromComponent(componentAddress: string, maxFee: bigint): this;
    callFunction(target: { templateAddress: string; functionName: string }, args: unknown[]): this;
    callMethod(target: { componentAddress: string; methodName: string }, args: unknown[]): this;
    addFeeInstruction(instruction: unknown): this;
    addInput(input: { substate_id: string; version: number | null }): this;
    buildUnsignedTransaction(): unknown;
  }

  export class WasmStealthCrypto {
    constructor(network: number);
    generateOutputsStatement(outputs: unknown[], maxFee: bigint): Promise<{ statement: unknown; outputMask: unknown }>;
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
    submitTransaction(envelope: unknown): Promise<{ transaction_id: string }>;
    getSubstate(id: string): Promise<unknown>;
    stopWatcher?(): void;
  }
}

declare module "@tari-project/ootle-secret-key-wallet" {
  export interface SecretKeyWallet {
    getViewSecret(): Promise<Uint8Array>;
    addStealthSignature(
      unsignedJson: unknown,
      nonce: Uint8Array,
      sealPublicKey: Uint8Array,
      opts: { crypto: unknown },
    ): Promise<unknown>;
  }
}
