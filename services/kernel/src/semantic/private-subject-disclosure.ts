import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { accessEvidenceDeadline } from '../access/evidence-deadline.ts';
import { privateSubjectReader } from '../access/private-subject-reader.ts';
import { requireAccessDeadline } from '../access/unavailable.ts';
import { authoritativeTimeValue, type AuthoritativeTime } from '../command/command.ts';
import { withBoundedReadConnection } from '../database/pool.ts';
import { statementBytes } from '../database/statement-bytes.ts';
import { instrumentNativeCollectionWork, type NativeCollectionWork } from '../library/collection-native-work.ts';
import { LIBRARY_SUBJECT_PAGE_LIMIT } from '../library/contract/presentation.ts';
import type { Access, AccountActor } from '../request/access.ts';
import { routeOf } from '../route/route.ts';
import disclosure from './private-subject-disclosure.sql';

type Pair = Readonly<{ original: string; terminal: string }>;
type Decision = Readonly<Pair & { state: 'disclosed' | 'withheld' }>;
type Dependencies = Readonly<{
  pool: Pool;
  access: Access;
  actor: AccountActor;
  ownerId: string;
  deadline: number;
  work: NativeCollectionWork;
}>;
type Row = {
  id: string | null;
  visibility: 'visible' | 'hidden' | 'taken_down' | null;
  target: string | null;
  denied: boolean;
};
const unknown = Object.freeze({ status: 'unknown' as const });

export type PrivateSubjectDisclosure =
  | typeof unknown
  | Readonly<{
      status: 'complete';
      basis: string;
      decisions: readonly Decision[];
      revalidate(time: AuthoritativeTime): Promise<boolean>;
    }>;

/** The input is the alternating original/terminal vector BEFORE deduplication. Both the caller and
 * its enclosing SQL observer can price the very same dispatch, including rejected and repeated keys.
 */
export function privateSubjectDisclosureFootprint(sql: string, values: readonly unknown[]) {
  if (sql !== disclosure.sql || values.length !== 8) return undefined;
  const [route, owner, floor, version, routes, ids, at, firstAt] = values;
  if (
    typeof owner !== 'string' || routeOf(owner) === null || routeOf(owner) !== route ||
    typeof floor !== 'string' || !/^[0-9]{1,19}$/.test(floor) ||
    typeof version !== 'string' || !/^[0-9a-f-]{36}$/.test(version) ||
    typeof at !== 'string' || Buffer.byteLength(at) > 64 ||
    typeof firstAt !== 'string' || Buffer.byteLength(firstAt) > 64 ||
    !Array.isArray(routes) || !Array.isArray(ids) ||
    ids.length > 2 * LIBRARY_SUBJECT_PAGE_LIMIT || ids.length % 2 !== 0 || routes.length !== ids.length ||
    ids.some((id, index) => typeof id !== 'string' || routeOf(id) === null || routeOf(id) !== routes[index])
  )
    return undefined;
  const keys = new Set(ids).size;
  // The native observer charges checkout. SQL has five viewer points and six per key (home, clock, Subject,
  // revision, redirect, current denial). Each inner miss is included in indexed point/row work.
  // The outer empty batch has one seek. Every result field is UUID, digest, enum, boolean or integer.
  return {
    candidateKeys: ids.length / 2,
    nativeRows: 16 + 2 * ids.length + 16 * keys,
    nativePoints: 5 + 6 * keys,
    identityMetadataRows: 0,
    emptySeeks: 1,
    witnessKeys: 1 + keys,
    statements: 1,
    bytes: statementBytes(sql) + Buffer.byteLength(JSON.stringify(values)) + 2 + Math.max(1, keys) * 1536,
  };
}

/** The caller's current, complete canonical Source supplies the directed pairs and owns its identity
 * and population fences. This observation supplies the independent native Subject and Access guards.
 */
