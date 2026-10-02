import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { uuidToSid } from '@rezics/model/address/sid';
import { S3ImmutableObjects } from '../../../services/main/src/infrastructure/immutable-objects.ts';
import { readZoneConfiguration } from '../../../services/main/src/modules/zone/configuration.ts';
import { ZONE_RESERVED_SEGMENTS } from '../../../services/main/src/modules/zone/route-path.ts';
import { addressFixture } from './g-937-support.ts';

test('G937: Zone detail routes declare name or id keys and validate their namespace', async () => {
  const f = await addressFixture('zone');
  try {
    const objects = new S3ImmutableObjects({
      endpoint: Bun.env.MAIN_S3_ENDPOINT!,
      bucket: Bun.env.MAIN_S3_BUCKET!,
      region: Bun.env.MAIN_S3_REGION!,
      accessKeyId: Bun.env.MAIN_S3_ACCESS_KEY!,
      secretAccessKey: Bun.env.MAIN_S3_SECRET_KEY!,
      prefix: 'semantic/structure/',
    });
    await objects.initialize();
    Object.assign(f.env, { structureObjects: objects });
    await f.grant('space:create:root', 'space.create');
    const space = await f.json<{ space: string; realm: string }>(
      await f.call('POST', '/v1/spaces', {
        profile: 'space-realm-v1',
        name: 'A title wiki',
        language: 'en',
        capabilities: ['realm'],
        actingSubject: f.actor,
      }),
      201,
    );
    const zone = `https://rezics.com/id/${randomUUID()}`,
      collection = `https://rezics.com/id/${randomUUID()}`;
    await f.grant(`zone:edit:${zone}`, 'zone.edit');
    await f.grant(`semantic:read:${zone}`, 'semantic.read');
    const site = await f.json<{ revision: string }>(
      await f.call('POST', '/v1/zones', {
        zone,
        space: space.space,
        disclosure: 'public',
        name: 'The title wiki',
        language: 'en',
        actingSubject: f.actor,
      }),
      201,
    );
    await f.grant(`collection:edit:${collection}`, 'collection.edit');
    await f.grant(`semantic:read:${collection}`, 'semantic.read');
    const curated = await f.json<{ structure: string; revision: string }>(
      await f.call('POST', '/v1/collections', {
        collection,
        name: 'Pages',
        disclosure: 'public',
        actingSubject: f.actor,
      }),
      201,
    );
    const resource = await f.work('日本語のページ');
    await f.grant(`work:read:${resource.work}`, 'work.read');
    await f.json(
      await f.call('POST', `/v1/collections/${collection.slice(-36)}/changes`, {
        expectedHead: curated.revision,
        actingSubject: f.actor,
        operations: [
          {
            op: 'insert',
            role: 'member',
            parent: curated.structure,
            position: 'last',
            target: resource.work,
            selection: { mode: 'follow-context' },
          },
        ],
      }),
      200,
    );
    const root = `/v1/zones/${zone.slice(-36)}`;
    const mount = (segment: string, key: 'name' | 'id', head: string) =>
      f.call('POST', `${root}/mounts`, {
        expectedHead: head,
        target: collection,
        routeSegment: segment,
        key,
        disclosure: 'public',
        actingSubject: f.actor,
      });
    for (const reserved of ZONE_RESERVED_SEGMENTS)
      expect((await mount(reserved, 'name', site.revision)).status).toBe(409);
    const first = await f.json<{ revision: string }>(
      await mount('pages', 'name', site.revision),
      200,
    );
    expect((await mount('pages', 'id', first.revision)).status).toBe(409);
    await f.json(await mount('records', 'id', first.revision), 200);
    const named = await f.receipt(
      await f.nameWrite(`zone:${space.space}`, resource.work, 'claim', '日本語のページ', null),
    );
    const route = (path: string) => f.publicCall(`${root}/routes?${new URLSearchParams({ path })}`);
    expect(await f.json(await route('/pages/日本語のページ'), 200)).toMatchObject({
      kind: 'detail',
      mount: { key: 'name' },
      resource: {
        id: resource.work,
        address: {
          prefix: `/z/${uuidToSid(space.space.slice(-36))}/pages/`,
          key: '日本語のページ',
        },
      },
    });
    expect(
      await f.json(await route(`/records/${uuidToSid(resource.work.slice(-36))}-stale-title`), 200),
    ).toMatchObject({
      kind: 'detail',
      mount: { key: 'id' },
      resource: { address: { key: uuidToSid(resource.work.slice(-36)) } },
    });
    expect((await route('/records/日本語のページ')).status).toBe(404);
    expect(
      await f.json(await f.lookup(`zone:${space.space}`, '日本語のページ'), 200),
    ).toMatchObject({
      canonical: {
        prefix: `/z/${uuidToSid(space.space.slice(-36))}/pages/`,
        key: '日本語のページ',
      },
    });
    await f.receipt(
      await f.nameWrite(
        `zone:${space.space}`,
        resource.work,
        'rename',
        '新しいページ',
        named.revision,
      ),
    );
    expect(await f.json(await route('/pages/日本語のページ'), 200)).toMatchObject({
      resource: { address: { key: '新しいページ' } },
    });
    expect(await f.json(await f.lookup('space', zone.slice(-36)), 200)).toMatchObject({
      holder: space.space,
      canonical: { prefix: '/z/', key: uuidToSid(space.space.slice(-36)) },
    });
    expect((await readZoneConfiguration(f.env, zone)).configuration.official).toBeUndefined();
    const missing = `zone:https://rezics.com/id/${randomUUID()}`;
    expect((await f.nameWrite(missing, resource.work, 'claim', 'Other Page', null)).status).toBe(
      400,
    );
  } finally {
    await f.close();
  }
}, 30_000);
