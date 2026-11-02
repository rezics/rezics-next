import { types, type Pool, type PoolClient, type QueryResult, type QueryConfig } from 'pg';
import {
  currentOperationalResources,
  hasLiveOperationalTransaction,
  type OperationalTransaction,
} from '../command/operational.ts';
import { deadlineClient } from '../access/authenticate.ts';
import { accessRoot } from '../access/derived-access.ts';
import { createResourcePublicEligibility } from '../access/public-eligibility.ts';
import { admitGroup, PlatformClosedError } from '../access/gates/admission.ts';
import {
  authoritativeTimeValue,
  currentCommandResources,
  hasLiveCommandTransaction,
  type CommandTransaction,
  type AuthoritativeTime,
} from '../command/command.ts';
import { discardConnection, withConnection } from '../database/pool.ts';
import { ProblemError } from '../http/problem.ts';
import { accessCheck, type Access, type Actor } from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import type { CanonicalRawKey } from './canonical-source-store.ts';
import { nativeSourceFence } from './canonical-source-store.ts';
import type { NativeSourceIdentity } from './native-source-custody.ts';
import type { WorkAllowance, WorkDimensions, WorkReceipt } from './collection-source.ts';
import { grantCapable } from './collection-reads.ts';
import { admittedOwnerWorkingSource } from './owner-filter-working-source.ts';
import { instrumentNativeCollectionWork, NativeCollectionWork } from './collection-source-work.ts';
import {
  assertLibraryIdentityWork,
  assertLibraryIdentityResources,
  revalidateBoundLibraryIdentityWork,
  withLibraryIdentityWork,
} from './identity-native-planner-work.ts';
import type { ListingStamp } from './listing-freshness-contract.ts';
import type { NativeOrdinalKey, NativeOrdinalRow } from './collection-source-order.ts';
import partitionRead from '../partition/read.sql';
import permissionTime from '../access/permission-time.sql';
import inverse from '../access/permission-inverse.sql';
import candidates from '../access/permission-candidates.sql';
import permissions from '../access/permission-check.sql';
import assignment from '../access/permission-assignment.sql';
import membership from '../access/permission-membership.sql';
import opening from '../access/gates/opening-read.sql';

export {
  readNativePublicCollectionOutput,
  lockNativePublicCollectionOutput,
  bindAndHoldNativePublicCollectionOutput,
  revalidateNativePublicCollectionOutputHold,
  transferNativePublicCollectionOutputHold,
  releaseNativePublicCollectionOutputHold,
} from './native-public-output-custody.ts';

/** Structural alias of the existing raw owner key; no canonical-order or Access claim. */
export type CanonicalRangeKey = CanonicalRawKey;
type Options = {
  deadline: number;
  allowance: WorkAllowance;
  /** Structural reads only. The Source work branch separately admits the actual native episode. */
  tx?: OperationalTransaction;
  /** Original native creation command; independent of mechanical work authority. */
  commandTx?: CommandTransaction;
};
type QueryClient = Pick<PoolClient, 'query'>;
type Ref = { route: number; collectionId: string };
type Header = Ref & {
  curatorAccountId: string | null;
  state: 'active' | 'deleted';
  visibility: 'private' | 'unlisted' | 'public';
  membershipKind: 'curated' | 'dynamic';
  revision: number;
  createdAt: string;
  sourceGeneration: string;
  builtinKind: 'everything' | 'state' | null;
  releaseDigest: string | null;
  profileId: string | null;
  stateSetId: string | null;
  stateId: string | null;
  ruleRevision?: string | null;
  ruleReleaseDigest?: string | null;
  ruleReady?: boolean;
};
/** Private observation only. Possession grants no source or subject access. */
export type NativeCollectionMetadata = Readonly<
  Header & {
    incarnation: string;
    stamp: ListingStamp;
    factFence: string | null;
    authority: 'curated' | 'private_builtin' | 'activated_output' | 'unavailable_output';
    /** Selected explicit COMPLETE membership only; never a private working generation. */
    outputGeneration: string | null;
    outputPublication: CollectionOutputPublication | null;
  }
>;
// Server-local provenance of structural working metadata, never a serialized permission bit.
const workingMetadata = new WeakSet<NativeCollectionMetadata>();
export type NativeCollectionWitness = Readonly<{
  incarnation: string;
  sourceGeneration: string;
  factFence: string | null;
}>;
type ProbeEvidence =
  | {
      result: 'present';
      key: CanonicalRangeKey;
      progress: null;
      witness: NativeCollectionWitness;
    }
  | { result: 'absent'; key: null; progress: null; witness: null }
  | {
      result: 'not_proven';
      key: null;
      progress: CanonicalRangeKey | null;
      witness: null;
    };
