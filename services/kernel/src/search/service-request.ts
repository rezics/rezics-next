/** Own bounded public request JSON at service entry, before the first await.
 * Live Access, read-context and release objects stay by identity.
 */
export function ownSubjectRequest<T>(value: T): T {
  return structuredClone(value);
}
