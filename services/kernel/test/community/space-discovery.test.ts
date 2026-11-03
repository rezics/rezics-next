import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { bundledRelease } from '@rezics/definitions/bundled';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { projectBatch, type CloudEvent } from '../../src/events/log.ts';
import { createSpaceDiscoveryEffect, spaceDiscoveryInvalidation } from '../../src/community/space-discovery.ts';
import {
  SPACE_DISCOVERY_INVALIDATED,
  type SpaceDiscoveryInvalidation,
} from '../../src/community/space-discovery-events.ts';
import { takedownSourceFence } from '../../src/content/source-fence-command.ts';
import { tupleRoute } from '../../src/content/imported-contract.ts';
import {
  createContentSystemWithOrdinaryScopes,
  contentGovernanceCredential,
  type ContentSystem,
} from '../content/support/system.ts';
import { productionActions } from '../support/production-actions.ts';

let system: ContentSystem;
beforeAll(async () => {
  system = await createContentSystemWithOrdinaryScopes({ databaseUrl: process.env.DATABASE_URL! }, [
    ...productionActions().keys(),
  ]);
  await bootstrapRelease(system.database.pool, bundledRelease);
}, 120_000);
afterAll(async () => {
  await system?.close();
});

async function call(method: string, path: string, input?: unknown, head?: string) {
  const response = await system.kernel.handle(
    new Request(`https://content.test${path}`, {
      method,
      headers: {
        authorization: `Bearer ${system.actors.author.bearer}`,
        'idempotency-key': JSON.stringify(crypto.randomUUID()),
        'content-type': 'application/json',
        ...(head ? { 'if-match': JSON.stringify(head) } : {}),
      },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    }),
  );
  const value = await response.json();
  const status = method === 'POST' && !/\/(removal|restoration)$/.test(path) ? 201 : 200;
  expect({ status: response.status, value }).toMatchObject({ status });
  return value as any;
}

async function events(partition: number, consumer: string) {
  const found: CloudEvent[] = [];
  for (;;) {
    const result = await projectBatch(system.database.pool, {
      partition,
      consumer,
      async apply(envelopes) {
        found.push(...envelopes.flatMap((envelope) => envelope.events));
      },
    });
    if (result.status !== 'read') throw new Error(`Unexpected relay result: ${JSON.stringify(result)}`);
    if (!result.envelopes) return found;
  }
}

