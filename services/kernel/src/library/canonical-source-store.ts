/** Derived native access paths. References and ready pointers never grant membership or Access. */
import type { Pool } from 'pg';

import type { ListingStamp } from './listing-freshness-contract.ts';

/**
 * Reserved by the caller BEFORE dispatch; raw keys hard <=100, shared Zone aggregate <=256 including final use.
 * `nativeRows` maps directly to the shared Source `rows` allowance and is charged from plan-proved operation bounds.
 */
export interface CanonicalAllowance {
  readonly reservationId: string;
  readonly rawKeys: number;
  /** Charged plan-proved native row-work bound across all pools; reserve before dispatch, independently of raw keys. */
  readonly nativeRows: number;
  readonly nativePoints: number;
  readonly emptySeeks: number;
  readonly statements: number;
  readonly bytes: number;
  /** TWO released 4096-home sweeps per basis read; independently reserved before dispatch. */
  readonly identityMetadataRows: number;
}

export interface CanonicalWork {
  readonly reservationId: string;
  /** Disjoint categories; their sum <= allowance.rawKeys. Repeated encounters are charged again. */
  readonly candidateKeys: number;
  readonly aliasKeys: number;
  readonly duplicateKeys: number;
  readonly lookaheadKeys: number;
  readonly internalDriverKeys: number;
  /** Charged plan-proved native row-work bound, not result size, raw-key count or observed physical tuples. */
  readonly nativeRows: number;
  readonly nativePoints: number;
  readonly emptySeeks: number;
  readonly statements: number;
  readonly bytes: number;
  /** Actual metadata rows, including both sweeps; core-home observations also consume nativePoints. */
  readonly identityMetadataRows: number;
}

export type CanonicalAuthority =
  | { readonly kind: 'curated' }
  | { readonly kind: 'private_builtin'; readonly curatorAccountId: string }
  | { readonly kind: 'activated_output'; readonly generation: string }
  | { readonly kind: 'frozen_output'; readonly generation: string };

/**
 * References ACTUAL selected owner authority and Semantic structural digest, not partition position or readiness.
 * The digest is the SAME commitment admitted by collection-source.ts, never a store-local substitute.
 * Semantic readIdentityBasis returns {digest:string}; actual code remains an independent dependency.
 * Never derive identity digest from labels, observations, fabricated epochs, positions or a local hash of fake data.
 */
export interface CanonicalBasis {
  /** Commitment to ALL actual references below, also bound into trusted continuation. */
  readonly digest: string;
  readonly incarnation: string;
  readonly authority: CanonicalAuthority;
  /** Membership/authority fence changed atomically by source mutations; editorial-only writes do not change it. */
  readonly sourceFence: string;
  readonly identity: Readonly<{ digest: string }>;
  /** Actual admitted meaning/profile/projection commitment, null for curated. */
  readonly meaning: string | null;
  /** State generations predating independent native support preparation cannot prove owner closure. */
  readonly originalCoverage?: 'owner-facts-v1';
}

export interface CanonicalSourceRef {
  readonly route: number;
  readonly collectionId: string;
}
export interface CanonicalCall extends CanonicalSourceRef {
  readonly deadline: number;
  readonly allowance: CanonicalAllowance;
}
export interface CanonicalBoundCall extends CanonicalCall {
  readonly basis: CanonicalBasis;
}

/** One fixed-width driver and two UUID keys; never notes, permissions, predicates or a set of visited IDs. */
export interface CanonicalRawKey {
  readonly driver: 'member' | 'entry' | 'label' | 'session' | 'copy' | 'output';
  readonly storedSubjectId: string;
  readonly factId: string;
}
/**
 * Exact owner sourceAfter handoff, 77 ASCII bytes after validation of lowercase UUIDs.
 * Ordinals 0..5 are member, entry, label, session, copy, output. Decode before SQL: encoded lexical order is
 * NOT the native (stored subject, driver, fact) order. No new public codec or nested token is defined here.
 */
export type CanonicalSourceAfter = `1:${0 | 1 | 2 | 3 | 4 | 5}:${string}:${string}`;
export interface CanonicalDerivedRow {
  readonly canonicalSubjectId: string;
  readonly key: CanonicalRawKey;
}

/** Single pending group. The canonical settled floor remains BEFORE pendingSubjectId until terminally decided. */
export interface CanonicalGroupProgress {
  readonly pendingSubjectId: string;
  readonly after: CanonicalRawKey | null;
  /** Last actually settled Semantic original, ONLY when a native alias window was consumed; absent means none. */
  readonly aliasAfter?: string | null;
  readonly generation: string;
  readonly basis: CanonicalBasis;
}

export type CanonicalNotReady = {
  readonly state: 'not_ready';
  readonly reason: 'source' | 'identity' | 'unbuilt' | 'incomplete' | 'stale' | 'allowance';
  readonly work: CanonicalWork;
};
export type CanonicalAuthorityRead =
  | CanonicalNotReady
  | {
      readonly state: 'admitted';
      readonly basis: CanonicalBasis;
      readonly observation: ListingStamp;
      readonly work: CanonicalWork;
    };
export type CanonicalReadyRead =
  | CanonicalNotReady
  | {
      readonly state: 'ready';
      readonly basis: CanonicalBasis;
      readonly generation: string;
      readonly work: CanonicalWork;
    };

