import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { authorCreditFixture, shortId } from '../fixtures/author-credit.ts';
import { GRAPHS, RV } from '../../../services/main/src/modules/work/activate.ts';
import { fusekiReadBudget } from '../../../services/main/src/infrastructure/fuseki.ts';
import { fieldAttachmentEvidenceSql } from '../../../services/main/src/modules/source/support-attach.ts';

const iri = (id: string) => `https://rezics.com/id/${id}`;
const sha = (value: string) => createHash('sha256').update(value).digest('hex');

test('LIVE05: two field keys attach exact retained values and one withdrawal keeps native acceptance', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated integration tier');
  const directory = join(resolve(import.meta.dir, '../../..'), '.temp', `source-support-${randomUUID()}`);
  const h = await authorCreditFixture(Bun.env as Record<string, string>, directory);
  try {
    const proposal = await h.propose('OL993120W', []);
    const work = await h.adoptWork(proposal);
    await h.grant(`work:edit:${work.work}`, 'work.edit');
    await h.grant(`work:read:${work.work}`, 'work.read');
    const scalar = await h.json<{ revision: string }>(await h.call('POST',
      `/v1/works/${shortId(work.work)}/scalar-value`, {
        profile: 'work-scalar-state-v1', expectedHead: work.workRevision,
        scalarValue: { kind: 'unknown' }, actingSubject: h.actor }), 200);
    const mapping = `fixture-${randomUUID().replaceAll('-', '')}-v1`;
    const setup = await h.pool.connect();
    try {
      await setup.query('BEGIN');
      await setup.query(`INSERT INTO source.field_mapping
        (mapping_revision, provider, namespace, root_grain, field_count)
        VALUES ($1,'fixture','work','work',2)`, [mapping]);
      await setup.query(`INSERT INTO source.field_disposition
        (mapping_revision, grain, field_key, disposition, value_kind, reason, native_target)
        VALUES ($1,'work','semanticTypes','native','structure','exact native value',
          'work-metadata-v1#semantic-types'),
          ($1,'work','scalarValue','native','structure','exact native value',
          'work-metadata-v1#scalar-value')`, [mapping]);
      await setup.query('COMMIT');
    } catch (error) { await setup.query('ROLLBACK'); throw error; }
    finally { setup.release(); }

    const seed = async (external: string) => {
      const record = randomUUID(), observation = randomUUID(), conversion = randomUUID();
      const bytes = JSON.stringify({ semanticTypes: [], scalarValue: { kind: 'unknown' } });
      await h.pool.query(`INSERT INTO source.record (id,provider,namespace,external_id)
        VALUES ($1,'fixture','work',$2)`, [record, external]);
      await h.pool.query(`INSERT INTO source.observation
        (id,record_id,principal_id,media_type,retention,raw_bytes,byte_digest,coverage,rights_evidence)
        VALUES ($1,$2,$3,'application/json','retained',$4,$5,'{"complete":true}','{}')`,
      [observation, record, h.principalId, Buffer.from(bytes), sha(bytes)]);
      await h.pool.query(`INSERT INTO source.conversion
        (id,observation_id,principal_id,mapping_revision,source_digest,projection,field_inventory)
        VALUES ($1,$2,$3,$4,$5,'{}',$6)`, [conversion, observation, h.principalId, mapping, sha(bytes),
        JSON.stringify([{ grain: 'work', field: 'semanticTypes', disposition: 'native' },
          { grain: 'work', field: 'scalarValue', disposition: 'native' }])]);
      return { record, conversion };
    };
    const a = await seed(`a-${randomUUID()}`), b = await seed(`b-${randomUUID()}`);
    const input = (source: typeof a, field: 'semanticTypes' | 'scalarValue') => ({
      profile: 'source-field-support-attachment-v1', target: work.work,
      slot: field === 'semanticTypes' ? 'work-metadata-v1#semantic-types' : 'work-metadata-v1#scalar-value',
      occurrence: null, context: 'global', sourceRecord: iri(source.record),
      conversion: iri(source.conversion), grain: 'work', sourceField: field,
      sourceOccurrence: null, sourcePointer: `/${field}`, expectedHead: scalar.revision,
      actingSubject: h.actor,
    });
    const route = '/v1/sources/field-supports';
    expect((await h.call('POST', route, input(a, 'semanticTypes'), randomUUID(), h.account.noScope)).status).toBe(401);
    expect((await h.call('POST', route, { ...input(a, 'semanticTypes'),
      slot: 'work-metadata-v1#invented' })).status).toBe(400);
    expect((await h.call('POST', route, { ...input(a, 'semanticTypes'),
      expectedHead: work.workRevision })).status).toBe(409);
    const key = randomUUID();
    const concurrent = await Promise.all([h.call('POST', route, input(a, 'semanticTypes'), key),
      h.call('POST', route, input(a, 'semanticTypes'), key)]);
    expect(concurrent.map(response => response.status).sort()).toEqual([200, 201]);
    const first = await concurrent[0]!.json() as { support: { support: string; supportIdentity: string;
      valueDigest: string; nativeRevision: string }; replayed: boolean };
    const second = await concurrent[1]!.json() as typeof first;
    expect(second.support.support).toBe(first.support.support);
    expect(first.support.nativeRevision).toBe(scalar.revision);
    expect((await h.call('POST', route, { ...input(a, 'semanticTypes'),
      sourcePointer: '/scalarValue' }, key)).status).toBe(409);
    const budget = { signal: AbortSignal.timeout(10_000), callsLeft: 64, bytesLeft: 262_144 };
    const scalarSupport = await h.json<{ support: { support: string } }>(
      await fusekiReadBudget.run(budget, () => h.call('POST', route, input(a, 'scalarValue'))), 201);
    expect(64 - budget.callsLeft).toBeLessThanOrEqual(24);
    expect(262_144 - budget.bytesLeft).toBeLessThan(96_000);
    const independent = await h.json<{ support: { support: string } }>(await h.call('POST', route,
      input(b, 'semanticTypes')), 201);
    expect((await h.call('GET', `/v1/sources/field-supports/${shortId(first.support.support)}`)).status).toBe(200);
    expect((await h.call('GET', `/v1/sources/field-supports/${shortId(first.support.support)}`,
      undefined, randomUUID(), h.account.tokenB)).status).toBe(404);
    const withdraw = { profile: 'source-support-withdrawal-v1', support: first.support.support,
      expectedSupport: first.support.supportIdentity, reason: 'One source withdrew its support' };
    expect((await h.call('POST', '/v1/sources/withdrawals', { ...withdraw,
      expectedSupport: iri(randomUUID()) })).status).toBe(409);
    const removed = await h.json<{ support: { state: string; nativeRevision: string } }>(
      await h.call('POST', '/v1/sources/withdrawals', withdraw), 201);
    expect(removed.support).toMatchObject({ state: 'withdrawn', nativeRevision: scalar.revision });
    for (const support of [scalarSupport.support.support, independent.support.support]) {
      const read = await h.call('GET', `/v1/sources/supports/${shortId(support)}`);
      expect(read.status).toBe(200);
      expect((await read.json() as { state: string }).state).toBe('recorded');
    }
    const later = await h.json<{ revision: string }>(await h.call('POST',
      `/v1/works/${shortId(work.work)}/scalar-value`, {
        profile: 'work-scalar-state-v1', expectedHead: scalar.revision,
        scalarValue: { kind: 'no-value' }, actingSubject: h.actor }), 200);
    expect(later.revision).not.toBe(scalar.revision);
    expect((await h.call('GET', `/v1/sources/field-supports/${shortId(scalarSupport.support.support)}`)).status).toBe(200);
    const graph = await h.env.fuseki.query(`ASK { GRAPH <${GRAPHS.current}> {
      <${work.work}> <${RV}head> <${later.revision}> . } }`);
    expect(graph.boolean).toBe(true);
    const c = await seed(`c-${randomUUID()}`);
    await h.accessPool.query(`UPDATE access.permission_grant SET active = false
      WHERE scope_id = $1 AND recipient_subject = $2`, [`work:edit:${work.work}`, h.actor]);
    expect((await h.call('POST', route, { ...input(c, 'semanticTypes'),
      expectedHead: later.revision })).status).toBe(403);
    const plan = (await h.pool.query<{ 'QUERY PLAN': Array<{ Plan: {
      'Actual Rows': number; 'Shared Hit Blocks': number; 'Shared Read Blocks': number;
      'Temp Read Blocks': number } }> }>(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON, TIMING OFF) ${fieldAttachmentEvidenceSql}`,
      [a.conversion, h.principalId, a.record, 'work', 'semanticTypes'])).rows[0]!['QUERY PLAN'][0]!.Plan;
    expect(plan['Actual Rows']).toBe(1);
    expect(plan['Shared Hit Blocks'] + plan['Shared Read Blocks']).toBeLessThan(96);
    expect(plan['Temp Read Blocks']).toBe(0);
  } finally { await h.close(); }
}, 60_000);
