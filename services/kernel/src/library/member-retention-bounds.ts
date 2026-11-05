/** Retained-occurrence SQL declarations. Plans retain original operands and clients. */
import { declareBound, repeatBound, sumBounds, type Bound } from '@rezics/bounds';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Pool, PoolClient } from 'pg';
import type {
  CommandResult,
  CommandTransaction,
  LegacyCommandOptions,
  PrincipalCommandOptions,
} from '../command/command.ts';
import { currentCommandWorkAssociation } from '../command/work-context.ts';
import { nativeWorkDimensions } from './native-work-dimensions.ts';
import { nativeCommandScaffoldPlan } from './shelf-maintenance-bounds.ts';
import { sessionSourceWork } from './session-operation-bounds.ts';
import { collectionPrivacyReductionPlan } from '../semantic/public-filter-collection-reduction-bounds.ts';
import accountRead from '../access/account-read.sql';
import builtinReference from './builtin-reference-read.sql';
import { durableStepPlan, durableSegmentPlan, durableEnqueuePlan } from '../work/durable-step-bounds.ts';
import { COMMAND_STEP_RETRIES } from '../work/retries.ts';
import { PARTITIONS } from '../route/route.ts';
import due from './member-retention-due-page.sql';
import purge from './member-retention-purge.sql';
import remove from './collection-store-collection-member-delete.sql';
import restore from './collection-store-collection-member-restore.sql';
import read from './collection-store-collection-member-retention-read.sql';
import partition from '../partition/read.sql';

type Client = Pick<PoolClient, 'query'>;
const size = (input: unknown) =>
  Buffer.byteLength(JSON.stringify(input, (_, v) => (typeof v === 'bigint' ? String(v) : v)));
export const retentionCost = (part: Partial<Bound> = {}): Bound =>
  declareBound({
    candidateKeys: 0,
    nativeRows: 0,
    identityMetadataRows: 0,
    emptySeeks: 0,
    nativePoints: 0,
    witnessKeys: 0,
    statements: 0,
    bytes: 0,
    engineRequests: 0,
    ...part,
  });
const uuid = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const timestamp = '\0'.repeat(64);
// Schema maxima, including JSON escaping, rather than one observed successful row.
export const MEMBER_RETENTION_MEMBER = Object.freeze({
  collectionId: uuid,
  id: uuid,
  subjectId: uuid,
  note: '\0'.repeat(2000),
  ordinalKey: '\0'.repeat(48),
  addedAt: timestamp,
  deletionId: uuid,
  revision: 2_147_483_647,
});
const memberBytes = size(MEMBER_RETENTION_MEMBER);
const dueBytes = size({ purgeAfter: timestamp, route: 65535, collectionId: uuid, memberId: uuid, deletionId: uuid });

export const MEMBER_RETENTION_LIMITS = Object.freeze({
  seeks: 100,
  partitions: PARTITIONS,
  pages: 100,
  selected: 100,
  retries: COMMAND_STEP_RETRIES.maxAttempts,
});

type Shape = Readonly<{ examined: number; points: number; returned: number; rowBytes: number; candidates: number }>;
export function memberRetentionSqlPlan(sql: string, values: readonly unknown[], shape: Shape) {
  const serializedBinds = JSON.stringify(values);
  return Object.freeze({
    sql,
    serializedBinds,
    examinedRows: shape.examined,
    resultLimit: shape.returned,
    total: retentionCost({
      candidateKeys: shape.candidates,
      nativeRows: shape.examined,
      nativePoints: shape.points,
      emptySeeks: shape.points,
      statements: 1,
      bytes: Buffer.byteLength(sql) + Buffer.byteLength(serializedBinds) + 2 + shape.returned * (shape.rowBytes + 1),
    }),
  });
}

/** A negative point probe has the same examined-work ceiling as a successful probe. */
export function memberRetentionPoint(sql: string, values: readonly unknown[], rows = 1, rowBytes = memberBytes) {
  return memberRetentionSqlPlan(sql, values, { examined: rows, points: rows, returned: rows, rowBytes, candidates: 1 });
}

