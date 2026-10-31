import { isDeepStrictEqual } from 'node:util';
import {
  compareZoneKeys, zoneUnavailable,
  type ZoneCandidate, type ZoneKey, type ZoneMembership, type ZonePending,
} from './membership.ts';

/** Derived ordered locators only. No native facts, permission, leaf verdicts or owner cursor vector. */
export type ZoneUnionPosition = {
  basis: string;
  after: ZoneKey | null;
  rows: ZoneCandidate[];
  pending?: ZonePending;
  exhausted: boolean;
};
export const initialUnionPosition = (basis: string): ZoneUnionPosition => ({ basis, after: null, rows: [], exhausted: false });

/** Settle only the range completely discovered by EVERY source. Independent true settles OR,
 * but cannot justify advancing beyond another stream's covered watermark. Unused lookahead is reread.
 */
export async function advanceZoneUnion(
  membership: ZoneMembership,
  before: ZoneUnionPosition,
  limit: number,
  remaining: () => number,
): Promise<{ position: ZoneUnionPosition; advanced: boolean; complete: boolean }> {
  const position = structuredClone(before.basis === membership.basis ? before : initialUnionPosition(membership.basis));
  const original = structuredClone(position);
  if (position.rows.length >= limit || position.exhausted)
    return { position, advanced: false, complete: true };
  if (!membership.streams.length) {
    position.exhausted = true;
    return { position, advanced: true, complete: true };
  }
  // Keep final current membership work inside the SAME raw root. It is never a free phase.
  const finalReserve = Math.max(limit, position.rows.length);
  for (let round = 0; round < 3 && remaining() > finalReserve + membership.streams.length * 2; round++) {
    const pages = [];
    for (let index = 0; index < membership.streams.length; index++) {
      const quota = Math.min(99, 2 * (limit - position.rows.length) + 1, Math.max(1, Math.floor((remaining() - finalReserve) / (2 * (membership.streams.length - index)))));
      const page = await membership.streams[index]!.prefix(position.after, quota);
      let previous = position.after;
      for (const row of page.rows) {
        if (previous && compareZoneKeys(membership.order, row.key, previous) <= 0) return zoneUnavailable();
        if (row.id !== row.key.at(-1)) return zoneUnavailable();
        previous = row.key;
      }
      if (!page.exhausted && (!page.covered || (position.after && compareZoneKeys(membership.order, page.covered, position.after) <= 0)))
        return zoneUnavailable();
      pages.push({ ...page, rows: page.rows.map(row => ({ ...row, source: index })) });
    }
    // Exhausted streams cover the entire remaining domain, including an empty suffix.
    const bounded = pages.filter(page => !page.exhausted).map(page => page.covered!);
    const covered = bounded.length ? bounded.reduce((a, b) => compareZoneKeys(membership.order, a, b) < 0 ? a : b) : null;
    const groups = new Map<string, ZoneCandidate>();
    for (const page of pages) for (const row of page.rows) {
      if (covered && compareZoneKeys(membership.order, row.key, covered) > 0) continue;
      const prior = groups.get(row.id);
      if (prior && compareZoneKeys(membership.order, row.key, prior.key) !== 0) return zoneUnavailable();
      groups.set(row.id, row);
    }
    const rows = [...groups.values()].sort((a, b) => compareZoneKeys(membership.order, a.key, b.key));
    for (const row of rows) {
      if (remaining() <= finalReserve) return result();
      const match = await membership.contains(row.id, position.pending, row.source);
      if (match.value === 'not_proven') {
        if (match.pending) position.pending = match.pending;
        return result(); // Keep the canonical floor BEFORE the unresolved group.
      }
      delete position.pending;
      position.after = row.key;
      if (match.value) position.rows.push({ ...row, source: match.source! });
      if (position.rows.length === limit) return result();
    }
    delete position.pending;
    if (pages.every(page => page.exhausted)) {
      position.exhausted = true;
      return result();
    }
    if (covered) position.after = covered;
    if (isDeepStrictEqual(position, original) && rows.length === 0) return zoneUnavailable();
  }
  return result();
  function result() {
    return {
      position,
      advanced: !isDeepStrictEqual(position, original),
      complete: position.rows.length >= limit || position.exhausted,
    };
  }
}

/** Final use rereads actual positive witnesses; a saved source ordinal is only a locator.
 * A changed/unknown row never becomes an absent row or a disclosed stale result.
 */
export async function revalidateZoneUnion(membership: ZoneMembership, position: ZoneUnionPosition): Promise<boolean> {
  if (membership.basis !== position.basis) return false;
  for (const row of position.rows) {
    const source = membership.streams[row.source];
    if (!source) return false;
    const result = await source.member(row.id, position.pending?.subject === row.id && position.pending.source === row.source ? position.pending : undefined);
    if (result.value !== true) {
      if (result.pending) position.pending = { ...result.pending, source: row.source };
      return false;
    }
    if (position.pending?.subject === row.id) delete position.pending;
  }
  return true;
}
