/** Shared identity failure without importing the store/closure/bootstrap cycle.
 * The store re-exports this exact class, preserving every caller's instanceof.
 */
export class IdentityEpochStoreError extends Error {
  constructor(
    public readonly code: string,
    detail: string,
  ) {
    super(detail);
  }
}

/** Cleanup can fail independently at several homes. Keep the source failure
 * and every attempted release failure without replacing either with success.
 */
export class IdentityTerminalClaimReleaseError extends AggregateError {
  readonly code = 'identity_epoch_unavailable';

  constructor(errors: readonly unknown[], cause: unknown) {
    super(errors, 'Terminal claim release incomplete', { cause });
    this.name = 'IdentityTerminalClaimReleaseError';
  }
}
