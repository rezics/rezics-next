import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { spaceDiscoverySource, readSpaceDiscoverySummaries } from '../../src/community/space-discovery.ts';
import { createImageJob } from '../../src/content/image-job.ts';
import { readRealmPresentationImages } from '../../src/content/realm-media.ts';
import { actionCatalogue } from '../../src/http/request.ts';
import type { Access } from '../../src/request/access.ts';
import { anchorRoute, newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { mediaRealmDownloadFixture } from '../content/media-realm-download-fixture.ts';
import { testAccess, testRouteKey } from '../support/test-kernel.ts';

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
    expect(Object.keys(summary).sort()).toEqual(['avatar', 'description', 'id', 'name', 'realmId']);
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
