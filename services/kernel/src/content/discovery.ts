import { requireDiscoverySourceLock } from './discovery-mutation.ts';
import { creationDeclares } from '../access/parent-creation.ts';
import {
  authoritativeTimeValue,
  currentCommand,
  type AuthoritativeTime,
  type CommandEvent,
  type CommandTransaction,
} from '../command/command.ts';
import type { RealmDiscoveryBinding } from '../community/discovery-source.ts';
import type { AccessClient } from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { DISCOVERY_DELTA, type DiscoveryDelta } from '../events/contracts/content-discovery.ts';
import create from './discovery-create.sql';
import read from './discovery-read.sql';
import retract from './discovery-retract.sql';
import target from './discovery-target.sql';

type SourceRow = NonNullable<Awaited<ReturnType<typeof read.run>>>;
export type DiscoverySourceFact = Readonly<Omit<DiscoveryDelta, 'change'>>;
function fact(row: SourceRow): DiscoverySourceFact {
  return {
    realmId: row.realm_id,
    spaceId: row.space_id,
    realmEpoch: row.realm_epoch,
    boardId: row.board_id,
    threadId: row.thread_id,
    sourceRoute: row.route,
    creationDay: row.creation_day,
    sourceVersion: row.source_version,
    contributing: row.contributing,
  };
}
function event(row: SourceRow): CommandEvent {
  const data: DiscoveryDelta = { ...fact(row), change: row.contributing ? 1 : -1 };
  return { type: DISCOVERY_DELTA, subject: row.thread_id, data };
}

/** Only a declared native thread INSERT can establish qualification. Publication,
 * replay and later public state have no creation capability and cannot backfill.
 */
export async function appendDiscoveryStart(
  tx: CommandTransaction,
  input: Readonly<{
    threadId: string;
    boardId: string;
    binding: RealmDiscoveryBinding;
    time: AuthoritativeTime;
  }>,
): Promise<CommandEvent[]> {
  const route = routeOf(input.threadId);
  const command = currentCommand(tx);
  if (
    route === null ||
    command.time !== input.time ||
    command.partition !== partitionOf(route) ||
    !creationDeclares(tx, { route, id: input.threadId })
  )
    throw new Error('Discovery requires native thread creation');
  const rows = await create.run(tx, {
    route,
    thread_id: input.threadId,
    board_id: input.boardId,
    realm_id: input.binding.realmId,
    space_id: input.binding.spaceId,
    realm_epoch: input.binding.realmEpoch,
    at: authoritativeTimeValue(input.time),
  });
  if (rows.length > 1) throw new Error('Discovery creation is not a point write');
  return rows.map(event);
}

/** Called after the native point mutation, in its same thread home. Replies have
 * no effect; source versions advance exactly once for each actual state change.
 * A board-wide change needs its own Realm fence/bucket operation, never a scan.
 */
export async function retractDiscoveryStart(
  tx: CommandTransaction,
  input: Readonly<{
    threadId: string;
    postId?: string;
  }>,
): Promise<CommandEvent[]> {
  const route = routeOf(input.threadId);
  if (route === null || currentCommand(tx).partition !== partitionOf(route))
    throw new Error('Discovery retraction requires its native thread home');
  if (input.postId !== undefined) {
    const thread = await target.run(tx, { route, thread_id: input.threadId });
    if (thread?.first_post_id !== input.postId) return [];
  }
  requireDiscoverySourceLock(tx, input.threadId);
  const row = await retract.run(tx, { route, thread_id: input.threadId });
  return row ? [event(row)] : [];
}

/** Exact source read for a later Community consumer, before its own home checkout.
 * Missing means never qualified, not a zero to infer from present-day visibility.
 */
export async function readDiscoverySource(client: AccessClient, threadId: string): Promise<DiscoverySourceFact | null> {
  const route = routeOf(threadId);
  if (route === null) return null;
  const row = await read.run(client, { route, thread_id: threadId });
  return row ? fact(row) : null;
}

/** Deterministic apply preparation after a genuine native envelope was read.
 * Consumers assign the absolute state, gated by sourceVersion, rather than add
 * arbitrary/replayed counts. This result supplies no Realm fence clearance.
 */
export function prepareDiscoverySourceApply(
  delta: DiscoveryDelta,
  source: DiscoverySourceFact | null,
  appliedVersion: string | null,
): Readonly<{ source: DiscoverySourceFact; previousVersion: string | null }> | null {
  if (
    !source ||
    source.sourceRoute !== routeOf(source.threadId) ||
    delta.change !== (delta.contributing ? 1 : -1) ||
    BigInt(delta.sourceVersion) > BigInt(source.sourceVersion) ||
    (appliedVersion !== null && BigInt(appliedVersion) >= BigInt(source.sourceVersion))
  )
    return null;
  for (const key of ['threadId', 'sourceRoute', 'boardId', 'realmId', 'spaceId', 'realmEpoch', 'creationDay'] as const)
    if (delta[key] !== source[key]) return null;
  if (delta.sourceVersion === source.sourceVersion && delta.contributing !== source.contributing) return null;
  return Object.freeze({ source: Object.freeze({ ...source }), previousVersion: appliedVersion });
}