export function memberRetentionDuePlan(input: Parameters<typeof due.run>[1]) {
  // UNION's one-time gates open exactly one indexed range. No prior history is a candidate.
  return memberRetentionSqlPlan(
    due.sql,
    due.params.map((key) => input[key as keyof typeof input]),
    {
      examined: input.page_limit + 1,
      points: 2,
      returned: input.page_limit,
      rowBytes: dueBytes,
      candidates: input.page_limit,
    },
  );
}

export async function memberRetentionRemovalPlan(input: Parameters<typeof remove.run>[1], n: number) {
  const c = await retainedCosts();
  const values = remove.params.map((key) =>
    key === 'items' ? JSON.stringify(input.items) : input[key as keyof typeof input],
  );
  const statement = memberRetentionSqlPlan(remove.sql, values, {
    // requested/selected materialization and scans, parent CAS and addressed member writes.
    examined: 8 * n + 2,
    points: 2 * n + 1,
    returned: n,
    rowBytes: memberBytes,
    candidates: n,
  });
  return Object.freeze({
    ...statement,
    values: Object.freeze(values),
    total: sumBounds(statement.total, repeatBound(sumBounds(structureChange(c), indexChanges), n)),
  });
}

export function memberRetentionReadPlan(input: Parameters<typeof read.run>[1]) {
  return memberRetentionPoint(
    read.sql,
    read.params.map((key) => input[key as keyof typeof input]),
    1,
    memberBytes + size({ deletedAt: timestamp, purgeAfter: timestamp, deletionRevision: '9223372036854775807' }),
  );
}
export async function memberRetentionRestorePlan(input: Parameters<typeof restore.run>[1]) {
  const c = await retainedCosts();
  const statement = memberRetentionPoint(
    restore.sql,
    restore.params.map((key) => input[key as keyof typeof input]),
    8,
  );
  return Object.freeze({ ...statement, total: sumBounds(statement.total, structureChange(c), indexChanges) });
}
export async function memberRetentionPurgePlan(input: Parameters<typeof purge.run>[1]) {
  const c = await retainedCosts();
  // Parent/member target probes, exact DELETE and public UPDATE alternatives and RETURNING.
  const statement = memberRetentionPoint(
    purge.sql,
    purge.params.map((key) => input[key as keyof typeof input]),
    8,
    size({ purged: true }),
  );
  return Object.freeze({
    ...statement,
    total: sumBounds(statement.total, structureCleanup, c.memberGuards, indexChanges),
  });
}
export function memberRetentionPartitionPlan(partitionNo: number) {
  return memberRetentionPoint(partition.sql, [partitionNo], 1, 1024);
}
const covered = new AsyncLocalStorage<boolean>();
export type MemberRetentionExecution = Readonly<{
  operation: string;
  total: Bound;
  native: Bound;
  identity?: Readonly<Episode>;
}>;
const observation = new AsyncLocalStorage<(execution: MemberRetentionExecution) => void>();
type Composition = { total: Bound; native: Bound };
const compositions = new AsyncLocalStorage<readonly Composition[]>();
/** Sum disjoint declarations at their real dispatches, including every reached Core retry.
 * Two fixed-depth accumulators retain nine counters each, never a vector of episode keys.
 * Core contention uses jitter rather than a finite attempt cap, so an invented retry
 * multiplier cannot enclose its work. Each original attempt still consumes before dispatch.
 */
