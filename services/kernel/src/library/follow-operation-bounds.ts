import { declareBound, repeatBound, sumBounds, type Bound } from '@rezics/bounds';
import pg, { type PoolClient } from 'pg';
import { currentCommandWorkAssociation, withNativeCommandAccounting } from '../command/work-context.ts';
import type { WorkDimensions } from './contract/work-dimensions.ts';
import { MAX_FOLLOW_PAGE_SIZE } from './follow-model.ts';
import apply from './follow-store-apply.sql';
import read from './follow-store-read.sql';
import page from './follow-store-page.sql';
import account from '../access/account-command-state.sql';
import accountShare from '../access/account-share.sql';
import partition from '../partition/read.sql';
import time from '../command/time.sql';
import receipt from '../command/read-receipt.sql';
import fence from '../command/fence.sql';
import { routeOf } from '../route/route.ts';
import { collectionDirectoryRowPlan } from './collection-directory-bounds.ts';
import collection from './collection-reads-collection.sql';
import mappingOwners from '../semantic/identity-epoch-read-owners.sql';
import mappingSources from '../semantic/identity-epoch-read-sources.sql';
import mappingPending from '../semantic/identity-epoch-read-pending.sql';
import mappingCurrent from '../semantic/identity-terminal-closure-current.sql';
import reference from '../semantic/read-subject-reference.sql';
import space from '../community/space-read.sql';
import partitions from '../partition/read-batch.sql';
import summaries from '../semantic/summaries-read.sql';
import representatives from '../semantic/summaries-representative-editions.sql';
import release from '../semantic/definitions-read.sql';
import releaseActive from '../semantic/definitions-active.sql';
import releaseExists from '../semantic/definitions-exists.sql';
import followingTargets from '../community/following-space-targets-page.sql';
import addressClaims from '../community/space-address-batch-active.sql';
import coverReferences from '../content/read-cover-reference.sql';
import sourceFences from '../content/read-source-fences.sql';
import { RELEASE_LIMITS } from '@rezics/definitions';
import { isAccessWorkDispatch } from './access-port.ts';
import openGroups from '../access/gates/open-groups.sql';

type Client = Pick<PoolClient, 'query'>;
type Query<I, R> = Readonly<{ sql: string; params: readonly string[]; run(client: Client, input: I): Promise<R> }>;
type Input<Q> = Q extends Query<infer I, unknown> ? I : never;
// The native pg adapter serializes typed SQL arrays and JSONB records before
// query dispatch; raw identity readers pass arrays directly. Decode only to
// retain their original cardinality. Bytes always use the original wire binds.
const arrayValues = (value: unknown): readonly unknown[] =>
  typeof value === 'string'
    ? (pg.types.getTypeParser(1009 as Parameters<typeof pg.types.getTypeParser>[0], 'text')(value) as unknown[])
    : (value as readonly unknown[]);
const recordValues = (value: unknown): readonly unknown[] =>
  typeof value === 'string' ? (JSON.parse(value) as unknown[]) : (value as readonly unknown[]);
const uuid = 'f'.repeat(36);
const int8 = '-9223372036854775808';
const timestamp = 'x'.repeat(64);
const size = (value: unknown) =>
  Buffer.byteLength(JSON.stringify(value, (_, entry) => (typeof entry === 'bigint' ? entry.toString() : entry)));

// UUIDs, route int4, three closed enums and two timestamptz::text projections.
// Escaping is charged independently of PostgreSQL's character encoding.
export const FOLLOW_ROW_BYTES = size({
  route: 65535,
  accountId: uuid,
  targetId: uuid,
  targetType: 'collection',
  state: 'unfollowed',
  reason: 'membership',
  createdAt: timestamp,
  updatedAt: timestamp,
  transactionId: uuid,
});
const accountProjection = { kind: 'organization', state: 'suspended', fenced: false, minimumAuthnEpoch: int8 };
const partitionProjection = {
  partitionNo: 4095,
  node: '',
  movedTo: '',
  writeState: 'draining',
  epoch: -2147483648,
  position: int8,
};
// core.partition node/moved_to are unconstrained text, unlike its finite control
// fields. PostgreSQL's per-field limit applies to these two projections only.
const partitionBytes = size(partitionProjection) + 2 * 6 * (2 ** 30 - 1);