export type NativeCollectionProbe = ProbeEvidence & { work: WorkReceipt };
import headerQuery from './collection-source-native-header.sql';
const headerSQL = headerQuery.sql;
import membersQuery from './collection-source-native-members.sql';
import factsQuery from './collection-source-native-facts.sql';
import probeQuery from './collection-source-native-probe.sql';
import type { CollectionOutputPublication } from './collection-source-output.ts';
import outputHead from './collection-source-output-head.sql';
import outputPage from './collection-source-output-page.sql';
import outputProbe from './collection-source-output-probe.sql';
import ordinalPage from './collection-source-native-ordinal.sql';
const probeSQL = probeQuery.sql;
const bind = (query: { params: readonly string[] }, values: Record<string, unknown>) =>
  query.params.map((name) => values[name]);
// Metadata consumes owner state and stamp only. It never needs node or the move address.
export const nativeCollectionPartitionMetadataSQL =
  'SELECT partition_no AS "partitionNo", write_state AS "writeState", epoch, position::text AS position FROM core.partition WHERE partition_no=$1';
const fenceSQL = 'SELECT generation::text AS generation FROM library.fact_source_head WHERE route=$1 AND account_id=$2';
const referenceSQL =
  'SELECT collection_id FROM library.builtin_collection_reference WHERE route=$1 AND collection_id=$2';
const scopeIdentitySQL =
  'SELECT identity FROM library.canonical_source_scope WHERE route=$1 AND collection_id=$2 AND source_fence=$3';
const accountSQL =
  'SELECT route, account_id AS "accountId", kind, state, authn_fenced AS fenced, minimum_authn_epoch::text AS "minimumAuthnEpoch" FROM access.account WHERE route=$1 AND account_id=$2';
const entrySQL =
  'SELECT state IS NOT NULL AS present, state=$4 AS matches, pg_column_size(library_profile_pin) AS bytes, pg_column_compression(library_profile_pin) IS NOT NULL AS compressed FROM library.entry WHERE route=$1 AND account_id=$2 AND subject_id=$3';
const pinSQL =
  'SELECT library_profile_pin FROM library.entry WHERE route=$1 AND account_id=$2 AND subject_id=$3 AND $4::bigint >= 0';
const labelSQL =
  'WITH raw AS MATERIALIZED (SELECT assignment_id, label_id, deleted_at IS NULL AS live FROM library.label_assignment WHERE route=$1 AND account_id=$2 AND subject_id=$3 AND slot_no IS NOT NULL AND assignment_id > $4::uuid ORDER BY assignment_id LIMIT $5) SELECT raw.assignment_id::text AS "factId", raw.live AND parent.deleted_at IS NULL AND parent.label_id IS NOT NULL AS present FROM raw LEFT JOIN library.personal_label parent ON parent.route=$1 AND parent.account_id=$2 AND parent.label_id=raw.label_id ORDER BY raw.assignment_id';
const pointSQL = (table: 'copy' | 'progress_session', key: 'copy_id' | 'session_id') =>
  `SELECT ${key}::text AS "factId" FROM library.${table} WHERE route=$1 AND account_id=$2 AND subject_id=$3${table === 'copy' ? ' AND deletion_id IS NULL' : ''} ORDER BY ${key} LIMIT 1`;
const copySQL = pointSQL('copy', 'copy_id'),
  sessionSQL = pointSQL('progress_session', 'session_id');
