import { readFileSync } from 'node:fs';
import { types, type Pool, type PoolClient } from 'pg';
import { deadlineClient } from '../access/authenticate.ts';
import { accessRoot } from '../access/derived-access.ts';
import { createResourcePublicEligibility } from '../access/public-eligibility.ts';
import { admitGroup, PlatformClosedError } from '../access/gates/admission.ts';
import { authoritativeTimeValue, type AuthoritativeTime } from '../command/command.ts';
import { discardConnection, withConnection } from '../database/pool.ts';
import { ProblemError } from '../http/problem.ts';
import { readPartition } from '../partition/partition.ts';
import { accessCheck, type Access, type Actor } from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import type { CanonicalRawKey } from './canonical-source-store.ts';
import type { WorkAllowance, WorkDimensions, WorkReceipt } from './collection-source.ts';
import { grantCapable } from './collection-reads.ts';
import { instrumentNativeCollectionWork, NativeCollectionWork } from './collection-source-work.ts';
import type { ListingStamp } from './listing-freshness-contract.ts';
import partitionRead from '../partition/read.sql';
import permissionTime from '../access/permission-time.sql';
import inverse from '../access/permission-inverse.sql';
import candidates from '../access/permission-candidates.sql';
import permissions from '../access/permission-check.sql';
import assignment from '../access/permission-assignment.sql';
import membership from '../access/permission-membership.sql';
import opening from '../access/gates/opening-read.sql';

/** Structural alias of the existing raw owner key; no canonical-order or Access claim. */
export type CanonicalRangeKey = CanonicalRawKey;
type Options = { deadline: number; allowance: WorkAllowance };
type Ref = { route: number; collectionId: string };
type Header = Ref & {
  curatorAccountId: string;
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
};
/** Private observation only. Possession grants no source or subject access. */
export type NativeCollectionMetadata = Readonly<
  Header & {
    incarnation: string;
    stamp: ListingStamp;
    factFence: string | null;
    authority: 'curated' | 'private_builtin' | 'unavailable_output';
  }
>;
export type NativeCollectionProbe = {
  result: 'present' | 'absent' | 'not_proven';
  key: CanonicalRangeKey | null;
  progress: CanonicalRangeKey | null;
  witness: { incarnation: string; sourceGeneration: string; factFence: string | null } | null;
  work: WorkReceipt;
};
const sqlFile = (name: string) => readFileSync(new URL(name, import.meta.url), 'utf8');
const headerSQL = sqlFile('./collection-source-native-header.sql');
const membersSQL = sqlFile('./collection-source-native-members.sql');
const factsSQL = sqlFile('./collection-source-native-facts.sql');
const probeSQL = sqlFile('./collection-source-native-probe.sql');
const fenceSQL = 'SELECT generation::text AS generation FROM library.fact_source_head WHERE route=$1 AND account_id=$2';
const referenceSQL =
  'SELECT collection_id FROM library.builtin_collection_reference WHERE route=$1 AND collection_id=$2';
const accountSQL =
  'SELECT route, account_id AS "accountId", kind, state, authn_fenced AS fenced, minimum_authn_epoch::text AS "minimumAuthnEpoch" FROM access.account WHERE route=$1 AND account_id=$2';
const entrySQL =
  'SELECT state IS NOT NULL AS present, state=$4 AS matches, pg_column_size(library_profile_pin) AS bytes, pg_column_compression(library_profile_pin) IS NOT NULL AS compressed FROM library.entry WHERE route=$1 AND account_id=$2 AND subject_id=$3';
const pinSQL =
  'SELECT library_profile_pin FROM library.entry WHERE route=$1 AND account_id=$2 AND subject_id=$3 AND $4::bigint >= 0';
const labelSQL =
  'WITH raw AS MATERIALIZED (SELECT assignment_id, label_id FROM library.label_assignment WHERE route=$1 AND account_id=$2 AND subject_id=$3 AND slot_no IS NOT NULL AND assignment_id > $4::uuid ORDER BY assignment_id LIMIT $5) SELECT raw.assignment_id::text AS "factId", parent.deleted_at IS NULL AND parent.label_id IS NOT NULL AS present FROM raw LEFT JOIN library.personal_label parent ON parent.route=$1 AND parent.account_id=$2 AND parent.label_id=raw.label_id ORDER BY raw.assignment_id';
const pointSQL = (table: 'copy' | 'progress_session', key: 'copy_id' | 'session_id') =>
  `SELECT ${key}::text AS "factId" FROM library.${table} WHERE route=$1 AND account_id=$2 AND subject_id=$3 ORDER BY ${key} LIMIT 1`;
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
for (const sql of [headerSQL, fenceSQL, referenceSQL, accountSQL, partitionRead.sql]) register(sql, fixed(4, 1, 2048));
register(entrySQL, () => ({ nativeRows: 4, nativePoints: 1, candidateKeys: 1, witnessKeys: 1, bytes: 256 }));
register(pinSQL, (v) => ({ nativeRows: 4, nativePoints: 1, candidateKeys: 1, witnessKeys: 1, bytes: Number(v[3]) }));
for (const sql of [probeSQL, copySQL, sessionSQL])
  register(sql, () => ({ nativeRows: 6, nativePoints: 1, witnessKeys: 1, candidateKeys: 1, bytes: 256 }));
