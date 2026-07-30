//   Minimal BUILD-TIME type stub for the slice of `@tari-project/ootle` that `writer.ts` uses.
//
//   `@tari-project/ootle` is an OPTIONAL peer dependency: only the write path needs it, and a
//   consumer that does writes installs the real package (ideally the build matching their deployed
//   engine). This stub lets the client type-check standalone without vendoring the SDK. It never
//   leaks into the public API — OnsWriter's method signatures use this package's own types
//   (WriteResult etc.), not SDK types — and it does not affect a consumer's own resolution of the
//   real package. The exact runtime surface below was proven against esmeralda in ONS-2.

declare module "@tari-project/ootle" {
  /** Fluent builder for an unsigned Ootle transaction. */
  export class TransactionBuilder {
    constructor(network: number);
    feeTransactionPayFromComponent(componentAddress: string, maxFee: bigint): this;
    callMethod(target: { componentAddress: string; methodName: string }, args: unknown[]): this;
    callFunction(target: { templateAddress: string; functionName: string }, args: unknown[]): this;
    buildUnsignedTransaction(): Record<string, unknown>;
  }

  /** CBOR-encode a string as an instruction argument. */
  export function stringLiteral(value: string): unknown;
}