/** Raw indexed candidates, not an authorized positive, complete negative, or public DTO. */
export type CanonicalGroupWindow =
  | CanonicalNotReady
  | {
      readonly state: 'ready';
      readonly rows: readonly CanonicalDerivedRow[];
      readonly examinedThrough: CanonicalRawKey | null;
      readonly exhausted: boolean;
      readonly progress: CanonicalGroupProgress;
      readonly work: CanonicalWork;
    };
export type CanonicalCandidateSeek =
  | CanonicalNotReady
  | {
      readonly state: 'ready';
      readonly subjectId: string | null;
      /** Every candidate in (afterSubjectId, coveredThrough] represented; never the raw source floor. */
      readonly coveredThrough: string | null;
      readonly exhausted: boolean;
      readonly work: CanonicalWork;
    };

export interface CanonicalRepair {
  readonly generation: string;
  readonly basis: CanonicalBasis;
  /** Durable last EXAMINED source key, including pending/rejected rows, committed with derived rows. */
  readonly after: CanonicalRawKey | null;
  readonly sourceExhausted: boolean;
}
export type CanonicalRepairRead =
  | CanonicalNotReady
  | { readonly state: 'working'; readonly repair: CanonicalRepair; readonly work: CanonicalWork };
export type CanonicalRepairStep =
  | CanonicalNotReady
  | {
      readonly state: 'working' | 'complete' | 'basis_changed';
      readonly repair: CanonicalRepair;
      readonly examined: readonly CanonicalRawKey[];
      readonly work: CanonicalWork;
    };
export type CanonicalPublication =
  | CanonicalNotReady
  | { readonly state: 'published' | 'basis_changed' | 'incomplete'; readonly work: CanonicalWork };

import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient, QueryResultRow } from 'pg';
import { withConnection } from '../database/pool.ts';
import { enqueueIntent, runOperationalTransaction, type OperationalTransaction } from '../command/operational.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { ProblemError } from '../http/problem.ts';
import type { WorkContext } from '../work/registry.ts';
import { identityEpochStore } from '../semantic/identity-epoch-store.ts';
import { createIdentityScopedObservations } from '../semantic/identity-scoped-observations.ts';
import type {
  IdentityScopeKey,
  IdentityScopeObservation,
  IdentityScopeWork,
} from '../semantic/identity-scope-types.ts';
import { CollectionSourceLedger } from './collection-source-work.ts';
import {
  createNativeLibrarySourceCustody,
  type NativeSourceIdentity,
  type NativeSourceFrontier,
} from './native-source-custody.ts';
import {
  readNativeCollectionWorkingMetadata,
  readNativeCollectionRawPage,
  type NativeCollectionMetadata,
} from './collection-source-native.ts';
import type { WorkAllowance } from './collection-source.ts';
import { readOwnerNativeFactPage, type OwnerNativeFactDriver } from './owner-index.ts';
import ownerFacts from './collection-source-native-facts.sql';
import { deadlineClient } from '../access/authenticate.ts';
import { creationDeclares } from '../access/parent-creation.ts';
import { shareAccount } from '../access/account-share.ts';
import { currentCommand, currentCommandResources, type CommandTransaction } from '../command/command.ts';
import { isDeepStrictEqual } from 'node:util';

const drivers = ['member', 'entry', 'label', 'session', 'copy', 'output'] as const;
const contexts = new WeakMap<Pool, WorkContext>();
export const CANONICAL_SOURCE_WORKFLOW = 'library.canonicalSource';
/** Bound once by the sole default Library WorkModule, using its real client and queues. */
export function bindCanonicalSourceWork(context: WorkContext): void {
  contexts.set(context.pool, context);
}
type ScopeRow = {
  identity: NativeSourceIdentity;
  frontier: NativeSourceFrontier | null;
  capture: string | null;
  revision: string | null;
};
type Generation = {
  generation: string;
  basis: CanonicalBasis;
  driver: CanonicalRawKey['driver'] | 'done';
  after_subject: string | null;
  after_fact: string | null;
  source_exhausted: boolean;
  state: 'working' | 'complete' | 'abandoned';
  version: string;
};
type Client = Pick<PoolClient, 'query'>;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function nativeSourceFence(metadata: NativeCollectionMetadata): string {
  return hash([
    metadata.incarnation,
    metadata.stamp.epoch,
    metadata.authority,
    metadata.sourceGeneration,
    metadata.factFence,
    metadata.outputGeneration,
  ]);
}
/** Native identity allocation is shared by initial owner commands and the existing capture producer.
 * Allocation never certifies a capture, scoped observation, repair, exhaustion or output receipt.
 */
