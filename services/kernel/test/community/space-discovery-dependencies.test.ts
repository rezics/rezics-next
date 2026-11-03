import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { Pool } from 'pg';
import { bundledRelease } from '@rezics/definitions/bundled';
import { PLATFORM_RESOURCE } from '../../src/access/bootstrap-governance.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { projectBatch, type CloudEvent } from '../../src/events/log.ts';
import { initializeSpaceDiscoveryDependencies } from '../../src/community/space-discovery-dependencies.ts';
import { drainSpaceDiscoveryFrontier, openSpaceDiscoveryFrontier, readSpaceDiscoveryFrontier } from '../../src/community/space-discovery-frontier.ts';
import { createSpaceDiscoveryEffect, readSpaceDiscoverySummaries, spaceDiscoverySource } from '../../src/community/space-discovery.ts';
import { SPACE_DISCOVERY_INVALIDATED, type SpaceDiscoveryInvalidation } from '../../src/community/space-discovery-events.ts';
import { takedownSourceFence } from '../../src/content/source-fence-command.ts';
import { tupleRoute } from '../../src/content/imported-contract.ts';
import { productionActions } from '../support/production-actions.ts';
import { contentGovernanceCredential, createContentSystemWithOrdinaryScopes, type ContentSystem } from '../content/support/system.ts';

let system: ContentSystem;
beforeAll(async () => {
  system = await createContentSystemWithOrdinaryScopes({ databaseUrl: process.env.DATABASE_URL! },
    [...productionActions().keys()].filter((action) => action !== 'media:complete'));
  await bootstrapRelease(system.database.pool, bundledRelease);
  system.database.pool.options.max = 1;
}, 120_000);
afterAll(async () => { await system?.close(); });