async function composeMemberRetention<T>(operation: string, dispatch: () => Promise<T>): Promise<T> {
  const result: Composition = { total: retentionCost(), native: retentionCost() };
  return compositions.run([...(compositions.getStore() ?? []), result], async () => {
    try {
      return await dispatch();
    } finally {
      observation.getStore()?.(Object.freeze({ operation, total: result.total, native: result.native }));
    }
  });
}
/** Observe declarations bound to genuine dispatch, without manufacturing a work association or grant. */
export function observeMemberRetentionExecution<T>(
  observe: (execution: MemberRetentionExecution) => void,
  dispatch: () => Promise<T>,
): Promise<T> {
  return observation.run(observe, dispatch);
}
function bindNative<T>(
  operation: string,
  total: Bound,
  native: Bound,
  dispatch: () => Promise<T>,
  identity?: Readonly<Episode>,
  compositionCost: Bound = native,
): Promise<T> {
  for (const composition of compositions.getStore() ?? []) {
    composition.total = sumBounds(composition.total, compositionCost);
    composition.native = sumBounds(composition.native, native);
  }
  observation.getStore()?.(Object.freeze({ operation, total, native, ...(identity ? { identity } : {}) }));
  const association = currentCommandWorkAssociation();
  return association
    ? association.run(`library.member-retention.${operation}`, nativeWorkDimensions(native), dispatch)
    : dispatch();
}
export function consumeMemberRetention<T>(name: string, bound: Bound, dispatch: () => Promise<T>): Promise<T> {
  if (covered.getStore()) return dispatch();
  return bindNative(name, bound, bound, dispatch);
}
export async function memberRetentionControl(client: Client, sql: string): Promise<void> {
  // Hold terminal control costs before useful work. Expiry cannot prevent the original client's rollback.
  if (sql === 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY') {
    const controls = sumBounds(
      ...[sql, 'COMMIT', 'ROLLBACK'].map(
        (text) =>
          memberRetentionSqlPlan(text, [], {
            examined: 0,
            points: 0,
            returned: 0,
            rowBytes: 0,
            candidates: 0,
          }).total,
      ),
    );
    await memberRetentionDiscovery('control', controls, () => client.query(sql));
  } else {
    await client.query(sql);
  }
}

/** The mounted adapter still owns encoding. Account for this sizing pass and its output encoding. */
export function serializeMemberRetention<T>(name: string, value: T): Promise<T> {
  return memberRetentionDiscovery(name, retentionCost({ bytes: 2 * size(value) }), async () => value);
}

export const MEMBER_RETENTION_SQL = Object.freeze({
  owner: 'SELECT curator_account_id FROM library.collection WHERE route=$1 AND collection_id=$2',
  authorize: `SELECT member.member_id, member.deletion_id, member.purge_after, member.purge_after<= $5::timestamptz AS due
           FROM library.collection_member member JOIN library.collection collection
             ON collection.route=member.route AND collection.collection_id=member.collection_id
          WHERE member.route=$1 AND member.collection_id=$2 AND member.member_id=$3
            AND member.deletion_id=$4 AND member.purge_after=$6::timestamptz FOR UPDATE OF member,collection`,
  collision: `SELECT 1 FROM library.collection_member
            WHERE route=$1 AND collection_id=$2 AND deletion_id IS NULL AND ordinal_key=$3 AND member_id<>$4 LIMIT 1`,
});

export type Episode = Readonly<{
  kind: 'remove' | 'restore' | 'purge';
  route: number;
  collectionId: string;
  memberId: string;
  deletionId: string;
  revision?: number;
  purgeAfter?: string;
  requestKey: string;
}>;
const episode = new AsyncLocalStorage<Episode>();
export function withMemberRetentionEpisode<T>(original: Episode, dispatch: () => Promise<T>): Promise<T> {
  return episode.run(Object.freeze({ ...original }), dispatch);
}

const control = (sql: string) =>
  memberRetentionSqlPlan(sql, [], {
    examined: 0,
    points: 0,
    returned: 0,
    rowBytes: 0,
    candidates: 0,
  }).total;
const snapshot = sumBounds(...['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', 'COMMIT', 'ROLLBACK'].map(control));
type NativeCosts = typeof import('./collection-order-bounds.ts').COLLECTION_NATIVE_COST;
// The installed ordinal owner also loads native Access. Resolve its producer at
// execution, after module initialization, without duplicating its declarations.
async function retainedCosts(): Promise<NativeCosts> {
  return (await import('./collection-order-bounds.ts')).COLLECTION_NATIVE_COST;
}
/** Ordinary admitted Collection lookup, including the compatibility overload before mutate. */
export async function readRetainedCollection<T>(dispatch: () => Promise<T>): Promise<T> {
  const c = await retainedCosts();
  return consumeMemberRetention('collection-read', c.collectionRow, dispatch);
}
export function retainedMemberBuiltin<T>(dispatch: () => Promise<T>): Promise<T> {
  if (!episode.getStore()) return dispatch();
  return consumeMemberRetention(
    'builtin-admission',
    sumBounds(
      snapshot,
      memberRetentionPoint(accountRead.sql, [65535, uuid], 1, 1024).total,
      memberRetentionPoint(builtinReference.sql, [65535, uuid], 1, 2048).total,
    ),
    dispatch,
  );
}

