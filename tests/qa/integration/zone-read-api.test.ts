import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { createMainApp } from '../../../services/main/src/app.ts';
import { S3ImmutableObjects, type ImmutableObjects }
  from '../../../services/main/src/infrastructure/immutable-objects.ts';
import { readZoneConfiguration } from '../../../services/main/src/modules/zone/configuration.ts';
import { DEFAULT_ZONE_PRESENTATION } from '../../../services/main/src/modules/zone/presentation-format.ts';
import { authorCreditFixture, nativeId, shortId } from '../fixtures/author-credit.ts';

test('public Realm resolves its community Zone and presentation with explicit read sources', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated integration tier');
  const f = await authorCreditFixture(Bun.env as Record<string, string>,
    resolve('.temp', `zone-read-${randomUUID()}`),
    'openid work:create work:read space:create zone:edit semantic:read');
  try {
    const objects = new S3ImmutableObjects({ endpoint: Bun.env.MAIN_S3_ENDPOINT!,
      bucket: Bun.env.MAIN_S3_BUCKET!, region: Bun.env.MAIN_S3_REGION!,
      accessKeyId: Bun.env.MAIN_S3_ACCESS_KEY!, secretAccessKey: Bun.env.MAIN_S3_SECRET_KEY!,
      prefix: 'semantic/structure/' });
    await objects.initialize();
    (f.env as typeof f.env & { structureObjects: ImmutableObjects }).structureObjects = objects;
    await f.grant('space:create:root', 'space.create');
    const space = await f.json<{ space: string; realm: string }>(await f.call('POST', '/v1/spaces', {
      profile: 'space-realm-v1', name: 'Community Zone', capabilities: ['realm'], actingSubject: f.actor,
    }), 201);
    const zone = nativeId();
    await f.grant(`zone:edit:${zone}`, 'zone.edit');
    await f.json(await f.call('POST', '/v1/zones', {
      zone, space: space.space, disclosure: 'public', actingSubject: f.actor,
    }), 201);
    const presentation = { ...DEFAULT_ZONE_PRESENTATION, modules: [{ id: 'latest',
      type: 'shelf' as const, title: 'Latest', titles: { fr: 'Nouveautés' },
      source: { kind: 'query-block' as const, block: 'new-adoptions' } }] };
    await f.json(await f.call('PUT', `/v1/zones/${shortId(zone)}/configuration`, {
      expectedHead: (await readZoneConfiguration(f.env, zone)).revision,
      defaultRealm: space.realm, presentation, actingSubject: f.actor,
    }), 200);
    const app = createMainApp(f.env.fuseki, { environment: f.env,
      account: f.account.verifier, access: f.access });
    const response = await app.handle(new Request(`http://main.local/v1/realms/${shortId(space.realm)}/zone`));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ profile: 'realm-zone-v1',
      zone, realm: space.realm, routeSegment: null, presentation });
    const publicRead = await app.handle(new Request(`http://main.local/v1/zones/${shortId(zone)}/presentation`));
    expect(publicRead.status).toBe(200);
    expect(await publicRead.json()).toMatchObject({ slideMedia: [],
      moduleData: [{ id: 'latest', sources: [{ state: 'public-read' }] }] });
    const missing = await app.handle(new Request(`http://main.local/v1/realms/${randomUUID()}/zone`));
    expect(missing.status).toBe(404);
  } finally { await f.close(); }
}, 120_000);