function nativeSourceIdentity(metadata: NativeCollectionMetadata): NativeSourceIdentity {
  if (!metadata.curatorAccountId || (metadata.authority !== 'curated' && metadata.authority !== 'private_builtin'))
    throw new ProblemError('dependency_unavailable');
  return {
    route: metadata.route,
    collectionId: metadata.collectionId,
    accountId: metadata.curatorAccountId,
    incarnation: metadata.incarnation,
    generation: metadata.sourceGeneration,
    scope: metadata.authority,
    ownerEpoch: metadata.stamp.epoch,
    receivingEpoch: metadata.stamp.epoch.toString(),
    effectKey: `collection-source:${nativeSourceFence(metadata)}`,
  };
}
/** Original native command only. Uses its SAME pool/transaction and existing Source identity storage. */
export async function initializeCanonicalCollectionSource(
  tx: CommandTransaction,
  input: Readonly<{ pool: Pool; route: number; collectionId: string; deadline: number; allowance: WorkAllowance }>,
): Promise<NativeSourceIdentity | null> {
  const command = currentCommand(tx),
    resources = currentCommandResources(tx),
    resource = { route: input.route, id: input.collectionId };
  if (
    resources.pool !== input.pool ||
    command.partition !== partitionOf(input.route) ||
    command.authorization?.mode !== 'execute' ||
    !(command.authorization.action === 'collection:update' ||
      (command.authorization.action === 'collection:create' && creationDeclares(tx, resource))) ||
    !(isDeepStrictEqual(command.authorization.resource, resource) || creationDeclares(tx, resource))
  )
    throw new TypeError('Source allocation requires the live original Collection update');
  const { metadata } = await readNativeCollectionWorkingMetadata(input.pool, input, {
    commandTx: tx,
    deadline: input.deadline,
    allowance: input.allowance,
  });
  if (
    !metadata ||
    !metadata.curatorAccountId ||
    metadata.state !== 'active' ||
    metadata.authority !== 'private_builtin' ||
    metadata.curatorAccountId !== command.basis?.actorAccountId
  )
    return null;
  await shareAccount(tx, metadata.curatorAccountId);
  const identity = nativeSourceIdentity(metadata),
    fence = nativeSourceFence(metadata);
  const current = await tx.query<{ identity: NativeSourceIdentity }>(
    'SELECT identity FROM library.canonical_source_scope WHERE route=$1 AND collection_id=$2 AND source_fence=$3',
    [input.route, input.collectionId, fence],
  );
  if (current.rows[0]) return isDeepStrictEqual(current.rows[0].identity, identity) ? current.rows[0].identity : null;
  const retained = await tx.query(
    'SELECT source_fence FROM library.canonical_source_scope WHERE route=$1 AND collection_id=$2 ORDER BY source_fence LIMIT 2',
    [input.route, input.collectionId],
  );
  if (retained.rows.length >= 2) return null;
  const created = await tx.query<{ identity: NativeSourceIdentity }>(
    'INSERT INTO library.canonical_source_scope(route,collection_id,source_fence,identity) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT DO NOTHING RETURNING identity',
    [input.route, input.collectionId, fence, JSON.stringify(identity)],
  );
  return created.rows[0]?.identity ?? null;
}
function scopeKey(identity: NativeSourceIdentity): IdentityScopeKey {
  return { source: { kind: 'library', identity }, scopeId: 'collection-source' };
}
function ledger(input: CanonicalCall): CollectionSourceLedger {
  const a = input.allowance;
  if (routeOf(input.collectionId) !== input.route || !Number.isInteger(a.rawKeys) || a.rawKeys < 0 || a.rawKeys > 100)
    throw new TypeError('Invalid canonical Source reservation');
  return new CollectionSourceLedger(
    {
      reservationId: a.reservationId,
      remaining: {
        candidateKeys: a.rawKeys,
        nativeRows: a.nativeRows,
        nativePoints: a.nativePoints,
        emptySeeks: a.emptySeeks,
        statements: a.statements,
        bytes: a.bytes,
        identityMetadataRows: a.identityMetadataRows,
        witnessKeys: a.rawKeys,
      },
    },
    input.deadline,
  );
}
function work(l: CollectionSourceLedger): CanonicalWork {
  const r = l.receipt();
  return {
    ...r.used,
    reservationId: r.reservationId,
    aliasKeys: 0,
    duplicateKeys: 0,
    lookaheadKeys: 0,
    internalDriverKeys: 0,
  };
}
function notReady(l: CollectionSourceLedger, reason: CanonicalNotReady['reason']): CanonicalNotReady {
  return { state: 'not_ready', reason, work: work(l) };
}
async function query<R extends QueryResultRow>(
  client: Client,
  l: CollectionSourceLedger,
  sql: string,
  values: readonly unknown[],
  rowBound = 16,
  resultBytes = 8192,
  rawBound = 0,
): Promise<R[]> {
  return l.bounded(
    {
      nativeRows: rowBound,
      nativePoints: 1,
      statements: 1,
      emptySeeks: 1,
      candidateKeys: rawBound,
      bytes: Buffer.byteLength(sql) + Buffer.byteLength(JSON.stringify(values)) + resultBytes,
    },
    async () => {
      const config = { text: sql, values: [...values], query_timeout: Math.max(1, l.deadline - Date.now()) };
      return (await client.query<R>(config)).rows;
    },
    (rows) => ({ emptySeeks: rows.length === 0 ? 1 : 0, candidateKeys: rawBound ? rows.length : 0 }),
  );
}
const scopeSQL = `SELECT identity,frontier,capture_id::text AS capture,committed_revision::text AS revision
  FROM library.canonical_source_scope WHERE route=$1 AND collection_id=$2 AND source_fence=$3`;
