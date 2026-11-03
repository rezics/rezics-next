import { describe, expect, it } from 'bun:test';
import type {
  SpaceDiscoverySource as NativeSource,
  SpaceDiscoverySummary,
  SpaceDiscoveryTupleWitness,
  SpaceDiscoveryTupleWitnessInput,
} from '../../src/community/space-discovery.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { createSpaceDiscoveryAdapter } from '../../src/search/space-discovery.ts';

const firstId = '11111111-1111-7111-8111-111111111111';
const secondId = '11111111-1111-7111-8111-111111111112';
const otherId = '11111111-1111-7111-8111-111111111113';
const route = routeOf(firstId)!;
const dependencies: NativeSource['dependencies'] = async () => {
  throw new Error('Space adapter fixtures do not supply native dependency readiness');
};
const partition = partitionOf(route);
const indexed = (id: string, realmId: string | null = null, revision = id) => ({
  id,
  realmId,
  address: `space-${id[0]}`,
  title: `Original ${id[0]}`,
  realmTitle: realmId ? `Realm ${id[0]}` : null,
  name: `Space ${id[0]}`,
  description: 'Owner-approved public summary',
  revision,
});
const nativeReadiness = (state: 'preparing' | 'unavailable'): Awaited<ReturnType<NativeSource['dependencies']>> => ({
  state,
  capabilities: {
    context: 'connected',
    media: 'connected',
    exposure: 'connected',
    'source-fence': 'unavailable',
  },
});
const summary = (id: string, realmId: string | null = null): SpaceDiscoverySummary => ({
  id,
  realmId,
  address: `space-${id[0]}`,
  title: `Current ${id[0]}`,
  realmTitle: realmId ? `Realm ${id[0]}` : null,
  name: `Current ${id[0]}`,
  description: 'Current authorized summary',
  avatar: null,
});

function adapterFor(
  source: NativeSource,
  current: (ids: readonly string[]) => Promise<ReadonlyMap<string, SpaceDiscoverySummary>>,
) {
  return createSpaceDiscoveryAdapter(source, async (ids) => current(ids));
}