// Each retained operation has at most 16 history operations, each with up to two
// transfer sides. Append can temporarily add one operation; physical cleanup
// visits at most 32 retained rows and their distinct Collection heads.
const historyRows = 2 * 16;
const structureCleanup = retentionCost({
  candidateKeys: historyRows,
  nativeRows: 3 * historyRows,
  nativePoints: 2 * historyRows,
  emptySeeks: 1,
  statements: 1 + historyRows,
  bytes: historyRows * (32_768 + 256),
});
const structureChange = (c: NativeCosts) =>
  sumBounds(
    c.memberGuards,
    c.structurePending,
    c.structureAppend,
    // Pending DELETE, bounded before/after states, per-occurrence prune and gap-head updates.
    retentionCost({
      nativeRows: 2 * historyRows + 8,
      nativePoints: historyRows + 8,
      statements: 6,
      bytes: 2 * 32_768 + historyRows * 256,
    }),
  );
// Parent PK/curator/listing indexes and member PK/deletion/live/raw/due/subject
// indexes: each changed index has old/new entries. Both OLD/NEW native and export
// source anchors upsert native_source_fence; export also point-reads the curator.
const parentIndexes = 6,
  memberIndexes = 6,
  sourceAnchors = 2 * 2 * 2;
const indexChanges = sumBounds(
  retentionCost({ nativeRows: 2 * (parentIndexes + memberIndexes), nativePoints: 2 * (parentIndexes + memberIndexes) }),
  retentionCost({
    nativeRows: sourceAnchors * 4 + 2,
    nativePoints: sourceAnchors * 3 + 2,
    statements: sourceAnchors + 2,
    bytes: sourceAnchors * 2048,
  }),
);