export async function observePrivateSubjectDisclosure(
  { pool, access, actor, ownerId, deadline, work }: Dependencies,
  candidates: readonly Pair[],
  time: AuthoritativeTime,
): Promise<PrivateSubjectDisclosure> {
  if (
    actor.kind !== 'account' ||
    actor.accountId !== ownerId ||
    !Number.isFinite(deadline) ||
    !Array.isArray(candidates) ||
    candidates.length > LIBRARY_SUBJECT_PAGE_LIMIT
  )
    return unknown;

  const pairs: Pair[] = [];
  const directed = new Map<string, string>();
  for (const candidate of candidates) {
    if (!candidate) return unknown;
    const { original, terminal } = candidate;
    if (
      routeOf(original) === null ||
      routeOf(terminal) === null ||
      (directed.has(original) && directed.get(original) !== terminal)
    )
      return unknown;
    directed.set(original, terminal);
    pairs.push({ original, terminal });
  }
  const ids = pairs.flatMap(({ original, terminal }) => [original, terminal]);
  const routes = ids.map((id) => routeOf(id)!);
  const keys = [...new Set(ids)];
  const firstAt = authoritativeTimeValue(time);
  const times = new WeakSet([time]);
  async function read(at: AuthoritativeTime) {
    const reader = privateSubjectReader(access, actor, pool);
    if (!reader) return null;
    const until = accessEvidenceDeadline(Math.min(reader.deadline, deadline));
    const instant = authoritativeTimeValue(at);
    const values = [routeOf(ownerId), ownerId, reader.floor, reader.accountVersion, routes, ids, instant, firstAt];
    const cost = privateSubjectDisclosureFootprint(disclosure.sql, values);
    if (!cost) return null;

    const rows = await instrumentNativeCollectionWork(pool, work, privateSubjectDisclosureFootprint, () =>
      // Each phase gets a fresh statement snapshot, even if pg reuses its connection.
      withBoundedReadConnection(pool, until, async (client) => {
        const held = work.reserve(cost);
        held.dispatch();
        let emptySeeks = cost.emptySeeks;
        try {
          const result = await held.query(() => client.query<Row>(disclosure.sql, values));
          emptySeeks = result.rows.length ? 0 : 1;
          return result.rows;
        } finally {
          // Charge every submitted original, including duplicates, on both success and failure.
          held.settle({ emptySeeks });
        }
      }),
    );
    requireAccessDeadline(until);
    authoritativeTimeValue(at);
    if (!keys.length && (rows.length !== 1 || rows[0]?.id !== null)) return null;
    const byId = new Map(rows.map((row) => [row.id, row]));
    if (
      keys.length && (
        rows.length !== keys.length ||
        byId.size !== keys.length ||
        keys.some((key) => !byId.has(key)) ||
        rows.some((row) =>
          row.visibility === null || !['visible', 'hidden', 'taken_down'].includes(row.visibility) ||
          typeof row.denied !== 'boolean',
        )
      )
    )
      return null;

    const decisions: Decision[] = [];
    for (const pair of pairs) {
      const original = byId.get(pair.original)!;
      const terminal = byId.get(pair.terminal)!;
      if (original.target !== (pair.original === pair.terminal ? null : pair.terminal) || terminal.target !== null)
        return null;
      const disclosed =
        original.visibility === 'visible' && !original.denied && terminal.visibility === 'visible' && !terminal.denied;
      const state = disclosed ? 'disclosed' : 'withheld';
      decisions.push(Object.freeze({ ...pair, state }));
    }
    // The empty vector still binds the viewer row. Nonempty vectors include withheld and order-only keys.
    const basis = createHash('sha256')
      .update(JSON.stringify([
        ownerId, actor.clientId, actor.requestedBy, actor.scopes, actor.authnEpoch, reader.accountVersion, reader.floor,
        pairs, keys.length ? keys.map((id) => byId.get(id)) : rows,
      ]))
      .digest('hex');
    return { decisions: Object.freeze(decisions), basis };
  }
  const first = await read(time);
  if (!first) return unknown;
  return Object.freeze({
    status: 'complete',
    ...first,
    async revalidate(fresh: AuthoritativeTime) {
      if (times.has(fresh)) return false;
      times.add(fresh);
      return (await read(fresh))?.basis === first.basis;
    },
  });
}
