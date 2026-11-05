import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Pool, PoolClient } from 'pg';
import type { AccountKind } from './account-data.ts';
import { classifyUnavailability, CommandUnavailableError, requireAccessDeadline } from './unavailable.ts';
import { readAvatarSummaries, type AvatarSummary } from '../content/avatar.ts';
import { readPartitions } from '../partition/partition.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { withReadTransaction } from '../semantic/read.ts';
import { DEFAULT_REQUEST_DEADLINE_MS } from '../command/command.ts';
import { deadlineFor, withRequestDeadline } from '../request/deadline.ts';
import {
  readAccountDiscoveryReductionBinding,
  type AccountDiscoveryReductionHead,
} from './account-discovery-reduction.ts';
import type { AccountDiscoverySource, AccountDiscoverySummary } from '../search/index.ts';
import { readSubjectSummaries, type SubjectSummary, type SummaryReaderDependencies } from '../semantic/summaries.ts';
import { accountBiography, ACCOUNT_CONTEXT_LIMITS, type AccountContext } from '../search/account-context.ts';
import { readAccountContextBindings } from '../search/account-context-native.ts';

type AccountRow = {
  route: number;
  id: string;
  accountKind: AccountKind;
  handle: string | null;
  displayName: string | null;
  revision: string;
  operatorId: string | null;
  avatar: string | null;
  agent: string | null;
  agentReceipt: string | null;
  biography?: string | null;
};
type ClaimRow = { route: number; handle: string; id: string; revision: string };
const columns = `route, account_id::text AS id, kind AS "accountKind", handle,
  display_name AS "displayName", discovery_revision::text AS revision,
  operator_account_id::text AS "operatorId", avatar::text,
  CASE WHEN agent_verified THEN agent_subject_id::text END AS agent,
  CASE WHEN agent_verified THEN agent_verification_receipt_id::text END AS "agentReceipt"`;

function partitionKey(partition: number): void {
  if (!Number.isInteger(partition) || partition < 0 || partition > 4095)
    throw new RangeError('Account discovery partition must be an integer from 0 to 4095');
}
function keys(ids: readonly string[], partition?: number) {
  if (ids.length > 100) throw new RangeError('Account discovery accepts at most 100 ids');
  const result = [...new Set(ids)].map((id) => {
    const route = routeOf(id);
    if (route === null || (partition !== undefined && partitionOf(route) !== partition))
      throw new TypeError('Account discovery requires full routable keys in the requested partition');
    return { route, id };
  });
  if (result.length > 100) throw new RangeError('Account discovery accepts at most 100 distinct ids');
  return result;
}
function claimRoute(handle: string): number {
  return createHash('sha256').update(handle, 'utf8').digest().readUInt16BE(0);
}
async function requireHomes(client: Pick<PoolClient, 'query'>, routes: readonly number[]) {
  const homes = [...new Set(routes.map(partitionOf))];
  const owners = new Map((await readPartitions(client, homes)).map((owner) => [owner.partitionNo, owner]));
  for (const home of homes) {
    const owner = owners.get(home);
    if (!owner) throw new CommandUnavailableError('contention', home);
    if (owner.writeState !== 'active')
      throw new CommandUnavailableError(owner.writeState === 'moved' ? 'moved' : 'fenced', home, owner.movedTo);
  }
}
async function accounts(client: Pick<PoolClient, 'query'>, requested: ReturnType<typeof keys>, context = false) {
  if (!requested.length) return [];
  await requireHomes(
    client,
    requested.map(({ route }) => route),
  );
  return (
    await client.query<AccountRow>(
      `SELECT ${columns}${context ? ', left(biography, 1025) AS biography' : ''} FROM access.account
     WHERE (route, account_id) IN (SELECT * FROM unnest($1::integer[], $2::uuid[]))
       AND state = 'active' AND NOT authn_fenced`,
      [requested.map(({ route }) => route), requested.map(({ id }) => id)],
    )
  ).rows;
}
async function claims(client: Pick<PoolClient, 'query'>, rows: readonly AccountRow[]) {
  const handles = [...new Set(rows.flatMap(({ handle }) => (handle === null ? [] : [handle])))];
  if (!handles.length) return new Map<string, ClaimRow>();
  // An unavailable exact-claim home cannot turn a named Account into an
  // apparently handleless identity. Account and claim reads share this DB snapshot.
  await requireHomes(client, handles.map(claimRoute));
  const found = await client.query<ClaimRow>(
    `SELECT route, normalized_handle AS handle, account_id::text AS id,
       discovery_revision::text AS revision FROM access.handle_claim
     WHERE (route, normalized_handle) IN (SELECT * FROM unnest($1::integer[], $2::text[]))
       AND state = 'active'`,
    [handles.map(claimRoute), handles],
  );
  return new Map(found.rows.map((row) => [row.handle, row]));
}
function exactHandle(row: AccountRow, found: Awaited<ReturnType<typeof claims>>) {
  return row.handle !== null && found.get(row.handle)?.id === row.id ? row.handle : null;
}
async function position(client: Pick<PoolClient, 'query'>, partition: number) {
  const result = await client.query<{ position: string }>(
    'SELECT position::text FROM core.partition WHERE partition_no = $1',
    [partition],
  );
  if (!result.rows[0]) throw new Error('Account discovery partition is unavailable');
  return BigInt(result.rows[0].position);
}
function indexed(row: AccountRow, found: Awaited<ReturnType<typeof claims>>) {
  return {
    id: row.id,
    accountKind: row.accountKind,
    handle: exactHandle(row, found),
    displayName: row.displayName,
    revision: BigInt(row.revision),
  };
}