export function followBytes(bytes: number): Bound {
  return declareBound({
    candidateKeys: 0,
    nativeRows: 0,
    identityMetadataRows: 0,
    emptySeeks: 0,
    nativePoints: 0,
    witnessKeys: 0,
    statements: 0,
    bytes,
    engineRequests: 0,
  });
}

type Shape = Readonly<{
  keys: number;
  rows: number;
  points: number;
  seeks: number;
  output: number;
  width: number;
  metadata?: number;
}>;
function sqlWork(sql: string, operands: unknown, shape: Shape): Bound {
  return declareBound({
    candidateKeys: shape.keys,
    nativeRows: shape.rows,
    nativePoints: shape.points,
    emptySeeks: shape.seeks,
    identityMetadataRows: shape.metadata ?? 0,
    witnessKeys: 0,
    statements: 1,
    bytes: Buffer.byteLength(sql) + size(operands) + 2 + shape.output * (shape.width + 1),
    // These leaves execute PostgreSQL only; none dispatches a Search request.
    engineRequests: 0,
  });
}
const point = (width: number): Shape => ({ keys: 1, rows: 2, points: 1, seeks: 1, output: 1, width });

/** Explicit translation: the native port's eight axes and the SQL-only ninth
 * axis remain together. No nonzero engine request is folded into SQL bytes. */
export function followNativeWork(total: Bound): Readonly<{ dimensions: WorkDimensions; engineRequests: number }> {
  return Object.freeze({
    dimensions: Object.freeze({
      candidateKeys: total.candidateKeys,
      nativeRows: total.nativeRows,
      identityMetadataRows: total.identityMetadataRows,
      emptySeeks: total.emptySeeks,
      nativePoints: total.nativePoints,
      witnessKeys: total.witnessKeys,
      statements: total.statements,
      bytes: total.bytes,
    }),
    engineRequests: total.engineRequests,
  });
}

export function consumeFollowWork<T>(
  kind: string,
  total: Bound,
  dispatch: () => Promise<T>,
  actual?: (value: T) => Bound,
): Promise<T> {
  const association = currentCommandWorkAssociation();
  const native = followNativeWork(total);
  return association
    ? association.run(
        `library.follow.${kind}`,
        native.dimensions,
        dispatch,
        actual
          ? (value) => ({ ...followNativeWork(actual(value)).dimensions, nativeRows: total.nativeRows })
          : undefined,
      )
    : dispatch();
}

export type FollowSqlPlan<I, R> = Readonly<{
  original: Readonly<I>;
  operands: readonly unknown[];
  total: Bound;
  run(client: Client): Promise<R>;
}>;

function statement<I extends object, R>(
  kind: string,
  query: Query<I, R>,
  input: I,
  shape: Shape,
  nested?: Bound,
  changed?: (result: R) => boolean,
): FollowSqlPlan<I, R> {
  const original = Object.freeze({ ...input });
  // The generated native adapter's own positional order, including repeated
  // parameters. The same frozen original is subsequently dispatched.
  const operands = Object.freeze(query.params.map((name) => original[name as keyof I]));
  const direct = sqlWork(query.sql, operands, shape);
  const total = nested ? sumBounds(direct, nested) : direct;
  return Object.freeze({
    original,
    operands,
    total,
    run: (client: Client) =>
      consumeFollowWork(
        kind,
        total,
        () => query.run(client, original),
        nested && changed ? (result) => (changed(result) ? total : direct) : undefined,
      ),
  });
}

/** Installed record_follow_count_source SQL. No target delivery or bootstrap is
 * synchronous here. Keep the five nested statements separate from the outer
 * INSERT: first-touch owner/source and both signed delta branches use these
 * same indexed points. A no-effect conflict never invokes this AFTER hook. */
