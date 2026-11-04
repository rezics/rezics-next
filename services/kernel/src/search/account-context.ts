/** Optional public presentation, never searchable text or evidence of Account eligibility. */
export type AccountBiography =
  | { state: 'available'; text: string; truncated: boolean }
  | { state: 'absent' | 'withheld' | 'unavailable' };
export type AccountContext = {
  biography: AccountBiography;
  followTarget:
    | { state: 'available'; id: string; label: string; type: string; source: string }
    | { state: 'unavailable' };
};
export const ACCOUNT_CONTEXT_LIMITS = Object.freeze({ biographyBytes: 1024, contextBytes: 8192, pageSize: 100 });

/** The native read supplies at most 1025 code points, before any foreign hydration. */
export function accountBiography(value: string | null | undefined): AccountBiography {
  if (value === undefined) return { state: 'unavailable' };
  if (!value) return { state: 'absent' };
  let text = '',
    bytes = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character);
    if (bytes + size > ACCOUNT_CONTEXT_LIMITS.biographyBytes) return { state: 'available', text, truncated: true };
    text += character;
    bytes += size;
  }
  return { state: 'available', text, truncated: false };
}