const generationSQL = `SELECT generation::text,basis,driver,after_subject::text,after_fact::text,source_exhausted,state,version::text
  FROM library.canonical_source_generation WHERE route=$1 AND collection_id=$2 AND generation=$3`;
function takeScopeWork(l: CollectionSourceLedger, used: IdentityScopeWork): void {
  l.take({
    reservationId: l.allowance().reservationId,
    used: {
      candidateKeys: 0,
      witnessKeys: 0,
      identityMetadataRows: 0,
      emptySeeks: 0,
      nativeRows: used.rows,
      nativePoints: used.points,
      statements: used.statements,
      bytes: used.bytes,
    },
  });
}
async function scope(pool: Pool, metadata: NativeCollectionMetadata, l: CollectionSourceLedger) {
  const [row] = await withConnection(pool, (client) =>
    query<ScopeRow>(client, l, scopeSQL, [metadata.route, metadata.collectionId, nativeSourceFence(metadata)]),
  );
  if (!row || !row.capture || row.revision === null) return null;
  const expected: IdentityScopeObservation = {
    key: scopeKey(row.identity),
    captureId: row.capture,
    committedRevision: BigInt(row.revision),
  };
  const result = await createIdentityScopedObservations(pool).revalidate({
    key: expected.key,
    expected,
    deadline: l.deadline,
  });
  takeScopeWork(l, result.work);
  if (
    result.status !== 'current' ||
    result.observation.captureId !== expected.captureId ||
    result.observation.committedRevision !== expected.committedRevision
  )
    return null;
  return expected;
}
async function observe(pool: Pool, input: CanonicalCall, l: CollectionSourceLedger) {
  const { metadata } = await l.run((allowance) =>
    readNativeCollectionWorkingMetadata(pool, input, { deadline: input.deadline, allowance }),
  );
  if (!metadata || metadata.state !== 'active' || metadata.authority === 'unavailable_output') return null;
  // Public capture remains solely Semantic-owned. A Library capture is never substituted for public proof.
  if (metadata.authority === 'activated_output') return null;
  const observation = await scope(pool, metadata, l);
  if (!observation) return null;
  const authority: CanonicalAuthority =
    metadata.authority === 'curated'
      ? { kind: 'curated' }
      : metadata.curatorAccountId
        ? { kind: 'private_builtin', curatorAccountId: metadata.curatorAccountId }
        : { kind: 'curated' };
  if (metadata.authority === 'private_builtin' && !metadata.curatorAccountId) return null;
  const identity = { digest: hash([observation.captureId, observation.committedRevision.toString()]) };
  const components = {
    incarnation: metadata.incarnation,
    authority,
    sourceFence: nativeSourceFence(metadata),
    identity,
    meaning:
      metadata.authority === 'private_builtin'
        ? hash([
            metadata.builtinKind,
            metadata.releaseDigest,
            metadata.profileId,
            metadata.stateSetId,
            metadata.stateId,
            ...(metadata.ruleReady ? [metadata.ruleRevision, metadata.ruleReleaseDigest] : []),
          ])
        : null,
    // Bind coverage into the actual generation commitment. An entry-only generation from an earlier
    // producer cannot be promoted into complete independent support by a reader or a positive witness.
    ...(metadata.authority === 'private_builtin' && metadata.builtinKind === 'state'
      ? { originalCoverage: 'owner-facts-v1' as const }
      : {}),
  };
  const basis: CanonicalBasis = { ...components, digest: hash(components) };
  return { metadata, basis };
}
function same(a: CanonicalBasis, b: CanonicalBasis) {
  return a.digest === b.digest && JSON.stringify(a) === JSON.stringify(b);
}
async function current(pool: Pool, input: CanonicalBoundCall, l: CollectionSourceLedger) {
  const observed = await observe(pool, input, l);
  return observed && same(observed.basis, input.basis) ? observed : null;
}
async function readGeneration(pool: Pool, input: CanonicalSourceRef, generation: string, l: CollectionSourceLedger) {
  return withConnection(
    pool,
    async (client) =>
      (await query<Generation>(client, l, generationSQL, [input.route, input.collectionId, generation]))[0] ?? null,
  );
}
function repair(row: Generation): CanonicalRepair {
  return {
    generation: row.generation,
    basis: row.basis,
    sourceExhausted: row.source_exhausted,
    after:
      row.after_subject && row.after_fact && row.driver !== 'done'
        ? { driver: row.driver, storedSubjectId: row.after_subject, factId: row.after_fact }
        : null,
  };
}
/** Source lock is held through every derived CAS; native writers advance this same source fence. */
async function mutate<T>(
  pool: Pool,
  input: CanonicalCall,
  l: CollectionSourceLedger,
  metadata: NativeCollectionMetadata,
  body: (tx: OperationalTransaction) => Promise<T>,
): Promise<T | null> {
  const context = contexts.get(pool);
  if (!context || !metadata.curatorAccountId) return null;
  return runOperationalTransaction(
    pool,
    {
      mode: 'work-step',
      partition: partitionOf(input.route),
      kind: CANONICAL_SOURCE_WORKFLOW,
      accounts: [metadata.curatorAccountId],
      workClient: context.client,
      deadline: input.deadline,
      clock: context.clock,
    },
    async (tx) => {
      const [row] = await query<{ generation: string }>(
        tx,
        l,
        "SELECT source_generation::text AS generation FROM library.collection WHERE route=$1 AND collection_id=$2 AND state='active' AND curator_account_id=$3 AND collection_id::text || ':' || extract(epoch FROM created_at)::text=$4 FOR UPDATE",
        [input.route, input.collectionId, metadata.curatorAccountId, metadata.incarnation],
      );
      if (!row || row.generation !== metadata.sourceGeneration) return null;
      if (metadata.authority === 'private_builtin') {
        const [fact] = await query<{ generation: string }>(
          tx,
          l,
          'SELECT generation::text FROM library.fact_source_head WHERE route=$1 AND account_id=$2 FOR SHARE',
          [metadata.route, metadata.curatorAccountId],
        );
        if (fact?.generation !== metadata.factFence) return null;
      }
      return body(tx);
    },
  );
}
export async function observeCanonicalSource(pool: Pool, input: CanonicalCall): Promise<CanonicalAuthorityRead> {
  const l = ledger(input);
  try {
    const observed = await observe(pool, input, l);
    return observed
      ? { state: 'admitted', basis: observed.basis, observation: observed.metadata.stamp, work: work(l) }
      : notReady(l, 'identity');
  } catch (error) {
    if (error instanceof Error) Object.defineProperty(error, 'work', { get: () => l.receipt(), configurable: true });
    throw error;
  }
}
export async function readCanonicalSourceState(pool: Pool, input: CanonicalCall): Promise<CanonicalReadyRead> {
  const l = ledger(input);
  try {
    const observed = await observe(pool, input, l);
    if (!observed) return notReady(l, 'identity');
    const [head] = await withConnection(pool, (client) =>
      query<{ generation: string }>(
        client,
        l,
        'SELECT generation::text FROM library.canonical_source_head WHERE route=$1 AND collection_id=$2',
        [input.route, input.collectionId],
      ),
    );
    if (!head) return notReady(l, 'unbuilt');
    const row = await readGeneration(pool, input, head.generation, l);
    if (!row || row.state !== 'complete' || !row.source_exhausted || !same(row.basis, observed.basis))
      return notReady(l, 'stale');
    return { state: 'ready', basis: observed.basis, generation: row.generation, work: work(l) };
  } catch (error) {
    if (error instanceof Error) Object.defineProperty(error, 'work', { get: () => l.receipt(), configurable: true });
    throw error;
  }
}
export async function seekCanonicalSourceGroup(
  pool: Pool,
  input: CanonicalBoundCall & { generation: string; afterSubjectId: string | null },
): Promise<CanonicalCandidateSeek> {
  const l = ledger(input);
  try {
    if (input.afterSubjectId !== null && routeOf(input.afterSubjectId) === null)
      throw new ProblemError('invalid_cursor');
    if (!(await current(pool, input, l))) return notReady(l, 'stale');
    const generation = await readGeneration(pool, input, input.generation, l);
    if (!generation || generation.state !== 'complete' || !same(generation.basis, input.basis))
      return notReady(l, 'unbuilt');
    const [row] = await withConnection(pool, (client) =>
      query<{ subject: string }>(
        client,
        l,
        `SELECT canonical_subject_id::text AS subject FROM library.canonical_source_reference
     WHERE route=$1 AND collection_id=$2 AND generation=$3 AND canonical_subject_id>COALESCE($4::uuid,'00000000-0000-0000-0000-000000000000')
     ORDER BY canonical_subject_id,stored_subject_id,driver,fact_id LIMIT 1`,
        [input.route, input.collectionId, input.generation, input.afterSubjectId],
        8,
        128,
        1,
      ),
    );
    return {
      state: 'ready',
      subjectId: row?.subject ?? null,
      coveredThrough: row?.subject ?? input.afterSubjectId,
      exhausted: !row,
      work: work(l),
    };
  } catch (error) {
    if (error instanceof Error) Object.defineProperty(error, 'work', { get: () => l.receipt(), configurable: true });
    throw error;
  }
}
export async function readCanonicalSourceGroup(
  pool: Pool,
  input: CanonicalBoundCall & { progress: CanonicalGroupProgress },
): Promise<CanonicalGroupWindow> {
  const l = ledger(input);
  try {
    const p = input.progress;
    if (!same(p.basis, input.basis) || routeOf(p.pendingSubjectId) === null) throw new ProblemError('invalid_cursor');
    if (!(await current(pool, input, l))) return notReady(l, 'stale');
    const generation = await readGeneration(pool, input, p.generation, l);
    if (!generation || generation.state !== 'complete' || !same(generation.basis, input.basis))
      return notReady(l, 'unbuilt');
    const limit = Math.min(100, l.allowance().remaining.candidateKeys);
    if (!limit) return notReady(l, 'allowance');
    const rows = await withConnection(pool, (client) =>
      query<{ original: string; driver: number; fact: string }>(
        client,
        l,
        `SELECT stored_subject_id::text AS original,driver,fact_id::text AS fact FROM library.canonical_source_reference
     WHERE route=$1 AND collection_id=$2 AND generation=$3 AND canonical_subject_id=$4
       AND (stored_subject_id,driver,fact_id)>(COALESCE($5::uuid,'00000000-0000-0000-0000-000000000000'),COALESCE($6::smallint,-1),COALESCE($7::uuid,'00000000-0000-0000-0000-000000000000'))
     ORDER BY stored_subject_id,driver,fact_id LIMIT $8`,
        [
          input.route,
          input.collectionId,
          p.generation,
          p.pendingSubjectId,
          p.after?.storedSubjectId ?? null,
          p.after ? drivers.indexOf(p.after.driver) : null,
          p.after?.factId ?? null,
          limit,
        ],
        8 * limit + 8,
        256 * limit,
        limit,
      ),
    );
    const derived: CanonicalDerivedRow[] = rows.map((row) => {
      const driver = drivers[row.driver];
      if (!driver) throw new ProblemError('dependency_unavailable');
      return {
        canonicalSubjectId: p.pendingSubjectId,
        key: { driver, storedSubjectId: row.original, factId: row.fact },
      };
    });
    const after = derived.at(-1)?.key ?? p.after;
    return {
      state: 'ready',
      rows: derived,
      examinedThrough: after,
      exhausted: rows.length < limit,
      progress: { ...p, after },
      work: work(l),
    };
  } catch (error) {
    if (error instanceof Error) Object.defineProperty(error, 'work', { get: () => l.receipt(), configurable: true });
    throw error;
  }
}
export async function beginCanonicalSourceRepair(pool: Pool, input: CanonicalBoundCall): Promise<CanonicalRepairRead> {
  const l = ledger(input);
  try {
    const observed = await current(pool, input, l);
    if (!observed) return notReady(l, 'stale');
    const result = await mutate(pool, input, l, observed.metadata, async (tx) => {
      const [existing] = await query<Generation>(
        tx,
        l,
        generationSQL.replace('AND generation=$3', "AND state='working' FOR UPDATE"),
        [input.route, input.collectionId],
      );
      if (existing && same(existing.basis, input.basis)) return repair(existing);
      if (existing)
        await query(
          tx,
          l,
          "UPDATE library.canonical_source_generation SET state='abandoned' WHERE route=$1 AND collection_id=$2 AND generation=$3",
          [input.route, input.collectionId, existing.generation],
        );
      // Old public/reader custody is retained. Missing disposition consumes capacity, never a fake release.
      const retained = await query(
        tx,
        l,
        'SELECT generation FROM library.canonical_source_generation WHERE route=$1 AND collection_id=$2 ORDER BY generation LIMIT 2',
        [input.route, input.collectionId],
      );
      if (retained.length === 2) return null;
      const generation = randomUUID(),
        driver = observed.metadata.authority === 'curated' ? 'member' : 'entry';
      await query(
        tx,
        l,
        `INSERT INTO library.canonical_source_generation(route,collection_id,generation,basis,driver) VALUES($1,$2,$3,$4::jsonb,$5)`,
        [input.route, input.collectionId, generation, JSON.stringify(input.basis), driver],
      );
      await enqueueIntent(tx, {
        queue: 'maintenance',
        workflowName: CANONICAL_SOURCE_WORKFLOW,
        workflowId: `${CANONICAL_SOURCE_WORKFLOW}:${input.collectionId}:${generation}:0`,
        input: { accounts: [observed.metadata.curatorAccountId!], collectionId: input.collectionId },
      });
      return { generation, basis: input.basis, after: null, sourceExhausted: false };
    });
    return result ? { state: 'working', repair: result, work: work(l) } : notReady(l, 'source');
  } catch (error) {
    if (error instanceof Error) Object.defineProperty(error, 'work', { get: () => l.receipt(), configurable: true });
    throw error;
  }
}
export async function repairCanonicalSourceStep(
  pool: Pool,
  input: CanonicalBoundCall & { repair: CanonicalRepair },
): Promise<CanonicalRepairStep> {
  const l = ledger(input);
  try {
    const observed = await current(pool, input, l);
    if (!observed) return { state: 'basis_changed', repair: input.repair, examined: [], work: work(l) };
    const row = await readGeneration(pool, input, input.repair.generation, l);
    if (!row || row.state !== 'working' || !same(row.basis, input.basis)) return notReady(l, 'stale');
    if (row.source_exhausted) return { state: 'complete', repair: repair(row), examined: [], work: work(l) };
    if (JSON.stringify(repair(row)) !== JSON.stringify(input.repair))
      return { state: 'working', repair: repair(row), examined: [], work: work(l) };
    if (row.driver === 'done') return notReady(l, 'incomplete');
    const limit = Math.min(100, l.allowance().remaining.candidateKeys);
    if (!limit) return notReady(l, 'allowance');
    const independentState =
      observed.metadata.authority === 'private_builtin' && observed.metadata.builtinKind === 'state';
    // Retained preparation closes the independent OWNER population, not the chosen state's entry slice.
    // The ordinary Source raw API deliberately keeps its entry-only state semantics. No Everything Source
    // or positive alias supplies permission/coverage here. Every range is a native indexed raw100 seek.
    const page = independentState
      ? await l.bounded(
          {
            candidateKeys: limit,
            nativeRows: 8 * limit + 8,
            nativePoints: 1,
            statements: 1,
            emptySeeks: 1,
            bytes: Buffer.byteLength(ownerFacts.sql) + 1024 + 256 * limit,
          },
          () =>
            withConnection(pool, (client) =>
              readOwnerNativeFactPage(
                deadlineClient(client, input.deadline),
                observed.metadata.curatorAccountId!,
                row.driver as OwnerNativeFactDriver,
                input.repair.after,
                limit,
              ),
            ),
          (page) => ({ candidateKeys: page.rows.length, emptySeeks: page.rows.length === 0 ? 1 : 0 }),
        )
      : await l.run((allowance) =>
          readNativeCollectionRawPage(pool, observed.metadata, {
            driver: row.driver === 'done' ? 'entry' : row.driver,
            after: input.repair.after,
            limit,
            deadline: input.deadline,
            allowance,
          }),
        );
    const originals = [...new Set(page.rows.map((r) => r.key.storedSubjectId))];
    const mappings = await l.bounded(
      {
        nativeRows: 32 * originals.length,
        nativePoints: 8 * originals.length,
        statements: 8 * originals.length,
        bytes: 16384 * originals.length,
      },
      () => identityEpochStore.readMappings(pool, originals),
    );
    // Mapping points supply identity for examined raw originals, never complete population evidence.
    if (mappings.some((mapping) => mapping.state !== 'mapped')) return notReady(l, 'identity');
    if (!(await current(pool, input, l)))
      return { state: 'basis_changed', repair: input.repair, examined: page.rows.map((r) => r.key), work: work(l) };
    const result = await mutate(pool, input, l, observed.metadata, async (tx) => {
      const [locked] = await query<Generation>(tx, l, generationSQL + ' FOR UPDATE', [
        input.route,
        input.collectionId,
        row.generation,
      ]);
      if (!locked || locked.version !== row.version || locked.state !== 'working') return null;
      for (const item of page.rows) {
        const mapping = mappings[originals.indexOf(item.key.storedSubjectId)];
        if (!mapping || mapping.state !== 'mapped') throw new ProblemError('dependency_unavailable');
        await query(
          tx,
          l,
          `INSERT INTO library.canonical_source_reference(route,collection_id,generation,canonical_subject_id,stored_subject_id,driver,fact_id)
        VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
          [
            input.route,
            input.collectionId,
            row.generation,
            mapping.terminal,
            item.key.storedSubjectId,
            drivers.indexOf(item.key.driver),
            item.key.factId,
          ],
        );
      }
      const sequence: readonly CanonicalRawKey['driver'][] =
        observed.metadata.authority === 'curated' ? ['member'] : ['entry', 'label', 'session', 'copy'];
      const nextDriver = page.exhausted
        ? (sequence[sequence.indexOf(row.driver === 'done' ? 'entry' : row.driver) + 1] ?? 'done')
        : row.driver;
      const next: Generation = {
        ...row,
        driver: nextDriver,
        after_subject: page.exhausted ? null : (page.after?.storedSubjectId ?? null),
        after_fact: page.exhausted ? null : (page.after?.factId ?? null),
        source_exhausted: nextDriver === 'done',
      };
      await query(
        tx,
        l,
        `UPDATE library.canonical_source_generation SET driver=$4,after_subject=$5,after_fact=$6,source_exhausted=$7,version=version+1
      WHERE route=$1 AND collection_id=$2 AND generation=$3`,
        [
          input.route,
          input.collectionId,
          row.generation,
          next.driver,
          next.after_subject,
          next.after_fact,
          next.source_exhausted,
        ],
      );
      await enqueueIntent(tx, {
        queue: 'maintenance',
        workflowName: CANONICAL_SOURCE_WORKFLOW,
        workflowId: `${CANONICAL_SOURCE_WORKFLOW}:${input.collectionId}:${row.generation}:${BigInt(row.version) + 1n}`,
        input: { accounts: [observed.metadata.curatorAccountId!], collectionId: input.collectionId },
      });
      return repair(next);
    });
    return result
      ? {
          state: result.sourceExhausted ? 'complete' : 'working',
          repair: result,
          examined: page.rows.map((r) => r.key),
          work: work(l),
        }
      : notReady(l, 'stale');
  } catch (error) {
    if (error instanceof Error) Object.defineProperty(error, 'work', { get: () => l.receipt(), configurable: true });
    throw error;
  }
}
export async function publishCanonicalSourceRepair(
  pool: Pool,
  input: CanonicalBoundCall & { repair: CanonicalRepair },
): Promise<CanonicalPublication> {
  const l = ledger(input);
  try {
    const observed = await current(pool, input, l);
    if (!observed) return { state: 'basis_changed', work: work(l) };
    const result = await mutate(pool, input, l, observed.metadata, async (tx) => {
      const [row] = await query<Generation>(tx, l, generationSQL + ' FOR UPDATE', [
        input.route,
        input.collectionId,
        input.repair.generation,
      ]);
      if (!row || !same(row.basis, input.basis)) return 'basis_changed' as const;
      if (!row.source_exhausted || row.state === 'abandoned') return 'incomplete' as const;
      await query(
        tx,
        l,
        "UPDATE library.canonical_source_generation SET state='complete' WHERE route=$1 AND collection_id=$2 AND generation=$3",
        [input.route, input.collectionId, row.generation],
      );
      await query(
        tx,
        l,
        `INSERT INTO library.canonical_source_head(route,collection_id,generation) VALUES($1,$2,$3)
      ON CONFLICT(route,collection_id) DO UPDATE SET generation=EXCLUDED.generation`,
        [input.route, input.collectionId, row.generation],
      );
      return 'published' as const;
    });
    return result ? { state: result, work: work(l) } : notReady(l, 'source');
  } catch (error) {
    if (error instanceof Error) Object.defineProperty(error, 'work', { get: () => l.receipt(), configurable: true });
    throw error;
  }
}

/** Bounded native population capture precedes canonical mapping; source originals include rejects/order inputs. */
export async function advanceCanonicalSourceCapture(pool: Pool, input: CanonicalCall): Promise<CanonicalAuthorityRead> {
  const l = ledger(input);
  try {
    const context = contexts.get(pool);
    const { metadata } = await l.run((allowance) =>
      readNativeCollectionWorkingMetadata(pool, input, { deadline: input.deadline, allowance }),
    );
    if (
      !context ||
      !metadata ||
      !metadata.curatorAccountId ||
      metadata.state !== 'active' ||
      (metadata.authority !== 'curated' && metadata.authority !== 'private_builtin')
    )
      return notReady(l, 'source');
    const fence = nativeSourceFence(metadata);
    let [row] = await withConnection(pool, (client) =>
      query<ScopeRow>(client, l, scopeSQL, [input.route, input.collectionId, fence]),
    );
    if (!row) {
      const identity = nativeSourceIdentity(metadata);
      await mutate(pool, input, l, metadata, async (tx) => {
        const retained = await query(
          tx,
          l,
          'SELECT source_fence FROM library.canonical_source_scope WHERE route=$1 AND collection_id=$2 ORDER BY source_fence LIMIT 2',
          [input.route, input.collectionId],
        );
        if (retained.length === 2) return; // Missing disposition retains custody and consumes capacity.
        await query(
          tx,
          l,
          `INSERT INTO library.canonical_source_scope(route,collection_id,source_fence,identity) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT DO NOTHING`,
          [input.route, input.collectionId, fence, JSON.stringify(identity)],
        );
      });
      [row] = await withConnection(pool, (client) =>
        query<ScopeRow>(client, l, scopeSQL, [input.route, input.collectionId, fence]),
      );
    }
    if (!row) return notReady(l, 'source');
    const custody = createNativeLibrarySourceCustody({ pool });
    if (!row.frontier || row.frontier.driver !== 'done') {
      if (l.allowance().remaining.candidateKeys < 1) return notReady(l, 'allowance');
      const page = await l.run((allowance) =>
        custody.capturePage({
          identity: row.identity,
          frontier: row.frontier,
          limit: Math.min(100, allowance.remaining.candidateKeys),
          deadline: input.deadline,
          allowance,
        }),
      );
      if (page.status !== 'pending') return notReady(l, 'identity');
      await mutate(pool, input, l, metadata, async (tx) => {
        const changed = await query(
          tx,
          l,
          `UPDATE library.canonical_source_scope SET frontier=$4::jsonb
        WHERE route=$1 AND collection_id=$2 AND source_fence=$3 AND frontier IS NOT DISTINCT FROM $5::jsonb RETURNING collection_id`,
          [
            input.route,
            input.collectionId,
            fence,
            JSON.stringify(page.frontier),
            row!.frontier ? JSON.stringify(row!.frontier) : null,
          ],
        );
        if (changed.length)
          await enqueueIntent(tx, {
            queue: 'maintenance',
            workflowName: CANONICAL_SOURCE_WORKFLOW,
            workflowId: `${CANONICAL_SOURCE_WORKFLOW}:${input.collectionId}:${page.frontier.captureId}:${page.frontier.version}`,
            input: { accounts: [metadata.curatorAccountId!], collectionId: input.collectionId },
          });
      });
      return notReady(l, 'incomplete');
    }
    const completed = await l.run((allowance) =>
      custody.finishCapture({ identity: row.identity, frontier: row.frontier!, deadline: input.deadline, allowance }),
    );
    if (completed.status !== 'complete') return notReady(l, 'identity');
    const registered = await createIdentityScopedObservations(pool).register({
      key: scopeKey(row.identity),
      deadline: input.deadline,
      capture: { kind: 'library', capture: completed.capture, frontier: row.frontier, allowance: l.allowance() },
    });
    takeScopeWork(l, registered.work);
    if (registered.status !== 'registered') return notReady(l, 'identity');
    await mutate(pool, input, l, metadata, async (tx) => {
      await query(
        tx,
        l,
        `UPDATE library.canonical_source_scope SET capture_id=$4,committed_revision=$5
      WHERE route=$1 AND collection_id=$2 AND source_fence=$3`,
        [
          input.route,
          input.collectionId,
          fence,
          registered.observation.captureId,
          registered.observation.committedRevision.toString(),
        ],
      );
    });
    const observed = await observe(pool, input, l);
    return observed
      ? { state: 'admitted', basis: observed.basis, observation: observed.metadata.stamp, work: work(l) }
      : notReady(l, 'identity');
  } catch (error) {
    if (error instanceof Error) Object.defineProperty(error, 'work', { get: () => l.receipt(), configurable: true });
    throw error;
  }
}
