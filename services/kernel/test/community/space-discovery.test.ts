import { productionActions } from '../support/production-actions.ts';
import sharp from 'sharp';
import { spaceDiscoverySource, readSpaceDiscoverySummaries } from '../../src/community/space-discovery.ts';
import { createImageJob } from '../../src/content/image-job.ts';
import { readRealmPresentationImages } from '../../src/content/realm-media.ts';
import { actionCatalogue } from '../../src/http/request.ts';
import type { Access } from '../../src/request/access.ts';
import { mediaRealmDownloadFixture } from '../content/media-realm-download-fixture.ts';
import { testAccess, testRouteKey } from '../support/test-kernel.ts';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { bundledRelease } from '@rezics/definitions/bundled';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { anchorRoute, newId, partitionOf, routeOf } from '../../src/route/route.ts';
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

let system: ContentSystem;
beforeAll(async () => {
  system = await createContentSystemWithOrdinaryScopes(
    { databaseUrl: process.env.DATABASE_URL! },
    [...productionActions().keys()].filter((action) => action !== 'media:complete'),
  );
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
    expect([space.spaceId, realm.realmId]).toContain(data.origin.resourceId);
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

test('Space bootstrap has exact native positions, sparse bounded pages and current anonymous hydration through lifecycle and media changes', async () => {
  const f = await mediaRealmDownloadFixture();
  try {
    const access = testAccess({
      pool: f.db.pool,
      actions: actionCatalogue(f.kernel),
      auth: {
        ...f.auth.host.service.verifier,
        fetch: (url: string | URL, init?: RequestInit) => f.auth.host.service.handler(new Request(url, init)),
      },
    });
    const deps = { pool: f.db.pool, access };
    const source = spaceDiscoverySource(deps);
    const hydrate = (ids: string[], currentAccess = access) =>
      readSpaceDiscoverySummaries({ ...deps, access: currentAccess }, ids, {
        deadline: Date.now() + 30_000,
      });
    const { space: host } = await f.checked('POST', '/v1/spaces', {
      title: 'Host metadata',
    });
    const { realm } = await f.checked('POST', '/v1/realms', {
      spaceId: host.spaceId,
      title: 'Native Realm name',
      summary: '  Current\n summary 😀  ',
      contextId: GLOBAL_CONTEXT,
      visibility: 'protected',
    });
    const route = routeOf(host.spaceId)!;
    const partition = partitionOf(route);
    // Choose an ordinary creation key for the same route, without creating unrelated Spaces.
    let key: string;
    do {
      key = crypto.randomUUID();
    } while (anchorRoute(testRouteKey(), `${f.governor.accountId}\ncommunity.space.create\n${key}`) !== route);
    const { space: standalone } = await f.checked(
      'POST',
      '/v1/spaces',
      {
        title: 'Standalone',
        summary: '😀'.repeat(161),
      },
      201,
      { key },
    );
    expect(routeOf(standalone.spaceId)).toBe(route);
    const after =
      (
        await f.db.pool.query<{ route: number; id: string }>(
          `SELECT route,space_id AS id FROM community.space
       WHERE route >= $1 AND (route,space_id)<($2::integer,$3::uuid)
       ORDER BY route DESC,space_id DESC LIMIT 1`,
          [partition * 16, route, host.spaceId],
        )
      ).rows[0] ?? null;
    const first = await source.page(partition, after, 1);
    expect(first.spaces).toEqual([]); // No fallback or refill past the protected occupied slot.
    expect(first.next).toEqual({ route, id: host.spaceId });
    const second = await source.page(partition, first.next, 1);
    expect(second.spaces).toMatchObject([
      {
        id: standalone.spaceId,
        name: 'Standalone',
        description: '😀'.repeat(160),
      },
    ]);
    expect([null, { route, id: standalone.spaceId }]).toContainEqual(second.next);
    const observed = await source.read(partition, [host.spaceId, standalone.spaceId, standalone.spaceId, newId(route)]);
    expect(observed.spaces.map((s) => s.id)).toEqual([standalone.spaceId]);
    const native = (
      await f.db.pool.query<{ position: string; population: string }>(
        `SELECT p.position::text, (SELECT count(*)::text FROM community.space WHERE route >= $2 AND route < $3) AS population
       FROM core.partition p WHERE partition_no=$1`,
        [partition, partition * 16, (partition + 1) * 16],
      )
    ).rows[0]!;
    const census = await source.count(partition);
    expect(observed.position).toBe(BigInt(native.position));
    expect(census).toEqual({
      partition,
      position: observed.position,
      count: Number(native.population),
    });
    expect(await hydrate([host.spaceId])).toEqual(new Map());
    expect((await hydrate([standalone.spaceId])).get(standalone.spaceId)?.avatar).toBeNull();
    await expect(source.read(partition, [newId((route + 16) % 65536)])).rejects.toThrow();
    await expect(source.read(partition, Array(101).fill(host.spaceId))).rejects.toThrow();
    await expect(source.page(partition, { id: host.spaceId, route: (route + 1) % 65536 }, 1)).rejects.toThrow();
    await expect(source.page(partition, null, 101)).rejects.toThrow();
    await f.db.pool.query("UPDATE core.partition SET write_state='fenced' WHERE partition_no=$1", [partition]);
    try {
      await expect(source.count(partition)).rejects.toThrow();
      await expect(source.read(partition, [standalone.spaceId])).rejects.toThrow();
      await expect(hydrate([standalone.spaceId])).rejects.toThrow();
    } finally {
      await f.db.pool.query("UPDATE core.partition SET write_state='active' WHERE partition_no=$1", [partition]);
    }

    const patch = async (body: unknown, kernel = f.kernel) => {
      const current = await f.call('GET', `/v1/realms/${realm.realmId}`, {
        kernel,
      });
      return f.checked('PATCH', `/v1/realms/${realm.realmId}`, body, 200, {
        kernel,
        headers: {
          'if-match': JSON.stringify(current.value.realm.headRevisionId),
        },
      });
    };
    await patch({ visibility: 'public' });
    const stale = await source.read(partition, [host.spaceId]);
    expect(stale.spaces).toMatchObject([
      {
        id: host.spaceId,
        realmId: realm.realmId,
        name: 'Native Realm name',
        description: 'Current summary 😀',
      },
    ]);
    await patch({ title: 'Edited native name' });
    expect((await hydrate(stale.spaces.map((s) => s.id))).get(host.spaceId)?.name).toBe('Edited native name');
    await patch({ visibility: 'protected' });
    expect(await hydrate(stale.spaces.map((s) => s.id))).toEqual(new Map());
    await patch({ visibility: 'public' });
    const lifecycle = async (
      kind: 'space' | 'realm',
      id: string,
      verb: 'removal' | 'restoration',
      kernel = f.kernel,
    ) => {
      const { container } = await f.checked('GET', `/v1/${kind}s/${id}/lifecycle`, undefined, 200, { kernel });
      await f.checked(
        'POST',
        `/v1/${kind}s/${id}/${verb}`,
        {
          expectedVersion: container.version,
          ...(verb === 'removal' ? { reason: 'Native removal' } : {}),
        },
        200,
        {
          kernel,
          headers: { 'if-match': JSON.stringify(container.headRevisionId) },
        },
      );
    };
    for (const [kind, id] of [
      ['space', host.spaceId],
      ['realm', realm.realmId],
    ] as const) {
      await lifecycle(kind, id, 'removal');
      expect((await source.read(partition, [host.spaceId])).spaces).toEqual([]);
      expect(await hydrate([host.spaceId])).toEqual(new Map());
      expect((await source.count(partition)).count).toBe(census.count);
      await lifecycle(kind, id, 'restoration');
      expect((await hydrate([host.spaceId])).has(host.spaceId)).toBe(true);
    }

    const bytes = await sharp({
      create: { width: 96, height: 48, channels: 3, background: '#123456' },
    })
      .png()
      .toBuffer();
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const reservation = crypto.randomUUID();
    const { media } = await f.checked(
      'POST',
      `/v1/realms/${realm.realmId}/media`,
      {
        purpose: 'realm-icon',
        mediaType: 'image/png',
        byteCount: bytes.length,
        sha256,
      },
      201,
      { key: reservation },
    );
    await f.storage.storage.put(`m/${media.id}/original`, bytes, {
      mediaType: 'image/png',
    });
    await f.checked(
      'POST',
      `/v1/media/${media.id}:complete`,
      {
        containerId: realm.realmId,
        reservationRequestId: reservation,
        byteCount: bytes.length,
        sha256,
      },
      200,
      { bearer: f.governor.websiteBearer },
    );
    expect((await createImageJob(f.db.pool, f.storage.storage).process(media.id)).state).toBe('available');
    await patch({
      presentation: {
        avatarMediaId: media.id,
        bannerMediaId: null,
        rules: null,
      },
    });
    const nativeAvatar = await readRealmPresentationImages(
      deps,
      {
        realmId: realm.realmId,
        avatarMediaId: media.id,
        bannerMediaId: null,
      },
      { actor: { kind: 'anonymous' }, deadline: Date.now() + 30_000 },
    );
    expect(nativeAvatar.avatar.state).toBe('available');
    const summary = (await hydrate([host.spaceId])).get(host.spaceId)!;
    expect(summary.avatar).toEqual(nativeAvatar.avatar.value);
    expect(Object.keys(summary).sort()).toEqual([
      'address',
      'avatar',
      'description',
      'id',
      'name',
      'realmId',
      'realmTitle',
      'title',
    ]);
    expect(summary).toMatchObject({ address: null, title: 'Host metadata', realmTitle: 'Edited native name' });
    let boundary: 'failure' | 'edit' | 'cycle' = 'failure';
    let calls = 0;
    const duringMedia: Access = {
      ...access,
      async prepare(actor, action, resource, context) {
        if (action === 'media:read') {
          expect(actor).toEqual({ kind: 'anonymous' });
          calls++;
          if (boundary === 'failure') throw new Error('Optional source unavailable');
          if (boundary === 'edit') await patch({ visibility: 'protected' }, f.mutationKernel);
          if (boundary === 'cycle') {
            await lifecycle('space', host.spaceId, 'removal', f.mutationKernel);
            await lifecycle('space', host.spaceId, 'restoration', f.mutationKernel);
          }
        }
        return access.prepare?.(actor, action, resource, context);
      },
    };
    expect((await hydrate([host.spaceId], duringMedia)).get(host.spaceId)?.avatar).toBeNull();
    expect(calls).toBe(1);
    boundary = 'cycle';
    expect(await hydrate([host.spaceId], duringMedia)).toEqual(new Map());
    boundary = 'edit';
    expect(await hydrate([host.spaceId], duringMedia)).toEqual(new Map());
    expect(calls).toBe(3);
  } finally {
    await f.close();
  }
}, 180_000);
