import { createHash } from 'node:crypto';
import type { Release } from '@rezics/definitions';
import type { Pool } from 'pg';
import { accessEvidenceDeadline } from '../access/evidence-deadline.ts';
import { privateSubjectReader } from '../access/private-subject-reader.ts';
import { requireAccessDeadline } from '../access/unavailable.ts';
import { authoritativeTimeValue, type AuthoritativeTime } from '../command/command.ts';
import { withBoundedReadConnection } from '../database/pool.ts';
import { statementBytes } from '../database/statement-bytes.ts';
import { instrumentNativeCollectionWork, type NativeCollectionWork } from '../library/collection-native-work.ts';
import { LIBRARY_SUBJECT_PAGE_LIMIT } from '../library/contract/presentation.ts';
import type { AccountActor, Access } from '../request/access.ts';
import { routeOf } from '../route/route.ts';
import { holdsCurrentStatements } from '../search/current-leaf.ts';
import type { FactClause } from '../search/disclosure/admission.ts';
import { hasVerifiedReleaseDigest } from './definition-release-read.ts';
import { freeze } from './core/freeze.ts';
import { statementSlotId } from './item.ts';
import { preparedScalarRangeQuery } from './private-range-query.ts';
import type { SelectedLeafFact } from './scope-leaf-evidence.ts';
import { normalizeSourceStatement } from './scope-leaf-selection.ts';

type RangeLeaf = Extract<FactClause, { range: unknown }>;
type Meaning = { release: Release; releaseDigest: string; leaf: RangeLeaf; maxSlotKeys?: number };
type Dependencies = {
  pool: Pool;
  actor: AccountActor;
  ownerId: string;
  access: Access;
  work: NativeCollectionWork;
  deadline: number;
};
type Rank = SelectedLeafFact['rank'];
type Tuple = {
  slotOperation: 'expand' | 'assert' | 'retract' | null;
  count: number;
  ordinal: number | null;
  witness: string | null;
  rank: Rank | null;
  concealed: boolean | null;
  located: string | null;
  sameProperty: boolean | null;
  expanded: boolean | null;
  operation: string | null;
  sameRelease: boolean | null;
  revision: number | null;
  sourceBytes: number | null;
  bodyRank: Rank | null;
  scalar: boolean;
  value: unknown;
};
type Row = {
  id: string;
  authority: {
    id: string;
    visibility: string;
    epoch: number;
    denied: boolean;
    target: string | null;
    current_release: string;
  };
  meaning: { head: number; digest: string };
  tuples: Tuple[] | null;
};
const unknown = Object.freeze({ status: 'unknown' as const });

function privateCatalogueRangeFootprint(sql: string, values: readonly unknown[]) {
  if (sql !== preparedScalarRangeQuery() || values.length !== 12) return undefined;
  const [route, owner, floor, version, routes, ids, at, firstAt, slots, property, digest, width] = values;
  if (
    typeof owner !== 'string' ||
    routeOf(owner) === null ||
    routeOf(owner) !== route ||
    typeof floor !== 'string' ||
    !/^\d{1,19}$/.test(floor) ||
    typeof version !== 'string' ||
    !/^[a-f0-9-]{36}$/.test(version) ||
    typeof at !== 'string' ||
    Buffer.byteLength(at) > 64 ||
    typeof firstAt !== 'string' ||
    Buffer.byteLength(firstAt) > 64 ||
    !Array.isArray(routes) ||
    !Array.isArray(ids) ||
    !Array.isArray(slots) ||
    !ids.length ||
    ids.length > LIBRARY_SUBJECT_PAGE_LIMIT ||
    routes.length !== ids.length ||
    slots.length !== ids.length ||
    typeof property !== 'string' ||
    !property.length ||
    Buffer.byteLength(property) > 256 ||
    typeof digest !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/.test(digest) ||
    width !== 1 ||
    ids.some(
      (id, i) =>
        routeOf(id) === null ||
        routeOf(id) !== routes[i] ||
        (i > 0 && ids[i - 1] >= id) ||
        slots[i] !== statementSlotId(id, property),
    )
  )
    return undefined;
  const n = ids.length;
  // Eight fixed viewer and meaning points. Each original has six disclosure points,
  // two slot heads and at most one raw key. The owner query admits its identity scope separately.
  return {
    statements: 1,
    candidateKeys: 2 * n,
    witnessKeys: 1 + 2 * n,
    identityMetadataRows: 0,
    nativePoints: 8 + 18 * n,
    // Prepared selection reads the same six disclosure points (18 rows including input),
    // two slot heads (four rows), then raw order, privacy, payload and provenance
    // (ten points, twenty rows per raw key). The scope observation lives on the owner query.
    nativeRows: 24 + 42 * n,
    emptySeeks: 1,
    bytes: statementBytes(sql) + Buffer.byteLength(JSON.stringify(values)) + 2 + 6144 * n,
  };
}

