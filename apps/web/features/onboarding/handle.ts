import { asciiHandleSuggestion, normalizeAddressName } from '@rezics/model/address/names';

export function normalizedHandle(value: string): string | null {
  try {
    return normalizeAddressName(value.trim(), 'ascii-handle').key;
  } catch {
    return null;
  }
}

export function currentVanityHandle(handle: string | null): string | null {
  return handle && !/^agent-[0-9a-f-]{36}$/.test(handle) ? handle : null;
}

/** A handle offered from the typed public name and nothing else (never
 * Account data). A name without Latin letters or digits offers none. */
export function suggestedHandle(name: string): string {
  return asciiHandleSuggestion(name) ?? '';
}
