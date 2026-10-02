import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { GRAPHS, iri, prepareComponent } from '../../../services/main/src/modules/work/activate.ts';
import { migrateGraphNames } from '../../../services/main/src/modules/address/migrate.ts';
import { addressFixture } from './g-937-support.ts';
import { S3ImmutableObjects } from '../../../services/main/src/infrastructure/immutable-objects.ts';
import { readZoneConfiguration } from '../../../services/main/src/modules/zone/configuration.ts';
import { ZONE_PROFILE } from '../../../services/main/src/modules/zone/config-format.ts';
import { uuidToSid,hasSidCaseVariant } from '@rezics/model/address/sid';
import { readFileSync } from 'node:fs';

test('G937: former graph names move once, retain holders and recover after native cleanup', async () => {
  const f = await addressFixture('migration');
  try {
    const record = await f.work('Migrated Work');
    await f.grant('space:create:root', 'space.create');
    const { space, realm } = await f.json<{ space: string; realm: string }>(
      await f.call('POST', '/v1/spaces', {
        profile: 'space-realm-v1',
        name: 'Migrated Space',
        language: 'en',
        capabilities: ['realm'],
        actingSubject: f.actor,
      }),
      201,
    );
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
    const zone = `https://rezics.com/id/${randomUUID()}`,
      binding = `https://rezics.com/id/${randomUUID()}`,
      revision = `https://rezics.com/id/${randomUUID()}`;
    await f.grant(`zone:edit:${zone}`, 'zone.edit');
    await f.json(
      await f.call('POST', '/v1/zones', {
        zone,
        space,
        disclosure: 'public',
        actingSubject: f.actor,
      }),
      201,
    );
    const key = `migrated-${randomUUID().slice(0, 8)}`;
    const retained = `https://rezics.com/id/${randomUUID()}`;
    const invalid = `https://rezics.com/id/${randomUUID()}`;
    const invalidKey = uuidToSid(randomUUID()).toLowerCase();
    const before = await readZoneConfiguration(f.env, zone);
    const legacyManifest = prepareComponent(
      f.env.objectDirectory,
      zone,
      {
        configuration: {
          ...before.configuration,
          defaultRealm: realm,
          official: { routeSegment: key },
        },
      },
      ZONE_PROFILE,
    );
    await f.nativeFuseki.update(`PREFIX rv: <https://rezics.com/vocab/>
      DELETE { GRAPH ${iri(GRAPHS.revisions)} { ${iri(before.revision)} rv:manifest ?manifest } }
      INSERT { GRAPH ${iri(GRAPHS.revisions)} { ${iri(before.revision)} rv:manifest <urn:rezics:sha256:${legacyManifest}> }
        GRAPH ${iri(GRAPHS.current)} { ${iri(zone)} rv:defaultRealm ${iri(realm)} } }
      WHERE { GRAPH ${iri(GRAPHS.revisions)} { ${iri(before.revision)} rv:manifest ?manifest } }`);
    await f.nativeFuseki
      .update(`PREFIX rv: <https://rezics.com/vocab/> PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
      INSERT DATA { GRAPH ${iri(GRAPHS.current)} {
        ${iri(realm)} rv:communityHandle "${key}" .
        ${iri(zone)} rv:official true ; rv:routeSegment "${key}" .
        ${iri(binding)} a rv:RouteBinding ; rv:routeNamespace "work" ; rv:normalizedSlug "${key}" ; rv:targetWork ${iri(record.work)} ; rv:routeState rv:Current ; rv:routeRevision ${iri(revision)} .
        ${iri(invalid)} a rv:RouteBinding ; rv:routeNamespace "work" ; rv:normalizedSlug "${invalidKey}" ; rv:targetWork ${iri(record.work)} ; rv:routeState rv:Current ; rv:routeRevision ${iri(retained)} .
      } GRAPH ${iri(GRAPHS.revisions)} { ${iri(retained)} a rv:RevisionAnchor ; rv:component ${iri(binding)} ;
        rv:targetWork ${iri(record.work)} ; rv:normalizedSlug "${key}" ; rv:routeState rv:Current } }`);
    await f.accessPool.query('DELETE FROM access.name_graph_import WHERE data_epoch = $1', [
      f.env.lineage.dataEpoch,
    ]);
    await f.nativeFuseki.update(`PREFIX rv: <https://rezics.com/vocab/> INSERT DATA {
      GRAPH ${iri(GRAPHS.control)} { <urn:rezics:dataset:product> rv:restoreHold true } }`);
    expect(await migrateGraphNames(f.env)).toEqual({ status: 'deferred' });
    expect((await f.accessPool.query('SELECT 1 FROM access.name_graph_import WHERE data_epoch = $1',[f.env.lineage.dataEpoch])).rowCount).toBe(0);
    await f.nativeFuseki.update(`PREFIX rv: <https://rezics.com/vocab/> DELETE DATA {
      GRAPH ${iri(GRAPHS.control)} { <urn:rezics:dataset:product> rv:restoreHold true } }`);
    const original = f.accessPool.query.bind(f.accessPool);
    let interrupt = true;
    f.accessPool.query = (async (sql: string, ...args: unknown[]) => {
      if (interrupt && sql.startsWith('INSERT INTO access.name_graph_import')) {
        interrupt = false;
        throw new Error('Lost completion marker');
      }
      return original(sql, ...(args as []));
    }) as typeof f.accessPool.query;
    expect(await migrateGraphNames(f.env)).toEqual({ status: 'deferred' });
    f.accessPool.query = original;
    await migrateGraphNames(f.env);
    await migrateGraphNames(f.env);
    expect((await f.env.addresses.lookup('space', key))?.holder).toBe(space);
    expect((await f.env.addresses.lookup('work', key))?.holder).toBe(record.work);
    expect(await f.env.addresses.lookup('work',invalidKey)).toBeNull();
    expect((await f.accessPool.query('SELECT reason FROM access.name_graph_import_report WHERE data_epoch = $1 AND source = $2',
      [f.env.lineage.dataEpoch,invalid])).rows[0]?.reason).toContain('Identity keys cannot be names');
    expect((await readZoneConfiguration(f.env, zone)).configuration.official).toEqual({});
    expect(
      (
        await f.accessPool.query(
          'SELECT count(*)::int AS count FROM access.name_history WHERE scope = $1 AND key = $2',
          ['work', key],
        )
      ).rows[0].count,
    ).toBe(2);
    expect(await f.env.addresses.exact('work', key, retained.slice(-36))).toMatchObject({
      holder: record.work,
      state: 'current',
    });
    expect(
      (
        await f.env.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/> ASK {
      GRAPH ${iri(GRAPHS.current)} { { ?r rv:communityHandle ?key } UNION { ?r a rv:Zone ; rv:routeSegment ?key }
        UNION { ?r a rv:RouteBinding } } }`)
      ).boolean,
    ).toBe(false);
    expect(await f.json(await f.lookup('work', key), 200)).toMatchObject({
      holder: record.work,
      canonical: { key },
    });
    for (const value of ['1'.repeat(22), 'z'.repeat(22), '1'.repeat(21) + '0', randomUUID()]) {
      const expected = value === '1'.repeat(22);
      expect(
        (await f.accessPool.query('SELECT access.is_address_sid($1) AS sid', [value])).rows[0].sid,
      ).toBe(expected);
    }
    for (const value of [invalidKey,invalidKey.toUpperCase(),'1'.repeat(21)+'l','z'.repeat(22)])
      expect((await f.accessPool.query('SELECT access.has_address_sid_case_variant($1) AS sid',[value])).rows[0].sid).toBe(hasSidCaseVariant(value));
    expect(
      (
        await f.accessPool.query(
          `SELECT obj_description('access.agent_handle'::regclass) AS description`,
        )
      ).rows[0].description,
    ).toContain('notification-producers/producer.ts:444');
  } finally {
    await f.close();
  }
}, 30_000);

test('G937: SQL Agent import reports every non-conforming legacy alias without aborting',async () => {
  const f = await addressFixture('agent-import');
  const schema = `g937_${randomUUID().replaceAll('-','')}`;
  const client = await f.accessPool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`CREATE SCHEMA ${schema};
      CREATE TABLE ${schema}.principal(id uuid PRIMARY KEY);
      CREATE TABLE ${schema}.admission(id uuid PRIMARY KEY,action text,acting_subject text,state text,graph_outcome text);
      CREATE TABLE ${schema}.agent_handle(handle text PRIMARY KEY,agent_id text,state text,skeleton text,
        claimed_at timestamptz DEFAULT clock_timestamp());
      CREATE TABLE ${schema}.agent_handle_receipt(id uuid);
      CREATE FUNCTION ${schema}.realm_member_search_key(value text) RETURNS text LANGUAGE sql IMMUTABLE AS 'SELECT value';
      CREATE FUNCTION ${schema}.realm_member_search_terms(value text) RETURNS text[] LANGUAGE sql IMMUTABLE AS 'SELECT ARRAY[value]';`);
    const valid = `https://rezics.com/id/${randomUUID()}`;
    const skipped = `https://rezics.com/id/${randomUUID()}`;
    for (const [handle,holder] of [['valid-name',valid],['_legacy',skipped],['legacy_',skipped],['admin',skipped],['1'.repeat(22),skipped]]) {
      await client.query(`INSERT INTO ${schema}.agent_handle(handle,agent_id,state,skeleton) VALUES ($1,$2,'current',$1)`,[handle,holder]);
    }
    const migration = readFileSync('services/main/migrations/access/1010_name_registry.sql','utf8').replaceAll('access.',`${schema}.`);
    await client.query(migration);
    expect((await client.query(`SELECT key,holder FROM ${schema}.name_registry`)).rows).toEqual([{ key:'valid-name',holder:valid }]);
    const report = (await client.query(`SELECT source,reason FROM ${schema}.name_graph_import_report ORDER BY source`)).rows;
    expect(report).toHaveLength(4);
    for (const handle of ['_legacy','legacy_','admin','1'.repeat(22)])
      expect(report.find(row => row.source === `${skipped}#${handle}`)?.reason).toContain(`handle ${handle}`);
    expect((await client.query(`SELECT handle FROM ${schema}.agent_handle`)).rows).toEqual([{ handle:'valid-name' }]);
  } finally {
    await client.query('ROLLBACK');client.release();await f.close();
  }
},30_000);
