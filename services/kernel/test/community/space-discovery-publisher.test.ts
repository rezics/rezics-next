import { productionActions } from '../support/production-actions.ts';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { bundledRelease } from '@rezics/definitions/bundled';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { initializeSpaceDiscoveryDependencies } from '../../src/community/space-discovery-dependencies.ts';
import { publishNativeSpaceDiscoveryWitness } from '../../src/community/space-discovery-publisher.ts';
import { publishSpaceDiscoveryTupleWitness } from '../../src/community/space-discovery-source-fences.ts';
import { spaceDiscoverySource } from '../../src/community/space-discovery.ts';
import { createContentSystemWithOrdinaryScopes, type ContentSystem } from '../content/support/system.ts';

let system: ContentSystem;
beforeAll(async () => {
  system = await createContentSystemWithOrdinaryScopes(
    { databaseUrl: process.env.DATABASE_URL! },
    [...productionActions().keys()].filter((action) => action !== 'media:complete'),
  );
  await bootstrapRelease(system.database.pool, bundledRelease);
  system.database.pool.options.max = 1;
}, 120_000);
afterAll(async () => system?.close());

async function call(method: string, path: string, body: unknown, head?: string) {
  const response = await system.kernel.handle(
    new Request(`https://content.test${path}`, {
      method,
      headers: {
        authorization: `Bearer ${system.actors.author.bearer}`,
        'idempotency-key': JSON.stringify(crypto.randomUUID()),
        'content-type': 'application/json',
        ...(head ? { 'if-match': JSON.stringify(head) } : {}),
      },
      body: JSON.stringify(body),
    }),
  );
  const value = (await response.json()) as any;
  expect(response.status, JSON.stringify(value)).toBeLessThan(300);
  return value;
}

test('native authored heads publish complete absence independently of eligibility and reject a stale owner cut', async () => {
  const pool = system.database.pool;
  const source = spaceDiscoverySource({ pool, access: system.access, deadlineNow: () => Date.now() });
  const { space } = await call('POST', '/v1/spaces', { title: 'Native place' });
  const home = partitionOf(routeOf(space.spaceId)!);
  while (await initializeSpaceDiscoveryDependencies(pool, home)) {
    /* bounded retained inventory */
  }
  expect((await source.dependencies()).state).toBe('unavailable');
  expect(await publishNativeSpaceDiscoveryWitness(pool)).toBe(true);
  expect(await publishNativeSpaceDiscoveryWitness(pool)).toBe(false);
  const read = async () => (await source.tupleWitnesses(home, [space.spaceId])).get(space.spaceId)!;
  const first = await read();
  expect(first).toMatchObject({
    state: 'ready',
    complete: true,
    spaceRevision: space.headRevisionId,
    realmId: null,
    tuples: [],
    native: { partition: home, epoch: expect.any(Number), position: expect.stringMatching(/^\d+$/) },
  });
  const { realm } = await call('POST', '/v1/realms', {
    spaceId: space.spaceId,
    title: 'Private community',
    visibility: 'protected',
    contextId: GLOBAL_CONTEXT,
  });
  expect((await read()).complete).toBeUndefined();
  expect(await publishNativeSpaceDiscoveryWitness(pool)).toBe(true);
  const protectedWitness = await read();
  expect(protectedWitness).toMatchObject({
    state: 'ready',
    complete: true,
    realmId: realm.realmId,
    realmRevision: realm.headRevisionId,
    tuples: [],
  });
  expect(protectedWitness.witnessGeneration).not.toBe(first.witnessGeneration);
  expect((await source.read(home, [space.spaceId])).spaces).toEqual([]);
  const { realm: changed } = await call(
    'PATCH',
    `/v1/realms/${realm.realmId}`,
    {
      title: 'Current community',
      visibility: 'public',
    },
    realm.headRevisionId,
  );
  expect((await read()).complete).toBeUndefined();
  expect(await publishNativeSpaceDiscoveryWitness(pool)).toBe(true);
  const current = await read();
  expect(current).toMatchObject({ state: 'ready', complete: true, realmRevision: changed.headRevisionId });
  expect((await source.read(home, [space.spaceId])).spaces).toMatchObject([{ realmId: realm.realmId }]);
  await expect(
    publishSpaceDiscoveryTupleWitness(pool, {
      spaceId: space.spaceId,
      spaceRevision: space.headRevisionId,
      realmId: realm.realmId,
      realmRevision: changed.headRevisionId,
      producerGeneration: current.producerGeneration!,
      producerEpoch: String(first.native!.epoch),
      sourcePosition: first.native!.position,
      native: { epoch: first.native!.epoch, position: first.native!.position },
      tuples: [],
      origin: {
        partition: home,
        epoch: first.native!.epoch,
        position: first.native!.position,
        eventId: crypto.randomUUID(),
        resourceId: space.spaceId,
        type: 'com.rezics.community.native-heads.observed.v1',
      },
    }),
  ).rejects.toThrow('Native Space tuple source changed before publication');
  expect((await read()).witnessGeneration).toBe(current.witnessGeneration);
}, 120_000);