async function call(method: string, path: string, body?: unknown, head?: string, bearer = system.actors.author.bearer) {
  const response = await system.kernel.handle(new Request(`https://content.test${path}`, {
    method, headers: {
      authorization: `Bearer ${bearer}`, 'idempotency-key': JSON.stringify(crypto.randomUUID()),
      'content-type': 'application/json', ...(head ? { 'if-match': JSON.stringify(head) } : {}),
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  const value = await response.json() as any;
  expect(response.status, JSON.stringify(value)).toBeLessThan(300);
  return value;
}

async function events(partition: number, consumer = crypto.randomUUID()) {
  const found: CloudEvent[] = [];
  for (;;) {
    const result = await projectBatch(system.database.pool, {
      partition, consumer, async apply(envelopes) { found.push(...envelopes.flatMap((e) => e.events)); },
    });
    if (result.status !== 'read') throw new Error(JSON.stringify(result));
    if (!result.envelopes) return found;
  }
}

// Fail the actual native acknowledgement transaction after a foreign Space wake
// committed, without modifying the shared pool or retaining a checkout.
function crashBeforeAcknowledgement(pool: Pool): Pool {
  return new Proxy(pool, { get(target, property) {
    if (property === 'connect') return async () => {
      const client = await target.connect();
      return new Proxy(client, { get(connection, name) {
        if (name === 'query') return (...args: any[]) => {
          if (typeof args[0] === 'string' && args[0].includes('SET cursor=$4,examined='))
            throw new Error('simulated frontier acknowledgement crash');
          return Reflect.apply(connection.query, connection, args);
        };
        const value = Reflect.get(connection, name);
        return typeof value === 'function' ? value.bind(connection) : value;
      } });
    };
    const value = Reflect.get(target, property);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}

test('shared native Context changes drain sparse retained identities, survive restart and converge with live edits and removal', async () => {
  const pool = system.database.pool;
  const governance = await contentGovernanceCredential(system);
  await call('POST', '/v1/grants', { resource: PLATFORM_RESOURCE,
    subject: { kind: 'account', id: system.actors.author.actor.accountId },
    actions: ['context:create'], valid: '(,)',
  }, undefined, governance.bearer);
  const { context } = await call('POST', '/v1/contexts', { labels: { en: 'Shared native discovery context' } });
  const owners: any[] = [];
  for (let i = 0; i < 3; i++) {
    const { space } = await call('POST', '/v1/spaces', { title: `Space ${i}` });
    const { realm } = await call('POST', '/v1/realms', {
      spaceId: space.spaceId, title: `Realm ${i}`, contextId: context.id, visibility: i ? 'public' : 'protected',
    });
    owners.push({ space, realm });
  }
  await call('DELETE', `/v1/contexts/${context.id}`);
  const partition = partitionOf(routeOf(context.id)!);
  const native = (await events(partition)).find((e) => e.type === 'com.rezics.semantic.record.deleted.v1' && e.subject === context.id)!;
  expect(native).toBeDefined();
  const relay = createSpaceDiscoveryEffect(pool);
  await relay.run(native);
  const scope = (await events(partition)).find((e) => e.type === SPACE_DISCOVERY_INVALIDATED &&
    (e.data as SpaceDiscoveryInvalidation).origin.eventId === native.id)!;
  const key = (await openSpaceDiscoveryFrontier(pool, scope))!;
  const first = owners[0].space;
  const home = partitionOf(routeOf(first.spaceId)!);
  await pool.query(`UPDATE community.space_discovery_dependency_install
    SET complete=false,cursor_route=$2,cursor_id='00000000-0000-0000-0000-000000000000',
      cut_route=$3,cut_id=$4 WHERE partition_no=$1`, [home, home * 16, routeOf(first.spaceId), first.spaceId]);
  expect(await drainSpaceDiscoveryFrontier(pool, key, 1)).toBe('preparing');
  const source = spaceDiscoverySource({ pool, access: system.access });
  expect((await source.dependencies()).state).toBe('preparing');
  while (await initializeSpaceDiscoveryDependencies(pool, home, 1)) { /* raw bounded installation pages */ }
  expect(await source.dependencies()).toMatchObject({ state: 'unavailable', capabilities: { 'source-fence': 'unavailable' } });
  const hydrate = (ids: string[]) => readSpaceDiscoverySummaries({ pool, access: system.access }, ids, { deadline: Date.now() + 30_000 });
  expect((await hydrate(owners.map((o) => o.space.spaceId))).size).toBe(0);
  await expect(drainSpaceDiscoveryFrontier(crashBeforeAcknowledgement(pool), key, 1))
    .rejects.toThrow('simulated frontier acknowledgement crash');
  // A fresh invocation has no in-memory page state; the committed wake is reused.
  expect(await drainSpaceDiscoveryFrontier(pool, await openSpaceDiscoveryFrontier(pool, scope) as typeof key, 1)).toBe('draining');
  await call('POST', `/v1/contexts/${context.id}:restore`, {});
  const last = owners[2];
  // Move a dependency across the captured cut. Both actual Realm changes retain
  // native direct wakes; an old scope cannot replace their current truth.
  const changed = await call('PATCH', `/v1/realms/${last.realm.realmId}`, { contextId: GLOBAL_CONTEXT }, last.realm.headRevisionId);
  await call('PATCH', `/v1/realms/${last.realm.realmId}`, { contextId: context.id }, changed.realm.headRevisionId);
  const { container } = await call('GET', `/v1/spaces/${last.space.spaceId}/lifecycle`);
  await call('POST', `/v1/spaces/${last.space.spaceId}/removal`,
    { expectedVersion: container.version, reason: 'Owner removal' }, last.space.headRevisionId);
  for (let pages = 0; pages < 4; pages++) {
    if (await drainSpaceDiscoveryFrontier(pool, key, 1) === 'settled') break;
  }
  const progress = (await readSpaceDiscoveryFrontier(pool, key))!;
  expect(progress.state).toBe('settled');
  expect(progress.cursor).toBe(progress.cut!);
  expect(BigInt(progress.examined)).toBe(2n);
  await relay.run(native); // reordered old removal, after current restoration
  expect(await drainSpaceDiscoveryFrontier(pool, key, 1)).toBe('settled');
  for (const o of owners) {
    const nativeChanges = (await events(partitionOf(routeOf(o.space.spaceId)!))).filter((e) =>
      relay.types.includes(e.type) && [o.space.spaceId, o.realm.realmId].includes(e.subject));
    for (const event of nativeChanges.toReversed()) await relay.run(event);
  }
  const wakes = (await Promise.all([...new Set(owners.map((o) => partitionOf(routeOf(o.space.spaceId)!)))].map((p) => events(p))))
    .flat().filter((e) => e.type === SPACE_DISCOVERY_INVALIDATED &&
      (e.data as SpaceDiscoveryInvalidation).origin.eventId === native.id &&
      (e.data as SpaceDiscoveryInvalidation).target.kind === 'space');
  expect(wakes).toHaveLength(2);
  expect(new Set(wakes.map((e) => e.subject)).size).toBe(2);
  for (const wake of wakes) expect((wake.data as SpaceDiscoveryInvalidation).origin).toEqual((scope.data as SpaceDiscoveryInvalidation).origin);
  const current = await hydrate(owners.map((o) => o.space.spaceId));
  expect([...current.keys()]).toEqual([owners[1].space.spaceId]);
}, 120_000);

test('native Search exposure wakes include standalone Spaces; source tuples stay unavailable without their producer', async () => {
  const governance = await contentGovernanceCredential(system);
  const { space } = await call('POST', '/v1/spaces', { title: 'Standalone exposure dependency' });
  await call('POST', '/v1/platform/exposure/search:close', {}, undefined, governance.bearer);
  const exposure = (await events(0)).find((e) => e.type === 'com.rezics.access.exposure.closed.v1' &&
    (e.data as { group: string }).group === 'search')!;
  expect(exposure).toBeDefined();
  const relay = createSpaceDiscoveryEffect(system.database.pool);
  await relay.run(exposure);
  const exposureScope = (await events(0)).find((e) => e.type === SPACE_DISCOVERY_INVALIDATED &&
    (e.data as SpaceDiscoveryInvalidation).origin.eventId === exposure.id)!;
  const exposureKey = (await openSpaceDiscoveryFrontier(system.database.pool, exposureScope))!;
  expect(await drainSpaceDiscoveryFrontier(system.database.pool, exposureKey)).toBe('settled');
  const direct = (await events(partitionOf(routeOf(space.spaceId)!))).find((e) =>
    e.type === SPACE_DISCOVERY_INVALIDATED && e.subject === space.spaceId &&
    (e.data as SpaceDiscoveryInvalidation).origin.eventId === exposure.id)!;
  expect((direct.data as SpaceDiscoveryInvalidation).target).toEqual({ kind: 'space', id: space.spaceId });
  const tuple = { source: 'example', external_id: 'space-dependency-unavailable', field_group: 'cover' as const };
  await takedownSourceFence({ pool: system.database.pool, access: system.access, routeKey: system.routeKey }, governance.actor,
    { ...tuple, reason: 'Private evidence' }, { idempotencyKey: crypto.randomUUID(), requestId: crypto.randomUUID(), deadline: Date.now() + 30_000 });
  const partition = partitionOf(tupleRoute(system.routeKey, tuple.source, tuple.external_id));
  const native = (await events(partition)).find((e) => e.type === 'com.rezics.content.source_fence.taken_down.v1')!;
  await createSpaceDiscoveryEffect(system.database.pool).run(native);
  const scope = (await events(partition)).find((e) => e.type === SPACE_DISCOVERY_INVALIDATED &&
    (e.data as SpaceDiscoveryInvalidation).origin.eventId === native.id)!;
  const key = (await openSpaceDiscoveryFrontier(system.database.pool, scope))!;
  expect(await drainSpaceDiscoveryFrontier(system.database.pool, key)).toBe('unavailable');
  expect(await drainSpaceDiscoveryFrontier(system.database.pool, key)).toBe('unavailable');
}, 120_000);
