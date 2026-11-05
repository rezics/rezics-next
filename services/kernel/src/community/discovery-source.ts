import type { Pool } from 'pg';
import { deadlineClient, within } from '../access/authenticate.ts';
import { authoritativeTimeValue, type AuthoritativeTime } from '../command/command.ts';
import { CommandUnavailableError } from '../request/unavailable.ts';
import { discardConnection, withConnection } from '../database/pool.ts';
import { readPartition } from '../partition/partition.ts';
import { accessCheck, type Access, type AccessClient } from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { realmReadEligibility } from './realm.ts';
import { spaceReadEligibility } from './space.ts';
import read from './discovery-source-read.sql';

/** Original qualification evidence only. This is not a current disclosure/fence decision. */
export type RealmDiscoveryBinding = Readonly<{
  realmId: string;
  spaceId: string;
  realmEpoch: string;
}>;

/** Released exact Realm and host reads at the originating command's T. Anonymous
 * Access checks are independent of the initiating account's grants/membership.
 * Never call while holding a source command transaction or another home.
 */
export async function prepareRealmDiscoverySource(
  deps: Readonly<{ pool: Pool; access: Access }>,
  realmId: string,
  time: AuthoritativeTime,
  deadline: number,
): Promise<RealmDiscoveryBinding | null> {
  const route = routeOf(realmId);
  if (route === null) return null;
  const realm = { route, id: realmId };
  const context = { pool: deps.pool, deadline };
  const realmCheck = await accessCheck(
    deps.access,
    { kind: 'anonymous' },
    'realm:read',
    { ...realm, eligibility: realmReadEligibility(realm) },
    context,
  );
  const current = await within(deadline, () =>
    withConnection(deps.pool, async (connection) => {
      const client = deadlineClient(connection, deadline);
      const partition = await readPartition(client, partitionOf(route));
      if (!partition || partition.writeState === 'moved') return null;
      const row = await read.run(client, { route, realm_id: realmId, at: authoritativeTimeValue(time) });
      return row && (await realmCheck(client, time)) ? row : null;
    }),
  );
  if (!current) return null;
  const spaceRoute = routeOf(current.space_id);
  if (spaceRoute === null) return null;
  const space = { route: spaceRoute, id: current.space_id };
  const spaceCheck = await accessCheck(
    deps.access,
    { kind: 'anonymous' },
    'space:read',
    { ...space, eligibility: spaceReadEligibility(space) },
    context,
  );
  const readable = await within(deadline, () =>
    withConnection(deps.pool, async (connection) => {
      const client = deadlineClient(connection, deadline);
      const partition = await readPartition(client, partitionOf(spaceRoute));
      return !!partition && partition.writeState !== 'moved' && (await spaceCheck(client, time));
    }),
  );
  return readable ? Object.freeze({ realmId, spaceId: current.space_id, realmEpoch: current.realm_epoch }) : null;
}

// These operations consume committed Content evidence. They never authorize a
// content mutation and never hold a source connection while entering Realm home.
import {
  currentCommand,
  noEffect,
  registerCommandCallback,
  runCommand,
  type CommandTransaction,
} from '../command/command.ts';
import {
  readDiscoveryOperation,
  readDiscoveryOutcome,
  type DiscoveryOperationReference,
} from '../content/discovery-mutation.ts';
import { readDiscoverySource, prepareDiscoverySourceApply, type DiscoverySourceFact } from '../content/discovery.ts';
import type { DiscoveryDelta } from '../events/contracts/content-discovery.ts';
import epoch from './discovery-source-epoch.sql';
import gate from './discovery-source-gate.sql';
import fence from './discovery-source-fence.sql';
import changes from './discovery-source-changes.sql';
import bindTransaction from './discovery-source-transaction.sql';
import project from './discovery-source-project.sql';
import projectBoard from './discovery-source-board.sql';

/** Same-home container writers can read this exact binding in their own command.
 * Space/Realm lifecycle owners must advance the epoch/generation atomically with
 * removal/restoration, retaining Context. This API never opens another home.
 */
export async function readRealmDiscoveryEpoch(tx: CommandTransaction, realmId: string) {
  const route = routeOf(realmId);
  if (route === null || currentCommand(tx).partition !== partitionOf(route))
    throw new Error('Discovery epoch requires the Realm home');
  return epoch.run(tx, { route, realm_id: realmId });
}

export type RealmDiscoveryGate = Readonly<{ realm_epoch: string; generation: string; settled: boolean }>;
/** Later disclosure also requires matching aggregate generation, original epoch,
 * active explicit-public Realm and independent anonymous-readable active Space.
 */
