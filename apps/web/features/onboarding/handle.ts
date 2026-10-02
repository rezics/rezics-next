import { normalizeAddressName } from '@rezics/model/address/names';
export const HANDLE_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{1,28})[a-z0-9]$/;

export function normalizedHandle(value: string): string | null {
  try { return normalizeAddressName(value.trim(),'ascii-handle').key; } catch { return null; }
}

export function currentVanityHandle(handle: string | null): string | null {
  return handle && !/^agent-[0-9a-f-]{36}$/.test(handle) ? handle : null;
}

/** A handle offered from the typed public name and nothing else (never
 * Account data). A name without Latin letters or digits offers none. */
export function suggestedHandle(name: string): string {
  const base = name.normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '').slice(0, 30).replace(/_+$/, '');
  return HANDLE_PATTERN.test(base) ? base : '';
}