const sourceHookSQL = Object.freeze({
  account: `SELECT live AND a.state = 'active' AND NOT a.authn_fenced INTO eligible
    FROM access.account a WHERE a.route = edge.route AND a.account_id = edge.account_id`,
  owner: `INSERT INTO library.follow_count_owner AS owner (route, account_id)
    VALUES (edge.route, edge.account_id) ON CONFLICT (route, account_id) DO UPDATE
    SET observed_live_count = owner.observed_live_count`,
  previous: `SELECT s.source_following INTO previous_live FROM library.follow_count_source s
    WHERE s.route = edge.route AND s.account_id = edge.account_id
    AND s.target_type = edge.target_type AND s.target_id = edge.target_id FOR UPDATE`,
  source: `INSERT INTO library.follow_count_source AS source
    (route, account_id, target_type, target_id, revision, source_following, desired_eligible, pending_since)
    VALUES (edge.route, edge.account_id, edge.target_type, edge.target_id, 1,
    live, COALESCE(eligible, false), statement_timestamp())
    ON CONFLICT (route, account_id, target_type, target_id) DO UPDATE
    SET revision = source.revision + 1, source_following = EXCLUDED.source_following,
    desired_eligible = EXCLUDED.desired_eligible,
    pending_since = LEAST(source.pending_since, EXCLUDED.pending_since)`,
  delta: `UPDATE library.follow_count_owner
    SET observed_live_count = observed_live_count + CASE WHEN live THEN 1 ELSE -1 END
    WHERE route = edge.route AND account_id = edge.account_id`,
});

export function followSourceHookWork(input: Input<typeof apply>): Bound {
  const owner = [input.route, input.account_id];
  const source = [...owner, input.target_type, input.target_id];
  return sumBounds(
    sqlWork(sourceHookSQL.account, owner, { ...point(5), output: 0 }),
    // owner heap old/new + PK and bootstrap index. Source heap old/new + PK,
    // owner-pending, original-page and partition-pending indexes.
    sqlWork(sourceHookSQL.owner, owner, { ...point(0), rows: 4, points: 3, output: 0 }),
    sqlWork(sourceHookSQL.previous, source, point(5)),
    sqlWork(sourceHookSQL.source, [...source, input.state === 'following', false, input.time], {
      ...point(0),
      rows: 6,
      points: 5,
      output: 0,
    }),
    // Reserve either +1 or -1, including absent legacy representation. The
    // one branch can execute once; reason-only changes may dispatch neither.
    sqlWork(sourceHookSQL.delta, owner, { ...point(0), rows: 4, points: 3, output: 0 }),
  );
}

/** Exported nested Entry contract: one mutation on its existing client/time,
 * including storage hooks. It creates no admission, receipt or transaction. */
export function followMutationPlan(input: Input<typeof apply>) {
  return statement(
    'apply',
    apply,
    input,
    { keys: 1, rows: 9, points: 4, seeks: 1, output: 1, width: size({ changed: true }) },
    followSourceHookWork(input),
    (rows) => rows[0]?.changed === true,
  );
}
export function followPointPlan(input: Input<typeof read>) {
  return statement('point', read, input, point(FOLLOW_ROW_BYTES));
}
export function followPagePlan(input: Input<typeof page> & { limit: number }) {
  const limit = Math.min(MAX_FOLLOW_PAGE_SIZE, input.limit);
  const arms = input.has_cursor ? 2 : 1;
  return statement(
    'page',
    page,
    { ...input, limit },
    {
      // Both index arms can produce limit rows BEFORE the final sort/limit.
      // Count index and Limit, Append, Sort, final Limit and three scalar limits.
      keys: arms * limit,
      rows: (4 * arms + 1) * limit + 3,
      points: arms,
      seeks: arms,
      output: limit,
      width: FOLLOW_ROW_BYTES,
    },
  );
}

export function followAccountWork(accountId: string): Bound {
  return sqlWork(account.sql, [routeOf(accountId)!, accountId], point(size(accountProjection)));
}
/** Each literal dispatch retains the original positional binds. A failed
 * Collection/subject probe and both identity observations have the same leaf
 * price as a successful probe; the resolver does not invent a stored type. */