export async function readRealmDiscoveryGate(
  client: AccessClient,
  realmId: string,
): Promise<RealmDiscoveryGate | null> {
  const route = routeOf(realmId);
  return route === null ? null : gate.run(client, { route, realm_id: realmId });
}
export type RealmDiscoveryChangeValue =
  | Readonly<{ kind: 'thread'; source: DiscoverySourceFact }>
  | Readonly<{ kind: 'board'; boardId: string; sourceVersion: string; published: boolean }>
  | Readonly<{ kind: 'epoch' }>
  | Readonly<{ kind: 'gate'; settled: boolean }>;
export type RealmDiscoveryCommittedChange = Readonly<{
  realmId: string;
  realmEpoch: string;
  generation: string;
  previousGeneration: string;
  transactionId: string;
  value: RealmDiscoveryChangeValue;
}>;
export type RealmDiscoveryChangePage = Readonly<{
  changes: readonly RealmDiscoveryCommittedChange[];
  head: RealmDiscoveryGate | null;
  next: string | null;
}>;

/** Deferred native SQL triggers obtain only the executor's actual transaction id.
 * Container lifecycle writers must call this in their ordinary command body.
 * No caller data, receipt, source version or event becomes a log transaction id.
 */
export function bindRealmDiscoveryCommand(tx: CommandTransaction): void {
  currentCommand(tx);
  registerCommandCallback(tx, async (transactionId) => {
    await bindTransaction.run(tx, { transaction_id: transactionId });
  });
}

/** One released, consistent native home snapshot. A missing log predecessor is
 * deliberately not repaired here: the consumer must remain unavailable on gaps.
 */
export async function readRealmDiscoveryChanges(
  pool: Pool,
  input: Readonly<{ realmId: string; afterGeneration: string; limit: number; deadline: number }>,
): Promise<RealmDiscoveryChangePage> {
  const { realmId, afterGeneration, limit, deadline } = input;
  const route = routeOf(realmId);
  if (
    route === null ||
    typeof afterGeneration !== 'string' ||
    afterGeneration.length > 19 ||
    !/^(0|[1-9][0-9]*)$/.test(afterGeneration) ||
    BigInt(afterGeneration) > 9223372036854775807n ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 50 ||
    !Number.isFinite(deadline)
  )
    throw new RangeError('Invalid Realm discovery change range');
  const partitionNo = partitionOf(route);
  return within(deadline, () =>
    withConnection(pool, async (connection) => {
      const client = deadlineClient(connection, deadline);
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      try {
        const partition = await readPartition(client, partitionNo);
        if (!partition) throw new CommandUnavailableError('contention', partitionNo);
        if (partition.writeState === 'moved')
          throw new CommandUnavailableError('moved', partitionNo, partition.movedTo);
        if (partition.writeState !== 'active') throw new CommandUnavailableError('fenced', partitionNo);
        const head = await readRealmDiscoveryGate(client, realmId);
        const rows = head
          ? await changes.run(client, {
              route,
              realm_id: realmId,
              after_generation: afterGeneration,
              limit,
            })
          : [];
        const records = rows.map((row): RealmDiscoveryCommittedChange =>
          Object.freeze({
            realmId,
            realmEpoch: row.realm_epoch,
            generation: row.generation,
            previousGeneration: row.previous_generation,
            transactionId: row.transaction_id,
            value: row.value as RealmDiscoveryChangeValue,
          }),
        );
        const last = records.at(-1)?.generation ?? afterGeneration;
        if (head && BigInt(last) < BigInt(head.generation) && records.length === 0)
          throw new Error('Realm discovery committed change range unavailable');
        await client.query('COMMIT');
        return Object.freeze({
          changes: Object.freeze(records),
          head,
          next: head && BigInt(last) < BigInt(head.generation) ? last : null,
        });
      } catch (error) {
        try {
          await connection.query('ROLLBACK');
        } catch (rollbackError) {
          discardConnection(connection, rollbackError as Error);
        }
        throw error;
      }
    }),
  );
}

function sourceEvent(realmId: string, realmEpoch: string) {
  return { type: 'com.rezics.community.realm-discovery.changed.v1', subject: realmId, data: { realmId, realmEpoch } };
}

/** Commits precisely one fence, using only a committed source preparation.
 * A terminal tombstone wins over any delayed installation of the same fence.
 */
