/** Native Access continuation operands, resolved under its actual step authority.
 * These are private comparisons, never HTTP input or authority by possession. */
export type NativeSessionRevocationBinding = Readonly<{
  accountId: string;
  continuationId: string;
  continuationDigest: string;
  operationKey: string;
  operationDigest: string;
  commandKeyPrefix: string;
  barrierReceiptId: string;
  barrierTransactionId: string;
  minimumAuthnEpoch: string;
  stepKey: string;
  stepDigest: string;
  authorizationReceiptId: string;
}>;

/** Auth returns only its exact durable terminal result. Missing, minimized or
 * mismatched evidence is unknown; no sessions or workflow status are disclosed. */
export interface NativeSessionRevocationResultPort {
  readSessionRevocationResult(
    binding: NativeSessionRevocationBinding,
    context: { deadline: number },
  ): Promise<'complete' | 'unknown'>;
}
