/** Own bounded public request JSON at service entry, before the first await.
 * Live Access, read-context and release objects stay by identity.
 */
export function ownSubjectRequest<T>(value: T): T {
  return structuredClone(value);
}

/** Maximum engine rows admitted across one mixed Search page and its useful-page refills. */
export function discoveryCandidateScanBound(limit: number): number {
  return Math.min(600, 6 * limit + 3);
}
