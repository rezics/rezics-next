import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { Value } from 'typebox/value';
import type { DatasetRecord } from '../../../scripts/datasets/types.ts';
import { canonicalJson } from '../../../scripts/lib/canonical-json.ts';
import { startPostgresCluster, type PostgresCluster } from '../../../tests/qa/support/postgres-cluster.ts';
import { migrateContent } from '../../content/src/migrate.ts';
import type { AccessAdmissionRegistry } from '../src/modules/access/admission.ts';
import { SourceIntakeStore } from '../src/modules/source/intake.ts';
import { SourceRetainedRecordStore } from '../src/modules/source/retained-record.ts';
import { canonicalDigest, sourceDigest } from '../src/modules/source/retained-record-normalization.ts';
import { SourceFieldProblem, type RetainedConversionRequest, type RetainedSupportRequest } from '../src/modules/source/field-support-contract.ts';
import { verifyRetainedField } from '../src/modules/source/field-support-evidence.ts';
import { acknowledgedSemanticSupportOwners } from '../src/modules/source/field-support-acknowledged.ts';
import { verifySourceNative } from '../src/modules/source/field-support-native.ts';
import { retainedSupportRequest } from '../src/modules/source/field-support-schema.ts';
import { SourceRetainedFieldSupportStore } from '../src/modules/source/field-support-retained.ts';
import type { NativeBasisVerificationInput } from '../src/modules/semantic/native-basis.ts';
import { nativeEpoch, nativeId, nativePrincipal, semanticFixture, statementFixture } from './support/source-field-native-fixture.ts';

let cluster: PostgresCluster, pool: Pool;
beforeAll(async () => {
  cluster = await startPostgresCluster();
  pool = new Pool({ ...cluster.connection,max: 4 });
  await migrateContent(pool);
},120_000);
afterAll(async () => { await pool?.end(); await cluster?.stop(); });

/** Actual retained bytes, persisted intake and explicit conversion. The native
 * graph transport is strict and the real native verifier reads sealed manifests.
 * Authority/reuse ports here are controlled composition inputs, not rights proof. */
async function retained(text = '原作', language: string | null | undefined = 'ja', omitLanguage = false) {
  if (omitLanguage) language = undefined;
  const principalId = randomUUID(), externalId = randomUUID();
  const alias = { name: text,...(language === undefined ? {} : { locale: language }) };
  const record: DatasetRecord = { key: `musicbrainz:artist:${externalId}`,provider: 'musicbrainz',kind: 'artist',externalId,
    title: text,language: 'ja',sourceUrl: `https://musicbrainz.org/artist/${externalId}`,native: 'person',
    data: { id: externalId,name: text,aliases: [alias] } };
  const snapshot = { id: 'source-native-owner-shape',digest: 'a'.repeat(64),fileSha256: 'b'.repeat(64) };
  const bytes = Buffer.from(canonicalJson({ format: 'rezics-dataset-record-v1',snapshot: snapshot.id,
    digest: snapshot.digest,record,edges: [],images: [] }));
  const intake = new SourceIntakeStore(pool);
  const observation = (await intake.submit(principalId,randomUUID(),{
    provider: record.provider,namespace: record.kind,externalId,sourceRevision: snapshot.digest,
    mediaType: 'application/json',retention: 'retained',rawBytesBase64: bytes.toString('base64'),
    coverage: { scope: 'captured-shape',complete: true,omittedFields: [] },rightsEvidence: { basis: 'facts',note: 'Unit shape only' },
  })).observation;
  const request: RetainedConversionRequest = { profile: 'source-retained-record-conversion-v1',
    mappingRevision: 'musicbrainz-artist-retained-map-v1',retained: {
      identity: { key: record.key,provider: record.provider,namespace: record.kind,externalId },snapshot,record,
      recordDigest: canonicalDigest(record),payload: { format: 'json',byteDigest: sourceDigest(bytes),byteLength: bytes.length },
      intakes: [{ index: 0,record: observation.record,observation: observation.observation,byteDigest: observation.byteDigest! }],
    } };
  const records = new SourceRetainedRecordStore(pool,intake);
  const converted = await records.convert(principalId,observation.observation.slice(-36),request);
  const evidence = (await records.evidence(principalId,converted.conversion.conversion))!;
  const candidate = evidence.fieldPlan!.fields.find(item => item.evidence.some(field => field.path === '/data/aliases/0/name'))!;
  const binding = converted.conversion.retainedRecord;
  const input = (basis: NativeBasisVerificationInput): RetainedSupportRequest => ({
    profile: 'source-field-support-attachment-v2',target: basis.native.target,
    slot: basis.native.kind === 'statement' ? 'statement-v1#value' : `component-property-v1#${basis.native.property.predicate}`,
    occurrence: null,context: 'global',sourceRecord: binding.sourceRecord,conversion: binding.conversion,
    grain: record.kind,sourceField: 'aliases/0/name',sourceOccurrence: null,expectedHead: basis.native.revision,
    actingSubject: basis.actingSubject,native: basis.native,evidence: { binding: binding.binding,recordDigest: binding.recordDigest,
      mappingRevision: binding.mappingRevision,field: { pointer: '/data/aliases/0/name',presence: 'value',valueDigest: canonicalDigest(text),
        ...(language === undefined ? {} : { language }) } },
  });
  return { principalId,records,evidence,candidate,input };
}

