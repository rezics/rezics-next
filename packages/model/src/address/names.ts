import { hasSidCaseVariant, identityKeyUuid } from './sid.ts';
import {
  allowedRanges,
  scriptRanges,
  scriptExtensions,
  caseFolds,
  confusables,
} from './unicode-data.ts';

export class InvalidAddressName extends Error {}
export type NamePolicy = 'ascii-handle' | 'unicode-title';
export interface NormalizedName {
  key: string;
  display: string;
  skeleton: string;
}

function rangeAt<T extends readonly [number, number, ...unknown[]]>(
  ranges: readonly T[],
  point: number,
): T | undefined {
  let low = 0,
    high = ranges.length - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const row = ranges[middle]!;
    if (point < row[0]) high = middle - 1;
    else if (point > row[1]) low = middle + 1;
    else return row;
  }
  return undefined;
}

export function foldAddressName(value: string): string {
  return [...value]
    .map((character) => caseFolds[character.codePointAt(0)!] ?? character)
    .join('')
    .normalize('NFC');
}

/** UTS #39 §4, Unicode 16.0.0. Case comparison precedes skeleton comparison;
 * the folded skeleton also prevents ASCII digit zero impersonating letter o. */
export function nameSkeleton(value: string): string {
  return foldAddressName(
    [...foldAddressName(value).normalize('NFD')]
      .map((character) => confusables[character.codePointAt(0)!] ?? character)
      .join('')
      .normalize('NFD'),
  );
}

/** UTS #39 §5.2. Hyphen and underscore are our profile's two additions to
 * Identifier_Status=Allowed. Script_Extensions, rather than Script alone,
 * handles shared Japanese marks and inherited combining characters. */
export function isHighlyRestrictive(value: string): boolean {
  const scripts: Set<string>[] = [];
  for (const character of value) {
    if (character === '-' || character === '_') continue;
    const point = character.codePointAt(0)!;
    if (!rangeAt(allowedRanges, point)) return false;
    const extension = rangeAt(scriptExtensions, point)?.[2];
    const script = rangeAt(scriptRanges, point)?.[2] ?? 'Zzzz';
    const set = new Set(extension ?? [script]);
    if (set.has('Zyyy') || set.has('Zinh')) continue;
    scripts.push(set);
  }
  if (!scripts.length) return true;
  const common = new Set(scripts[0]);
  for (const set of scripts.slice(1))
    for (const script of common) if (!set.has(script)) common.delete(script);
  if (common.size) return true;
  return [
    new Set(['Latn', 'Hani', 'Hira', 'Kana']),
    new Set(['Latn', 'Hani', 'Hang']),
    new Set(['Latn', 'Hani', 'Bopo']),
  ].some((group) => scripts.every((set) => [...set].some((script) => group.has(script))));
}

export function normalizeAddressName(value: string, policy: NamePolicy): NormalizedName {
  if (typeof value !== 'string' || value.length > 512)
    throw new InvalidAddressName('Name exceeds its bound');
  const display = value.normalize('NFC');
  const key = foldAddressName(display).replace(/\s+/gu, '-');
  if (
    identityKeyUuid(display) ||
    identityKeyUuid(key) ||
    hasSidCaseVariant(key) ||
    (key[22] === '-' && hasSidCaseVariant(key.slice(0, 22)))
  ) {
    throw new InvalidAddressName('Identity keys cannot be names');
  }
  if (policy === 'ascii-handle') {
    if (!/^[a-z0-9](?:[a-z0-9_-]{1,28})[a-z0-9]$/.test(key) || !/^[A-Za-z0-9_-]+$/.test(display))
      throw new InvalidAddressName('Invalid ASCII handle');
  } else if (
    [...key].length < 1 ||
    [...key].length > 120 ||
    !/[\p{L}\p{N}]/u.test(key) ||
    !isHighlyRestrictive(key)
  ) {
    throw new InvalidAddressName('Title must use a Highly Restrictive script combination');
  }
  return { key, display, skeleton: nameSkeleton(key) };
}

/** A readable ASCII candidate from the typed public name, never an identity
 * token or Account data. Availability remains the name registry's decision. */
export function asciiHandleSuggestion(value: string): string | null {
  try {
    return normalizeAddressName(value, 'ascii-handle').key;
  } catch {
    /* Derive a candidate from display-name words. */
  }
  // Remove identity tokens before truncation: truncating a UUID can otherwise
  // turn it into a syntactically valid, misleading handle.
  const words = value
    .split(/\s+/u)
    .filter((word) => !identityKeyUuid(word))
    .join(' ');
  const base = words
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 30)
    .replace(/_+$/g, '');
  try {
    return normalizeAddressName(base, 'ascii-handle').key;
  } catch {
    return null;
  }
}