const normal = (sql: string) =>
  sql
    .replace(/--[^\n]*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
const costs = new Map<string, (values: readonly unknown[]) => Partial<WorkDimensions>>();
const register = (sql: string, cost: (values: readonly unknown[]) => Partial<WorkDimensions>) =>
  costs.set(normal(sql), cost);
const fixed = (rows: number, points: number, bytes: number) => () => ({
  nativeRows: rows,
  nativePoints: points,
  bytes,
});
// These bounds count plan-node row work, including materialization/sort/joins, rather than result.rowCount.
// Header/fence/reference/account/partition are exact native primary-key points with fixed-width projections.
for (const sql of [headerSQL, fenceSQL, referenceSQL, accountSQL]) register(sql, fixed(4, 1, 2048));
// The native identity JSON has a schema-enforced 4096-byte ceiling, plus its result framing.
register(scopeIdentitySQL, fixed(4, 1, 4608));
register(nativeCollectionPartitionMetadataSQL, fixed(4, 1, 128));
register(outputHead.sql, fixed(48, 7, 1024));
register(outputProbe.sql, () => ({
  nativeRows: 4,
  nativePoints: 1,
  candidateKeys: 1,
  witnessKeys: 1,
  bytes: 256,
}));
register(outputPage.sql, (v) => ({
  nativeRows: 4 * Number(v[4]) + 4,
  nativePoints: 1,
  candidateKeys: Number(v[4]),
  bytes: 256 * Number(v[4]),
}));
register(ordinalPage.sql, (v) => ({
  nativeRows: 4 * Number(v[4]) + 4,
  nativePoints: 1,
  candidateKeys: Number(v[4]),
  bytes: 512 * Number(v[4]),
}));
register(entrySQL, () => ({
  nativeRows: 4,
  nativePoints: 1,
  candidateKeys: 1,
  witnessKeys: 1,
  bytes: 256,
}));
register(pinSQL, (v) => ({
  nativeRows: 4,
  nativePoints: 1,
  candidateKeys: 1,
  witnessKeys: 1,
  bytes: Number(v[3]),
}));
for (const sql of [probeSQL, copySQL, sessionSQL])
  register(sql, () => ({
    nativeRows: 6,
    nativePoints: 1,
    witnessKeys: 1,
    candidateKeys: 1,
    bytes: 256,
  }));
for (const query of [membersQuery, factsQuery])
  register(query.sql, (values) => {
    const limit = Number(values[query.params.indexOf('limit')]);
    return {
      nativeRows: 8 * limit + 8,
      nativePoints: 1,
      candidateKeys: limit,
      bytes: 256 * limit,
    };
  });
register(labelSQL, (v) => ({
  nativeRows: 12 * Number(v[4]) + 8,
  nativePoints: 1 + Number(v[4]),
  candidateKeys: Number(v[4]),
  witnessKeys: Number(v[4]),
  bytes: 256 * Number(v[4]),
}));
register(permissionTime.sql, fixed(1, 0, 256));
register(opening.sql, fixed(8, 1, 256));
// The inverse owner admits <=1000 groups; the anchored view reads one account plus that native inverse range.
register(inverse.sql, fixed(4004, 1, 128128));
register(assignment.sql, fixed(8, 2, 512));
register(membership.sql, fixed(32, 5, 1024));
for (const query of [candidates, permissions])
  register(query.sql, (values) => {
    const params = Object.fromEntries(query.params.map((name, i) => [name, values[i]]));
    const roles =
      typeof params.roles === 'string'
        ? (JSON.parse(params.roles) as unknown[])
        : Array.isArray(params.roles)
          ? params.roles
          : [];
    const arrayLength = (value: unknown) =>
      Array.isArray(value)
        ? value.length
        : typeof value === 'string'
          ? (types.getTypeParser(1009 as Parameters<typeof types.getTypeParser>[0])(value) as unknown[]).length
          : 0;
    const grantRoles = arrayLength(params.grant_roles);
    const targets = arrayLength(params.resource_ids) + (params.include_global === true ? 1 : 0);
    const branches = params.include_explicit === true ? 2 : 1;
    // Two actor/principal identities and their active-account keys supplement the admitted group-role records.
    // Each target/key probes one exclusion-constrained grant, <=3 denial reasons and each installed role.
    const keys = roles.length + 4,
      points = targets * branches * keys * (grantRoles + 4) + 1;
    return {
      nativeRows: 32 * points + 64,
      nativePoints: points,
      bytes: 256 * keys,
    };
  });
export function nativeCollectionFootprint(sql: string, values: readonly unknown[], work?: NativeCollectionWork): WorkDimensions | undefined {
  if (work) revalidateBoundLibraryIdentityWork(work);
  // The existing shared native capture sends these two session SETs. They access no relation, but still cost
  // statements/bytes here; the capture deliberately omits its own setup from its measured statement list.
  const control =
    ['BEGIN', 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', 'COMMIT', 'ROLLBACK',
      'SET auto_explain.log_min_duration = 0', 'SET auto_explain.log_min_duration = -1'].includes(sql.trim());
  const range = [outputPage, ordinalPage, membersQuery, factsQuery].find((query) => normal(query.sql) === normal(sql));
  if (range) {
    const n = values[range === outputPage || range === ordinalPage ? 4 : range.params.indexOf('limit')];
    if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 1 || n > 100) return undefined;
  }
  const partitionBytes = work?.resultByteBound('partition:' + values[0]);
  const cost = control
    ? { nativeRows: 0, nativePoints: 0, bytes: 0 }
    : normal(sql) === normal(partitionRead.sql)
      ? partitionBytes === undefined
        ? undefined
        : { nativeRows: 4, nativePoints: 1, bytes: partitionBytes }
      : costs.get(normal(sql))?.(values);
  if (!cost) return undefined; // Includes unproved cold catalogue/schema checks and unknown owner ports.
  return {
    candidateKeys: 0,
    identityMetadataRows: 0,
    nativeRows: 0,
    nativePoints: 0,
    witnessKeys: 0,
    statements: 1,
    emptySeeks: control ? 0 : 1,
    ...cost,
    bytes: Buffer.byteLength(sql) + Buffer.byteLength(JSON.stringify(values)) + (cost.bytes ?? 0),
  };
}
async function call<T extends object>(
  pool: Pool,
  options: Options,
  operation: (work: NativeCollectionWork) => Promise<T>,
  sharedWork?: NativeCollectionWork,
) {
  const work = sharedWork ?? new NativeCollectionWork(options.allowance, options.deadline);
  if (sharedWork) assertLibraryIdentityResources(pool, work, options.deadline);
  if (options.tx && options.commandTx) throw new TypeError('Ambiguous native read transaction');
  if (options.tx || options.commandTx) {
    if (options.commandTx) {
      if (!hasLiveCommandTransaction(options.commandTx) || currentCommandResources(options.commandTx).pool !== pool)
        throw new ProblemError('semantic_not_ready');
      if (sharedWork && currentCommandResources(options.commandTx).deadline !== options.deadline)
        throw new TypeError('Library command changed its prepaid resources');
    } else if (!options.tx || !hasLiveOperationalTransaction(options.tx)) throw new ProblemError('semantic_not_ready');
    if (options.tx) {
      const resources = currentOperationalResources(options.tx);
      if (resources.pool !== pool || resources.mode !== 'work-step') throw new ProblemError('semantic_not_ready');
    }
    try {
      return { ...(await operation(work)), work: work.receipt() };
    } catch (error) {
      if (error instanceof Error)
        Object.defineProperty(error, 'work', { get: () => work.receipt(), configurable: true });
      throw error;
    }
  }
  return instrumentNativeCollectionWork(
    pool,
    work,
    (sql, values) => {
      if (sharedWork) assertLibraryIdentityWork(work);
      return nativeCollectionFootprint(sql, values, work);
    },
    async () => ({
      ...(await operation(work)),
      work: work.receipt(),
    }),
  );
}
async function readOnly<T>(
  pool: Pool,
  options: Options,
  work: NativeCollectionWork,
  operation: (client: QueryClient) => Promise<T>,
): Promise<T> {
  const { deadline } = options;
  const tx = options.commandTx ?? options.tx;
  if (tx) {
    // Core owns this transaction and its locks. No checkout, BEGIN, COMMIT or foreign read here.
    const client: QueryClient = {
      query: (async (config: string | QueryConfig, parameters: unknown[] = []) => {
        const sql = typeof config === 'string' ? config : config.text;
        const values = (typeof config === 'string' ? parameters : config.values) ?? [];
        if (
          options.commandTx
            ? !hasLiveCommandTransaction(options.commandTx)
            : !options.tx || !hasLiveOperationalTransaction(options.tx)
        )
          throw new ProblemError('semantic_not_ready');
        const bound = nativeCollectionFootprint(sql, values, work);
        const reservation = work.reserve(bound);
        reservation.dispatch();
        let result: QueryResult | undefined;
        try {
          const request = { text: sql, values, query_timeout: Math.max(1, deadline - Date.now()) };
          result = await reservation.query(() => tx.query(request));
          revalidateBoundLibraryIdentityWork(work);
          return result;
        } finally {
          reservation.settle({
            emptySeeks: !result || bound!.emptySeeks > 1 ? bound!.emptySeeks : result.rows.length === 0 ? bound!.emptySeeks : 0,
            candidateKeys: result ? Math.min(bound!.candidateKeys, result.rows.length) : bound!.candidateKeys,
            witnessKeys: result ? Math.min(bound!.witnessKeys, result.rows.length) : bound!.witnessKeys,
          });
        }
      }) as QueryClient['query'],
    };
    return operation(client);
  }
  return withConnection(pool, async (client) => {
    const begin = {
      text: 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
      query_timeout: Math.max(1, deadline - Date.now()),
    };
    await client.query(begin);
    try {
      const value = await operation(deadlineClient(client, deadline) as PoolClient);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (cleanup) {
        discardConnection(client, cleanup instanceof Error ? cleanup : new Error('Native rollback failed'));
      }
      throw error;
    }
  });
}