function targetStatement(sql: string, operands: readonly unknown[]): Bound | undefined {
  if (sql === collection.sql) {
    const input = Object.fromEntries(collection.params.map((key, index) => [key, operands[index]]));
    return collectionDirectoryRowPlan(input as Parameters<typeof collectionDirectoryRowPlan>[0]).total;
  }
  if (sql === space.sql)
    return sqlWork(sql, operands, {
      keys: 2,
      rows: 9,
      points: 2,
      seeks: 2,
      output: 1,
      width:
        size({
          space_id: uuid,
          lifecycle_version: int8,
          state: 'active',
          head_revision_id: uuid,
          created_at: timestamp,
          creator: uuid,
          predecessor: uuid,
          address: '',
          title: '\u0001'.repeat(1024),
          summary: '\u0001'.repeat(4096),
          revision_created_at: timestamp,
          author: uuid,
          inserted_here: false,
        }) +
        // The address is the only unconstrained Space revision field projected.
        6 * (2 ** 30 - 1),
    });
  if (sql === reference.sql)
    return sqlWork(sql, operands, {
      ...point(size({ id: uuid, redirect: uuid })),
      rows: 6,
      points: 2,
      seeks: 2,
    });
  if (sql === mappingOwners.sql) {
    const count = arrayValues(operands[0]).length;
    return sqlWork(sql, operands, {
      keys: count,
      rows: 4 * count,
      points: count,
      seeks: count,
      output: count,
      width: size({ partition_no: 4095, epoch: -2147483648, position: int8, write_state: 'draining' }),
      metadata: count,
    });
  }
  if (sql === mappingSources.sql) {
    const count = arrayValues(operands[0]).length;
    return sqlWork(sql, operands, {
      keys: count,
      rows: 16 * count,
      points: 4 * count,
      seeks: 4 * count,
      output: count,
      width: size({
        subject_id: uuid,
        route: 65535,
        original: uuid,
        terminal: uuid,
        epoch: int8,
        origin: 'published',
        recorded_transaction_id: uuid,
        control_partition: 4095,
        control_group: uuid,
        source_revision: int8,
        owner_epoch: -2147483648,
        erasure_key: int8,
        closure_state: 'withdrawn',
        closure_enrollment: uuid,
        closure_generation: uuid,
        closure_incarnation: uuid,
        closure_immediate: uuid,
        closure_export_transaction: uuid,
        closure_hold_transaction: uuid,
        closure_hold_xid: int8,
        closure_registration_transaction: uuid,
        closure_install_transaction: uuid,
        closure_install_xid: int8,
        closure_ack_transaction: uuid,
        closure_ack_xid: int8,
        closure_source_reservation: uuid,
        closure_claim: uuid,
        closure_withdraw_transaction: uuid,
        closure_withdraw_xid: int8,
        closure_successor_ticket: uuid,
        closure_successor_original: uuid,
        closure_ticket_reservation: uuid,
        closure_mutation_xid: int8,
        closure_cancelled_successor: false,
        dirty_revision: int8,
        captured_revision: int8,
        current_target: uuid,
      }),
      metadata: 4 * count,
    });
  }
  if (sql === mappingPending.sql) {
    const count = arrayValues(operands[0]).length;
    return sqlWork(sql, operands, {
      keys: count,
      rows: 4 * count,
      points: count,
      seeks: count,
      output: count,
      width: size({ partition_no: 4095, terminal: uuid, pending_job: uuid, pending_epoch: int8 }),
      metadata: count,
    });
  }
  if (sql === mappingCurrent.sql) {
    const count = arrayValues(operands[0]).length;
    return sqlWork(sql, operands, {
      keys: count,
      rows: 16 * count,
      points: 4 * count,
      seeks: 4 * count,
      output: count,
      width: size({
        partition_no: 4095,
        terminal: uuid,
        published_epoch: int8,
        owner_epoch: -2147483648,
        generation: int8,
        closure_state: 'receiving',
        closure_incarnation: uuid,
        requested_original: uuid,
        directory_state: 'receiving',
        directory_enrollment: int8,
        directory_incarnation: uuid,
        directory_install: uuid,
        directory_export: uuid,
        directory_revision: int8,
        directory_owner: -2147483648,
        registration_transaction: uuid,
        redirected: true,
      }),
      metadata: 4 * count,
    });
  }
  return undefined;
}

/** FULL uses the admitted Semantic summary slots, not Subject's complete fact
 * and source-member view. Each literal query is priced on its original batch,
 * including representative planning attempts and terminal currentness reads. */