test('Source passes independently resolved retained bytes and exact supplied language to the actual Semantic owner', async () => {
  const f = await semanticFixture(), r = await retained(), input = r.input(f.input);
  const field = await verifyRetainedField(input,r.evidence), owners = acknowledgedSemanticSupportOwners(f.work);
  expect(field.selected).toEqual({ value: '原作',language: { state: 'value',value: 'ja' } });
  const ack = await verifySourceNative(f.work.environment,input,owners,true,{ principal: nativePrincipal,selected: field.selected });
  expect(ack).toEqual({ receipt: f.receipt,admissionId: f.admissionId,scope: 'semantic:create:root',
    action: 'semantic.change',component: input.target,revision: f.revision,dataEpoch: nativeEpoch,sequence: '4',
    semantic: { operation: f.operation,manifest: f.manifest,modelGeneration: f.generation,headGuarantee: 'verified-before-commit' } });
  // Resolve a second genuine retained selection first. A native claim matching
  // its own current property is insufficient when the source value/language differ.
  for (const [text,language] of [['改作','ja'],['原作','zh']] as const) {
    const different = await retained(text,language), correct = different.input(f.input);
    if (correct.native.kind !== 'component-property' || correct.native.owner !== 'semantic') throw new Error('Semantic basis required');
    correct.native = { ...correct.native,property: different.candidate.native!.property! };
    const independentlySelected = (await verifyRetainedField(correct,different.evidence)).selected;
    await expect(verifySourceNative(f.work.environment,input,owners,true,{ principal: nativePrincipal,selected: independentlySelected }))
      .rejects.toMatchObject({ status: 409,code: 'source_support_changed',basis: 'native-value' });
  }
  await expect(verifySourceNative(f.work.environment,input,{},true,{ principal: nativePrincipal,selected: field.selected }))
    .rejects.toMatchObject({ status: 503,code: 'source_support_unavailable' });
  f.receiptRevision(nativeId(99));
  await expect(verifySourceNative(f.work.environment,input,owners,true,{ principal: nativePrincipal,selected: field.selected }))
    .rejects.toMatchObject({ status: 409,basis: 'native-head' });
  f.receiptRevision(f.revision); f.receiptAvailable(false);
  await expect(verifySourceNative(f.work.environment,input,owners,true,{ principal: nativePrincipal,selected: field.selected }))
    .rejects.toMatchObject({ status: 503,code: 'source_support_unavailable' });
});

test('retained correspondence preserves V1 meaning and lossless language states while V2 requires authored coverage', async () => {
  const f = await statementFixture();
  for (const language of [null,undefined,'','ja'] as const) {
    const r = await retained('原作',language,language === undefined);
    const input = r.input(f.input);
    if (input.native.kind !== 'statement') throw new Error('Statement basis required');
    input.native = { ...input.native,value: r.candidate.native!.property!.value };
    const field = await verifyRetainedField(input,r.evidence);
    expect(field.selected.language).toEqual(language === undefined ? { state: 'omitted' }
      : language === null ? { state: 'null' } : { state: 'value',value: language });
  }
  const r = await retained(), input = r.input(f.input);
  expect(Value.Check(retainedSupportRequest as never,input)).toBe(true);
  const legacy = structuredClone(input);
  if (legacy.native.kind !== 'statement') throw new Error('Statement basis required');
  delete legacy.native.coverage;
  legacy.native.value = r.candidate.native!.statementValue!;
  expect(Value.Check(retainedSupportRequest as never,legacy)).toBe(true);
  expect((await verifyRetainedField(legacy,r.evidence)).candidate.native!.statementValue).toEqual(legacy.native.value);
  const noCoverage = structuredClone(input);
  if (noCoverage.native.kind !== 'statement') throw new Error('Statement basis required');
  delete noCoverage.native.coverage;
  expect(Value.Check(retainedSupportRequest as never,noCoverage)).toBe(false);
  const missingOccurrence = structuredClone(input);
  if (missingOccurrence.native.kind !== 'statement') throw new Error('Statement basis required');
  missingOccurrence.native.coverage = { kind: 'participation',occurrence: nativeId(80),occurrenceRevision: nativeId(81),participation: nativeId(82) };
  await expect(verifyRetainedField(missingOccurrence,r.evidence)).rejects.toMatchObject({ status: 409,basis: 'native-target' });
});