function validate(ref: Ref) {
  if (routeOf(ref.collectionId) !== ref.route) throw new TypeError('Invalid native Collection reference');
}
async function observe(
  client: QueryClient,
  ref: Ref,
  work: NativeCollectionWork,
): Promise<NativeCollectionMetadata | null> {
  validate(ref);
  const row = (
    await client.query<Header>(headerSQL, bind(headerQuery, { route: ref.route, collection_id: ref.collectionId }))
  ).rows[0];
  if (!row) {
    if ((await client.query(referenceSQL, [ref.route, ref.collectionId])).rows.length)
      throw new ProblemError('dependency_unavailable');
    return null;
  }
  const home = partitionOf(ref.route);
  const partition = (await client.query<{
    partitionNo: number; writeState: string; epoch: number; position: string;
  }>(nativeCollectionPartitionMetadataSQL, [home])).rows[0];
  if (!partition || partition.writeState === 'moved') throw new ProblemError('partition_unavailable');
  const outputPublication =
    row.membershipKind === 'dynamic' && row.visibility !== 'private' && row.state === 'active'
      ? ((
          await client.query<CollectionOutputPublication>(outputHead.sql, [
            ref.route,
            ref.collectionId,
            row.sourceGeneration,
          ])
        ).rows[0] ?? null)
      : null;
  const outputGeneration = outputPublication?.generation ?? null;
  const authority =
    row.membershipKind === 'curated'
      ? 'curated'
      : row.visibility === 'private'
        ? 'private_builtin'
        : outputGeneration
          ? 'activated_output'
          : 'unavailable_output';
  const factFence =
    authority === 'private_builtin'
      ? ((await client.query<{ generation: string }>(fenceSQL, [ref.route, row.curatorAccountId])).rows[0]
          ?.generation ?? null)
      : null;
  return Object.freeze({
    ...row,
    incarnation: `${row.collectionId}:${row.createdAt}`,
    authority,
    outputGeneration,
    outputPublication,
    factFence,
    stamp: {
      partition: partition.partitionNo,
      epoch: partition.epoch,
      position: BigInt(partition.position),
    },
  });
}
/** Structural producer read only. Maintenance/custody do not obtain reader authority from this result. */
async function observeWorking(client: QueryClient, ref: Ref, work: NativeCollectionWork) {
  const metadata = await observe(client, ref, work);
  if (!metadata || metadata.membershipKind !== 'dynamic' || metadata.visibility === 'private') return metadata;
  if (
    !metadata.curatorAccountId ||
    !(metadata.ruleReady || (metadata.builtinKind !== null && metadata.releaseDigest !== null))
  )
    return null;
  const factFence =
    (await client.query<{ generation: string }>(fenceSQL, [ref.route, metadata.curatorAccountId])).rows[0]
      ?.generation ?? null;
  const working: NativeCollectionMetadata = Object.freeze({
    ...metadata,
    authority: 'private_builtin',
    factFence,
    outputGeneration: null,
    outputPublication: null,
  });
  workingMetadata.add(working);
  return working;
}