function viewStatement(sql: string, operands: readonly unknown[]): Bound | undefined {
  const values = (query: { params: readonly string[] }, name: string) => operands[query.params.indexOf(name)];
  if (sql === openGroups.sql) {
    const groups = arrayValues(values(openGroups, 'groups'));
    return sqlWork(sql, operands, {
      keys: groups.length,
      rows: 4 * groups.length,
      points: groups.length,
      seeks: groups.length,
      output: groups.length,
      width: size({ group: '' }) + size(groups),
    });
  }
  if (sql === partitions.sql) {
    const count = arrayValues(values(partitions, 'partitions')).length;
    return sqlWork(sql, operands, {
      keys: count,
      rows: 2 * count,
      points: count,
      seeks: count,
      output: count,
      width: partitionBytes,
      metadata: count,
    });
  }
  if (sql === releaseActive.sql)
    return sqlWork(sql, operands, point(size({ digest: `sha256:${'f'.repeat(64)}`, head: int8 })));
  if (sql === releaseExists.sql) return sqlWork(sql, operands, point(size({ digest: `sha256:${'f'.repeat(64)}` })));
  if (sql === release.sql) return sqlWork(sql, operands, point(size({ body: null }) + 6 * RELEASE_LIMITS.bytes));
  if (sql === representatives.sql) {
    const count = recordValues(values(representatives, 'subjects')).length;
    // Requested originals, the indexed 12-row range and Limit, window order,
    // row_number and final join. These are raw occurrences before selection.
    return sqlWork(sql, operands, {
      keys: 12 * count,
      rows: (1 + 5 * 12) * count,
      points: count,
      seeks: count,
      output: 12 * count,
      width: size({ id: uuid, slot_id: uuid, ordinal: 12 }),
    });
  }
  if (sql === summaries.sql) {
    const subjects = recordValues(values(summaries, 'subjects'));
    const selected = recordValues(values(summaries, 'representatives'));
    const languages = arrayValues(values(summaries, 'label_languages'));
    const count = subjects.length;
    // Native compact creation and expanded selection each admit 32 entries.
    // Image + original-language slots, and the actually selected <=12 edition
    // slots. Each selected candidate probes hidden/lifecycle/disclosure/retraction.
    const slots = 2 * count + selected.length;
    const candidates = 32 * slots;
    const fallback = values(summaries, 'display_fallback') === true ? count : 0;
    const labels = (languages.length + 1) * count + fallback;
    return sqlWork(sql, operands, {
      keys: count + candidates + labels + fallback,
      rows: 5 * count + 6 * labels + 9 * slots + 12 * candidates + 3 * fallback,
      points: count + labels + 3 * slots + 5 * candidates + fallback,
      seeks: count + labels + 3 * slots + 5 * candidates + fallback,
      output: count,
      // The projection contains unconstrained stored JSONB statement bodies and
      // term bodies. PostgreSQL's per-field maximum covers those fields only;
      // it is not a blanket width for UUIDs, counters, enums or every SQL row.
      width:
        size({ id: uuid, type: '', labels: {}, original: '', choices: [] }) +
        6 * RELEASE_LIMITS.bytes +
        2 * 6 * (2 ** 30 - 1),
    });
  }
  if (sql === followingTargets.sql) {
    const count = arrayValues(values(followingTargets, 'ids')).length;
    return sqlWork(sql, operands, {
      keys: 4 * count,
      rows: 14 * count + 1,
      points: 4 * count,
      seeks: 4 * count,
      output: count,
      width:
        size({
          space_id: uuid,
          space_head_revision_id: uuid,
          space_lifecycle_version: int8,
          address: '',
          title: '\u0001'.repeat(1024),
          realm_id: uuid,
          realm_head_revision_id: uuid,
          realm_lifecycle_version: int8,
        }) +
        6 * (2 ** 30 - 1),
    });
  }
  if (sql === addressClaims.sql) {
    const count = arrayValues(values(addressClaims, 'addresses')).length;
    const addresses = size(values(addressClaims, 'addresses'));
    return sqlWork(sql, operands, {
      keys: count,
      rows: 4 * count,
      points: count,
      seeks: count,
      output: count,
      width: size({ requested_space_id: uuid, address: '', claimed_space_id: uuid }) + addresses,
    });
  }
  if (sql === coverReferences.sql) {
    const count = arrayValues(values(coverReferences, 'media_ids')).length;
    // Available variants are the two formats and six unique native width slots (including the sub-320 slot).
    const variants = 2 * 6;
    return sqlWork(sql, operands, {
      keys: (1 + variants) * count,
      rows: (5 + 3 * variants) * count,
      points: 2 * count,
      seeks: 2 * count,
      output: count,
      width:
        size({
          mediaId: uuid,
          containerId: uuid,
          sha256: 'f'.repeat(64),
          sourceUrl: '',
          credit: null,
          provenance: null,
          width: -2147483648,
          height: -2147483648,
          thumbhash: 'f'.repeat(44),
          color: '#ffffff',
          variantsJson: '',
          focalX: -1,
          focalY: -1,
        }) +
        6 * 2048 +
        6 * 8192 +
        6 * 65536 +
        2 * variants * size({ format: 'webp', width: 2560 }),
    });
  }
  if (sql === sourceFences.sql) {
    const tuples = recordValues(values(sourceFences, 'tuples'));
    return sqlWork(sql, operands, {
      keys: tuples.length,
      rows: 5 * tuples.length,
      points: tuples.length,
      seeks: tuples.length,
      output: tuples.length,
      width:
        size({
          route: 65535,
          source: '',
          external_id: '',
          field_group: '',
          takenDown: false,
          securityRevision: int8,
          takenDownAt: timestamp,
          takedownId: uuid,
        }) + size(tuples),
    });
  }
  return undefined;
}

