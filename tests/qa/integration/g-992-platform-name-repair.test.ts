import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { rmSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { authorCreditFixture } from '../fixtures/author-credit.ts';
import { S3ImmutableObjects } from '../../../services/main/src/infrastructure/immutable-objects.ts';
import { readZoneConfiguration } from '../../../services/main/src/modules/zone/configuration.ts';
import { ZONE_PROFILE } from '../../../services/main/src/modules/zone/config-format.ts';
import {
  GRAPHS,
  RV,
  iri,
  lit,
  prepareWorkComponent,
} from '../../../services/main/src/modules/work/activate.ts';
import { migrateGraphNames } from '../../../services/main/src/modules/address/migrate.ts';
import {
  NameInvalid,
  type NameReceipt,
} from '../../../services/main/src/modules/address/registry.ts';
import { readWorkComponentState } from '../../../services/main/src/modules/work/history.ts';
import { createAgentGraph } from '../../../services/main/src/modules/agent/graph.ts';

test('G992: official claims retain all owner gates; completed imports repair retained names, publish bytes and replay', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through isolated integration QA');
  const directory = resolve('.temp', `g-992-${randomUUID()}`);
  const f = await authorCreditFixture(
    Bun.env as Record<string, string>,
    directory,
    'openid space:create zone:edit owner:operate semantic:read',
  );
  const store = (prefix: string) =>
    new S3ImmutableObjects({
      endpoint: Bun.env.MAIN_S3_ENDPOINT!,
      bucket: Bun.env.MAIN_S3_BUCKET!,
      region: Bun.env.MAIN_S3_REGION!,
      accessKeyId: Bun.env.MAIN_S3_ACCESS_KEY!,
      secretAccessKey: Bun.env.MAIN_S3_SECRET_KEY!,
      prefix,
    });
  const structureObjects = store('semantic/structure/'),
    workObjects = store('semantic/work/');
  await structureObjects.initialize();
  await workObjects.initialize();
  Object.assign(f.env, { structureObjects, workObjects });
  const registry = f.env.addresses;
  const allowed = registry.assertNameAllowed.bind(registry);
  try {
    await createAgentGraph(f.env, {
      id: randomUUID(),
      agent: f.actor,
      kind: 'person',
      displayName: 'Platform name owner',
      digest: '1'.repeat(64),
    });
    await f.grant('space:create:root', 'space.create');
    const site = async (official: boolean) => {
      const result = await f.json<{ space: string; realm: string }>(
        await f.call('POST', '/v1/spaces', {
          profile: 'space-realm-v1',
          name: 'Platform name test',
          language: 'en',
          capabilities: ['realm'],
          actingSubject: f.actor,
        }),
        201,
      );
      const zone = `https://rezics.com/id/${randomUUID()}`;
      await f.grant(`zone:edit:${zone}`, 'zone.edit');
      await f.grant(`governance:realm:${result.realm}`, 'realm.settings.manage');
      await f.json(
        await f.call('POST', '/v1/zones', {
          zone,
          space: result.space,
          disclosure: 'public',
          name: 'Platform name test',
          language: 'en',
          actingSubject: f.actor,
        }),
        201,
      );
      if (official) {
        await f.grant(`zone:official:${zone}`, 'zone.official');
        await f.json(
          await f.call('PUT', `/v1/zones/${zone.slice(-36)}/configuration`, {
            expectedHead: (await readZoneConfiguration(f.env, zone)).revision,
            actingSubject: f.actor,
            official: {},
            defaultRealm: result.realm,
          }),
          200,
        );
      }
      return { ...result, zone };
    };
    const ordinary = await site(false),
      platform = await site(true),
      collision = await site(true);
    const intent = (holder: string, name: string) => ({
      profile: 'name-write-v1',
      scope: 'space',
      holder,
      operation: 'claim',
      name,
      expectedRevision: null,
      actingSubject: f.actor,
    });
    expect(
      (await f.call('POST', '/v1/addresses/claims', intent(ordinary.space, 'mods'))).status,
    ).toBe(400);
    expect(
      (
        await f.call('POST', '/v1/addresses/claims', {
          ...intent(ordinary.space, 'mods'),
          platformAuthority: true,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await f.call(
          'POST',
          '/v1/addresses/claims',
          intent(platform.space, 'mods'),
          randomUUID(),
          f.account.tokenB,
        )
      ).status,
    ).toBe(403);
    const idempotencyKey = randomUUID();
    const named = await f.json<NameReceipt>(
      await f.call('POST', '/v1/addresses/claims', intent(platform.space, 'mods'), idempotencyKey),
      201,
    );
    expect(
      await f.json(
        await f.call(
          'POST',
          '/v1/addresses/claims',
          intent(platform.space, 'mods'),
          idempotencyKey,
        ),
        200,
      ),
    ).toMatchObject({ ...named, replayed: true });
    expect(
      (await f.call('POST', '/v1/addresses/claims', intent(collision.space, 'mods'))).status,
    ).toBe(409);
    expect(
      (
        await f.call('POST', '/v1/addresses/renames', {
          ...intent(platform.space, 'support'),
          operation: 'rename',
          expectedRevision: randomUUID(),
        })
      ).status,
    ).toBe(409);

    const repair = await site(true);
    const before = await readZoneConfiguration(f.env, repair.zone);
    const legacy = {
      ...before.configuration,
      budget: { ...before.configuration.budget, rows: 24 },
      official: { routeSegment: 'support' },
    };
    const manifest = await prepareWorkComponent(
      workObjects,
      repair.zone,
      { configuration: legacy, name: before.name, language: before.language },
      ZONE_PROFILE,
    );
    await f.nativeFuseki.update(`PREFIX rv: <${RV}>
      DELETE { GRAPH ${iri(GRAPHS.revisions)} { ${iri(before.revision)} rv:manifest ?old } }
      INSERT { GRAPH ${iri(GRAPHS.revisions)} { ${iri(before.revision)} rv:manifest ${iri(`urn:rezics:sha256:${manifest}`)} }
        GRAPH ${iri(GRAPHS.current)} { ${iri(repair.zone)} rv:routeSegment "support" .
          ${iri(ordinary.realm)} rv:communityHandle "admin" } }
      WHERE { GRAPH ${iri(GRAPHS.revisions)} { ${iri(before.revision)} rv:manifest ?old } }`);
    await f.accessPool.query('DELETE FROM access.name_graph_import WHERE data_epoch = $1', [
      f.env.lineage.dataEpoch,
    ]);
    // Reproduce the old reservation bug while running real cleanup and completion.
    registry.assertNameAllowed = async (scope, key, client, authority) => {
      if (key === 'support') throw new NameInvalid('Former name is reserved');
      return allowed(scope, key, client, authority);
    };
    expect(await migrateGraphNames(f.env)).toEqual({ status: 'complete' });
    registry.assertNameAllowed = allowed;
    const upgraded = await readZoneConfiguration(f.env, repair.zone);
    expect(upgraded.revision).not.toBe(before.revision);
    expect(upgraded.configuration).toEqual({ ...legacy, official: {} });
    expect(existsSync(`${directory}/${upgraded.manifest.slice(-64)}`)).toBe(false);
    expect(
      (
        await readWorkComponentState(
          { ...f.env, objectDirectory: resolve(directory, 'empty') },
          upgraded.manifest,
          repair.zone,
          ZONE_PROFILE,
        )
      ).configuration,
    ).toEqual(upgraded.configuration);
    expect(
      (
        await readWorkComponentState(
          f.env,
          `urn:rezics:sha256:${manifest}`,
          repair.zone,
          ZONE_PROFILE,
        )
      ).configuration,
    ).toEqual(legacy);
    expect(
      (
        await f.accessPool.query(
          'SELECT completed_at FROM access.name_graph_import WHERE data_epoch = $1',
          [f.env.lineage.dataEpoch],
        )
      ).rows[0].completed_at,
    ).not.toBeNull();
    const pending = await f.accessPool.query(
      'SELECT legacy_name,repaired_at FROM access.name_graph_import_report WHERE data_epoch = $1 AND source = $2',
      [f.env.lineage.dataEpoch, ordinary.realm],
    );
    expect(pending.rows[0].legacy_name.key.value).toBe('admin');
    expect(pending.rows[0].repaired_at).toBeNull();
    // Older completed imports have no saved binding. Recover from retained bytes.
    await f.accessPool.query(
      'UPDATE access.name_graph_import_report SET legacy_name = NULL WHERE data_epoch = $1 AND source = $2',
      [f.env.lineage.dataEpoch, repair.zone],
    );
    await f.accessPool.query('UPDATE access.recovery_fence SET open = false WHERE id');
    expect(await migrateGraphNames(f.env)).toEqual({ status: 'deferred' });
    expect(await registry.lookup('space', 'support')).toBeNull();
    await f.accessPool.query('UPDATE access.recovery_fence SET open = true WHERE id');
    expect(await Promise.all([migrateGraphNames(f.env), migrateGraphNames(f.env)])).toEqual([
      { status: 'complete' },
      { status: 'complete' },
    ]);
    const fixed = await registry.lookup('space', 'support');
    expect(fixed?.holder).toBe(repair.space);
    expect(await registry.lookup('space', 'admin')).toBeNull();
    expect((await readZoneConfiguration(f.env, repair.zone)).revision).toBe(upgraded.revision);
    const report = (
      await f.accessPool.query(
        'SELECT legacy_name,reason,repaired_at FROM access.name_graph_import_report WHERE data_epoch = $1 AND source = $2',
        [f.env.lineage.dataEpoch, repair.zone],
      )
    ).rows[0];
    expect(report.legacy_name.key.value).toBe('support');
    expect(report.reason).toBe('Imported retained name');
    expect(report.repaired_at).not.toBeNull();
    const resolveName = async (name: string) =>
      f.json(
        await f.call(
          'GET',
          `/v1/addresses/resolve?scope=space&key=${name}&actingSubject=${encodeURIComponent(f.actor)}`,
        ),
        200,
      );
    expect(await resolveName('support')).toMatchObject({
      status: 'resolved',
      holder: repair.space,
      canonical: { prefix: '/z/', key: 'support' },
    });
    expect(await resolveName('mods')).toMatchObject({ status: 'resolved', holder: platform.space });
    expect(await migrateGraphNames(f.env)).toEqual({ status: 'complete' });
    expect((await registry.lookup('space', 'support'))?.revision).toBe(fixed?.revision);
    expect(
      (
        await f.accessPool.query(
          'SELECT count(*)::int AS count FROM access.name_history WHERE scope = $1 AND key = $2',
          ['space', 'support'],
        )
      ).rows[0].count,
    ).toBe(1);
    expect(
      (
        await f.env.fuseki.query(`PREFIX rv: <${RV}> ASK { GRAPH ${iri(GRAPHS.current)} {
      ${iri(repair.zone)} rv:routeSegment ${lit('support')} } }`)
      ).boolean,
    ).toBe(false);
  } finally {
    registry.assertNameAllowed = allowed;
    await f.accessPool.query('UPDATE access.recovery_fence SET open = true WHERE id');
    await f.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 120_000);