export async function commitDiscoveryFence(pool: Pool, ref: DiscoveryOperationReference): Promise<string> {
  const source = await readDiscoveryOperation(pool, ref);
  if (!source) throw new Error('Discovery preparation unavailable');
  const route = routeOf(source.realm_id)!;
  const result = await runCommand(
    pool,
    { partition: partitionOf(route), deadline: Date.now() + 30_000 },
    async (tx) => {
      if (!(await epoch.run(tx, { route, realm_id: source.realm_id }))) throw new Error('Discovery Realm unavailable');
      const installed = (
        await fence.run(tx, {
          route,
          realm_id: source.realm_id,
          realm_epoch: source.realm_epoch,
          source_route: ref.route,
          intent: ref.intent,
          generation: ref.generation,
          outcome: null,
          transaction_id: null,
        })
      )[0];
      if (!installed || installed.fence_generation === null) throw new Error('Discovery Realm fence unavailable');
      if (!installed.changed) return noEffect(installed.fence_generation);
      bindRealmDiscoveryCommand(tx);
      return { value: installed.fence_generation, events: [sourceEvent(source.realm_id, source.realm_epoch)] };
    },
  );
  return result.value;
}

/** Projects absolute, version-guarded native source state and resolves only its
 * exact terminal generation in the SAME Realm command. There is no caller-supplied
 * success flag. APPLIED evidence is read from the source journal and native rows.
 */
export async function projectDiscoveryOutcome(pool: Pool, ref: DiscoveryOperationReference): Promise<void> {
  const { operation: source, current, source: contribution } = await readDiscoveryOutcome(pool, ref);
  const route = routeOf(source.realm_id)!;
  await runCommand(pool, { partition: partitionOf(route), deadline: Date.now() + 30_000 }, async (tx) => {
    if (!(await epoch.run(tx, { route, realm_id: source.realm_id }))) throw new Error('Discovery Realm unavailable');
    let changed = false;
    if (source.phase === 'applied') {
      if (contribution)
        changed = !!(await project.run(tx, {
          route,
          realm_id: contribution.realmId,
          realm_epoch: contribution.realmEpoch,
          source_route: contribution.sourceRoute,
          thread_id: contribution.threadId,
          board_id: contribution.boardId,
          creation_day: contribution.creationDay,
          space_id: contribution.spaceId,
          source_version: contribution.sourceVersion,
          contributing: contribution.contributing,
        }));
      else if (source.target_kind === 'board')
        changed = !!(await projectBoard.run(tx, {
          route,
          realm_id: source.realm_id,
          realm_epoch: source.realm_epoch,
          board_id: source.board_id,
          source_version: current.native_version,
          published: current.visibility === 'published',
        }));
      else throw new Error('Discovery contribution unavailable');
    }
    const resolved = (
      await fence.run(tx, {
        route,
        realm_id: source.realm_id,
        realm_epoch: source.realm_epoch,
        source_route: ref.route,
        intent: ref.intent,
        generation: ref.generation,
        outcome: source.phase,
        transaction_id: source.outcome_transaction_id,
      })
    )[0];
    if (
      !resolved ||
      resolved.outcome !== source.phase ||
      resolved.outcome_transaction_id !== source.outcome_transaction_id
    )
      throw new Error('Discovery fence outcome conflict');
    if (!changed && !resolved.changed) return noEffect(null);
    bindRealmDiscoveryCommand(tx);
    return { value: null, events: [sourceEvent(source.realm_id, source.realm_epoch)] };
  });
}

/** Genuine initial/delayed deltas assign current source state; they cannot restore
 * stale positive state or clear an operation fence. Later aggregate maintenance
 * consumes these native facts and advances its own generation after bucket work.
 */
export async function projectDiscoveryStart(pool: Pool, delta: DiscoveryDelta): Promise<void> {
  const prepared = prepareDiscoverySourceApply(delta, await readDiscoverySource(pool, delta.threadId), null);
  if (!prepared) throw new Error('Discovery source delta unavailable');
  const source = prepared.source;
  const route = routeOf(source.realmId)!;
  await runCommand(pool, { partition: partitionOf(route), deadline: Date.now() + 30_000 }, async (tx) => {
    if (!(await epoch.run(tx, { route, realm_id: source.realmId }))) throw new Error('Discovery Realm unavailable');
    const changed = await project.run(tx, {
      route,
      realm_id: source.realmId,
      realm_epoch: source.realmEpoch,
      source_route: source.sourceRoute,
      thread_id: source.threadId,
      board_id: source.boardId,
      creation_day: source.creationDay,
      space_id: source.spaceId,
      source_version: source.sourceVersion,
      contributing: source.contributing,
    });
    if (!changed) return noEffect(null);
    bindRealmDiscoveryCommand(tx);
    return { value: null, events: [sourceEvent(source.realmId, source.realmEpoch)] };
  });
}
