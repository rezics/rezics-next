/**
 * What a write's HTTP status means for editing access.
 *
 * A lapsed session (401) can be saved again after signing in. Access taken
 * away (403), and a private resource indistinguishable from a missing one
 * (404), closes further writes. Every recipe-editor save path uses this and
 * no other status rule.
 */
export function editingAccess(status: number): { refusal: 'sign-in' | 'denied'; revoked: boolean } | null {
  if (status === 401) return { refusal: 'sign-in', revoked: false };
  if (status === 403 || status === 404) return { refusal: 'denied', revoked: true };
  return null;
}