test('native edits, protected Realm gates and removal/restoration deliver only versioned Space invalidations, including duplicate/reordered delivery', async () => {
  const { space } = await call('POST', '/v1/spaces', { title: 'Original place' });
  const { space: edited } = await call(
    'PATCH',
    `/v1/spaces/${space.spaceId}`,
    { title: 'New place', summary: 'Current purpose' },
    space.headRevisionId,
  );
  const address = `discovery_${crypto.randomUUID().replaceAll('-', '')}`;
  const { space: addressed } = await call(
    'PUT',
    `/v1/spaces/${space.spaceId}/address`,
    { address },
    edited.headRevisionId,
  );
  const { realm } = await call('POST', '/v1/realms', {
    spaceId: space.spaceId,
    title: 'Carried community',
    visibility: 'public',
    contextId: GLOBAL_CONTEXT,
  });
  await call('PATCH', `/v1/realms/${realm.realmId}`, { visibility: 'protected' }, realm.headRevisionId);
  const { container } = await call('GET', `/v1/spaces/${space.spaceId}/lifecycle`);
  const removed = await call(
    'POST',
    `/v1/spaces/${space.spaceId}/removal`,
    { expectedVersion: container.version, reason: 'Private moderation evidence' },
    addressed.headRevisionId,
  );
  await call(
    'POST',
    `/v1/spaces/${space.spaceId}/restoration`,
    { expectedVersion: removed.container.version },
    addressed.headRevisionId,
  );
  const partition = partitionOf(routeOf(space.spaceId)!);
  const native: CloudEvent[] = [];
  const effect = createSpaceDiscoveryEffect(system.database.pool);
  const addressPartition = partitionOf(createHash('sha256').update(address).digest().readUInt16BE(0));
  for (const home of new Set([partition, addressPartition])) {
    native.push(
      ...(await events(home, 'space_discovery_native_test')).filter(
        (event) => effect.types.includes(event.type) && [space.spaceId, realm.realmId].includes(event.subject),
      ),
    );
  }
  expect(native.some((event) => event.type === 'com.rezics.community.space.updated.v1')).toBe(true);
  expect(native.some((event) => event.type === 'com.rezics.community.realm.updated.v1')).toBe(true);
  expect(native.some((event) => event.type === 'com.rezics.community.space.removed.v1')).toBe(true);
  expect(native.some((event) => event.type === 'com.rezics.community.space.restored.v1')).toBe(true);
  expect(native.some((event) => event.type === 'com.rezics.community.space.address-activated.v1')).toBe(true);
  for (const event of native.toReversed()) await effect.run(event);
  for (const event of native) await effect.run(event);
  const delivered = (await events(partition, 'space_discovery_output_test')).filter(
    (event) => event.type === SPACE_DISCOVERY_INVALIDATED,
  );
  expect(delivered).toHaveLength(native.length);
  expect(new Set(delivered.map((event) => (event.data as SpaceDiscoveryInvalidation).origin.eventId)).size).toBe(
    native.length,
  );
  for (const event of delivered) {
    const data = event.data as SpaceDiscoveryInvalidation;
    expect(data.target).toEqual({ kind: 'space', id: space.spaceId });
    expect(native.find((source) => source.id === data.origin.eventId)!.source).toBe(
      `urn:rezics:log:${data.origin.partition}.${data.origin.epoch}`,
    );
    expect(BigInt(data.origin.position)).toBeGreaterThan(0n);
    expect(JSON.stringify(data)).not.toMatch(/New place|Current purpose|Private moderation/);
  }
  const update = native.find((event) => event.type === 'com.rezics.community.space.updated.v1')!;
  await expect(spaceDiscoveryInvalidation(system.database.pool, { ...update, subject: realm.realmId })).rejects.toThrow(
    'Invalid Space discovery native identity',
  );
}, 120_000);

test('a real source fence delivers one durable tuple obligation, without enumerating Spaces or copying removal evidence', async () => {
  const governance = await contentGovernanceCredential(system);
  const tuple = { source: 'example', external_id: 'public-space-avatar', field_group: 'cover' as const };
  await takedownSourceFence(
    { pool: system.database.pool, access: system.access, routeKey: system.routeKey },
    governance.actor,
    { ...tuple, reason: 'Private source evidence' },
    { idempotencyKey: crypto.randomUUID(), requestId: crypto.randomUUID(), deadline: Date.now() + 30_000 },
  );
  const route = tupleRoute(system.routeKey, tuple.source, tuple.external_id);
  const partition = partitionOf(route);
  const native = (await events(partition, 'space_discovery_fence_native_test')).find(
    (event) => event.type === 'com.rezics.content.source_fence.taken_down.v1',
  )!;
  expect(native).toBeDefined();
  const effect = createSpaceDiscoveryEffect(system.database.pool);
  await effect.run(native);
  await effect.run(native);
  const output = (await events(partition, 'space_discovery_fence_output_test')).filter(
    (event) =>
      event.type === SPACE_DISCOVERY_INVALIDATED &&
      (event.data as SpaceDiscoveryInvalidation).origin.eventId === native.id,
  );
  expect(output).toHaveLength(1);
  expect((output[0]!.data as SpaceDiscoveryInvalidation).target).toEqual({
    kind: 'source-fence',
    route,
    source: tuple.source,
    externalId: tuple.external_id,
    fieldGroup: 'cover',
  });
  expect((output[0]!.data as SpaceDiscoveryInvalidation).nativeVersion).toBe('1');
  expect(JSON.stringify(output)).not.toContain('Private source evidence');
}, 120_000);
