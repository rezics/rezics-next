import type { RealmPresentationImage } from '../content/realm-media.ts';
import type { Access } from '../request/access.ts';
import { prepareSpaceDiscovery, spaceDiscoveryRound, spaceDiscoverySnapshot } from './space-discovery-read.ts';
import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { DEFAULT_REQUEST_DEADLINE_MS, runCommand } from '../command/command.ts';
import { withConnection } from '../database/pool.ts';
import { lookupEventType } from '../events/catalogue.ts';
import type { Effect } from '../events/effects.ts';
import type { CloudEvent } from '../events/log.ts';
import { PARTITIONS, partitionOf, routeOf } from '../route/route.ts';
import { SPACE_DISCOVERY_INVALIDATED, type SpaceDiscoveryInvalidation } from './space-discovery-events.ts';
import {
  spaceDiscoveryDependencyReadiness,
  type SpaceDiscoveryDependencyReadiness,
} from './space-discovery-dependencies.ts';
import {
  publishSpaceDiscoveryTupleWitness,
  readSpaceDiscoveryTupleWitnesses,
  registerSpaceDiscoveryTupleProducer,
  type SpaceDiscoveryTupleWitness,
  type SpaceDiscoveryTupleWitnessInput,
} from './space-discovery-source-fences.ts';
export type { SpaceDiscoveryTupleWitness, SpaceDiscoveryTupleWitnessInput } from './space-discovery-source-fences.ts';

const spaceTypes = [
  'created',
  'updated',
  'removed',
  'restored',
  'address-changed',
  'address-claim-accepted',
  'address-activated',
].map((name) => `com.rezics.community.space.${name}.v1`);
const realmTypes = ['created', 'updated', 'removed', 'restored', 'board-scheme'].map(
  (name) => `com.rezics.community.realm.${name}.v1`,
);
const realmGateType = 'com.rezics.community.realm-discovery.changed.v1';
const mediaTypes = ['available', 'rejected', 'erased', 'collected', 'taken-down'].map(
  (name) => `com.rezics.content.media.${name}.v1`,
);
const contextTypes = ['com.rezics.semantic.record.deleted.v1', 'com.rezics.semantic.record.restored.v1'];
const fenceType = 'com.rezics.content.source_fence.taken_down.v1';
const exposureTypes = ['com.rezics.access.exposure.opened.v1', 'com.rezics.access.exposure.closed.v1'];
export const SPACE_DISCOVERY_NATIVE_EVENTS = [
  ...spaceTypes,
  ...realmTypes,
  realmGateType,
  ...mediaTypes,
  ...contextTypes,
  fenceType,
  ...exposureTypes,
];

const basis = {
  actorAccountId: '00000000-0000-8000-8000-000000000001',
  clientId: 'internal-community',
  requestedBy: null,
};

/** Exact log identity, not a wall clock, event UUID ordering or a caller's eligibility flag. */
function origin(event: CloudEvent): SpaceDiscoveryInvalidation['origin'] {
  const match = /^urn:rezics:log:(\d+)\.(\d+)$/.exec(event.source);
  if (!match || !/^0*[1-9][0-9]*$/.test(event.sequence)) throw new TypeError('Invalid Space discovery log origin');
  const partition = Number(match[1]);
  const epoch = Number(match[2]);
  const position = BigInt(event.sequence);
  if (
    !Number.isInteger(partition) ||
    partition < 0 ||
    partition > 4095 ||
    !Number.isSafeInteger(epoch) ||
    epoch < 1 ||
    position > 9223372036854775807n
  )
    throw new TypeError('Invalid Space discovery log origin');
  const data = event.data as Record<string, unknown>;
  return {
    partition,
    epoch,
    position: position.toString(),
    eventId: event.id,
    type: event.type,
    resourceId: (data.spaceId ?? data.realmId ?? data.id ?? data.mediaId ?? null) as string | null,
  };
}

/** Consumes committed native events only. The reader/bootstrap task owns population and hydration.
 * Removed identities must still resolve: an active-only Realm read would lose the removal delta.
 */