/** Native source only; neither routing text keys nor caller policy belong in this factory. */
export function accountDiscoverySource(pool: Pool): AccountDiscoverySource {
  return {
    async read(partition: number, ids: readonly string[]) {
      partitionKey(partition);
      const requested = keys(ids, partition);
      return withReadTransaction(pool, async (client) => {
        const at = await position(client, partition);
        const rows = await accounts(client, requested);
        const found = await claims(client, rows);
        const byId = new Map(rows.map((row) => [row.id, row]));
        return {
          partition,
          position: at,
          accounts: requested.flatMap(({ id }) => {
            const row = byId.get(id);
            return row ? [indexed(row, found)] : [];
          }),
        };
      });
    },
    async count(partition: number) {
      partitionKey(partition);
      return withReadTransaction(pool, async (client) => {
        const at = await position(client, partition);
        const result = await client.query<{ population: string }>(
          'SELECT population::text FROM access.account_discovery_population WHERE partition_no = $1',
          [partition],
        );
        if (!result.rows[0]) throw new Error('Account discovery census is not installed');
        const count = Number(result.rows[0].population);
        if (!Number.isSafeInteger(count)) throw new RangeError('Account discovery census exceeds safe integer range');
        return { partition, position: at, count };
      });
    },
    async page(partition: number, after: { route: number; id: string } | null, limit: number) {
      partitionKey(partition);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100)
        throw new RangeError('Account discovery page limit must be an integer from 1 to 100');
      if (after !== null && keys([after.id], partition)[0]!.route !== after.route)
        throw new TypeError('Account discovery frontier must carry its full native route');
      return withReadTransaction(pool, async (client) => {
        const at = await position(client, partition);
        const rows = (
          await client.query<AccountRow>(
            `SELECT ${columns} FROM access.account
           WHERE route >= $1 AND route < $2 AND state = 'active' AND NOT authn_fenced
             AND (route, account_id) > ($3::integer, $4::uuid)
           ORDER BY route, account_id LIMIT $5`,
            [
              partition * 16,
              (partition + 1) * 16,
              after?.route ?? -1,
              after?.id ?? '00000000-0000-0000-0000-000000000000',
              limit + 1,
            ],
          )
        ).rows;
        const selected = rows.slice(0, limit);
        const found = await claims(client, selected);
        const last = selected.at(-1);
        return {
          partition,
          position: at,
          accounts: selected.map((row) => indexed(row, found)),
          next: rows.length > limit && last ? { route: last.route, id: last.id } : null,
        };
      });
    },
  };
}

