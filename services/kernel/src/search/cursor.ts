import canonicalize from 'canonicalize';
import { createHash } from 'node:crypto';
import { decodeListCursor, encodeListCursor } from '../tokens/list-cursor.ts';
import type { KeyRing } from '../tokens/seal.ts';

export type SearchCursorBinding = { operation: string; request: unknown; principal: string };
export type SearchSortValue = string | number | null;
export type SearchCursorResult =
  | { ok: true; generation: number; after: SearchSortValue[] }
  | { ok: false; reason: 'expired' | 'invalid' };

function cursorBinding(binding: SearchCursorBinding) {
  if (
    binding === null ||
    typeof binding !== 'object' ||
    typeof binding.operation !== 'string' ||
    !binding.operation ||
    typeof binding.principal !== 'string' ||
    (binding.principal !== 'anonymous' && !/^account:.+$/.test(binding.principal))
  )
    throw new TypeError('Invalid search cursor binding');
  const canonical = canonicalize(binding.request);
  if (canonical === undefined) throw new TypeError('Search request must be canonical JSON');
  const requestHash = createHash('sha256').update(canonical, 'utf8').digest('hex');
  return {
    route: binding.operation,
    viewer: binding.principal === 'anonymous' ? null : binding.principal.slice('account:'.length),
    query: { request: requestHash },
  };
}

function encodeAfter(after: readonly SearchSortValue[]): string[] {
  if (!Array.isArray(after) || after.length > 8)
    throw new TypeError('Search cursor sort values must contain at most 8 values');
  return after.map((value) => {
    if (typeof value === 'string') return `s${value}`;
    if (typeof value === 'number' && Number.isFinite(value)) return `n${Object.is(value, -0) ? '-0' : String(value)}`;
    if (value === null) return 'z';
    throw new TypeError('Invalid search cursor sort value');
  });
}

function decodeAfter(values: readonly string[]): SearchSortValue[] | null {
  const after: SearchSortValue[] = [];
  for (const value of values) {
    if (value === 'z') after.push(null);
    else if (value.startsWith('s')) after.push(value.slice(1));
    else if (value.startsWith('n')) {
      if (value === 'n-0') {
        after.push(-0);
        continue;
      }
      const number = Number(value.slice(1));
      if (!value.slice(1) || !Number.isFinite(number) || String(number) !== value.slice(1)) return null;
      after.push(number);
    } else return null;
  }
  return after;
}

export async function encodeSearchCursor(
  ring: KeyRing,
  binding: SearchCursorBinding,
  cursor: { generation: number; after: readonly SearchSortValue[] },
  now = Date.now(),
): Promise<string> {
  if (!Number.isSafeInteger(now)) throw new TypeError('Invalid search cursor time');
  return encodeListCursor(
    ring,
    cursorBinding(binding),
    { epoch: cursor.generation, after: encodeAfter(cursor.after) },
    new Date(now),
    { profile: 'search' },
  );
}

export async function decodeSearchCursor(
  ring: KeyRing,
  binding: SearchCursorBinding,
  token: string,
  now = Date.now(),
): Promise<SearchCursorResult> {
  let scope;
  try {
    scope = cursorBinding(binding);
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  const decoded = await decodeListCursor(ring, scope, token, new Date(Number.isSafeInteger(now) ? now : NaN), {
    profile: 'search',
  });
  if (!decoded.ok) return decoded;
  if (!decoded.after.every((value): value is string => typeof value === 'string'))
    return { ok: false, reason: 'invalid' };
  const after = decodeAfter(decoded.after);
  return after === null ? { ok: false, reason: 'invalid' } : { ok: true, generation: decoded.epoch, after };
}
