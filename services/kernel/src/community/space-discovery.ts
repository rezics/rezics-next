import type { Pool } from 'pg';
import { DEFAULT_REQUEST_DEADLINE_MS } from '../command/command.ts';
import type { RealmPresentationImage } from '../content/realm-media.ts';
import type { Access } from '../request/access.ts';
import { PARTITIONS, partitionOf, routeOf } from '../route/route.ts';
import { prepareSpaceDiscovery, spaceDiscoveryRound, spaceDiscoverySnapshot } from './space-discovery-read.ts';

export const SPACE_DISCOVERY_BATCH_SIZE = 100;
export type SpaceDiscoveryKey = Readonly<{ route: number; id: string }>;
export type SpaceDiscoverySummary = Readonly<{
  id: string;
  realmId: string | null;
  name: string;
  description: string;
  avatar: RealmPresentationImage | null;
}>;
export type IndexedSpace = Omit<SpaceDiscoverySummary, 'avatar'> & Readonly<{ revision: string }>;
export type SpaceDiscoverySnapshot = Readonly<{
  partition: number;
  position: bigint;
  spaces: readonly IndexedSpace[];
}>;
export type SpaceDiscoveryDependencies = Readonly<{
  pool: Pool;
  access: Access;
  clock?: () => Date;
}>;
export interface SpaceDiscoverySource {
  read(partition: number, ids: readonly string[]): Promise<SpaceDiscoverySnapshot>;
  /** Internal generation census of retained native candidates, including ineligible identities. */
  count(partition: number): Promise<Readonly<{ partition: number; position: bigint; count: number }>>;
  /** At most limit candidates, without refill. next is the last examined native key. */
  page(
    partition: number,
    after: SpaceDiscoveryKey | null,
    limit: number,
  ): Promise<SpaceDiscoverySnapshot & Readonly<{ next: SpaceDiscoveryKey | null }>>;
}

function partitionKey(partition: number) {
  if (!Number.isInteger(partition) || partition < 0 || partition >= PARTITIONS)
    throw new RangeError('Space discovery requires a native partition');
}
function keys(ids: readonly string[], partition?: number): SpaceDiscoveryKey[] {
  if (ids.length > SPACE_DISCOVERY_BATCH_SIZE) throw new RangeError('Space discovery accepts at most 100 keys');
  return [...new Set(ids)].map((id) => {
    const route = routeOf(id);
    if (route === null || (partition !== undefined && partitionOf(route) !== partition))
      throw new TypeError('Space discovery requires full native keys in the requested partition');
    return { route, id };
  });
}

/** Producer-owned bootstrap interface. Search owns registration and generations;
 * neither this census nor an index hit supplies current disclosure authority.
 */
export function spaceDiscoverySource(
  deps: SpaceDiscoveryDependencies,
  context?: Readonly<{ deadline: number }>,
): SpaceDiscoverySource {
  const deadline = () => context?.deadline ?? Date.now() + DEFAULT_REQUEST_DEADLINE_MS;
  return {
    async read(partition, ids) {
      partitionKey(partition);
      const requested = keys(ids, partition);
      const until = deadline();
      const decisions = await prepareSpaceDiscovery(deps, until);
      const result = await spaceDiscoveryRound(deps, decisions, partition, requested, until);
      return {
        partition,
        position: result.position,
        spaces: [...result.cards.values()].map((c) => c.indexed),
      };
    },
    async count(partition) {
      partitionKey(partition);
      return spaceDiscoverySnapshot(deps, partition, deadline(), async (client, anchor) => {
        const row = (
          await client.query<{ population: string }>(
            'SELECT population::text FROM community.space_discovery_population WHERE partition_no=$1',
            [partition],
          )
        ).rows[0];
        if (!row) throw new Error('Space discovery census is unavailable');
        const count = Number(row.population);
        if (!Number.isSafeInteger(count) || count < 0)
          throw new RangeError('Space discovery census exceeds safe range');
        return { partition, position: anchor.position, count };
      });
    },
    async page(partition, after, limit) {
      partitionKey(partition);
      if (!Number.isInteger(limit) || limit < 1 || limit > SPACE_DISCOVERY_BATCH_SIZE)
        throw new RangeError('Space discovery page limit must be 1..100');
      if (after !== null && keys([after.id], partition)[0]!.route !== after.route)
        throw new TypeError('Space discovery frontier requires its exact native route');
      // Copy the frontier before preparing foreign Access evidence.
      const frontier = after === null ? null : { route: after.route, id: after.id };
      const until = deadline();
      const decisions = await prepareSpaceDiscovery(deps, until);
      const result = await spaceDiscoveryRound(deps, decisions, partition, { after: frontier, limit }, until);
      return {
        partition,
        position: result.position,
        spaces: [...result.cards.values()].map((c) => c.indexed),
        next: result.next,
      };
    },
  };
}

/** Fixed current candidate hydration, always anonymous even for privileged Search callers. */
export async function readSpaceDiscoverySummaries(
  deps: SpaceDiscoveryDependencies,
  ids: readonly string[],
  context: Readonly<{ deadline: number }>,
): Promise<ReadonlyMap<string, SpaceDiscoverySummary>> {
  const requested = keys(ids);
  const result = new Map<string, SpaceDiscoverySummary>();
  if (!requested.length) return result;
  const decisions = await prepareSpaceDiscovery(deps, context.deadline);
  const groups = new Map<number, SpaceDiscoveryKey[]>();
  for (const key of requested) {
    const partition = partitionOf(key.route);
    const group = groups.get(partition) ?? [];
    group.push(key);
    groups.set(partition, group);
  }
  const { exactRealmPresentationImage, readRealmPresentationImages } = await import('../content/realm-media.ts');
  for (const [partition, group] of groups) {
    const first = await spaceDiscoveryRound(deps, decisions, partition, group, context.deadline);
    const avatars = new Map<string, RealmPresentationImage>();
    // No owner snapshot is held during native media authority reads.
    for (const [id, card] of first.cards) {
      if (!card.indexed.realmId || !card.avatarMediaId) continue;
      const image = await readRealmPresentationImages(
        deps,
        {
          realmId: card.indexed.realmId,
          avatarMediaId: card.avatarMediaId,
          bannerMediaId: null,
        },
        { actor: { kind: 'anonymous' }, deadline: context.deadline },
      );
      if (image.avatar.state !== 'available') continue;
      const avatar = exactRealmPresentationImage(image.avatar.value);
      if (avatar && avatar.id === card.avatarMediaId && avatar.containerId === card.indexed.realmId)
        avatars.set(id, avatar);
    }
    const final = await spaceDiscoveryRound(deps, decisions, partition, group, context.deadline);
    for (const [id, card] of final.cards) {
      if (first.cards.get(id)?.binding !== card.binding) continue;
      const { revision: _, ...value } = card.indexed;
      result.set(id, { ...value, avatar: avatars.get(id) ?? null });
    }
  }
  return result;
}
