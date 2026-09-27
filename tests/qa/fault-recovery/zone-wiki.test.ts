import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { authorCreditFixture, nativeId, shortId } from '../fixtures/author-credit.ts';
import { S3ImmutableObjects, type ImmutableObjects }
  from '../../../services/main/src/infrastructure/immutable-objects.ts';
import { readZoneConfiguration } from '../../../services/main/src/modules/zone/configuration.ts';

test('WIKI02/VIEW06: Zone owner bootstrap and configuration recover exact lost graph responses', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated fault/recovery tier');
  const f = await authorCreditFixture(Bun.env as Record<string, string>,
    resolve('.temp', `zone-wiki-fault-${randomUUID()}`),
    'openid work:create work:read space:create zone:edit semantic:read');
  const objects = new S3ImmutableObjects({ endpoint: Bun.env.MAIN_S3_ENDPOINT!,
    bucket: Bun.env.MAIN_S3_BUCKET!, region: Bun.env.MAIN_S3_REGION!,
    accessKeyId: Bun.env.MAIN_S3_ACCESS_KEY!, secretAccessKey: Bun.env.MAIN_S3_SECRET_KEY!,
    prefix: 'semantic/structure/' });
  await objects.initialize();
  (f.env as typeof f.env & { structureObjects: ImmutableObjects }).structureObjects = objects;
  try {
    await f.grant('space:create:root', 'space.create');
    const space = await f.json<{ space: string }>(await f.call('POST', '/v1/spaces', {
      profile: 'space-realm-v1', name: 'Recoverable wiki', capabilities: ['realm'],
      actingSubject: f.actor }), 201);
    const zone = nativeId();
    const editGrant = await f.grant(`zone:edit:${zone}`, 'zone.edit');
    await f.grant(`semantic:read:${zone}`, 'semantic.read');
    const original = f.env.fuseki;
    let lostOwner = false;
    f.env.fuseki = new Proxy(original, { get(target, property) {
      if (property === 'commandWithReceipt') return async (...args: Parameters<typeof target.commandWithReceipt>) => {
        const result = await target.commandWithReceipt(...args);
        if (!lostOwner && args[0].update.includes('ZoneCreateEvent')) {
          lostOwner = true;
          throw new Error('lost Zone owner acknowledgement');
        }
        return result;
      };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } }) as typeof original;
    const createKey = `zone-fault-create-${randomUUID()}`;
    const createBody = { zone, space: space.space, disclosure: 'public', actingSubject: f.actor };
    const created = await f.json<{ navigation: string; revision: string }>(await f.call('POST',
      '/v1/zones', createBody, createKey), 201);
    f.env.fuseki = original;
    expect(lostOwner).toBe(true);
    expect((await f.json<{ navigation: string; revision: string; replayed: boolean }>(await f.call(
      'POST', '/v1/zones', createBody, createKey), 200)))
      .toMatchObject({ navigation: created.navigation, revision: created.revision, replayed: true });
    const zoneRevisions = await f.env.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
      SELECT (COUNT(?revision) AS ?count) WHERE { GRAPH <urn:rezics:graph:revisions> {
        ?revision a rv:ZoneRevision ; rv:component <${zone}> . } }`);
    expect(zoneRevisions.results?.bindings[0]?.count?.value).toBe('1');
    const current = await readZoneConfiguration(f.env, zone);
    const advancedBase64 = Buffer.from(JSON.stringify({ futureLayout: { untouched: true } })).toString('base64');
    let lostConfig = false;
    f.env.fuseki = new Proxy(original, { get(target, property) {
      if (property === 'commandWithReceipt') return async (...args: Parameters<typeof target.commandWithReceipt>) => {
        const result = await target.commandWithReceipt(...args);
        if (!lostConfig && args[0].update.includes('ZoneConfigureEvent')) {
          lostConfig = true;
          throw new Error('lost Zone configuration acknowledgement');
        }
        return result;
      };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } }) as typeof original;
    const configKey = `zone-fault-config-${randomUUID()}`;
    const configBody = { expectedHead: current.revision, actingSubject: f.actor,
      advancedBase64, budget: { rows: 2, timeMs: 500 } };
    const path = `/v1/zones/${shortId(zone)}/configuration`;
    const configured = await f.json<{ revision: string }>(await f.call('PUT', path,
      configBody, configKey), 200);
    f.env.fuseki = original;
    expect(lostConfig).toBe(true);
    expect((await f.json<{ revision: string; replayed: boolean }>(await f.call('PUT', path,
      configBody, configKey), 200))).toMatchObject({ revision: configured.revision, replayed: true });
    expect((await readZoneConfiguration(f.env, zone)).advancedBase64).toBe(advancedBase64);
    await f.accessPool.query('UPDATE access.permission_grant SET active = false WHERE id = $1', [editGrant]);
    expect((await f.call('PUT', path, { expectedHead: configured.revision,
      actingSubject: f.actor, budget: { rows: 3, timeMs: 500 } })).status).toBe(403);
    expect((await readZoneConfiguration(f.env, zone)).revision).toBe(configured.revision);
  } finally { await f.close(); }
}, 180_000);
