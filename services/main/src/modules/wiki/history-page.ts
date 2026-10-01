import { canonicalCandidate, EditorialInvalid } from '../editorial-review/contract.ts';
import type { WikiHistory } from './history.ts';

/** A content keyset is bound to the journal pin and disclosure selection. Names,
 * entities, claims and chapters are retained, even across more than 64 proposals. */
export function wikiHistoryPage<T extends Pick<WikiHistory, 'claims' | 'entities' | 'units'>>(
  history: T,
  binding: unknown,
  options: { limit?: number; cursor?: string } = {},
) {
  const limit = options.limit ?? 64;
  if (!Number.isInteger(limit) || limit < 1 || limit > 64)
    throw new EditorialInvalid('Invalid history page limit');
  const digest = canonicalCandidate(binding).digest;
  let after = '';
  if (options.cursor) {
    try {
      if (options.cursor.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(options.cursor))
        throw new Error('cursor');
      const value = JSON.parse(Buffer.from(options.cursor, 'base64url').toString('utf8')) as {
        binding?: unknown;
        after?: unknown;
      };
      if (value.binding !== digest || typeof value.after !== 'string') throw new Error('binding');
      after = value.after;
    } catch {
      throw new EditorialInvalid('History cursor belongs to another selection or is invalid');
    }
  }
  const items = [
    ...history.claims.map((value) => ({
      key: `claim:${value.claim}`,
      kind: 'claims' as const,
      value,
    })),
    ...history.entities.map((value) => ({
      key: `entity:${value.entity}`,
      kind: 'entities' as const,
      value,
    })),
    ...history.units.map((value) => ({ key: `unit:${value.id}`, kind: 'units' as const, value })),
  ]
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .filter((item) => item.key > after);
  const page = items.slice(0, limit),
    last = page.at(-1);
  const keys = new Set(page.map((item) => item.key));
  return {
    ...history,
    claims: history.claims.filter((value) => keys.has(`claim:${value.claim}`)),
    entities: history.entities.filter((value) => keys.has(`entity:${value.entity}`)),
    units: history.units.filter((value) => keys.has(`unit:${value.id}`)),
    nextCursor:
      items.length > limit && last
        ? Buffer.from(JSON.stringify({ binding: digest, after: last.key })).toString('base64url')
        : null,
  };
}