describe('second-scope Space discovery adapter', () => {
  it('forwards complete tuple witnesses and producer writes through the Search source boundary', async () => {
    const witness = {
      state: 'ready',
      spaceId: firstId,
      spaceRevision: firstId,
      realmId: null,
      realmRevision: null,
      producerGeneration: 'source-generation',
      producerEpoch: '1',
      sourcePosition: '4',
      witnessGeneration: '9',
      generation: 'native-generation',
      cut: 'native-cut',
      tuples: [],
    } satisfies SpaceDiscoveryTupleWitness;
    const input: SpaceDiscoveryTupleWitnessInput = {
      spaceId: firstId,
      spaceRevision: firstId,
      realmId: null,
      realmRevision: null,
      producerGeneration: 'source-generation',
      producerEpoch: '1',
      sourcePosition: '4',
      tuples: [],
      origin: {
        partition,
        epoch: 1,
        position: '4',
        eventId: '11111111-1111-7111-8111-111111111114',
        type: 'com.rezics.search.source-tuple.changed.v1',
        resourceId: firstId,
      },
    };
    let registered = '';
    let published: SpaceDiscoveryTupleWitnessInput | undefined;
    const source: NativeSource = {
      dependencies: async () => ({
        state: 'ready',
        generation: 'native-generation',
        cut: 'native-cut',
        capabilities: { context: 'connected', media: 'connected', exposure: 'connected', 'source-fence': 'connected' },
      }),
      tupleWitnesses: async (_partition, ids) => new Map(ids.map((id) => [id, witness])),
      registerTupleProducer: async (value) => {
        registered = value.generation;
      },
      publishTupleWitness: async (value) => {
        published = value;
        return witness;
      },
      async read(p) {
        return { partition: p, position: 4n, spaces: [] };
      },
      async count(p) {
        return { partition: p, position: 4n, count: 0 };
      },
      async page(p) {
        return { partition: p, position: 4n, spaces: [], next: null };
      },
    };
    const adapter = adapterFor(source, async () => new Map());

    expect(await adapter.source.tupleWitnesses?.(partition, [firstId])).toEqual(new Map([[firstId, witness]]));
    await adapter.source.registerTupleProducer?.({
      generation: 'source-generation',
      cut: 'source-cut',
      complete: true,
    });
    expect(registered).toBe('source-generation');
    expect(await adapter.source.publishTupleWitness?.(input)).toBe(witness);
    expect(published).toBe(input);
  });

  it('forwards native readiness without treating empty pages or censuses as complete coverage', async () => {
    let readiness = nativeReadiness('preparing');
    const source: NativeSource = {
      dependencies: async () => readiness,
      async read(p) {
        return { partition: p, position: 1n, spaces: [] };
      },
      async count(p) {
        return { partition: p, position: 1n, count: 0 };
      },
      async page(p) {
        return { partition: p, position: 1n, spaces: [], next: null };
      },
    };
    const adapter = adapterFor(source, async () => new Map());

    expect(await adapter.source.dependencies()).toBe(readiness);
    expect(await adapter.source.page(partition, null, 10)).toMatchObject({ spaces: [], next: null });
    readiness = nativeReadiness('unavailable');
    expect(await adapter.source.count(partition)).toMatchObject({ count: 0 });
    expect(await adapter.source.dependencies()).toBe(readiness);
  });

  it('projects one canonical Space identity and hydrates current authorized summaries', async () => {
    const source: NativeSource = {
      dependencies,
      async read(p, ids) {
        return { partition: p, position: 12n, spaces: ids.map((id) => indexed(id, id === firstId ? secondId : null)) };
      },
      async count(p) {
        return { partition: p, position: 12n, count: 2 };
      },
      async page(p, after, limit) {
        return {
          partition: p,
          position: 11n,
          spaces: [indexed(firstId, secondId), indexed(secondId)].slice(0, limit),
          next: after,
        };
      },
    };
    const adapter = adapterFor(
      source,
      async (ids) => new Map(ids.map((id) => [id, summary(id, id === firstId ? secondId : null)])),
    );
    const prepared = await adapter.preparePage(partition, null, 10);
    const indexedActions = prepared.actions.filter((action) => action.op === 'index');
    expect(prepared.next).toBeNull();
    expect(indexedActions).toHaveLength(2);
    expect(indexedActions.map((action) => action.id)).toEqual([
      `discovery-v1:space:${firstId}`,
      `discovery-v1:space:${secondId}`,
    ]);
    expect(indexedActions[0]).toMatchObject({
      version: 12n,
      document: {
        owner: 'content',
        kind: 'space',
        id: firstId,
        realm_id: secondId,
        names: [`Space ${firstId[0]}`],
        descriptions: ['Owner-approved public summary'],
        source_position: '12',
      },
    });
    const hydrated = await adapter.hydrate([firstId, secondId], { deadline: Date.now() + 1000 });
    expect([...hydrated.values()].map((value) => value.name)).toEqual([
      `Current ${firstId[0]}`,
      `Current ${secondId[0]}`,
    ]);
  });

  it('rejects a malformed page before reading rows or exposing its frontier', async () => {
    let reads = 0;
    const source: NativeSource = {
      dependencies,
      async read(p) {
        reads += 1;
        return { partition: p, position: 1n, spaces: [] };
      },
      async count(p) {
        return { partition: p, position: 1n, count: 0 };
      },
      async page(p) {
        return {
          partition: p,
          position: 1n,
          spaces: [indexed(firstId)],
          next: { route: routeOf(secondId)! + 1, id: secondId },
        };
      },
    };
    const adapter = adapterFor(source, async () => new Map());
    await expect(adapter.preparePage(partition, null, 10)).rejects.toThrow('Space discovery key does not belong');
    expect(reads).toBe(0);
  });

  it('rejects an inexact producer position before consuming the page', async () => {
    let reads = 0;
    const source: NativeSource = {
      dependencies,
      async read(p) {
        reads += 1;
        return { partition: p, position: 1n, spaces: [] };
      },
      async count(p) {
        return { partition: p, position: 1n, count: 0 };
      },
      async page(p) {
        return { partition: p, position: '1', spaces: [], next: null } as never;
      },
    };
    const adapter = adapterFor(source, async () => new Map());
    await expect(adapter.preparePage(partition, null, 10)).rejects.toThrow('exact native position');
    expect(reads).toBe(0);
  });

  it('turns lagging withdrawal and deletion into newer deletes, then restores the same Space identity', async () => {
    let readPosition = 21n;
    let current: ReturnType<typeof indexed> | null = null;
    const source: NativeSource = {
      dependencies,
      async read(p, ids) {
        return { partition: p, position: readPosition, spaces: current && ids.includes(current.id) ? [current] : [] };
      },
      async count(p) {
        return { partition: p, position: readPosition, count: 1 };
      },
      async page(p) {
        return { partition: p, position: 20n, spaces: [indexed(firstId)], next: null };
      },
    };
    const adapter = adapterFor(
      source,
      async (ids) => new Map(ids.flatMap((id) => (current?.id === id ? [[id, summary(id)]] : []))),
    );
    const prepared = await adapter.preparePage(partition, null, 10);
    expect(prepared.actions).toEqual([{ op: 'delete', id: `discovery-v1:space:${firstId}`, version: 21n }]);
    expect(await adapter.hydrate([firstId], { deadline: 1 })).toEqual(new Map());

    readPosition = 23n;
    current = indexed(firstId, null, otherId);
    const restored = await adapter.preparePage(partition, null, 10);
    expect(restored.actions).toMatchObject([
      { op: 'index', id: `discovery-v1:space:${firstId}`, version: 23n, document: { revision: otherId } },
    ]);
    expect((await adapter.hydrate([firstId], { deadline: 1 })).get(firstId)?.name).toBe(`Current ${firstId[0]}`);
  });
});