for (const sql of [membersSQL, factsSQL])
  register(sql, (v) => ({
    nativeRows: 8 * Number(v[4]) + 8,
    nativePoints: 1,
    candidateKeys: Number(v[4]),
    bytes: 256 * Number(v[4]),
  }));
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
          ? (types.getTypeParser(1009)(value) as unknown[]).length
          : 0;
    const grantRoles = arrayLength(params.grant_roles);
    const targets = arrayLength(params.resource_ids) + (params.include_global === true ? 1 : 0);
    const branches = params.include_explicit === true ? 2 : 1;
    // Two actor/principal identities and their active-account keys supplement the admitted group-role records.
    // Each target/key probes one exclusion-constrained grant, <=3 denial reasons and each installed role.
    const keys = roles.length + 4,
      points = targets * branches * keys * (grantRoles + 4) + 1;
    return { nativeRows: 32 * points + 64, nativePoints: points, bytes: 256 * keys };
  });
function footprint(sql: string, values: readonly unknown[]): WorkDimensions | undefined {
  const control = /^(?:BEGIN|COMMIT|ROLLBACK)\b/i.test(sql);
  const cost = control ? { nativeRows: 0, nativePoints: 0, bytes: 0 } : costs.get(normal(sql))?.(values);
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
) {
  const work = new NativeCollectionWork(options.allowance, options.deadline);
  return instrumentNativeCollectionWork(pool, work, footprint, async () => ({
    ...(await operation(work)),
    work: work.receipt(),
  }));
}
async function readOnly<T>(pool: Pool, deadline: number, operation: (client: PoolClient) => Promise<T>): Promise<T> {
  return withConnection(pool, async (client) => {
    await client.query({
      text: 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
      query_timeout: Math.max(1, deadline - Date.now()),
    });
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
async function observe(client: PoolClient, ref: Ref): Promise<NativeCollectionMetadata | null> {
  validate(ref);
  const row = (await client.query<Header>(headerSQL, [ref.route, ref.collectionId])).rows[0];
  if (!row) {
    if ((await client.query(referenceSQL, [ref.route, ref.collectionId])).rows.length)
      throw new ProblemError('dependency_unavailable');
    return null;
  }
  const partition = await readPartition(client, partitionOf(ref.route));
  if (!partition || partition.writeState === 'moved') throw new ProblemError('partition_unavailable');
  const authority =
    row.membershipKind === 'curated'
      ? 'curated'
      : row.visibility === 'private'
        ? 'private_builtin'
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
    factFence,
    stamp: { partition: partition.partitionNo, epoch: partition.epoch, position: partition.position },
  });
}
export function readNativeCollectionMetadata(pool: Pool, ref: Ref, options: Options) {
  return call(pool, options, async () => ({
    metadata: await readOnly(pool, options.deadline, (client) => observe(client, ref)),
  }));
}
export function authorizeNativeCollectionMetadata(
  pool: Pool,
  metadata: NativeCollectionMetadata,
  context: Options & { access: Access; actor: Actor; at: AuthoritativeTime },
) {
  authoritativeTimeValue(context.at);
  return call(pool, context, async () => {
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
        return null;
      },
      async verify({ client }) {
        try {
          current = await observe(client as PoolClient, metadata);
          return current?.state === 'active' && current.visibility !== 'private';
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
    return readOnly(pool, context.deadline, async (client) => {
      const allowed = await check(client, context.at);
      if (failure) throw failure;
      current ??= await observe(client, metadata);
      if (!allowed || !current || current.state !== 'active' || current.incarnation !== metadata.incarnation)
        return { authorized: false };
      if (current.visibility !== 'private') return { authorized: true };
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
          grantCapable({ ...account, minimumAuthnEpoch: BigInt(account.minimumAuthnEpoch) }, actor),
      };
    });
  });
}
async function currentSource(client: PoolClient, metadata: NativeCollectionMetadata) {
  const current = await observe(client, metadata);
  if (!current || current.state !== 'active') throw new ProblemError('not_found');
  if (
    current.incarnation !== metadata.incarnation ||
    current.sourceGeneration !== metadata.sourceGeneration ||
    current.factFence !== metadata.factFence ||
    current.authority !== metadata.authority
  )
    throw new ProblemError('stale_cursor');
  if (
    current.authority === 'unavailable_output' ||
    (current.authority === 'private_builtin' && (!current.factFence || !current.builtinKind))
  )
    throw new ProblemError('dependency_unavailable');
  return current;
}
function keyInput(key: CanonicalRangeKey | null | undefined, driver?: CanonicalRangeKey['driver']) {
  if (
    key &&
    (routeOf(key.storedSubjectId) === null ||
      routeOf(key.factId) === null ||
      !['member', 'entry', 'copy', 'session', 'label', 'output'].includes(key.driver) ||
      (key.driver === 'entry' && key.factId !== key.storedSubjectId) ||
      (driver && key.driver !== driver))
  )
    throw new ProblemError('invalid_cursor');
}
export function readNativeCollectionRawPage(
  pool: Pool,
  metadata: NativeCollectionMetadata,
  input: Options & { driver: CanonicalRangeKey['driver']; after: CanonicalRangeKey | null; limit: number },
) {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100)
    throw new RangeError('Native source limit must be 1..100');
  keyInput(input.after, input.driver);
  return call(pool, input, async () =>
    readOnly(pool, input.deadline, async (client) => {
      const current = await currentSource(client, metadata);
      if ((current.authority === 'curated') !== (input.driver === 'member') || input.driver === 'output')
        throw new ProblemError('dependency_unavailable');
      const rows = (
        await client.query<{ storedSubjectId: string; factId: string }>(
          input.driver === 'member' ? membersSQL : factsSQL,
          [
            current.route,
            input.driver === 'member' ? current.collectionId : current.curatorAccountId,
            input.after?.storedSubjectId ?? null,
            input.after?.factId ?? null,
            input.limit,
            ...(input.driver === 'member' ? [] : [input.driver]),
          ],
        )
      ).rows.map((row) => ({ key: { driver: input.driver, ...row } }));
      return { rows, after: rows.at(-1)?.key ?? input.after, exhausted: rows.length < input.limit };
    }),
  );
}
/** Current original-source fact only. This result never authorizes original/terminal Subjects or disclosure. */
export async function probeNativeCollectionOriginal(
  pool: Pool,
  metadata: NativeCollectionMetadata,
  input: Options & { originalId: string; keyHint?: CanonicalRangeKey; after?: CanonicalRangeKey | null },
): Promise<NativeCollectionProbe> {
  if (routeOf(input.originalId) === null) throw new TypeError('Invalid original subject');
  keyInput(input.keyHint);
  keyInput(input.after);
  if ([input.after, input.keyHint].some((key) => key && key.storedSubjectId !== input.originalId))
    throw new ProblemError('invalid_cursor');
  if (
    input.after &&
    (input.after.driver !== 'label' ||
      metadata.authority !== 'private_builtin' ||
      metadata.builtinKind !== 'everything')
  )
    throw new ProblemError('invalid_cursor');
  let progress = input.after ?? null;
  try {
    return await call(pool, input, async (work) =>
      readOnly(pool, input.deadline, async (client) => {
        const current = await currentSource(client, metadata);
        const done = (result: NativeCollectionProbe['result'], key: CanonicalRangeKey | null = null) => ({
          result,
          key,
          progress: result === 'not_proven' ? progress : null,
          witness:
            result === 'present'
              ? {
                  incarnation: current.incarnation,
                  sourceGeneration: current.sourceGeneration,
                  factFence: current.factFence,
                }
              : null,
        });
        if (current.authority === 'curated') {
          const row = (
            await client.query<{ storedSubjectId: string; factId: string }>(probeSQL, [
              current.route,
              current.collectionId,
              input.originalId,
            ])
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
          if (row?.present && current.builtinKind === 'everything')
            return done('present', { driver: 'entry', storedSubjectId: input.originalId, factId: input.originalId });
          if (row?.matches && current.builtinKind === 'state') {
            // A compressed datum's wire expansion has no small bound. Admit the native maximum, rather than cap type IDs.
            const bytes = row.compressed ? 1024 * 1024 * 1024 : 6 * (row.bytes ?? 0) + 256;
            {
              const pin = (
                await client.query<{ library_profile_pin: { releaseDigest?: string; profileId?: string } | null }>(
                  pinSQL,
                  [...params, bytes],
                )
              ).rows[0]?.library_profile_pin;
              if (!pin || pin.releaseDigest !== current.releaseDigest || pin.profileId !== current.profileId)
                return done('not_proven');
              return done('present', { driver: 'entry', storedSubjectId: input.originalId, factId: input.originalId });
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
            if (row) return done('present', { driver, storedSubjectId: input.originalId, factId: row.factId });
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
          progress = { driver: 'label', storedSubjectId: input.originalId, factId: row.factId };
          if (row.present) return done('present', progress);
        }
        // There are at most 32 reserved labels per subject; a full page is a complete materialized reservation set.
        return done(rows.length === limit && limit < 32 ? 'not_proven' : 'absent');
      }),
    );
  } catch (error) {
    const receipt = error instanceof Error && 'work' in error ? (error as Error & { work: WorkReceipt }).work : null;
    if (error instanceof ProblemError && error.code === 'dependency_unavailable' && receipt)
      return { result: 'not_proven', key: null, progress, witness: null, work: receipt };
    throw error;
  }
}