export function readNativeCollectionWorkingMetadata(pool: Pool, ref: Ref, options: Options) {
  return call(pool, options, async (work) => ({
    metadata: await readOnly(pool, options, work, (client) => observeWorking(client, ref, work)),
  }));
}

/** Public-only observation on the caller's already metered snapshot/client. */
export async function observeNativePublicCollectionOutput(
  client: QueryClient,
  ref: Ref,
  work: NativeCollectionWork,
): Promise<NativeCollectionMetadata | null> {
  const metadata = await observe(client, ref, work);
  return metadata?.state === 'active' &&
    metadata.membershipKind === 'dynamic' &&
    metadata.visibility !== 'private' &&
    metadata.authority === 'activated_output'
    ? metadata
    : null;
}

export function readNativeCollectionMetadata(pool: Pool, ref: Ref, options: Options) {
  return metadataCall(pool, ref, options);
}
export function readNativeCollectionMetadataWithWork(
  pool: Pool, ref: Ref, options: Options, work: NativeCollectionWork,
) {
  return withLibraryIdentityWork(pool, work, () => metadataCall(pool, ref, options, work));
}
function metadataCall(pool: Pool, ref: Ref, options: Options, sharedWork?: NativeCollectionWork) {
  const owner = admittedOwnerWorkingSource(pool, ref.collectionId);
  return call(pool, options, async (work) => ({
    metadata: await readOnly(pool, options, work, async (client) => {
      const metadata = await (owner ? observeWorking(client, ref, work) : observe(client, ref, work));
      if (
        owner &&
        metadata?.membershipKind === 'dynamic' &&
        (owner.actor.kind !== 'account' || metadata.curatorAccountId !== owner.actor.accountId)
      )
        throw new ProblemError('not_found');
      return metadata;
    }),
  }), sharedWork);
}
/** Raw source discovery stays separate from Source.prepare and never executes the built-in query recursively. */
export function readNativeCollectionScopeIdentity(pool: Pool, input: Ref & Options) {
  return call(pool, input, async (work) => ({
    identity: await readOnly(pool, input, work, async (client) => {
      const metadata = await observe(client, input, work);
      if (!metadata || metadata.state !== 'active') return null;
      return (
        (
          await client.query<{ identity: NativeSourceIdentity }>(scopeIdentitySQL, [
            input.route,
            input.collectionId,
            nativeSourceFence(metadata),
          ])
        ).rows[0]?.identity ?? null
      );
    }),
  }));
}
export function authorizeNativeCollectionMetadata(
  pool: Pool,
  metadata: NativeCollectionMetadata,
  context: Options & { access: Access; actor: Actor; at: AuthoritativeTime },
) {
  if (context.tx) throw new ProblemError('semantic_not_ready');
  authoritativeTimeValue(context.at);
  const owner = workingMetadata.has(metadata) ? admittedOwnerWorkingSource(pool, metadata.collectionId) : undefined;
  if (workingMetadata.has(metadata) && (!owner || owner.actor !== context.actor || owner.at !== context.at))
    throw new ProblemError('not_found');
  return call(pool, context, async (work) => {
    const access = accessRoot(context.access);
    try {
      await admitGroup({
        pool,
        access: () => access,
        actor: context.actor,
        group: 'collections',
        clientAction: 'collection:read',
        deadline: context.deadline,
        clock: () => new Date(authoritativeTimeValue(context.at)),
      });
    } catch (error) {
      if (error instanceof PlatformClosedError) return { authorized: false };
      throw error;
    }
    let current: NativeCollectionMetadata | null = null,
      failure: unknown;
    const eligibility = createResourcePublicEligibility({
      resource: { route: metadata.route, id: metadata.collectionId },
      action: 'collection:read',
      async prepare() {
        return { route: metadata.route, collectionId: metadata.collectionId };
      },
      async verify({ client }) {
        try {
          current = await observe(client as PoolClient, metadata, work);
          // A public read floor authorizes the selected output, never the curator's working facts.
          return !owner && current?.state === 'active' && current.visibility !== 'private';
        } catch (error) {
          failure = error;
          throw error;
        }
      },
    });
    const check = await accessCheck(
      access,
      context.actor,
      'collection:read',
      { route: metadata.route, id: metadata.collectionId, eligibility },
      { pool, deadline: context.deadline },
    );
    return readOnly(pool, context, work, async (client) => {
      const allowed = await check(client, context.at);
      if (failure) throw failure;
      current ??= await observe(client, metadata, work);
      if (!allowed || !current || current.state !== 'active' || current.incarnation !== metadata.incarnation)
        return { authorized: false };
      if (current.visibility !== 'private' && !owner) return { authorized: true };
      const actor = context.actor;
      if (
        actor.kind !== 'account' ||
        routeOf(actor.accountId) === null ||
        (current.membershipKind === 'dynamic' && actor.accountId !== current.curatorAccountId)
      )
        return { authorized: false };
      const account = (
        await client.query<{
          route: number;
          accountId: string;
          kind: 'actor' | 'organization';
          state: 'active';
          fenced: boolean;
          minimumAuthnEpoch: string;
        }>(accountSQL, [routeOf(actor.accountId), actor.accountId])
      ).rows[0];
      return {
        authorized:
          account !== undefined &&
          grantCapable(
            {
              ...account,
              minimumAuthnEpoch: BigInt(account.minimumAuthnEpoch),
            },
            actor,
          ),
      };
    });
  });
}
async function currentSource(client: QueryClient, metadata: NativeCollectionMetadata, work: NativeCollectionWork) {
  const current = await (workingMetadata.has(metadata)
    ? observeWorking(client, metadata, work)
    : observe(client, metadata, work));
  if (!current || current.state !== 'active') throw new ProblemError('not_found');
  if (
    current.incarnation !== metadata.incarnation ||
    current.curatorAccountId !== metadata.curatorAccountId ||
    current.sourceGeneration !== metadata.sourceGeneration ||
    current.ruleRevision !== metadata.ruleRevision ||
    current.ruleReleaseDigest !== metadata.ruleReleaseDigest ||
    current.factFence !== metadata.factFence ||
    current.authority !== metadata.authority ||
    current.outputGeneration !== metadata.outputGeneration
  )
    throw new ProblemError('stale_cursor');
  if (current.authority === 'unavailable_output' || (current.authority === 'private_builtin' && !current.factFence))
    throw new ProblemError('dependency_unavailable');
  return current;
}
function keyInput(key: CanonicalRangeKey | null | undefined, driver?: CanonicalRangeKey['driver']) {
  if (
    key &&
    (routeOf(key.storedSubjectId) === null ||
      routeOf(key.factId) === null ||
      !['member', 'entry', 'copy', 'session', 'label', 'output'].includes(key.driver) ||
      ((key.driver === 'entry' || key.driver === 'output') && key.factId !== key.storedSubjectId) ||
      (driver && key.driver !== driver))
  )
    throw new ProblemError('invalid_cursor');
}
/** Internal raw data only: deletion episodes advance the same native ordinal frontier as live occurrences. */
export function readNativeCollectionRawOrdinalPage(
  pool: Pool,
  metadata: NativeCollectionMetadata,
  input: Options & { after: NativeOrdinalKey | null; limit: number },
) {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100)
    throw new RangeError('Native source limit must be 1..100');
  if (input.after && (routeOf(input.after.memberId) === null || !/^[\x21-\x7e]{1,48}$/.test(input.after.ordinalKey)))
    throw new ProblemError('invalid_cursor');
  return call(pool, input, async (work) =>
    readOnly(pool, input, work, async (client) => {
      const current = await currentSource(client, metadata, work);
      if (current.authority !== 'curated') throw new ProblemError('dependency_unavailable');
      const raw = (
        await client.query<Omit<NativeOrdinalRow, 'memberRevision'> & { memberRevision: string }>(ordinalPage.sql, [
          current.route,
          current.collectionId,
          input.after?.ordinalKey ?? '',
          input.after?.memberId ?? '00000000-0000-0000-0000-000000000000',
          input.limit,
        ])
      ).rows;
      const rows: NativeOrdinalRow[] = raw.map((row) => {
        const memberRevision = Number(row.memberRevision);
        if (!Number.isSafeInteger(memberRevision) || memberRevision < 1)
          throw new ProblemError('dependency_unavailable');
        return { ...row, memberRevision };
      });
      const last = rows.at(-1);
      return {
        rows,
        frontier: {
          after: last ? { ordinalKey: last.ordinalKey, memberId: last.memberId } : input.after,
        },
        exhausted: rows.length < input.limit,
      };
    }),
  );
}
type RawPageInput = Options & { driver: CanonicalRangeKey['driver']; after: CanonicalRangeKey | null; limit: number };
export function readNativeCollectionRawPage(pool: Pool, metadata: NativeCollectionMetadata, input: RawPageInput) {
  return rawPageCall(pool, metadata, input);
}
export function readNativeCollectionRawPageWithWork(
  pool: Pool, metadata: NativeCollectionMetadata, input: RawPageInput, work: NativeCollectionWork,
) {
  return withLibraryIdentityWork(pool, work, () => rawPageCall(pool, metadata, input, work));
}
function rawPageCall(
  pool: Pool,
  metadata: NativeCollectionMetadata,
  input: Options & {
    driver: CanonicalRangeKey['driver'];
    after: CanonicalRangeKey | null;
    limit: number;
  },
  sharedWork?: NativeCollectionWork,
) {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100)
    throw new RangeError('Native source limit must be 1..100');
  if (!['member', 'entry', 'copy', 'session', 'label', 'output'].includes(input.driver))
    throw new TypeError('Invalid native source driver');
  keyInput(input.after, input.driver);
  return call(pool, input, async (work) =>
    readOnly(pool, input, work, async (client) => {
      const current = await currentSource(client, metadata, work);
      if (
        (current.authority === 'curated' && input.driver !== 'member') ||
        (current.authority === 'activated_output' && input.driver !== 'output') ||
        (current.authority === 'private_builtin' && (input.driver === 'member' || input.driver === 'output')) ||
        (current.authority === 'private_builtin' && current.builtinKind === 'state' && input.driver !== 'entry')
      )
        throw new ProblemError('dependency_unavailable');
      if (input.driver === 'output') {
        const rows = (
          await client.query<{ storedSubjectId: string; factId: string }>(outputPage.sql, [
            current.route,
            current.collectionId,
            current.outputGeneration,
            input.after?.storedSubjectId ?? '00000000-0000-0000-0000-000000000000',
            input.limit,
          ])
        ).rows.map((row) => ({ key: { driver: 'output' as const, ...row } }));
        return {
          rows,
          after: rows.at(-1)?.key ?? input.after,
          exhausted: rows.length < input.limit,
        };
      }
      const query = input.driver === 'member' ? membersQuery : factsQuery;
      const rows = (
        await client.query<{ storedSubjectId: string; factId: string }>(
          query.sql,
          bind(query, {
            route: current.route,
            collection_id: current.collectionId,
            account_id: current.curatorAccountId,
            after_subject: input.after?.storedSubjectId ?? null,
            after_fact: input.after?.factId ?? null,
            limit: input.limit,
            driver: input.driver,
          }),
        )
      ).rows.map((row) => ({ key: { driver: input.driver, ...row } }));
      return {
        rows,
        after: rows.at(-1)?.key ?? input.after,
        exhausted: rows.length < input.limit,
      };
    }),
    sharedWork,
  );
}
/** Current original-source fact only. This result never authorizes original/terminal Subjects or disclosure. */
export async function probeNativeCollectionOriginal(
  pool: Pool,
  metadata: NativeCollectionMetadata,
  input: Options & {
    originalId: string;
    keyHint?: CanonicalRangeKey;
    after?: CanonicalRangeKey | null;
  },
): Promise<NativeCollectionProbe> {
  if (routeOf(input.originalId) === null) throw new TypeError('Invalid original subject');
  keyInput(input.keyHint);
  keyInput(input.after);
  if ([input.after, input.keyHint].some((key) => key && key.storedSubjectId !== input.originalId))
    throw new ProblemError('invalid_cursor');
  if (
    input.after &&
    (input.after.driver !== 'label' || metadata.authority !== 'private_builtin' || metadata.builtinKind === 'state')
  )
    throw new ProblemError('invalid_cursor');
  let progress = input.after ?? null;
  try {
    return await call(pool, input, async (work) =>
      readOnly(pool, input, work, async (client) => {
        const current = await currentSource(client, metadata, work);
        const done = (result: NativeCollectionProbe['result'], key: CanonicalRangeKey | null = null): ProbeEvidence => {
          if (result === 'present') {
            if (!key) throw new TypeError('Missing native source witness key');
            return {
              result,
              key,
              progress: null,
              witness: {
                incarnation: current.incarnation,
                sourceGeneration: current.sourceGeneration,
                factFence: current.factFence,
              },
            };
          }
          return result === 'absent'
            ? { result, key: null, progress: null, witness: null }
            : { result, key: null, progress, witness: null };
        };
        if (current.authority === 'activated_output') {
          const row = (
            await client.query<{ storedSubjectId: string; factId: string }>(outputProbe.sql, [
              current.route,
              current.collectionId,
              current.outputGeneration,
              input.originalId,
            ])
          ).rows[0];
          return row ? done('present', { driver: 'output', ...row }) : done('absent');
        }
        if (current.authority === 'curated') {
          const row = (
            await client.query<{ storedSubjectId: string; factId: string }>(
              probeSQL,
              bind(probeQuery, {
                route: current.route,
                collection_id: current.collectionId,
                subject_id: input.originalId,
              }),
            )
          ).rows[0];
          return row ? done('present', { driver: 'member', ...row }) : done('absent');
        }
        const params = [current.route, current.curatorAccountId, input.originalId];
        if (!progress) {
          const row = (
            await client.query<{
              present: boolean;
              matches: boolean | null;
              bytes: number | null;
              compressed: boolean;
            }>(entrySQL, [...params, current.stateId])
          ).rows[0];
          if (row?.present && current.builtinKind !== 'state')
            return done('present', {
              driver: 'entry',
              storedSubjectId: input.originalId,
              factId: input.originalId,
            });
          if (row?.matches && current.builtinKind === 'state') {
            // A compressed datum's wire expansion has no small bound. Admit the native maximum, rather than cap type IDs.
            const bytes = 6 * (row.compressed ? 1024 * 1024 * 1024 : (row.bytes ?? 0)) + 256;
            {
              const pin = (
                await client.query<{
                  library_profile_pin: {
                    provenance?: string;
                    releaseDigest?: string;
                    profileId?: string;
                  } | null;
                }>(pinSQL, [...params, bytes])
              ).rows[0]?.library_profile_pin;
              if (
                !pin ||
                pin.provenance !== 'profile' ||
                pin.releaseDigest !== current.releaseDigest ||
                pin.profileId !== current.profileId
              )
                return done('not_proven');
              return done('present', {
                driver: 'entry',
                storedSubjectId: input.originalId,
                factId: input.originalId,
              });
            }
          }
          if (current.builtinKind === 'state') return done('absent');
        }
        // Hints never select an incomplete negative path; an old witness miss still checks all current drivers.
        if (!progress || progress.driver !== 'label') {
          for (const [driver, sql] of [
            ['copy', copySQL],
            ['session', sessionSQL],
          ] as const) {
            const row = (await client.query<{ factId: string }>(sql, params)).rows[0];
            if (row)
              return done('present', {
                driver,
                storedSubjectId: input.originalId,
                factId: row.factId,
              });
          }
        }
        const limit = Math.min(
          32,
          work.available('candidateKeys'),
          work.available('witnessKeys'),
          work.available('nativePoints') - 1,
          Math.floor((work.available('nativeRows') - 8) / 12),
          Math.floor(work.available('bytes') / 256),
        );
        if (limit < 1) return done('not_proven');
        const rows = (
          await client.query<{ factId: string; present: boolean }>(labelSQL, [
            ...params,
            progress?.driver === 'label' ? progress.factId : '00000000-0000-0000-0000-000000000000',
            limit,
          ])
        ).rows;
        for (const row of rows) {
          progress = {
            driver: 'label',
            storedSubjectId: input.originalId,
            factId: row.factId,
          };
          if (row.present) return done('present', progress);
        }
        // There are at most 32 reserved labels per subject; a full page is a complete materialized reservation set.
        return done(rows.length === limit && limit < 32 ? 'not_proven' : 'absent');
      }),
    );
  } catch (error) {
    const receipt = error instanceof Error && 'work' in error ? (error as Error & { work: WorkReceipt }).work : null;
    if (error instanceof ProblemError && error.code === 'dependency_unavailable' && receipt)
      return {
        result: 'not_proven',
        key: null,
        progress,
        witness: null,
        work: receipt,
      };
    throw error;
  }
}