/** Current writer witness only. Immutable query admission must retain the complete
 * native reduction binding in its registered Source, including ownership epochs.
 */
export async function readAccountDiscoveryWitness(pool: Pool, partitions: readonly number[]) {
  // Preserve the existing writer API's empty batch; it is not query evidence.
  if (partitions.length === 0) return new Map<number, { revision: bigint; claimRevision: bigint }>();
  const binding = await readAccountDiscoveryReductionBinding(pool, partitions, {
    deadline: deadlineFor(DEFAULT_REQUEST_DEADLINE_MS),
  });
  return new Map(
    binding.heads.map(({ partition, revision, claimRevision }) => [partition, { revision, claimRevision }]),
  );
}

/** Source bindings for the index writer. An unconsumed exact claim is never
 * certified for publication: redrive its native intent, then resnapshot.
 */
export async function readAccountDiscoveryBindings(
  pool: Pool,
  partition: number,
  ids: readonly string[],
  snapshotClient?: PoolClient,
) {
  partitionKey(partition);
  const requested = keys(ids, partition);
  // Canonical targets collect presentation flags in this same native snapshot.
  const read = async (client: PoolClient) => {
    const rows = await accounts(client, requested);
    const found = await claims(client, rows);
    const dependencies = rows.flatMap((row) => {
      const claim = row.handle === null ? undefined : found.get(row.handle);
      return claim?.id === row.id ? [{ route: row.route, id: row.id, partition: partitionOf(claim.route) }] : [];
    });
    const cursors = dependencies.length
      ? (
          await client.query<{ id: string; partition: number; revision: string }>(
            `SELECT account_id::text AS id, claim_partition AS partition, revision::text
       FROM access.account_discovery_claim_cursor
       WHERE (route, account_id, claim_partition) IN (SELECT * FROM unnest($1::integer[], $2::uuid[], $3::integer[]))`,
            [
              dependencies.map(({ route }) => route),
              dependencies.map(({ id }) => id),
              dependencies.map(({ partition }) => partition),
            ],
          )
        ).rows
      : [];
    return new Map(
      rows.map((row) => {
        const claim = row.handle === null ? undefined : found.get(row.handle);
        const exact = claim?.id === row.id ? claim : undefined;
        const consumed = exact
          ? cursors.find((cursor) => cursor.id === row.id && cursor.partition === partitionOf(exact.route))
          : undefined;
        return [
          row.id,
          {
            revision: BigInt(row.revision),
            handle: exactHandle(row, found),
            // Native reciprocal-link facts only, not publication or Subject eligibility.
            agent: row.agent && row.agentReceipt ? { subjectId: row.agent, receiptId: row.agentReceipt } : null,
            claim: exact ? { route: exact.route, revision: BigInt(exact.revision) } : null,
            consumedClaimRevision: BigInt(consumed?.revision ?? '0'),
          },
        ];
      }),
    );
  };
  return snapshotClient ? read(snapshotClient) : withReadTransaction(pool, read);
}

/** Original Account repair input. The core snapshot position is a writer floor;
 * revision and claimRevision remain independent native Account domains. None of
 * these fields is a Semantic privacy-log position or a population ACK.
 */
export type AccountDiscoveryRepairObservation = Readonly<{
  id: string;
  head: AccountDiscoveryReductionHead;
  claimHead: AccountDiscoveryReductionHead | null;
  position: bigint;
  account: Awaited<ReturnType<AccountDiscoverySource['read']>>['accounts'][number] | null;
  binding: Awaited<ReturnType<typeof readAccountDiscoveryBindings>> extends Map<string, infer B> ? B | null : never;
}>;