export async function memberRetentionCommandPlan(
  pool: Pool,
  options: LegacyCommandOptions | PrincipalCommandOptions,
  original: Episode,
) {
  const c = await retainedCosts();
  const response = original.kind === 'purge' ? { purged: true } : MEMBER_RETENTION_MEMBER;
  const events = [
    {
      id: uuid,
      type:
        original.kind === 'purge'
          ? 'com.rezics.library.collection.member.purged.v1'
          : 'com.rezics.library.collection.member.changed.v1',
      subject: original.collectionId,
      data: {
        collectionId: original.collectionId,
        memberId: original.memberId,
        ...(original.kind === 'purge' ? { deletionId: original.deletionId } : { subjectId: uuid }),
      },
    },
  ];
  const scaffold = nativeCommandScaffoldPlan(pool, options, { response, events });
  const route = original.route,
    collection_id = original.collectionId,
    member_id = original.memberId;
  const time = timestamp,
    transaction_id = uuid,
    expected_revision = original.revision ?? 2_147_483_647;
  const deletion_id = original.deletionId;
  const reads =
    original.kind === 'purge'
      ? memberRetentionPoint(
          MEMBER_RETENTION_SQL.authorize,
          [route, collection_id, member_id, deletion_id, time, original.purgeAfter],
          2,
          512,
        ).total
      : sumBounds(repeatBound(c.authorizationCollection, 3), c.accountShare, c.collectionRow, c.barrier);
  const mutation =
    original.kind === 'remove'
      ? sumBounds(
          (
            await memberRetentionRemovalPlan(
              { route, collection_id, expected_revision, items: [{ member_id, deletion_id }], time, transaction_id },
              1,
            )
          ).total,
          collectionPrivacyReductionPlan(route, collection_id).total,
        )
      : original.kind === 'restore'
        ? sumBounds(
            repeatBound(memberRetentionReadPlan({ route, collection_id, member_id }).total, 2),
            sessionSourceWork(uuid, false),
            (
              await memberRetentionRestorePlan({
                route,
                collection_id,
                member_id,
                deletion_id,
                expected_revision,
                time,
                transaction_id,
              })
            ).total,
            memberRetentionPoint(MEMBER_RETENTION_SQL.collision, [route, collection_id, '\0'.repeat(48), member_id])
              .total,
          )
        : sumBounds(
            (
              await memberRetentionPurgePlan({
                route,
                collection_id,
                member_id,
                deletion_id,
                expected_purge_after: original.purgeAfter!,
                time,
              })
            ).total,
          );
  const terms = Object.freeze({
    scaffold,
    partition: c.partitionProbe,
    recovery: repeatBound(
      sumBounds(c.actorTimeMint, c.partitionProbe),
      1 + Math.ceil(Math.max(0, (options.deadline ?? Date.now() + 5000) - Date.now()) / 25),
    ),
    authorization: reads,
    mutation,
    // Native Access and Shelf already consume through their owners in this same frame.
    access: original.kind === 'purge' ? retentionCost() : c.accessPreparation,
    // resolveSubject prepares original and terminal subject:read checks through
    // native Access, even when both anchors identify the same subject.
    subjectAccess: original.kind === 'restore' ? repeatBound(c.accessNativePreparation, 2) : retentionCost(),
    shelf: original.kind === 'purge' ? retentionCost() : c.shelfWrite,
    serialization: retentionCost({
      bytes:
        size([original, options.deadline, options.receipt?.key, options.receipt?.digest]) +
        3 * size(response) +
        size(events),
    }),
  });
  const native = sumBounds(scaffold, terms.partition, terms.recovery, reads, mutation, terms.serialization);
  return Object.freeze({
    identity: Object.freeze({ ...original }),
    terms,
    native,
    total: sumBounds(native, terms.access, terms.subjectAccess, terms.shelf),
  });
}

/** The original executor still owns time, admission, retries, replay, drain and release.
 * Charge disjoint Library/Core terms per reached attempt; existing Access/Shelf terms
 * remain with their native owners. Covered retained SQL cannot be charged twice.
 */
export async function runMemberRetentionCommand<T>(
  pool: Pool,
  options: LegacyCommandOptions | PrincipalCommandOptions,
  body: (
    tx: CommandTransaction,
    context: { transactionId: string; time: import('../command/command.ts').AuthoritativeTime },
  ) => Promise<CommandResult<T>>,
): Promise<import('../command/command.ts').CommandOutcome<T>> {
  const { runCommand, withCommandAttemptWork } = await import('../command/command.ts');
  const original = episode.getStore();
  const dispatch = () => ('principal' in options ? runCommand(pool, options, body) : runCommand(pool, options, body));
  if (!original) return dispatch();
  const plan = await memberRetentionCommandPlan(pool, options, original);
  return withCommandAttemptWork(
    options,
    () =>
      bindNative(`${original.kind}-attempt`, plan.total, plan.native, async () => undefined, plan.identity, plan.total),
    () => covered.run(true, dispatch),
  );
}

export type MemberRetentionCursor = Readonly<{
  partition: number;
  after?: Readonly<{
    purgeAfter: string;
    route: number;
    collectionId: string;
    memberId: string;
    deletionId: string;
  }>;
}>;
const discovery = new AsyncLocalStorage<boolean>();
const pageDeadline = new AsyncLocalStorage<number>();
export function retainedMemberPageDeadline(): number {
  return pageDeadline.getStore()!;
}
const pageOutputBytes = size({
  cursor: {
    partition: PARTITIONS,
    after: { purgeAfter: timestamp, route: 65535, collectionId: uuid, memberId: uuid, deletionId: uuid },
  },
  examined: 100,
  purged: 100,
  pending: PARTITIONS,
  probes: PARTITIONS,
});

