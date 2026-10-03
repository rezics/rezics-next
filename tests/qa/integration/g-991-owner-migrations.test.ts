import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from 'pg';
import { authorCreditFixture } from '../fixtures/author-credit.ts';
import { createAgentGraph } from '../../../services/main/src/modules/agent/graph.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { S3ImmutableObjects } from '../../../services/main/src/infrastructure/immutable-objects.ts';
import { readZoneConfiguration } from '../../../services/main/src/modules/zone/configuration.ts';
import { readWorkComponentState } from '../../../services/main/src/modules/work/history.ts';
import { GRAPHS, RV, iri, lit, prepareComponent } from '../../../services/main/src/modules/work/activate.ts';
import { ZONE_PROFILE } from '../../../services/main/src/modules/zone/config-format.ts';
import { assertOwnerMigrationsComplete, migrateFixtureOwners, migrateOwnerData } from '../../../scripts/fixture/migrate.ts';
import { replacePrivate } from '../../../scripts/dev/config.ts';

test('G991: common owner migrations retain reads on deferral, import official names on retry and replay without changing heads', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through isolated integration QA');
  const apps = Bun.env as Record<string, string>;
  const directory = resolve('.temp', `g-991-migration-${randomUUID()}`);
  // QA bootstrap applies SQL directly without the dev/release ledger. Rebuild
  // only this disposable project's owners through the production runner so we
  // exercise a genuine fresh install and its retry instead of inventing history.
  for (const [database, schema] of [['ACCESS_DATABASE_URL', 'access'],
    ['ACCOUNT_RELAY_DATABASE_URL', 'relay']] as const) {
    const client = new Client({ connectionString: apps[database] });
    await client.connect();
    try {
      for (const owned of schema === 'access' ? ['access', 'commerce', 'quota', 'site'] : ['relay']) {
        await client.query(`DROP SCHEMA ${owned} CASCADE`);
      }
    }
    finally { await client.end(); }
  }
  const applied = await migrateFixtureOwners(apps);
  expect(applied.some(path => path.startsWith('services/main/migrations/access/'))).toBe(true);
  expect(applied.some(path => path.startsWith('services/main/migrations/relay/'))).toBe(true);
  expect(await migrateFixtureOwners(apps)).toEqual([]);
  const f = await authorCreditFixture(apps, directory,
    'openid space:create zone:edit owner:operate semantic:read');
  try {
    await createAgentGraph(f.env, { id: randomUUID(), agent: f.actor, kind: 'person',
      displayName: 'Stored Zone owner', digest: '1'.repeat(64) });
    const objects = new S3ImmutableObjects({ endpoint: apps.MAIN_S3_ENDPOINT!,
      bucket: apps.MAIN_S3_BUCKET!, region: apps.MAIN_S3_REGION!,
      accessKeyId: apps.MAIN_S3_ACCESS_KEY!, secretAccessKey: apps.MAIN_S3_SECRET_KEY!,
      prefix: 'semantic/structure/' });
    await objects.initialize();
    const workObjects = new S3ImmutableObjects({ endpoint: apps.MAIN_S3_ENDPOINT!,
      bucket: apps.MAIN_S3_BUCKET!, region: apps.MAIN_S3_REGION!,
      accessKeyId: apps.MAIN_S3_ACCESS_KEY!, secretAccessKey: apps.MAIN_S3_SECRET_KEY!,
      prefix: 'semantic/work/' });
    await workObjects.initialize();
    Object.assign(f.env, { structureObjects: objects, workObjects });
    await f.grant('space:create:root', 'space.create');
    const key = `g991-${randomUUID().slice(0, 8)}`;
    const { space, realm } = await f.json<{ space: string; realm: string }>(
      await f.call('POST', '/v1/spaces', { profile: 'space-realm-v2', handle: key,
        name: 'Stored community', language: 'en', capabilities: ['realm'], actingSubject: f.actor }), 201);
    const zone = `https://rezics.com/id/${randomUUID()}`;
    await f.grant(`zone:edit:${zone}`, 'zone.edit');
    await f.json(await f.call('POST', '/v1/zones', { zone, space, disclosure: 'public',
      name: 'Stored official Zone', language: 'en', actingSubject: f.actor }), 201);
    await f.grant(`zone:official:${zone}`, 'zone.official');
    await f.json(await f.call('PUT', `/v1/zones/${zone.slice(-36)}/configuration`, {
      expectedHead: (await readZoneConfiguration(f.env, zone)).revision,
      actingSubject: f.actor, official: {}, defaultRealm: realm }), 200);
    const head = await readZoneConfiguration(f.env, zone);
    const legacy = { ...head.configuration, official: { routeSegment: key } };
    const manifest = prepareComponent(directory, zone,
      { configuration: legacy, name: head.name, language: head.language }, ZONE_PROFILE);
    const manifestBytes = readFileSync(`${directory}/${manifest}`);
    await f.env.fuseki.update(`PREFIX rv: <${RV}>
      DELETE { GRAPH ${iri(GRAPHS.revisions)} { ${iri(head.revision)} rv:manifest ?manifest } }
      INSERT { GRAPH ${iri(GRAPHS.revisions)} { ${iri(head.revision)} rv:manifest ${iri(`urn:rezics:sha256:${manifest}`)} }
        GRAPH ${iri(GRAPHS.current)} { ${iri(zone)} rv:routeSegment ${lit(key)} } }
      WHERE { GRAPH ${iri(GRAPHS.revisions)} { ${iri(head.revision)} rv:manifest ?manifest } }`);
    const app = createMainApp(f.env.fuseki, { environment: f.env, account: f.account.verifier, access: f.access });
    const presentation = () => app.handle(new Request(`http://main.local/v1/zones/${zone.slice(-36)}/presentation`));
    expect((await presentation()).status).toBe(200);
    await f.accessPool.query('DELETE FROM access.name_graph_import WHERE data_epoch = $1', [f.env.lineage.dataEpoch]);
    await f.accessPool.query('UPDATE access.recovery_fence SET open = false WHERE id');
    const migrationApps = { ...apps, MAIN_OBJECT_DIRECTORY: directory };
    const deferred = await migrateOwnerData(migrationApps);
    expect(deferred[0]?.status).toBe('deferred');
    expect(() => assertOwnerMigrationsComplete(deferred)).toThrow('graph-names');
    const envFile = `${directory}/migration.env`;
    replacePrivate(envFile, Object.fromEntries(Object.entries(migrationApps)
      .filter(([name]) => /^(ACCESS_|ACCOUNT_|CONTENT_|FUSEKI_|MAIN_)/.test(name))));
    const prepare = () => spawnSync('task', ['dev:prepare', '--', '--existing-env', envFile],
      { encoding: 'utf8', timeout: 60_000 });
    const failedPreparation = prepare();
    expect(failedPreparation.status).not.toBe(0);
    expect(failedPreparation.stderr).toContain('Owner migrations deferred: graph-names');
    expect((await presentation()).status).toBe(200);
    expect((await readZoneConfiguration(f.env, zone)).revision).toBe(head.revision);
    await f.accessPool.query('UPDATE access.recovery_fence SET open = true WHERE id');
    const migrated = await migrateOwnerData(migrationApps);
    expect(migrated).toEqual([{ owner: 'graph-names', status: 'complete' }]);
    const upgraded = await readZoneConfiguration(f.env, zone);
    expect(upgraded.revision).not.toBe(head.revision);
    expect(upgraded.configuration).toEqual({ ...legacy, official: {} });
    expect((await readWorkComponentState(f.env, upgraded.manifest, zone, ZONE_PROFILE)).configuration)
      .toEqual(upgraded.configuration);
    expect(readFileSync(`${directory}/${manifest}`)).toEqual(manifestBytes);
    const resolved = await app.handle(new Request(`http://main.local/v1/addresses/resolve?scope=space&key=${key}`));
    expect(resolved.status, await resolved.clone().text()).toBe(200);
    expect(await resolved.json()).toMatchObject({ status: 'resolved', holder: space,
      canonical: { prefix: '/z/', key }, capabilities: { zone, realm } });
    expect((await presentation()).status).toBe(200);
    expect(await migrateOwnerData(migrationApps)).toEqual(migrated);
    const successfulPreparation = prepare();
    expect(successfulPreparation.status, successfulPreparation.stderr).toBe(0);
    expect((await readZoneConfiguration(f.env, zone)).revision).toBe(upgraded.revision);
  } finally {
    await f.accessPool.query('UPDATE access.recovery_fence SET open = true WHERE id');
    await f.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 120_000);