export async function spaceDiscoveryInvalidation(
  pool: Pool,
  event: CloudEvent,
): Promise<SpaceDiscoveryInvalidation | null> {
  if (!SPACE_DISCOVERY_NATIVE_EVENTS.includes(event.type)) return null;
  if (!lookupEventType(event.type)?.Check(event.data)) throw new TypeError('Invalid Space discovery native event');
  const data = event.data as Record<string, unknown>;
  const evidence = origin(event);
  let target: SpaceDiscoveryInvalidation['target'];
  const sameHome = (id: unknown, nativeRoute?: number): string => {
    const route = typeof id === 'string' ? routeOf(id) : null;
    if (route === null || partitionOf(nativeRoute ?? route) !== evidence.partition || event.subject !== id)
      throw new TypeError('Invalid Space discovery native identity');
    return id as string;
  };
  if (spaceTypes.includes(event.type)) {
    // Claim acceptance without a revision and activation commit in the address home.
    // Their target remains the Space's own routed identity, never the claim identity.
    const addressHome =
      event.type.endsWith('.address-activated.v1') ||
      (event.type.endsWith('.address-claim-accepted.v1') && !data.revisionId);
    const nativeRoute = addressHome
      ? createHash('sha256')
          .update(data.address as string)
          .digest()
          .readUInt16BE(0)
      : undefined;
    target = { kind: 'space', id: sameHome(data.spaceId ?? data.id, nativeRoute) };
  } else if (realmTypes.includes(event.type) || event.type === realmGateType) {
    const realmId = sameHome(data.realmId ?? data.id);
    const space = await withConnection(
      pool,
      async (client) =>
        (
          await client.query<{ space_id: string }>(
            'SELECT space_id FROM community.realm WHERE route=$1 AND realm_id=$2',
            [routeOf(realmId), realmId],
          )
        ).rows[0],
    );
    // Native Realm identities and their carrying slot are retained across removal.
    if (!space) throw new Error('Space discovery Realm binding unavailable');
    target = { kind: 'space', id: space.space_id };
  } else if (contextTypes.includes(event.type)) {
    if (data.kind !== 'context') return null;
    target = { kind: 'context', id: sameHome(data.id) };
  } else if (mediaTypes.includes(event.type)) {
    // Media events do not all carry a subject; their schema supplies the exact media identity.
    const mediaId = data.mediaId as string;
    const route = routeOf(mediaId);
    if (route === null || partitionOf(route) !== evidence.partition)
      throw new TypeError('Invalid Space discovery media identity');
    target = { kind: 'media', id: mediaId };
  } else if (event.type === fenceType) {
    const route = data.route as number;
    if (partitionOf(route) !== evidence.partition) throw new TypeError('Invalid Space discovery fence home');
    target = {
      kind: 'source-fence',
      route,
      source: data.source as string,
      externalId: data.external_id as string,
      fieldGroup: data.field_group as 'facts' | 'summary' | 'cover',
    };
  } else {
    if (!data.changed) return null;
    target = { kind: 'exposure', group: data.group as string };
  }
  return {
    target,
    origin: evidence,
    revisionId: (data.revisionId ?? data.headRevisionId ?? null) as string | null,
    nativeVersion: (data.version ?? data.securityRevision ?? null) as string | null,
  };
}

/** Generic effects retain the original event and retry after a crash. A command receipt coalesces
 * repeat delivery; after receipt retention, another invalidation is safe because consumers reread truth.
 * Dependency targets represent one durable scope obligation, never a census in a mutation/effect.
 */
export function createSpaceDiscoveryEffect(pool: Pool): Effect {
  return {
    name: 'community_space_discovery',
    types: SPACE_DISCOVERY_NATIVE_EVENTS,
    async run(event) {
      const invalidation = await spaceDiscoveryInvalidation(pool, event);
      if (!invalidation) return;
      const key = createHash('sha256').update(JSON.stringify(invalidation)).digest('hex');
      await runCommand(
        pool,
        {
          partition:
            invalidation.target.kind === 'space'
              ? partitionOf(routeOf(invalidation.target.id)!)
              : invalidation.origin.partition,
          basis,
          receipt: {
            actorAccountId: basis.actorAccountId,
            kind: 'community.space-discovery.invalidate',
            key,
            digest: createHash('sha256').update(key).digest(),
          },
        },
        async () => ({
          value: null,
          events: [
            {
              type: SPACE_DISCOVERY_INVALIDATED,
              ...(invalidation.target.kind === 'space' ? { subject: invalidation.target.id } : {}),
              data: invalidation,
            },
          ],
        }),
      );
    },
  };
}

export const SPACE_DISCOVERY_BATCH_SIZE = 100;
export type SpaceDiscoveryKey = Readonly<{ route: number; id: string }>;
export type SpaceDiscoverySummary = Readonly<{
  id: string;
  realmId: string | null;
  address: string | null;
  title: string;
  realmTitle: string | null;
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
  /** Dependency capability is separate from census and current hydration. */
  dependencies(): Promise<SpaceDiscoveryDependencyReadiness>;
  /** Exact Content source-fence provenance for selected current Space keys. */
  tupleWitnesses?(partition: number, ids: readonly string[]): Promise<ReadonlyMap<string, SpaceDiscoveryTupleWitness>>;
  /** Explicit source-owner census cut; an empty page is never registration evidence. */
  registerTupleProducer?(input: Readonly<{ generation: string; cut: string; complete: true }>): Promise<void>;
  /** Producer seam for an authoritative owner's exact current tuple witness. */
  publishTupleWitness?(input: SpaceDiscoveryTupleWitnessInput): Promise<SpaceDiscoveryTupleWitness>;
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

/** Concrete native factory result with the complete source-tuple capability. */
export interface SpaceDiscoveryTupleSource extends SpaceDiscoverySource {
  tupleWitnesses: NonNullable<SpaceDiscoverySource['tupleWitnesses']>;
  registerTupleProducer: NonNullable<SpaceDiscoverySource['registerTupleProducer']>;
  publishTupleWitness: NonNullable<SpaceDiscoverySource['publishTupleWitness']>;
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
): SpaceDiscoveryTupleSource {
  const deadline = () => context?.deadline ?? Date.now() + DEFAULT_REQUEST_DEADLINE_MS;
  return {
    dependencies: () => spaceDiscoveryDependencyReadiness(deps.pool),
    tupleWitnesses(partition, ids) {
      partitionKey(partition);
      const requested = keys(ids, partition);
      return readSpaceDiscoveryTupleWitnesses(
        deps.pool,
        requested.map(({ id }) => id),
      );
    },
    registerTupleProducer(input) {
      return registerSpaceDiscoveryTupleProducer(deps.pool, input);
    },
    publishTupleWitness(input) {
      return publishSpaceDiscoveryTupleWitness(deps.pool, input);
    },
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
