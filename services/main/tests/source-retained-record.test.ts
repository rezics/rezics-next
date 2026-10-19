import { beforeAll, afterAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import type { DatasetRecord } from '../../../scripts/datasets/types.ts';
import { canonicalJson } from '../../../scripts/lib/canonical-json.ts';
import { startPostgresCluster, type PostgresCluster } from '../../../tests/qa/support/postgres-cluster.ts';
import { migrateContent } from '../../content/src/migrate.ts';
import { SourceIntakeStore, type StagedSourceObservation } from '../src/modules/source/intake.ts';
import { SourceRetainedRecordStore, retainedInventory } from '../src/modules/source/retained-record.ts';
import { canonicalDigest, sourceDigest, retainedMappingRevision, verifyRetainedRecord,
  sourceIri } from '../src/modules/source/retained-record-normalization.ts';
import type { RetainedConversionRequest } from '../src/modules/source/field-support-contract.ts';

const snapshot = { id: 'captured-shape-v1', digest: 'a'.repeat(64), fileSha256: 'b'.repeat(64) };
function record(provider: DatasetRecord['provider'] = 'vndb'): DatasetRecord {
  return provider === 'vndb' ? { key: 'vndb:vn:v11', provider, kind: 'vn', externalId: 'v11',
    title: 'Exact title', language: 'ja', sourceUrl: 'https://vndb.org/v11', native: 'work',
    semanticTypes: ['https://schema.org/VideoGame'],
    data: { id: 'v11', name: 'Exact title', olang: 'ja', description: 'First line\r\nSecond line',
      aliases: 'First alias\n\nThird alias', released: '20049999', omittedExample: null, empty: '' } }
    : provider === 'bangumi' ? { key: 'bangumi:subject:1014', provider, kind: 'subject', externalId: '1014',
      title: 'Exact title', language: 'ja', sourceUrl: 'https://bgm.tv/subject/1014', native: 'work',
      data: { id: 1014, name: 'Exact title', summary: '简介\n第二行', api_subject: { id: 1014, tags: [] } } }
      : { key: 'musicbrainz:artist:24f1766e-9635-4d58-a4d4-9413f9f98a4c', provider,
        kind: 'artist', externalId: '24f1766e-9635-4d58-a4d4-9413f9f98a4c',
        title: 'Johann Sebastian Bach', language: 'und',
        sourceUrl: 'https://musicbrainz.org/artist/24f1766e-9635-4d58-a4d4-9413f9f98a4c', native: 'person',
        data: { id: '24f1766e-9635-4d58-a4d4-9413f9f98a4c', name: 'Johann Sebastian Bach', type: 'Person',
          aliases: [{ name: 'J. S. Bach', locale: null }], 'life-span': { begin: '1685-03' } } };
}
function fixture(original = record(), multipart = false, envelope = true) {
  const value = envelope ? { format: 'rezics-dataset-record-v1', snapshot: snapshot.id,
    digest: snapshot.digest, record: original, edges: [], images: [] } : original.data;
  const bytes = Buffer.from(canonicalJson(value));
  const buffers = multipart ? [bytes.subarray(0, 113), bytes.subarray(113)].map((part, index) =>
    Buffer.from(canonicalJson({ format: 'rezics-dataset-chunk-v1', digest: sourceDigest(bytes),
      byteLength: bytes.length, index, count: 2, encoding: 'base64', bytes: part.toString('base64') }))) : [bytes];
  const observations: StagedSourceObservation[] = buffers.map((part, index) => ({
    profile: 'source-manual-intake-v1', state: 'staged', record: sourceIri(randomUUID()), observation: sourceIri(randomUUID()),
    provider: original.provider, namespace: multipart ? `${original.kind}-dataset-part` : original.kind,
    externalId: multipart ? `${original.externalId}:part:${index}` : original.externalId,
    sourceRevision: snapshot.digest, mediaType: 'application/json', retention: 'retained',
    rawBytesBase64: part.toString('base64'), byteDigest: sourceDigest(part), byteLength: part.length,
    coverage: { scope: 'captured-shape', complete: !multipart, omittedFields: [] },
    rightsEvidence: { basis: 'facts', note: 'Owner behavior test; no public disclosure grant.' }, submittedAt: '2026-10-19' }));
  const request: RetainedConversionRequest = { profile: 'source-retained-record-conversion-v1',
    mappingRevision: retainedMappingRevision(original.provider, original.kind), retained: {
      identity: { key: original.key, provider: original.provider, namespace: original.kind, externalId: original.externalId },
      snapshot, record: original, recordDigest: canonicalDigest(original),
      payload: { format: multipart ? 'rezics-dataset-chunk-v1' : 'json', byteDigest: sourceDigest(bytes), byteLength: bytes.length },
      intakes: observations.map((item, index) => ({ index, record: item.record,
        observation: item.observation, byteDigest: item.byteDigest! })) } };
  return { request, observations };
}

test('registered Source conversion verifies the full record in each admitted envelope shape', async () => {
  for (const provider of ['vndb', 'bangumi', 'musicbrainz'] as const) for (const multipart of [false, true]) {
    const f = fixture(record(provider), multipart);
    const verified = verifyRetainedRecord(f.request, f.observations);
    expect(verified.record).toEqual(f.request.retained.record);
    expect(verified.rule).toBe('dataset-record-envelope-v1');
    expect(verified.payload.record).toEqual(f.request.retained.record);
    expect(canonicalDigest(verified.payload)).not.toBe(f.request.retained.recordDigest);
    const inventory = await retainedInventory(f.request);
    expect(inventory.some(field => field.disposition === 'candidate')).toBe(true);
    expect(inventory.find(field => field.pointer === '/title')).toBeDefined();
  }
});

test('bare provider normalization verifies metadata outside data instead of trusting a supplied title', () => {
  for (const provider of ['vndb', 'musicbrainz'] as const) {
    const f = fixture(record(provider), false, false);
    expect(verifyRetainedRecord(f.request, f.observations).record).toEqual(f.request.retained.record);
    for (const member of ['title', 'language', 'sourceUrl', 'native'] as const) {
      const request = structuredClone(f.request);
      Object.assign(request.retained.record, { [member]: 'forged metadata' });
      request.retained.recordDigest = canonicalDigest(request.retained.record);
      expect(() => verifyRetainedRecord(request, f.observations)).toThrow(expect.objectContaining({
        status: 409, code: 'source_conversion_changed', basis: 'record' }));
    }
  }
});

test('conversion separates record, record digest, raw byte digest and ordered part refusals', () => {
  const f = fixture(record(), true);
  const mutations: Array<[string, (request: RetainedConversionRequest) => void]> = [
    ['record', request => { request.retained.record.title = 'Different'; request.retained.recordDigest = canonicalDigest(request.retained.record); }],
    ['record-digest', request => { request.retained.recordDigest = 'c'.repeat(64); }],
    ['byte-digest', request => { request.retained.intakes[1]!.byteDigest = 'd'.repeat(64); }],
    ['byte-digest', request => { request.retained.payload.byteDigest = 'e'.repeat(64); }],
    ['part-order', request => { request.retained.intakes.reverse(); }],
  ];
  for (const [basis, change] of mutations) {
    const request = structuredClone(f.request); change(request);
    expect(() => verifyRetainedRecord(request, f.observations)).toThrow(expect.objectContaining({
      status: 409, code: 'source_conversion_changed', basis }));
  }
  const corrupt = structuredClone(f.observations);
  corrupt[0]!.rawBytesBase64 = Buffer.from('{}').toString('base64');
  expect(() => verifyRetainedRecord(f.request, corrupt)).toThrow(expect.objectContaining({ status: 503 }));
  const missing = structuredClone(f.observations); missing[0]!.retention = 'not-retained';
  expect(() => verifyRetainedRecord(f.request, missing)).toThrow(expect.objectContaining({ status: 503 }));
  const unsupported = structuredClone(f.request); unsupported.mappingRevision = 'unregistered-map-v1';
  expect(() => verifyRetainedRecord(unsupported, f.observations)).toThrow(expect.objectContaining({ status: 422, code: 'source_mapping_unverified' }));
});

let cluster: PostgresCluster, pool: Pool;
beforeAll(async () => {
  cluster = await startPostgresCluster();
  pool = new Pool({ ...cluster.connection, max: 4 });
  await migrateContent(pool);
}, 120_000);
afterAll(async () => { await pool?.end(); await cluster?.stop(); });

test('Source persists actual multipart custody, the original record and immutable replay identity', async () => {
  const principal = randomUUID(), intake = new SourceIntakeStore(pool), store = new SourceRetainedRecordStore(pool, intake);
  const f = fixture(record(), true);
  for (let index = 0; index < f.observations.length; index++) {
    const observation = f.observations[index]!;
    const admitted = (await intake.submit(principal, randomUUID(), observation)).observation;
    f.observations[index] = admitted;
    f.request.retained.intakes[index] = { index, record: admitted.record,
      observation: admitted.observation, byteDigest: admitted.byteDigest! };
  }
  const observationId = f.observations[0]!.observation.slice(-36);
  const settled = await store.convert(principal, observationId, f.request);
  expect(settled.replayed).toBe(false);
  const binding = settled.conversion.retainedRecord;
  expect(binding.sourceRecord).not.toBe(f.observations[0]!.record);
  expect(binding.intakes).toEqual(f.request.retained.intakes);
  expect(await store.read(principal, binding.conversion)).toEqual(settled.conversion);
  expect(await store.convert(principal, observationId, structuredClone(f.request))).toEqual({ ...settled, replayed: true });
  expect(await store.read(randomUUID(), binding.conversion)).toBeNull();
  await expect(store.convert(randomUUID(), observationId, f.request)).rejects.toMatchObject({ status: 404 });
  const mismatch = structuredClone(f.request); mismatch.retained.record.title = 'Mutation';
  mismatch.retained.recordDigest = canonicalDigest(mismatch.retained.record);
  await expect(store.convert(principal, observationId, mismatch)).rejects.toMatchObject({ status: 409, basis: 'record' });
  expect(await store.read(principal, binding.conversion)).toEqual(settled.conversion);
  await expect(pool.query('UPDATE source.retained_record_binding SET record_id=$1 WHERE id=$2',
    [f.observations[0]!.record.slice(-36), binding.binding.slice(-36)])).rejects.toMatchObject({ code: '23514' });
  const original = (await pool.query('SELECT provider,namespace,external_id FROM source.record WHERE id=$1',
    [binding.sourceRecord.slice(-36)])).rows[0];
  expect(original).toEqual({ provider: 'vndb', namespace: 'vn', external_id: 'v11' });
});

test('retained registry is sealed and legacy conversion inventory guards still reject undeclared native fields', async () => {
  const mapping = (await pool.query(`SELECT normalization_revision,field_count FROM source.field_mapping
    WHERE mapping_revision='vndb-vn-retained-map-v1'`)).rows[0];
  expect(mapping).toEqual({ normalization_revision: 'dataset-record-normalization-v1', field_count: 0 });
  await expect(pool.query(`INSERT INTO source.field_disposition
    (mapping_revision,grain,field_key,disposition,value_kind,reason)
    VALUES ('vndb-vn-retained-map-v1','vn','invented','unsupported','metadata','Not registered')`))
    .rejects.toMatchObject({ code: '23514' });
  const principal = randomUUID();
  const observation = (await new SourceIntakeStore(pool).submit(principal, randomUUID(), {
    provider: 'bangumi', namespace: 'subject', externalId: '1014', sourceRevision: snapshot.digest,
    mediaType: 'application/json', retention: 'retained', rawBytesBase64: Buffer.from('{}').toString('base64'),
    coverage: { scope: 'fixture', complete: true, omittedFields: [] }, rightsEvidence: { basis: 'facts', note: '' },
  })).observation;
  await expect(pool.query(`INSERT INTO source.conversion
    (id,observation_id,principal_id,mapping_revision,source_digest,projection,field_inventory)
    VALUES ($1,$2,$3,'bangumi-subject-map-v1',$4,'{}',$5)`,
  [randomUUID(), observation.observation.slice(-36), principal, observation.byteDigest,
    JSON.stringify([{ grain: 'subject', field: 'not-declared', disposition: 'native' }])]))
    .rejects.toMatchObject({ code: '23514', constraint: 'conversion_field_inventory' });
});