/** Release every owner read before the next phase and revalidate both the local
 * native head and the exact current-handle/claim cursor after foreign reads.
 * Missing/fenced rows are retained as keyed deletion inputs, never Subjects.
 */
export async function readAccountDiscoveryRepairObservation(
  pool: Pool,
  id: string,
  context: Readonly<{ deadline: number }>,
): Promise<AccountDiscoveryRepairObservation> {
  const route = routeOf(id);
  if (route === null) throw new TypeError('Account repair requires a native Account key');
  const partition = partitionOf(route);
  requireAccessDeadline(context.deadline);
  return withRequestDeadline(context.deadline, async () => {
    const before = (await readAccountDiscoveryReductionBinding(pool, [partition], context)).heads[0]!;
    const snapshot = await accountDiscoverySource(pool).read(partition, [id]);
    const binding = (await readAccountDiscoveryBindings(pool, partition, [id])).get(id) ?? null;
    // The handle is routed independently. Its native epoch cannot be inferred
    // from the Account home or from the consumed claim revision alone.
    const claimPartition = binding?.claim ? partitionOf(binding.claim.route) : null;
    const claimBefore =
      claimPartition === null
        ? null
        : (await readAccountDiscoveryReductionBinding(pool, [claimPartition], context)).heads[0]!;
    const current = (await readAccountDiscoveryBindings(pool, partition, [id])).get(id) ?? null;
    const claimAfter =
      claimPartition === null
        ? null
        : (await readAccountDiscoveryReductionBinding(pool, [claimPartition], context)).heads[0]!;
    const after = (await readAccountDiscoveryReductionBinding(pool, [partition], context)).heads[0]!;
    const account = snapshot.accounts[0] ?? null;
    requireAccessDeadline(context.deadline);
    if (
      !isDeepStrictEqual(before, after) ||
      !isDeepStrictEqual(binding, current) ||
      !isDeepStrictEqual(claimBefore, claimAfter) ||
      (account === null
        ? binding !== null
        : binding === null ||
          binding.revision !== account.revision ||
          binding.handle !== account.handle ||
          (binding.claim !== null && binding.consumedClaimRevision < binding.claim.revision))
    )
      throw new CommandUnavailableError('contention', partition);
    return Object.freeze({ id, head: before, claimHead: claimBefore, position: snapshot.position, account, binding });
  });
}

function summary(
  row: AccountRow,
  handle: string | null,
  avatar: AvatarSummary | null,
  verifiedAgent: { id: string; label: string; type: string } | null,
): AccountDiscoverySummary {
  return {
    id: row.id,
    accountKind: row.accountKind,
    handle,
    displayName: row.displayName,
    automated: row.operatorId !== null,
    operatorId: row.operatorId,
    avatar,
    verifiedAgent,
  };
}

/** An unavailable optional owner cannot hide the otherwise eligible Account.
 * Preserve unexpected failures and the caller's overall deadline; native Account
 * revalidation below still has to succeed before any summary can be disclosed.
 */
async function optionalSummaries<T>(deadline: number, read: () => Promise<Map<string, T | null>>) {
  try {
    return await read();
  } catch (error) {
    requireAccessDeadline(deadline);
    if (classifyUnavailability(error) === undefined) throw error;
    return new Map<string, T | null>();
  }
}