export type FollowCommandOriginal = Readonly<{
  accountId: string;
  clientId: string | null;
  requestedBy: string | null;
  kind: string;
  key: string;
  input: unknown;
}>;
/** Bind Core's literal native statements at their actual dispatches. This keeps
 * retries, failed fence recovery, exact replay and rollback distinct without
 * multiplying a success envelope or renewing the original absolute deadline. */
export function followCommandPlan(original: FollowCommandOriginal, deadline: number) {
  const retained = Object.freeze({ ...original, input: Object.freeze(structuredClone(original.input)) });
  return Object.freeze({
    original: retained,
    deadline,
    statement(sql: string, operands: readonly unknown[]): Bound | undefined {
      if (sql === time.sql)
        return sqlWork(sql, operands, {
          keys: 0,
          rows: 1,
          points: 0,
          seeks: 0,
          output: 1,
          width: size({ at: timestamp }),
        });
      if (sql === receipt.sql) {
        const candidates = arrayValues(operands[receipt.params.indexOf('idempotency_keys')]).length;
        return sqlWork(sql, operands, {
          keys: candidates,
          rows: 2 * candidates + 1,
          points: candidates,
          seeks: candidates,
          output: 1,
          width:
            size({
              requestDigest: 'f'.repeat(64),
              epoch: -2147483648,
              position: int8,
              transactionId: uuid,
              response: null,
              payloadState: 'retained',
            }) + FOLLOW_ROW_BYTES,
        });
      }
      if (sql === fence.sql)
        return sqlWork(sql, operands, {
          // partition old/new + PK; outbox heap + five indexes; write basis heap
          // + three indexes; receipt heap + three indexes, and CTE outputs.
          keys: 4,
          rows: 4 + 6 + 4 + 4 + 5,
          points: 1 + 5 + 3 + 3,
          seeks: 1,
          output: 1,
          width: size({ epoch: -2147483648, position: int8 }),
        });
      if (sql === partition.sql) return sqlWork(sql, operands, point(partitionBytes));
      if (
        sql === 'COMMIT' ||
        sql === 'ROLLBACK' ||
        sql === 'BEGIN ISOLATION LEVEL SERIALIZABLE' ||
        sql === 'BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY' ||
        sql === 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' ||
        sql === "SET LOCAL lock_timeout = '200ms'" ||
        /^SET LOCAL statement_timeout = '\d+ms'$/.test(sql)
      )
        return sqlWork(sql, operands, { keys: 0, rows: 0, points: 0, seeks: 0, output: 0, width: 0 });
      // SQL leaves and foreign owners compose independently on the same frame.
      return targetStatement(sql, operands) ?? viewStatement(sql, operands);
    },
  });
}

export function followAccountAuthorizationWork(accountId: string): Bound {
  return sumBounds(
    followAccountWork(accountId),
    sqlWork(accountShare.sql, [routeOf(accountId)!, accountId], point(size({ state: 'suspended', fenced: false }))),
  );
}

