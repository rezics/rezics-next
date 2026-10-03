import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { authorCreditFixture } from '../fixtures/author-credit.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { createAgentGraph } from '../../../services/main/src/modules/agent/graph.ts';
import { AccessRealmManagement } from '../../../services/main/src/modules/access/realm-management.ts';
import { S3ImmutableObjects } from '../../../services/main/src/infrastructure/immutable-objects.ts';
import { readZoneConfiguration } from '../../../services/main/src/modules/zone/configuration.ts';
import { readZonePublication } from '../../../services/main/src/modules/zone/publication.ts';

test('G961: registry mentions, viewer-aware private and unlisted Sites, canonical reads and mixed batches', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated QA integration tier');
  const directory = resolve('.temp', `g-961-${randomUUID()}`);
  const f = await authorCreditFixture(
    Bun.env as Record<string, string>,
    directory,
    'openid work:create work:edit work:read space:create zone:edit owner:operate semantic:read',
  );
  try {
    await createAgentGraph(f.env, {
      id: randomUUID(),
      agent: f.actor,
      kind: 'person',
      displayName: 'Site editor',
      digest: createHash('sha256').update(f.actor).digest('hex'),
    });
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
    const createSite = async (disclosure: 'public' | 'private', name: string) => {
      const key = `site-${randomUUID().slice(0, 8)}`;
      const { space, realm } = await f.json<{ space: string; realm: string }>(
        await f.call('POST', '/v1/spaces', {
          profile: 'space-realm-v2', handle: key, name: 'A routed community',
          language: 'en', capabilities: ['realm'], actingSubject: f.actor,
        }), 201,
      );
      const zone = `https://rezics.com/id/${randomUUID()}`;
      await f.grant(`zone:edit:${zone}`, 'zone.edit');
      await f.json(await f.call('POST', '/v1/zones', {
        zone, space, disclosure, name, language: 'en', actingSubject: f.actor,
      }), 201);
      return { key, space, realm, zone };
    };
    let { key, space, realm, zone } = await createSite('public', 'A canonical Site');
    const principal = await f.account.verifier.verify(new Request('http://main.local', {
      headers: { authorization: `Bearer ${f.account.tokenA}` },
    }), []);
    const admin = new AccessRealmManagement(f.accessPool);
    const settings = async (visibility: 'public' | 'private') => {
      await admin.initialize(principal, realm, f.actor, f.env);
      await f.grant(`governance:realm:${realm}`, 'realm.owner');
      const current = await admin.spaceSettings(principal, space, f.actor, f.env);
      await admin.changeSpaceSettings(principal, space, {
        actingSubject: f.actor, expectedGeneration: current.generation,
        reason: 'Exercise canonical Site disclosure and listing',
        settings: { visibility, listing: 'unlisted', history: 'everything', admission: 'invitation' },
      }, randomUUID(), f.env);
    };
    await f.grant(`zone:official:${zone}`, 'zone.official');
    await f.json(
      await f.call('PUT', `/v1/zones/${zone.slice(-36)}/configuration`, {
        expectedHead: (await readZoneConfiguration(f.env, zone)).revision,
        actingSubject: f.actor,
        official: {},
        defaultRealm: realm,
      }),
      200,
    );
    const app = createMainApp(f.env.fuseki, {
      environment: f.env,
      account: f.account.verifier,
      access: f.access,
    });
    const publicCall = (path: string, body?: object) =>
      app.handle(
        new Request(`http://main.local${path}`, {
          method: body ? 'POST' : 'GET',
          ...(body
            ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
            : {}),
        }),
      );
    const path = () => `/v1/addresses/resolve?${new URLSearchParams({ scope: 'space', key })}`;
    const authenticatedPath = () => path() + `&actingSubject=${encodeURIComponent(f.actor)}`;
    const canonical = { prefix: '/z/', key, slugSource: 'A canonical Site' };
    const summaries = async (references: string[]) =>
      f.json<{ summaries: Array<Record<string, unknown>> }>(
        await publicCall('/v1/resources/summaries', {
          profile: 'resource-summary-batch-v1',
          resources: references,
        }),
        200,
      );
    expect((await summaries([zone])).summaries[0]).toMatchObject({
      status: 'available',
      type: 'zone',
      name: { value: 'A canonical Site', language: 'en' },
      address: canonical,
    });
    expect(
      await f.json(await publicCall(`/v1/zones/${zone.slice(-36)}/presentation`), 200),
    ).toMatchObject({ address: canonical });
    expect(await f.json(await publicCall('/v1/zones?official=true'), 200)).toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({ zone, routeSegment: key, address: canonical }),
      ]),
    });
    // Configuration revisions must replace the same projected title used by
    // summaries, canonical Site presentation and the official directory.
    await f.json(await f.call('PUT', `/v1/zones/${zone.slice(-36)}/configuration`, {
      expectedHead: (await readZoneConfiguration(f.env, zone)).revision,
      actingSubject: f.actor,
      name: 'Renamed canonical Site',
      language: 'en',
    }), 200);
    canonical.slugSource = 'Renamed canonical Site';
    expect((await summaries([zone])).summaries[0]).toMatchObject({
      name: { value: canonical.slugSource, language: 'en' },
      address: canonical,
    });
    expect(await f.json(await publicCall(`/v1/zones/${zone.slice(-36)}/presentation`), 200))
      .toMatchObject({ name: canonical.slugSource, address: canonical });
    expect(await f.json(await publicCall('/v1/zones?official=true'), 200)).toMatchObject({
      items: expect.arrayContaining([expect.objectContaining({ zone, address: canonical })]),
    });
    expect(
      (await f.accessPool.query("SELECT to_regclass('access.agent_handle') AS bridge")).rows[0]
        ?.bridge,
    ).toBeNull();
    const foreign = 'https://example.org/non-native/日本語',
      missing = `https://rezics.com/id/${randomUUID()}`;
    expect((await summaries([foreign, zone, missing, foreign])).summaries).toMatchObject([
      { reference: foreign, status: 'unavailable' },
      { reference: zone, status: 'available' },
      { reference: missing, status: 'unavailable' },
      { reference: foreign, status: 'unavailable' },
    ]);
    await settings('public');
    expect((await publicCall(path())).status).toBe(200);
    expect(await f.json(await publicCall('/v1/zones?official=true'), 200)).toMatchObject({
      items: expect.not.arrayContaining([expect.objectContaining({ zone })]),
    });
    // A Zone's disclosure belongs to its immutable configuration. Create a
    // private Zone through its owner rather than corrupting the public head;
    // Space policy changes remain independent and use the policy owner.
    ({ key, space, realm, zone } = await createSite('private', canonical.slugSource));
    canonical.key = key;
    await settings('private');
    expect(await readZoneConfiguration(f.env, zone)).toMatchObject({
      name: canonical.slugSource, disclosure: 'private', spaceVisibility: 'private',
      configuration: { disclosure: 'private' },
    });
    // Use actual Access grants with a separately authenticated denied Account.
    const spaceGrant = await f.grant(`semantic:read:${space}`, 'semantic.read');
    const zoneGrant = await f.grant(`semantic:read:${zone}`, 'semantic.read');
    const privateCanonical = { ...canonical, slugSource: '' };
    expect((await publicCall(path())).status).toBe(404);
    expect(
      (await f.call('GET', authenticatedPath(), undefined, randomUUID(), f.account.tokenB)).status,
    ).toBe(404);
    expect(await f.json(await f.call('GET', authenticatedPath()), 200)).toMatchObject({
      holder: space,
      canonical: privateCanonical,
      capabilities: { zone },
    });
    expect(
      await f.json(
        await f.call('POST', '/v1/addresses/resolutions', {
          actingSubject: f.actor,
          lookups: [{ scope: 'space', key }],
        }),
        200,
      ),
    ).toMatchObject({ results: [{ status: 'resolved', canonical: privateCanonical }] });
    expect(
      await f.json(
        await f.call('POST', '/v1/resources/summaries', {
          profile: 'resource-summary-batch-v1',
          actingSubject: f.actor,
          resources: [space, zone, foreign],
        }),
        200,
      ),
    ).toMatchObject({
      summaries: [
        { status: 'available', disclosure: 'restricted', address: privateCanonical },
        { status: 'available', disclosure: 'restricted', address: privateCanonical },
        { reference: foreign, status: 'unavailable' },
      ],
    });
    // The canonical publication owner omits a private title from URL decoration.
    expect((await readZonePublication(f.env, zone)).address).toEqual(privateCanonical);
    await f.accessPool.query('UPDATE access.permission_grant SET active = false WHERE id = $1', [
      zoneGrant,
    ]);
    const zoneAlias = `/v1/addresses/resolve?${new URLSearchParams({ scope: 'space', key: zone.slice(-36), actingSubject: f.actor })}`;
    expect((await f.call('GET', zoneAlias)).status).toBe(404);
    await f.accessPool.query('UPDATE access.permission_grant SET active = false WHERE id = $1', [
      spaceGrant,
    ]);
    // The creator's independent Realm mandate is a valid Space read basis;
    // revoke that too before asserting that all of the reader's bases are gone.
    await f.accessPool.query(
      `UPDATE access.permission_grant SET active = false
      WHERE recipient_subject = $1 AND scope_id = $2 AND action = 'realm.owner'`,
      [f.actor, `governance:realm:${realm}`],
    );
    expect((await f.call('GET', authenticatedPath())).status).toBe(404);
  } finally {
    await f.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);