/** Current owner hydration; linked Subject disclosure is exclusively Semantic's. */
export async function readAccountDiscoverySummaries(
  deps: SummaryReaderDependencies,
  ids: readonly string[],
  options: { languages?: readonly string[]; context?: boolean } = {},
) {
  const requested = keys(ids);
  if (!(deps.routeKey instanceof Uint8Array) || deps.routeKey.byteLength < 32)
    throw new TypeError('Account summaries require the server route key');
  requireAccessDeadline(deps.deadline);
  const result = new Map<string, ReturnType<typeof summary> | null>(requested.map(({ id }) => [id, null]));
  if (!requested.length) return result;
  const initial = await withReadTransaction(deps.pool, async (client) => {
    requireAccessDeadline(deps.deadline);
    const rows = await accounts(client, requested, options.context);
    const found = await claims(client, rows);
    return rows.map((row) => ({
      row,
      handle: exactHandle(row, found),
      claimRevision: row.handle === null ? null : (found.get(row.handle)?.revision ?? null),
    }));
  });
  // No Account transaction/custody remains open during foreign owner reads.
  const mediaIds = [...new Set(initial.flatMap(({ row }) => (row.avatar ? [row.avatar] : [])))];
  const contextBindings = options.context
    ? await optionalSummaries(deps.deadline, () =>
        readAccountContextBindings(
          deps,
          initial.map(({ row, handle }) => ({ ...row, handle })),
        ),
      )
    : new Map<string, { id: string; source: string }>();
  const subjectIds = [
    ...new Set(
      initial.flatMap(({ row }) => {
        const target = contextBindings.get(row.id);
        return [...(row.agent ? [row.agent] : []), ...(target ? [target.id] : [])];
      }),
    ),
  ];
  const avatars = mediaIds.length
    ? await optionalSummaries(deps.deadline, () =>
        withReadTransaction(deps.pool, (client) => readAvatarSummaries(client, mediaIds)),
      )
    : new Map<string, AvatarSummary | null>();
  requireAccessDeadline(deps.deadline);
  const subjects = subjectIds.length
    ? await optionalSummaries(deps.deadline, () =>
        readSubjectSummaries(options.context ? { ...deps, actor: { kind: 'anonymous' } } : deps, subjectIds, options),
      )
    : new Map<string, SubjectSummary | null>();
  requireAccessDeadline(deps.deadline);
  const finalBindings = options.context
    ? await optionalSummaries(deps.deadline, () =>
        readAccountContextBindings(
          deps,
          initial.map(({ row, handle }) => ({ ...row, handle })),
        ),
      )
    : contextBindings;
  // Whole candidates, not just their handle, are withheld on a fence, rename or
  // profile revision during hydration. A bad claim alone leaves a handleless hit.
  await withReadTransaction(deps.pool, async (client) => {
    const current = new Map((await accounts(client, requested, options.context)).map((row) => [row.id, row]));
    const found = await claims(client, [...current.values()]);
    for (const before of initial) {
      const row = current.get(before.row.id);
      if (
        !row ||
        row.revision !== before.row.revision ||
        exactHandle(row, found) !== before.handle ||
        (row.handle === null ? null : (found.get(row.handle)?.revision ?? null)) !== before.claimRevision
      )
        continue;
      const subject =
        row.agent &&
        (!options.context ||
          (contextBindings.get(row.id)?.id === row.agent &&
            isDeepStrictEqual(contextBindings.get(row.id), finalBindings.get(row.id))))
          ? subjects.get(row.agent)
          : null;
      const value = summary(
        row,
        before.handle,
        row.avatar ? (avatars.get(row.avatar) ?? null) : null,
        subject?.label ? { id: subject.id, label: subject.label.value, type: subject.type } : null,
      );
      if (options.context) {
        const binding = contextBindings.get(row.id);
        const target =
          binding && isDeepStrictEqual(binding, finalBindings.get(row.id)) ? subjects.get(binding.id) : null;
        const context: AccountContext = {
          biography: before.handle === null ? { state: 'withheld' } : accountBiography(row.biography),
          followTarget:
            target?.label && target.label.value.length <= 160 && target.type.length <= 256 && binding
              ? {
                  state: 'available',
                  id: target.id,
                  label: target.label.value,
                  type: target.type,
                  source: binding.source,
                }
              : { state: 'unavailable' },
        };
        // Optional oversized native labels cannot disqualify the Account itself.
        value.context =
          Buffer.byteLength(JSON.stringify(context)) <= ACCOUNT_CONTEXT_LIMITS.contextBytes
            ? context
            : { biography: context.biography, followTarget: { state: 'unavailable' } };
      }
      result.set(row.id, value);
    }
    requireAccessDeadline(deps.deadline);
  });
  return result;
}