function queryOperands(query: { params: readonly string[] }, values: Record<string, unknown>): unknown[] {
  return query.params.map((name) => values[name]);
}

/** Semantic summary/observation SQL already priced for FULL Follow, reused by Label tiles. */
export function followSubjectSummaryObservationWork(count: number): Bound {
  const n = Math.max(0, count);
  if (n === 0) return followBytes(0);
  const subjects = Array.from({ length: n }, () => uuid);
  const subjectRecords = subjects.map((id) => ({ route: 65535, id }));
  const summarySubjects = subjects.map((id) => ({ route: 65535, id, image: uuid, original: uuid }));
  const selected = subjects.map((id) => ({ id, slot_id: uuid }));
  const tuples = subjects.map((id) => ({ route: 65535, source: id, external_id: id, field_group: 'image' }));
  const requireBound = (sql: string, operands: readonly unknown[], view: boolean): Bound => {
    const bound = view ? viewStatement(sql, operands) : targetStatement(sql, operands);
    if (!bound) throw new TypeError(`Missing Follow bound for ${sql.slice(0, 48)}`);
    return bound;
  };
  return sumBounds(
    repeatBound(requireBound(reference.sql, [65535, uuid], false), 4 * n),
    requireBound(mappingOwners.sql, [subjects], false),
    requireBound(mappingSources.sql, [subjects], false),
    requireBound(mappingPending.sql, [subjects], false),
    requireBound(mappingCurrent.sql, [subjects], false),
    requireBound(
      representatives.sql,
      queryOperands(representatives, { partition_no: 4095, subjects: subjectRecords }),
      true,
    ),
    requireBound(
      summaries.sql,
      queryOperands(summaries, {
        partition_no: 4095,
        context_id: uuid,
        subjects: summarySubjects,
        representatives: selected,
        label_languages: ['en'],
        display_fallback: true,
      }),
      true,
    ),
    requireBound(
      coverReferences.sql,
      queryOperands(coverReferences, {
        partition: 4095,
        routes: Array.from({ length: n }, () => 65535),
        media_ids: subjects,
      }),
      true,
    ),
    requireBound(sourceFences.sql, queryOperands(sourceFences, { partition: 4095, tuples }), true),
  );
}

export function withFollowCommandWork<T>(
  plan: ReturnType<typeof followCommandPlan>,
  run: () => Promise<T>,
): Promise<T> {
  return withNativeCommandAccounting(
    {
      connection(dispatch) {
        // Access's native checkout declaration already owns this physical wait.
        if (isAccessWorkDispatch()) return dispatch();
        return consumeFollowWork(
          'connection',
          declareBound({
            candidateKeys: 0,
            nativeRows: 0,
            identityMetadataRows: 0,
            emptySeeks: 0,
            nativePoints: 1,
            witnessKeys: 0,
            statements: 0,
            bytes: 0,
            engineRequests: 0,
          }),
          dispatch,
        );
      },
      query(sql, operands, dispatch) {
        if (isAccessWorkDispatch()) {
          // The foreign owner already holds keys/rows/points/witnesses/binds and
          // projections. Add only the literal SQL surface missing in its six
          // dimensions, including negative and failed dispatches.
          return consumeFollowWork(
            'access-sql',
            declareBound({
              ...followBytes(Buffer.byteLength(sql)),
              statements: 1,
            }),
            dispatch,
          );
        }
        const bound = plan.statement(sql, operands);
        return bound ? consumeFollowWork('command', bound, dispatch) : dispatch();
      },
    },
    run,
  );
}

/** Read preparation, command attempts and finish all consume the same native
 * caller frame. This scope owns no allowance and starts no transaction. */
export function withFollowWork<T>(deadline: number, run: () => Promise<T>): Promise<T> {
  return withFollowCommandWork(
    followCommandPlan(
      { accountId: '', clientId: null, requestedBy: null, kind: 'library.follow.read', key: '', input: {} },
      deadline,
    ),
    run,
  );
}

/** The final immutable DTO is the serialization operand, independent of the raw
 * page producer. A short or concealed display never refunds its native work. */
export function followResponse<T>(body: T): Promise<T> {
  const original = JSON.stringify(body);
  return consumeFollowWork('serialize', followBytes(2 * Buffer.byteLength(original)), async () => body);
}
