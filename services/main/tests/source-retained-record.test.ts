import { beforeAll, afterAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import type { DatasetRecord } from '../../../scripts/datasets/types.ts';
import { canonicalJson } from '../../../scripts/lib/canonical-json.ts';
import { startPostgresCluster, type PostgresCluster } from '../../../tests/qa/support/postgres-cluster.ts';
import { migrateContent } from '../../content/src/migrate.ts';
import { SourceIntakeStore, type StagedSourceObservation } from '../src/modules/source/intake.ts';
import { SourceRetainedRecordStore, retainedInventory, retainedFieldPlan } from '../src/modules/source/retained-record.ts';
import { canonicalDigest, sourceDigest, retainedMappingRevision, verifyRetainedRecord,
  sourceIri } from '../src/modules/source/retained-record-normalization.ts';
import { SourceFieldProblem, supportChanged, type RetainedConversionRequest, type RetainedSupportRequest,
  type VerifiedNativeAcknowledgement } from '../src/modules/source/field-support-contract.ts';
import { retainedValueAt, verifyRetainedField } from '../src/modules/source/field-support-evidence.ts';
import { SourceRetainedFieldSupportStore, retainedFieldEvidenceOwners,
  type RetainedPublicEvidence } from '../src/modules/source/field-support-retained.ts';
import { SourceFieldWithdrawalStore } from '../src/modules/source/withdrawal.ts';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import type { AccessAdmissionRegistry } from '../src/modules/access/admission.ts';
import { WorkReadSession, WorkReadMoved, withWorkReadSession } from '../src/modules/work/read-session.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';

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

async function retain(principal: string, original = record('musicbrainz'), multipart = false) {
  const intake = new SourceIntakeStore(pool), conversions = new SourceRetainedRecordStore(pool,intake);
  const f = fixture(original,multipart);
  for (let index = 0; index < f.observations.length; index++) {
    const observation = (await intake.submit(principal,randomUUID(),f.observations[index]!)).observation;
    f.request.retained.intakes[index] = { index,record: observation.record,
      observation: observation.observation,byteDigest: observation.byteDigest! };
  }
  const converted = await conversions.convert(principal,f.request.retained.intakes[0]!.observation.slice(-36),f.request);
  const evidence = (await conversions.evidence(principal,converted.conversion.conversion))!;
  return { conversions,evidence,binding: converted.conversion.retainedRecord };
}

test('field coordinates prove full-record to payload correspondence and exact date precision', async () => {
  const { evidence,binding } = await retain(randomUUID(),record('musicbrainz'),true);
  const candidate = (await retainedFieldPlan(evidence.request)).fields.find(field => field.role === 'begin-date')!;
  const target = sourceIri(randomUUID()), revision = sourceIri(randomUUID());
  const input: RetainedSupportRequest = { profile: 'source-field-support-attachment-v2',target,
    slot: 'component-property-v1#https://schema.org/birthDate',occurrence: null,context: 'global',
    sourceRecord: binding.sourceRecord,conversion: binding.conversion,grain: 'artist',sourceField: 'life-span/begin',
    sourceOccurrence: null,expectedHead: revision,actingSubject: sourceIri(randomUUID()),
    evidence: { binding: binding.binding,recordDigest: binding.recordDigest,mappingRevision: binding.mappingRevision,
      field: { pointer: '/data/life-span/begin',presence: 'value',valueDigest: canonicalDigest('1685-03') } },
    native: { kind: 'component-property',owner: 'semantic',target,component: target,revision,
      receipt: `urn:rezics:receipt:${'1'.repeat(64)}`,property: candidate.native!.property! } };
  const verified = await verifyRetainedField(input,evidence);
  expect(verified.correspondence).toEqual({ normalizationRevision: binding.normalizationRevision,
    rule: 'dataset-record-envelope-v1',payloadPointers: ['/record/data/life-span/begin'],
    selectedValueDigest: canonicalDigest('1685-03') });
  expect(verified.candidate.native!.property!.value).toMatchObject({ kind: 'temporal',precision: 'month',lexical: '1685-03' });
  const mismatch = structuredClone(input); mismatch.evidence.field.valueDigest = '0'.repeat(64);
  await expect(verifyRetainedField(mismatch,evidence)).rejects.toMatchObject({ status: 409,basis: 'value-digest' });
  const native = structuredClone(input);
  if (native.native.kind === 'component-property') native.native.property.value = { kind: 'temporal',
    lexical: '1685',precision: 'year',calendar: 'gregorian' };
  await expect(verifyRetainedField(native,evidence)).rejects.toMatchObject({ status: 409,basis: 'native-value' });
  const other = structuredClone(input); other.sourceField = 'name';
  await expect(verifyRetainedField(other,evidence)).rejects.toMatchObject({ status: 409,basis: 'evidence-binding' });
  for (const pointer of ['/data/life-span/begin/0','/data/aliases/01/name','/data/~2name']) {
    const invalid = structuredClone(input); invalid.evidence.field.pointer = pointer;
    await expect(verifyRetainedField(invalid,evidence)).rejects.toMatchObject({ status: 422,code: 'source_coordinate_invalid' });
  }
  expect(retainedValueAt(evidence.record,'/data/absent')).toEqual({ present: false });
  expect(retainedValueAt({ a: null,b: '',c: [],d: {} },'/a')).toEqual({ present: true,value: null });
});

test('release field custody retains primitive booleans and binds the actual edition occurrence', async () => {
  const original: DatasetRecord = { key: 'vndb:release:r14',provider: 'vndb',kind: 'release',externalId: 'r14',
    title: 'Exact edition',language: 'ja',sourceUrl: 'https://vndb.org/r14',native: 'release',
    data: { official: false,released: '20049999',tables: { releases_titles: [{ lang: 'ja',mtl: false }] } } };
  const principalId = randomUUID(), { evidence,binding,conversions } = await retain(principalId,original,true);
  const target = sourceIri(randomUUID()), revision = sourceIri(randomUUID()), component = sourceIri(randomUUID());
  const property = (await retainedFieldPlan(evidence.request)).fields
    .find(field => field.role === 'release-status')!.native!.property!;
  const command = { component: sourceIri(randomUUID()),revision: sourceIri(randomUUID()),
    receipt: `urn:rezics:receipt:${'7'.repeat(64)}`,expectedHead: sourceIri(randomUUID()) };
  const input: RetainedSupportRequest = { profile: 'source-field-support-attachment-v2',target,
    slot: `component-property-v1#${property.predicate}`,occurrence: component,context: 'global',
    sourceRecord: binding.sourceRecord,conversion: binding.conversion,grain: 'release',sourceField: 'official',
    sourceOccurrence: null,expectedHead: revision,actingSubject: sourceIri(randomUUID()),
    evidence: { binding: binding.binding,recordDigest: binding.recordDigest,mappingRevision: binding.mappingRevision,
      field: { pointer: '/data/official',presence: 'value',valueDigest: canonicalDigest(false) } },
    native: { kind: 'component-property',owner: 'release',target,component,revision,
      receipt: `urn:rezics:receipt:${'8'.repeat(64)}`,expectedHead: revision,property,
      coverage: { realization: command,completeness: 'complete' } } };
  const verified = await verifyRetainedField(input,evidence);
  expect(verified.value).toBe(false);
  expect(verified.candidate.native?.owner).toBe('release');
  expect(verified.correspondence.payloadPointers).toEqual(['/record/data/official']);
  expect(verified.candidate.native?.property?.value).toEqual({ kind: 'string',lexical: 'unofficial' });
  const wrong = structuredClone(input); wrong.occurrence = sourceIri(randomUUID());
  await expect(verifyRetainedField(wrong,evidence)).rejects.toMatchObject({ status: 409,basis: 'native-target' });
  const value = structuredClone(input);
  if (value.native.kind === 'component-property') value.native.property.value = { kind: 'string',lexical: 'official' };
  await expect(verifyRetainedField(value,evidence)).rejects.toMatchObject({ status: 409,basis: 'native-value' });
  expect(binding.mappingRevision).toBe('vndb-release-retained-map-v2');
  const legacyRequest = { ...evidence.request,mappingRevision: 'vndb-release-retained-map-v1' };
  const legacy = await conversions.convert(principalId,legacyRequest.retained.intakes[0]!.observation.slice(-36),legacyRequest);
  expect(legacy.conversion.fieldInventory.some(field => ['release-status','release-title','release-language'].includes(field.role)))
    .toBe(false);
  expect(await conversions.read(principalId,legacy.conversion.conversion)).toEqual(legacy.conversion);
  expect(await conversions.convert(principalId,legacyRequest.retained.intakes[0]!.observation.slice(-36),legacyRequest))
    .toEqual({ ...legacy,replayed: true });
});

test('Source settles separate record supports with delegated native acknowledgements and immutable certificates', async () => {
  // This is the SQL/Source boundary test. The delegated Statement verifier and
  // graph admission are controlled ports; no real native/public outcome is proved.
  const principalId = randomUUID(), principal = { issuer: 'https://account.test',subject: 'source-owner' };
  const first = await retain(principalId), secondRecord = record('musicbrainz');
  secondRecord.externalId = randomUUID(); secondRecord.key = `musicbrainz:artist:${secondRecord.externalId}`;
  secondRecord.data.id = secondRecord.externalId;
  secondRecord.sourceUrl = `https://musicbrainz.org/artist/${secondRecord.externalId}`;
  const second = await retain(principalId,secondRecord,true);
  const target = sourceIri(randomUUID()), revision = sourceIri(randomUUID()), actor = sourceIri(randomUUID());
  const native: RetainedSupportRequest['native'] = { kind: 'statement',owner: 'statement',target,revision,
    receipt: `urn:rezics:receipt:${canonicalDigest({ boundary: randomUUID() })}`,statement: sourceIri(randomUUID()),
    relationDefinition: sourceIri(randomUUID()),predicate: 'https://schema.org/name',
    value: { kind: 'literal',lexical: 'Johann Sebastian Bach',datatype: 'http://www.w3.org/2001/XMLSchema#string',language: null },
    context: 'global',qualifiers: { applicability: [],interpretationDefinitions: [] },acceptance: null };
  const ack: VerifiedNativeAcknowledgement = { receipt: native.receipt,admissionId: randomUUID(),dataEpoch: randomUUID(),
    sequence: '17',scope: `statement:speak:${actor}`,action: 'statement.record',component: native.statement,revision };
  const env = { lineage: { dataEpoch: ack.dataEpoch,routingEpoch: randomUUID() },fuseki: {
    query: async (query: string) => { expect(query).toContain('ASK'); return { boolean: true }; },
  } } as unknown as WorkActivationEnvironment;
  let current = true, permitted = true, reuseChecks = 0;
  const access: Pick<AccessAdmissionRegistry, 'withOwnerAuthority'> = { withOwnerAuthority: async (request, operation) => {
    expect(request).toMatchObject({ scope: ack.scope,action: ack.action });
    const client = await pool.connect();
    try { return await operation(client); } finally { client.release(); }
  } };
  const store = new SourceRetainedFieldSupportStore(pool,env,access,first.conversions,{
    authorizeReuse: async (_principal,_actor,custody) => {
      reuseChecks++; expect(custody.observations.length).toBeGreaterThan(0);
      if (!permitted) throw new SourceFieldProblem(403,'rights_denied','Reuse denied');
    }, statement: async (input,requireCurrent) => {
      expect(input.native).toEqual(native);
      expect(requireCurrent).toBe(true);
      if (requireCurrent && !current) return supportChanged('native-head');
      return ack;
    },publicEvidence: async () => null,
  });
  const request = (binding: typeof first.binding): RetainedSupportRequest => ({
    profile: 'source-field-support-attachment-v2',target,slot: 'statement-v1#value',occurrence: null,context: 'global',
    sourceRecord: binding.sourceRecord,conversion: binding.conversion,grain: 'artist',sourceField: 'name',sourceOccurrence: null,
    expectedHead: revision,actingSubject: actor,native,evidence: { binding: binding.binding,
      mappingRevision: binding.mappingRevision,recordDigest: binding.recordDigest,
      field: { pointer: '/data/name',presence: 'value',valueDigest: canonicalDigest('Johann Sebastian Bach') } } });
  const input = request(first.binding), key = randomUUID();
  const attached = await store.attach(principal,principalId,key,input);
  const a = (await store.read(principalId,attached.support))!;
  expect(a.graphReceipt).toBe(native.receipt);
  expect(a.attachment.nativeReceipt).toBe(native.receipt);
  expect(a.attachment.receipt).not.toBe(native.receipt);
  expect(a.headGuarantee).toBe('verified-before-commit');
  expect(a.admission.correspondence.payloadPointers).toEqual(['/record/data/name']);
  expect(a.publicEvidence).toBeNull();
  expect(await store.attach(principal,principalId,key,structuredClone(input))).toEqual({ ...attached,replayed: true });
  expect((await store.read(principalId,attached.support))!.attachment).toEqual(a.attachment);
  const attachedOther = await store.attach(principal,principalId,randomUUID(),request(second.binding));
  expect(attachedOther.support).not.toBe(attached.support);
  const b = (await store.read(principalId,attachedOther.support))!;
  expect(b.graphReceipt).toBe(a.graphReceipt);
  expect(b.attachment.receipt).not.toBe(a.attachment.receipt);
  expect(await store.read(randomUUID(),attached.support)).toBeNull();
  await expect(pool.query('UPDATE source.field_support_attachment SET request_digest=$1 WHERE step_id=$2',
    ['0'.repeat(64),attached.step.slice(-36)])).rejects.toMatchObject({ code: '23514' });
  const before = (await pool.query('SELECT count(*)::integer AS n FROM source.field_support_step WHERE principal_id=$1',[principalId])).rows[0].n;
  permitted = false;
  const denied = structuredClone(input); denied.evidence.field.valueDigest = '0'.repeat(64);
  await expect(store.attach(principal,principalId,randomUUID(),denied)).rejects.toMatchObject({ status: 403,code: 'rights_denied' });
  const checks = reuseChecks;
  denied.sourceRecord = sourceIri(randomUUID());
  await expect(store.attach(principal,principalId,randomUUID(),denied)).rejects.toMatchObject({ status: 404 });
  expect(reuseChecks).toBe(checks);
  permitted = true; current = false;
  expect((await store.read(principalId,attached.support))!.attachment).toEqual(a.attachment);
  expect(await store.attach(principal,principalId,key,input)).toEqual({ ...attached,replayed: true });
  await expect(store.attach(principal,principalId,randomUUID(),input)).rejects.toMatchObject({ status: 409,basis: 'native-head' });
  expect((await pool.query('SELECT count(*)::integer AS n FROM source.field_support_step WHERE principal_id=$1',[principalId])).rows[0].n).toBe(before);
  const withdrawals = new SourceFieldWithdrawalStore(pool,env,store);
  const withdrawn = await withdrawals.withdraw(principalId,randomUUID(),{ support: attached.support,
    expectedSupport: a.supportIdentity,reason: 'Withdraw one source record' });
  expect(withdrawn?.support.withdrawal?.nativeEffect).toBe('none');
  expect((await store.read(principalId,attachedOther.support))!.state).toBe('recorded');
  expect((await store.read(principalId,attached.support))!.attachment).toEqual(a.attachment);
});

test('Source evidence windows preserve the evidence owner projection, hidden positions and settlement/withdrawal fences', async () => {
  // Real Source SQL, immutable certificates and Work dependency fencing, with
  // controlled native/evidence transports. This is not public/native-stack proof.
  const principalId = randomUUID(), principal = { issuer: 'https://account.test',subject: 'source-window-owner' };
  const first = await retain(principalId), target = sourceIri(randomUUID()), revision = sourceIri(randomUUID());
  const actor = sourceIri(randomUUID()), statement = sourceIri(randomUUID());
  const native: RetainedSupportRequest['native'] = { kind: 'statement',owner: 'statement',target,revision,statement,
    receipt: `urn:rezics:receipt:${canonicalDigest({ command: randomUUID() })}`,
    relationDefinition: sourceIri(randomUUID()),predicate: 'https://schema.org/name',
    value: { kind: 'literal',lexical: 'Johann Sebastian Bach',datatype: 'http://www.w3.org/2001/XMLSchema#string',language: null },
    context: 'global',qualifiers: { applicability: [],interpretationDefinitions: [] },acceptance: null };
  const ack: VerifiedNativeAcknowledgement = { receipt: native.receipt,admissionId: randomUUID(),dataEpoch: randomUUID(),
    sequence: '31',scope: `statement:speak:${actor}`,action: 'statement.record',component: statement,revision };
  const env = { lineage: { dataEpoch: ack.dataEpoch,routingEpoch: randomUUID() },fuseki: {
    query: async () => ({ boolean: true }),
  } } as unknown as WorkActivationEnvironment;
  const access: Pick<AccessAdmissionRegistry,'withOwnerAuthority'> = { withOwnerAuthority: async (_request,operation) => {
    const client = await pool.connect(); try { return await operation(client); } finally { client.release(); }
  } };
  const hidden = new Set<string>(), projections = new Map<string,RetainedPublicEvidence>();
  let reuseChecks = 0, nativeChecks = 0;
  let deniedRecord: string | null = null;
  const evidenceOwners = retainedFieldEvidenceOwners({
    authorizeRetainedFieldReuse: async (who,actingSubject,sourceRecord,observations) => {
      reuseChecks++; expect(who).toEqual(principal); expect(actingSubject).toBe(actor);
      expect(sourceRecord).toMatch(/^https:\/\/rezics.com\/id\//); expect(observations.length).toBeGreaterThan(0);
      if (sourceRecord === deniedRecord) throw new SourceFieldProblem(403,'rights_denied','Reuse denied');
    },
    projectPublicRetainedField: async (who,actingSubject,evidence,pointer,language) => {
      expect(who).toEqual(principal); expect(actingSubject).toBe(actor);
      expect(pointer).toBe('/record/data/name'); expect(language).toEqual({ state: 'omitted' });
      const binding = evidence.conversion.retainedRecord;
      if (hidden.has(binding.sourceRecord)) return null;
      const projection: RetainedPublicEvidence = { id: binding.sourceRecord,sourceWork: null,
        representationSha256: binding.payload.byteDigest,locator: { pointer },
        attribution: { sourceName: binding.identity.provider,sourceUrl: evidence.record.sourceUrl,licence: null },
        language,quote: null,quoteWithheld: true,rightsBasis: { basisKind: 'unassessed',basisRef: null,
          licenseExpression: null,notice: null,obligations: [],useScope: 'quotation',result: 'undetermined',memberOrdinals: [1] } };
      projections.set(binding.sourceRecord,projection); return projection;
    },
  });
  const store = new SourceRetainedFieldSupportStore(pool,env,access,first.conversions,{
    ...evidenceOwners,statement: async () => { nativeChecks++; return ack; },
  });
  const selection = { target,slot: 'statement-v1#value',occurrence: null,context: 'global',component: statement,revision };
  const entries: Array<{ input: RetainedSupportRequest; key: string; support: string }> = [];
  for (let index = 0; index < 18; index++) {
    const original = record('musicbrainz'); original.externalId = randomUUID();
    original.key = `musicbrainz:artist:${original.externalId}`; original.data.id = original.externalId;
    original.sourceUrl = `https://musicbrainz.org/artist/${original.externalId}`;
    const { binding } = index === 0 ? first : await retain(principalId,original,index % 2 === 0);
    const input: RetainedSupportRequest = { profile: 'source-field-support-attachment-v2',target,
      slot: 'statement-v1#value',occurrence: null,context: 'global',sourceRecord: binding.sourceRecord,
      conversion: binding.conversion,grain: 'artist',sourceField: 'name',sourceOccurrence: null,
      expectedHead: revision,actingSubject: actor,native,evidence: { binding: binding.binding,
        recordDigest: binding.recordDigest,mappingRevision: binding.mappingRevision,
        field: { pointer: '/data/name',presence: 'value',valueDigest: canonicalDigest('Johann Sebastian Bach') } } };
    const key = randomUUID(), attached = await store.attach(principal,principalId,key,input);
    entries.push({ input,key,support: attached.support });
  }
  expect(reuseChecks).toBe(18);
  expect(await store.evidenceGeneration(selection)).toBe('18');
  expect(await store.evidenceGeneration({ ...selection,target: sourceIri(randomUUID()) })).toBe('0');
  expect(await store.evidenceGeneration({ ...selection,occurrence: sourceIri(randomUUID()) })).toBe('0');
  expect(await store.evidenceGeneration({ ...selection,slot: 'statement-v1#other' })).toBe('0');
  const beforeRefusal = await store.evidenceGeneration(selection), beforeNative = nativeChecks;
  const mismatched = structuredClone(entries[0]!.input);
  mismatched.sourceRecord = entries[1]!.input.sourceRecord; deniedRecord = mismatched.sourceRecord;
  await expect(store.attach(principal,principalId,randomUUID(),mismatched))
    .rejects.toMatchObject({ status: 403,code: 'rights_denied' });
  expect(nativeChecks).toBe(beforeNative); expect(await store.evidenceGeneration(selection)).toBe(beforeRefusal);
  deniedRecord = null;
  await expect(store.attach(principal,principalId,randomUUID(),mismatched))
    .rejects.toMatchObject({ status: 409,basis: 'record' });
  expect(nativeChecks).toBe(beforeNative); expect(await store.evidenceGeneration(selection)).toBe(beforeRefusal);
  const session = () => {
    const read = new WorkReadSession({ environment: env } as MainWorkDependencies,
      new Request('https://rezics.test/v1/query'),{}, { dataEpoch: ack.dataEpoch,sequence: ack.sequence });
    read.principal = principal; return read;
  };
  await expect(store.readEvidenceWindow(session(),selection)).rejects.toMatchObject({ status: 503 });
  const active = session();
  const page = await withWorkReadSession(active,() => store.readEvidenceWindow(active,selection));
  expect(page.items).toHaveLength(16); expect(page.more).toBe(true); expect(page.next).not.toBeNull();
  const nextSession = session();
  const next = await withWorkReadSession(nextSession,() => store.readEvidenceWindow(nextSession,selection,page.next!));
  expect(next.items).toHaveLength(2); expect(next.more).toBe(false); expect(next.next).toBeNull();
  const all = [...page.items,...next.items];
  expect(new Set(all.map(item => item.id)).size).toBe(18);
  for (const item of all) {
    expect(item).toEqual(projections.get(item.id)!); expect(item.sourceWork).toBeNull();
    expect(item.quoteWithheld).toBe(true); expect(item.quote).toBeNull();
    for (const privateField of ['binding','intakes','attachment','native','requestDigest']) expect(item).not.toHaveProperty(privateField);
  }
  await active.fenceDependencies();
  const before = await store.evidenceGeneration(selection);
  await store.attach(principal,principalId,entries[0]!.key,entries[0]!.input);
  expect(await store.evidenceGeneration(selection)).toBe(before);
  for (const item of page.items) hidden.add(item.id);
  await expect(active.fenceDependencies()).rejects.toBeInstanceOf(WorkReadMoved);
  const hiddenSession = session();
  const hiddenPage = await withWorkReadSession(hiddenSession,() => store.readEvidenceWindow(hiddenSession,selection));
  expect(hiddenPage.items).toEqual([]); expect(hiddenPage.more).toBe(true); expect(hiddenPage.next).toEqual(page.next);
  const tailSession = session();
  expect((await withWorkReadSession(tailSession,() => store.readEvidenceWindow(tailSession,selection,hiddenPage.next!)))
    .items.map(item => item.id)).toEqual(next.items.map(item => item.id));
  const saved = (await store.read(principalId,entries[0]!.support,undefined,principal))!;
  const repeated = await retain(principalId,first.evidence.record,true);
  const repeatedInput = structuredClone(entries[0]!.input);
  repeatedInput.sourceRecord = repeated.binding.sourceRecord;
  repeatedInput.conversion = repeated.binding.conversion;
  repeatedInput.evidence = { ...repeatedInput.evidence,binding: repeated.binding.binding,
    recordDigest: repeated.binding.recordDigest,mappingRevision: repeated.binding.mappingRevision };
  const repeatedSupport = await store.attach(principal,principalId,randomUUID(),repeatedInput);
  expect(repeatedSupport.support).toBe(entries[0]!.support);
  expect((await pool.query('SELECT count(*)::integer AS n FROM source.field_support WHERE principal_id=$1',[principalId]))
    .rows[0].n).toBe(18);
  const afterRepeat = await store.evidenceGeneration(selection);
  expect(afterRepeat).not.toBe(before);
  const repeatedSaved = (await store.read(principalId,repeatedSupport.support,undefined,principal))!;
  expect(repeatedSaved.attachment.nativeReceipt).toBe(saved.attachment.nativeReceipt);
  expect(repeatedSaved.attachment.receipt).not.toBe(saved.attachment.receipt);
  await new SourceFieldWithdrawalStore(pool,env,store).withdraw(principalId,randomUUID(),{
    support: entries[0]!.support,expectedSupport: repeatedSaved.supportIdentity,reason: 'Withdraw a retained record' });
  expect(await store.evidenceGeneration(selection)).not.toBe(afterRepeat);
  const staleSession = session();
  await expect(withWorkReadSession(staleSession,() => store.readEvidenceWindow(staleSession,selection,page.next!)))
    .rejects.toBeInstanceOf(WorkReadMoved);
  await expect(hiddenSession.fenceDependencies()).rejects.toBeInstanceOf(WorkReadMoved);
});


test('source synopsis admission consumes the saved explicit conversion, preserving provenance, text and reuse checks', async () => {
  const principalId = randomUUID(), original = record('vndb');
  original.data.description = '  First line\r\nSecond line\t' + 'long'.repeat(3000);
  original.data.description_language = '';
  const { evidence,binding,conversions } = await retain(principalId,original,true);
  expect(evidence.fieldPlan).not.toBeNull();
  const saved = (await pool.query<{ projection: { fieldPlan: unknown; fieldPlanDigest: string } }>(
    'SELECT projection FROM source.conversion WHERE id=$1',[binding.conversion.slice(-36)])).rows[0]!;
  expect(saved.projection.fieldPlan).toEqual(evidence.fieldPlan);
  expect(saved.projection.fieldPlanDigest).toBe(canonicalDigest(evidence.fieldPlan));
  await expect(pool.query('UPDATE source.conversion SET projection=$1 WHERE id=$2',
    ['{}',binding.conversion.slice(-36)])).rejects.toMatchObject({ code: '23514' });
  let permitted = true, checks = 0;
  const store = new SourceRetainedFieldSupportStore(pool,{} as WorkActivationEnvironment,
    {} as Pick<AccessAdmissionRegistry,'withOwnerAuthority'>,conversions,{
      authorizeReuse: async (_principal,_actor,custody) => {
        checks++; expect(custody.sourceRecord).toBe(binding.sourceRecord);
        expect(custody.observations).toHaveLength(2);
        if (!permitted) throw new SourceFieldProblem(403,'rights_denied','Reuse denied');
      },
    });
  const intent = { profile: 'work-editorial-field-control-v1' as const,work: sourceIri(randomUUID()),
    field: 'synopsis' as const,expectedWorkHead: sourceIri(randomUUID()),
    basis: { contentHead: null,head: null,epoch: '0',protection: null },value: original.data.description as string,
    language: { state: 'value' as const,value: '' },origin: 'source' as const,
    source: { record: binding.sourceRecord,observation: binding.intakes[0]!.observation,
      conversion: binding.conversion,mapping: binding.mappingRevision },actingSubject: sourceIri(randomUUID()) };
  const principal = { token: 'controlled-account-port' } as unknown as Parameters<typeof store.admitSynopsis>[0];
  await store.admitSynopsis(principal,principalId,intent);
  expect(checks).toBe(1);
  await expect(store.admitSynopsis(principal,principalId,{ ...intent,value: intent.value.trim() }))
    .rejects.toMatchObject({ status: 409,basis: 'native-value' });
  await expect(store.admitSynopsis(principal,principalId,{ ...intent,language: { state: 'omitted' } }))
    .rejects.toMatchObject({ status: 409,basis: 'native-value' });
  permitted = false;
  await expect(store.admitSynopsis(principal,principalId,{ ...intent,value: 'different' }))
    .rejects.toMatchObject({ status: 403,code: 'rights_denied' });
  expect((await conversions.evidence(principalId,binding.conversion))!.fieldPlan).toEqual(evidence.fieldPlan);
});
