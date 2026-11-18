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
import { partitionOf, routeOf } from '../route/route.ts';
import { holdsCurrentStatements } from '../search/current-leaf.ts';
import type { FactClause } from '../search/disclosure/admission.ts';
import { hasVerifiedReleaseDigest } from './definition-release-read.ts';
import { freeze } from './core/freeze.ts';
import {
  classifyIdentityMappings,
  type IdentitySourceEvidence,
  type IdentityControlEvidence,
  type IdentityPendingEvidence,
} from './identity-core/mapping.ts';
import { statementSlotId } from './item.ts';
import { privateRangeQuery, preparedScalarRangeQuery } from './private-range-query.ts';
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
type RecordedDefinition = { digest: string; datatype: 'time' | 'quantity' | null };
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
  recording: RecordedDefinition | null;
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
  source: IdentitySourceEvidence;
  control: IdentityControlEvidence & IdentityPendingEvidence & { control_epoch: number };
  subject_definition: RecordedDefinition | null;
  tuples: Tuple[] | null;
};
type Decision = Readonly<
  { original: string; terminal: string; epoch: string } & (
    | { state: 'withheld'; matches: false }
    | { state: 'disclosed'; matches: boolean; facts: readonly SelectedLeafFact[] }
  )
>;
const unknown = Object.freeze({ status: 'unknown' as const });

export function privateCatalogueRangeFootprint(sql: string, values: readonly unknown[]) {
  const prepared = sql === preparedScalarRangeQuery();
  if ((!prepared && sql !== privateRangeQuery()) || values.length !== 12) return undefined;
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
    typeof width !== 'number' ||
    !Number.isInteger(width) ||
    width < 1 ||
    width > (prepared ? 1 : 32) ||
    ids.some(
      (id, i) =>
        routeOf(id) === null ||
        routeOf(id) !== routes[i] ||
        (i > 0 && ids[i - 1] >= id) ||
        slots[i] !== statementSlotId(id, property),
    )
  )
    return undefined;
  const n = ids.length,
    raw = n * width;
  // Eight fixed points (viewer standing and global meaning). Per original: six disclosure,
  // six identity, a recorded definition, two slot heads and one ordered raw range. Per raw key: three privacy,
  // two payload, four provenance and one recorded definition probe. Checkout is metered separately by the page.
  return {
    statements: 1,
    candidateKeys: n + raw,
    witnessKeys: 1 + n + raw,
    identityMetadataRows: prepared ? 0 : 6 * n,
    nativePoints: prepared ? 8 + 8 * n + 10 * raw : 8 + 16 * n + 10 * raw,
    // Prepared selection reads the same six disclosure points (18 rows including input),
    // two slot heads (four rows), then raw order, privacy, payload and provenance
    // (ten points, twenty rows per raw key). The scope observation lives on the owner query.
    nativeRows: prepared ? 24 + 22 * n + 20 * raw : 24 + 36 * n + 28 * raw,
    emptySeeks: 1,
    bytes: statementBytes(sql) + Buffer.byteLength(JSON.stringify(values)) + 2 + 4096 * n + 2048 * raw,
  };
}

function selectedFacts(row: Row, slot: string, meaning: Meaning) {
  const tuples = row.tuples;
  if (!tuples?.length) return null;
  if (
    row.authority.current_release !== meaning.releaseDigest &&
    (!row.subject_definition || row.subject_definition.digest !== row.authority.current_release)
  )
    return null;
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
    if (!t.scalar || t.sourceBytes !== 0 || t.revision === null) return null;
    const recording = t.sameRelease
      ? { digest: meaning.releaseDigest, datatype: meaning.release.properties[meaning.leaf.property]!.datatype }
      : t.recording;
    if (!recording?.datatype) return null;
    const rank = t.slotOperation === 'expand' ? t.rank : t.bodyRank;
    if (!rank) continue;
    const statement = normalizeSourceStatement(
      meaning.leaf.property,
      { value: t.value },
      { [meaning.leaf.property]: { datatype: recording.datatype } },
    );
    if (!statement) continue;
    // A routed quantity unit needs independent target disclosure. Qualifiers and imported
    // provenance also require separate owner evidence outside this scalar profile.
    if (statement.facet?.kind === 'quantity' && routeOf(statement.facet.unit) !== null) return null;
    facts.push({ witness: t.witness, rank, revision: t.revision, release: recording.digest, statement });
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

function decision(row: Row, id: string, slot: string, meaning: Meaning): Decision | null {
  const home = partitionOf(routeOf(id)!);
  const [mapping] = classifyIdentityMappings([{ original: id, sourceHome: home }], {
    sourceOwners: [{ partition_no: home, epoch: row.authority.epoch, write_state: 'active' }],
    sourceRows: [row.source],
    controlOwners: [
      { partition_no: row.control.partition_no, epoch: row.control.control_epoch, write_state: 'active' },
    ],
    pendingRows: [row.control],
    currentRows: [row.control],
  });
  if (mapping?.state !== 'mapped' || mapping.terminal !== id) return null;
  const pair = { original: id, terminal: id, epoch: mapping.epoch.toString() };
  const scalar = scalarDecision(row, id, slot, meaning);
  return scalar && { ...pair, ...scalar };
}

/** For an admitted, complete, id-ordered private entry population. The caller owns the
 * population and page ledger, native read times, and final check after presentation.
 * Each nonempty slice (at most 100 originals) costs one statement in each phase.
 * maxSlotKeys bounds compact history or selected Global adoption ordinals per original.
 * Exceeding it invalidates the batch, including an otherwise provable positive.
 */
export async function observePrivateCatalogueRange(
  deps: Dependencies,
  originals: readonly string[],
  input: Meaning,
  time: AuthoritativeTime,
) {
  return observeRange(deps, originals, input, time, privateRangeQuery(), decision);
}

/** Proves scalar decisions and fresh Subject disclosure only. The owner separately
 * checks its published self-pairs and committed identity scope across both phases. */
export function observePreparedScalarRange(
  deps: Dependencies,
  originals: readonly string[],
  input: Meaning,
  time: AuthoritativeTime,
) {
  return observeRange(deps, originals, input, time, preparedScalarRangeQuery(), scalarDecision);
}

async function observeRange<T extends object>(
  { pool, actor, ownerId, access, work, deadline }: Dependencies,
  originals: readonly string[],
  input: Meaning,
  time: AuthoritativeTime,
  sql: string,
  select: (row: Row, id: string, slot: string, meaning: Meaning) => T | null,
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
    const decisions: T[] = [];
    for (const [i, row] of rows.entries()) {
      const d = select(row, ids[i]!, slots[i]!, meaning);
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
