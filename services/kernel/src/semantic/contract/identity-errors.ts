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