/** Independent probe/seek ceilings: all-pending homes can reach 4096 probes with zero seeks. */
export function memberRetentionPagePlan(cutoff: string, start: MemberRetentionCursor) {
  const homes = PARTITIONS - start.partition;
  const due = memberRetentionDuePlan({
    partition_no: 4095,
    cutoff,
    after_purge_after: timestamp,
    after_route: 65535,
    after_collection_id: uuid,
    after_member_id: uuid,
    page_limit: 1,
  }).total;
  const terms = Object.freeze({
    partitions: repeatBound(memberRetentionPartitionPlan(4095).total, homes),
    transactions: repeatBound(snapshot, homes + MEMBER_RETENTION_LIMITS.seeks),
    seeks: repeatBound(due, MEMBER_RETENTION_LIMITS.seeks),
    output: retentionCost({ bytes: 2 * pageOutputBytes }),
  });
  const perAttempt = sumBounds(...Object.values(terms));
  const sdk = durableStepPlan([cutoff, start], pageOutputBytes).total;
  return Object.freeze({
    terms,
    perAttempt,
    sdk,
    // Purge commands retain their own actual per-attempt declaration and original deadline.
    total: sumBounds(repeatBound(perAttempt, MEMBER_RETENTION_LIMITS.retries), sdk),
  });
}
export function withMemberRetentionPage<T>(
  cutoff: string,
  start: MemberRetentionCursor,
  dispatch: () => Promise<T>,
): Promise<T> {
  const plan = memberRetentionPagePlan(cutoff, start);
  return bindNative('page-discovery-attempt', plan.perAttempt, plan.perAttempt, () => discovery.run(true, dispatch));
}
export function memberRetentionDiscovery<T>(name: string, bound: Bound, dispatch: () => Promise<T>): Promise<T> {
  return discovery.getStore() ? dispatch() : consumeMemberRetention(name, bound, dispatch);
}
/** Wrap outside the registered body so replay still reaches and prices the SDK lookup. */
export function runMemberRetentionPage<T>(
  cutoff: string,
  start: MemberRetentionCursor,
  dispatch: () => Promise<T>,
  deadline: number,
): Promise<T> {
  const plan = memberRetentionPagePlan(cutoff, start);
  // The enclosing declaration includes discovery attempts. Those attempts consume
  // their disjoint native terms at the actual registered-body dispatch below.
  return composeMemberRetention('page-complete', () =>
    bindNative('page-sdk', plan.total, plan.sdk, () => pageDeadline.run(deadline, dispatch)),
  );
}
export function memberRetentionSegmentPlan(input: { cutoff: string; cursor: MemberRetentionCursor }) {
  const page = memberRetentionPagePlan(input.cutoff, input.cursor);
  const sdk = durableSegmentPlan(input);
  const continuation = durableStepPlan([input], 4).total;
  return Object.freeze({
    page,
    sdk,
    continuation,
    total: sumBounds(sdk, repeatBound(page.total, MEMBER_RETENTION_LIMITS.pages), continuation),
  });
}
export function runMemberRetentionSegment<T>(
  input: { cutoff: string; cursor: MemberRetentionCursor },
  dispatch: () => Promise<T>,
): Promise<T> {
  const plan = memberRetentionSegmentPlan(input);
  return composeMemberRetention('segment-complete', () => bindNative('segment-sdk', plan.total, plan.sdk, dispatch));
}
export function runMemberRetentionContinuationStep<T>(input: unknown, dispatch: () => Promise<T>): Promise<T> {
  const plan = durableStepPlan([input], 4);
  return bindNative('continuation-sdk', plan.total, plan.total, dispatch);
}
export function runMemberRetentionContinuation<T>(
  input: unknown,
  options: unknown,
  dispatch: () => Promise<T>,
): Promise<T> {
  const plan = durableEnqueuePlan(input, options);
  return bindNative('continuation', plan.total, plan.native, dispatch);
}
export function runMemberRetentionCutoff<T>(dispatch: () => Promise<T>): Promise<T> {
  const plan = durableStepPlan([], size(timestamp));
  return bindNative('cutoff-sdk', plan.total, plan.total, dispatch);
}
