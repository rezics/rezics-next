import { isDeepStrictEqual } from 'node:util';
import {
  compareZoneKeys,
  zoneUnavailable,
  type ZoneCandidate,
  type ZoneKey,
  type ZoneMembership,
  type ZonePending,
} from './membership.ts';

/** One in-progress range, not a vector of owner cursors or verdicts. `next` counts actually discovered
 * sources. Their bounded merged keys and the common minimum coverage survive another request's budget.
 */
type Discovery = { next: number; rows: ZoneCandidate[]; covered: ZoneKey | null; exhausted: boolean };
/** Derived ordered locators only. No native facts, permission, leaf verdicts or owner cursor vector. */
export type ZoneUnionPosition = {
  basis: string;
  after: ZoneKey | null;
  rows: ZoneCandidate[];
  pending?: ZonePending;
  discovery?: Discovery;
  exhausted: boolean;
};
export const initialUnionPosition = (basis: string): ZoneUnionPosition => ({
  basis,
  after: null,
  rows: [],
  exhausted: false,
});

/** Settle only the range completely discovered by EVERY source. Independent true settles OR,
 * but cannot justify advancing beyond another stream's covered watermark. Unused input is reread.
 */
export async function advanceZoneUnion(
  membership: ZoneMembership,
  before: ZoneUnionPosition,
  limit: number,
  remaining: () => number,
): Promise<{ position: ZoneUnionPosition; advanced: boolean; complete: boolean }> {
  const position = structuredClone(before.basis === membership.basis ? before : initialUnionPosition(membership.basis));
  const original = structuredClone(position);
  if (position.rows.length >= limit || position.exhausted) return result();
  if (!membership.streams.length) {
    position.exhausted = true;
    return result();
  }
  const compare = (a: ZoneKey, b: ZoneKey) => compareZoneKeys(membership.order, a, b);
  // Final current membership consumes the same root. There is no free final phase.
  const finalReserve = Math.max(limit, position.rows.length);
  let prefixes = 0;
  for (let round = 0; round < 3; round++) {
    const discovery = position.discovery ?? { next: 0, rows: [], covered: null, exhausted: true };
    while (discovery.next < membership.streams.length) {
      if (
        remaining() <= finalReserve + 1 ||
        !membership.prefixAvailable() ||
        (membership.order !== 'id' && prefixes >= 3)
      )
        return result();
      const index = discovery.next;
      const quota = Math.min(
        99,
        2 * (limit - position.rows.length) + 1,
        Math.max(1, Math.floor((remaining() - finalReserve) / 2)),
      );
      const page = await membership.streams[index]!.prefix(position.after, quota);
      prefixes++;
      let previous = position.after;
      for (const row of page.rows) {
        if (previous && compare(row.key, previous) <= 0) return zoneUnavailable();
        if (row.id !== row.key.at(-1)) return zoneUnavailable();
        previous = row.key;
        if (page.covered && compare(row.key, page.covered) > 0) return zoneUnavailable();
      }
      if (!page.exhausted) {
        if (!page.covered || (position.after && compare(page.covered, position.after) <= 0)) return zoneUnavailable();
        if (!discovery.covered || compare(page.covered, discovery.covered) < 0) discovery.covered = page.covered;
        discovery.exhausted = false;
      }
      const groups = new Map<string, ZoneCandidate>();
      for (const row of [...discovery.rows, ...page.rows.map((row) => ({ ...row, source: index }))]) {
        if (discovery.covered && compare(row.key, discovery.covered) > 0) continue;
        const prior = groups.get(row.id);
        if (prior && compare(row.key, prior.key) !== 0) return zoneUnavailable();
        groups.set(row.id, row);
      }
      discovery.rows = [...groups.values()].sort((a, b) => compare(a.key, b.key));
      // Keep a bounded native-tuple range even when every disjoint source exhausts in one call.
      // Discarded suffixes stay after the common floor and must be read again, at their real cost.
      const retained = Math.min(100, 2 * (limit - position.rows.length) + 1);
      if (discovery.rows.length > retained) {
        discovery.rows.length = retained;
        discovery.covered = discovery.rows.at(-1)!.key;
        discovery.exhausted = false;
      }
      discovery.next++;
      position.discovery = discovery; // Only after actual validated native discovery.
    }
    while (discovery.rows.length) {
      if (remaining() <= finalReserve) return result();
      const row = discovery.rows[0]!;
      const match = await membership.contains(row.id, position.pending, row.source);
      if (match.value === 'not_proven') {
        if (match.pending) position.pending = match.pending;
        return result(); // The floor remains BEFORE the unresolved canonical group.
      }
      delete position.pending;
      discovery.rows.shift();
      position.after = row.key;
      if (match.value) position.rows.push({ ...row, source: match.source! });
      if (position.rows.length === limit) {
        if (!discovery.rows.length && discovery.exhausted) {
          position.exhausted = true;
          delete position.discovery;
        }
        return result();
      }
    }
    delete position.pending;
    delete position.discovery;
    if (discovery.exhausted) {
      position.exhausted = true;
      return result();
    }
    if (!discovery.covered) return zoneUnavailable();
    position.after = discovery.covered;
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

/** Final use reruns current OR; a saved source ordinal is only a preferred lookup locator.
 * An actual current negative repairs retained rows; unknown never becomes an absent row or stale disclosure.
 */
export async function revalidateZoneUnion(membership: ZoneMembership, position: ZoneUnionPosition): Promise<boolean> {
  if (membership.basis !== position.basis) return false;
  for (const [index, row] of position.rows.entries()) {
    const result = await membership.contains(
      row.id,
      position.pending?.subject === row.id ? position.pending : undefined,
      row.source,
    );
    if (result.value !== true) {
      if (result.pending) position.pending = result.pending;
      if (result.value === false) {
        position.rows.splice(index, 1);
        if (position.pending?.subject === row.id) delete position.pending;
      }
      return false;
    }
    row.source = result.source!;
    if (position.pending?.subject === row.id) delete position.pending;
  }
  return true;
}