test('Source settles an actual V2 acknowledgement, refuses missing coverage/adoption and replays historical custody without current evidence', async () => {
  const f = await statementFixture(), r = await retained(), input = r.input(f.input);
  let permitted = true;
  const access: Pick<AccessAdmissionRegistry,'withOwnerAuthority'> = { withOwnerAuthority: async (request,operation) => {
    expect(request).toMatchObject({ scope: `statement:speak:${f.input.actingSubject}`,action: 'statement.record' });
    const client = await pool.connect();
    try { return await operation(client); } finally { client.release(); }
  } };
  const store = new SourceRetainedFieldSupportStore(pool,f.work.environment,access,r.records,{
    ...acknowledgedSemanticSupportOwners(f.work),
    authorizeReuse: async () => { if (!permitted) throw new SourceFieldProblem(403,'rights_denied','Reuse denied'); },
    publicEvidence: async () => null,
  });
  const key = randomUUID(), attached = await store.attach(nativePrincipal,r.principalId,key,input);
  const read = () => store.read(r.principalId,attached.support,undefined,nativePrincipal);
  const original = (await read())!;
  expect(original.attachment.nativeReceipt).toBe(f.receipt);
  expect(original.graphReceipt).toBe(f.receipt);
  expect(original.admission.native).toEqual(f.input.native);
  expect(original.headGuarantee).toBe('verified-before-commit');
  const saved = (await pool.query('SELECT native_acknowledgement FROM source.field_support_step WHERE id=$1',[attached.step.slice(-36)])).rows[0].native_acknowledgement;
  expect(saved).toMatchObject({ admissionId: f.admissionId,scope: `statement:speak:${f.input.actingSubject}`,semantic: { operation: f.operation,manifest: f.manifest } });
  const count = async () => (await pool.query('SELECT count(*)::integer AS n FROM source.field_support_step WHERE principal_id=$1',[r.principalId])).rows[0].n;
  const refused = async (request: RetainedSupportRequest,expected: object) => {
    await expect(store.attach(nativePrincipal,r.principalId,randomUUID(),request)).rejects.toMatchObject(expected);
    expect(await count()).toBe(1);
  };
  const legacy = structuredClone(input);
  if (legacy.native.kind !== 'statement') throw new Error('Statement basis required');
  delete legacy.native.coverage; legacy.native.value = r.candidate.native!.statementValue!;
  await refused(legacy,{ status: 409,basis: 'native-value' });
  const noAcceptance = structuredClone(input);
  if (noAcceptance.native.kind !== 'statement') throw new Error('Statement basis required');
  noAcceptance.native.acceptance = null;
  await refused(noAcceptance,{ status: 409,basis: 'native-value' });
  f.adoption('rejected'); await refused(input,{ status: 409,basis: 'native-value' });
  f.adoption('unavailable'); await refused(input,{ status: 503,code: 'source_support_unavailable' });
  f.adoption('accepted'); f.receiptAdmission(randomUUID());
  await refused(input,{ status: 409,basis: 'native-head' });
  f.receiptAdmission(f.admissionId); f.receiptAvailable(false);
  await refused(input,{ status: 503,code: 'source_support_unavailable' });
  f.receiptAvailable(true);
  permitted = false;
  const wrong = structuredClone(input); wrong.evidence.field.valueDigest = '0'.repeat(64);
  await refused(wrong,{ status: 403,code: 'rights_denied' });
  permitted = true; f.head(nativeId(99));
  await refused(input,{ status: 409,basis: 'native-head' });
  const historical = (await read())!;
  expect(historical.attachment).toEqual(original.attachment);
  expect(historical.admission).toEqual(original.admission);
  expect(historical.publicEvidence).toBeNull();
  expect(await store.attach(nativePrincipal,r.principalId,key,input)).toEqual({ ...attached,replayed: true });
  expect(await count()).toBe(1);
});