function selectedFacts(row: Row, slot: string, meaning: Meaning) {
  const tuples = row.tuples;
  if (!tuples?.length) return null;
  if (row.authority.current_release !== meaning.releaseDigest) return null;
  const first = tuples[0]!;
  if (first.count === 0) return tuples.length === 1 && first.ordinal === null ? [] : null;
  if (first.count !== tuples.length) return null;
  const facts: SelectedLeafFact[] = [];
  const seen = new Set<string>();
  for (const [index, t] of tuples.entries()) {
    if (t.ordinal !== index + 1 || !t.witness || t.count !== first.count || t.concealed === null) return null;
    if (seen.has(t.witness)) continue;
    seen.add(t.witness);
    if (t.concealed) continue;
    if (!t.located || t.located !== slot || t.sameProperty !== true) return null;
    if (t.slotOperation !== 'expand' && (t.expanded || t.operation !== 'assert')) continue;
    if (!t.scalar || t.sourceBytes !== 0 || t.revision === null || t.sameRelease !== true) return null;
    const datatype = meaning.release.properties[meaning.leaf.property]!.datatype;
    const rank = t.slotOperation === 'expand' ? t.rank : t.bodyRank;
    if (!rank) continue;
    const statement = normalizeSourceStatement(
      meaning.leaf.property,
      { value: t.value },
      { [meaning.leaf.property]: { datatype } },
    );
    if (!statement) continue;
    // A routed quantity unit needs independent target disclosure. Qualifiers and imported
    // provenance also require separate owner evidence outside this scalar profile.
    if (statement.facet?.kind === 'quantity' && routeOf(statement.facet.unit) !== null) return null;
    facts.push({ witness: t.witness, rank, revision: t.revision, release: meaning.releaseDigest, statement });
  }
  return facts;
}

function scalarDecision(row: Row, id: string, slot: string, meaning: Meaning) {
  const a = row.authority;
  if (
    row.id !== id ||
    a.id !== id ||
    a.target !== null ||
    row.meaning.digest !== meaning.releaseDigest ||
    !['visible', 'hidden', 'taken_down'].includes(a.visibility) ||
    typeof a.denied !== 'boolean'
  )
    return null;
  if (a.visibility !== 'visible' || a.denied)
    return row.tuples === null ? { state: 'withheld' as const, matches: false as const } : null;
  const facts = selectedFacts(row, slot, meaning);
  if (!facts) return null;
  const matches = holdsCurrentStatements(
    facts.map((f) => f.statement),
    meaning.leaf,
  );
  return typeof matches === 'boolean' ? { state: 'disclosed' as const, matches, facts } : null;
}

/** Proves scalar selection and fresh disclosure for separately guarded prepared identities. */
export async function observePreparedScalarRange(
  { pool, actor, ownerId, access, work, deadline }: Dependencies,
  originals: readonly string[],
  input: Meaning,
  time: AuthoritativeTime,
) {
  if (
    actor.kind !== 'account' ||
    actor.accountId !== ownerId ||
    !Number.isFinite(deadline) ||
    !Array.isArray(originals) ||
    !originals.length ||
    originals.length > LIBRARY_SUBJECT_PAGE_LIMIT ||
    originals.some((id, i) => routeOf(id) === null || (i > 0 && originals[i - 1]! >= id)) ||
    !hasVerifiedReleaseDigest(input.release, input.releaseDigest) ||
    input.leaf.facet !== 'statement' ||
    !('range' in input.leaf) ||
    'values' in input.leaf ||
    input.leaf.qualifiers?.length
  )
    return unknown;
  const sql = preparedScalarRangeQuery();
  const meaning = { ...input, leaf: structuredClone(input.leaf) };
  const def = meaning.release.properties[meaning.leaf.property];
  if (!def || def.relation || !['time', 'quantity'].includes(def.datatype)) return unknown;
  const ids = [...originals],
    routes = ids.map(routeOf),
    slots = ids.map((id) => statementSlotId(id, meaning.leaf.property));
  const firstAt = authoritativeTimeValue(time);
  const used = new WeakSet([time]);
  async function read(at: AuthoritativeTime) {
    const reader = privateSubjectReader(access, actor, pool);
    if (!reader) return null;
    const until = accessEvidenceDeadline(Math.min(deadline, reader.deadline));
    const values = [
      routeOf(ownerId),
      ownerId,
      reader.floor,
      reader.accountVersion,
      routes,
      ids,
      authoritativeTimeValue(at),
      firstAt,
      slots,
      meaning.leaf.property,
      meaning.releaseDigest,
      meaning.maxSlotKeys ?? 1,
    ];
    const bound = privateCatalogueRangeFootprint(sql, values);
    if (!bound) return null;
    const rows = await instrumentNativeCollectionWork(pool, work, privateCatalogueRangeFootprint, () =>
      withBoundedReadConnection(pool, until, async (client) => {
        const held = work.reserve(bound);
        held.dispatch();
        let emptySeeks = bound.emptySeeks;
        try {
          const { rows } = await held.query(() => client.query<Row>(sql, values));
          emptySeeks = rows.length ? 0 : 1;
          return rows;
        } finally {
          held.settle({ emptySeeks });
        }
      }),
    );
    requireAccessDeadline(until);
    authoritativeTimeValue(at);
    if (rows.length !== ids.length) return null;
    const decisions: NonNullable<ReturnType<typeof scalarDecision>>[] = [];
    for (const [i, row] of rows.entries()) {
      const d = scalarDecision(row, ids[i]!, slots[i]!, meaning);
      if (!d) return null;
      decisions.push(d);
    }
    const basis = createHash('sha256')
      .update(
        JSON.stringify([
          ownerId,
          actor.clientId,
          actor.requestedBy,
          actor.scopes,
          actor.authnEpoch,
          reader.accountVersion,
          reader.floor,
          meaning.leaf,
          rows,
        ]),
      )
      .digest('hex');
    freeze(decisions);
    requireAccessDeadline(until);
    return { decisions: Object.freeze(decisions), basis };
  }
  const first = await read(time);
  if (!first) return unknown;
  return Object.freeze({
    status: 'complete' as const,
    ...first,
    async revalidate(fresh: AuthoritativeTime) {
      if (used.has(fresh)) return false;
      used.add(fresh);
      return (await read(fresh))?.basis === first.basis;
    },
  });
}
