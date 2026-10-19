import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { DatasetRecord } from '../../../scripts/datasets/types.ts';
import { canonicalJson } from '../../../scripts/lib/canonical-json.ts';
import { FusekiClient } from '../src/infrastructure/fuseki.ts';
import { AccessAdmissionRegistry } from '../src/modules/access/admission.ts';
import { fixtureAuthorityScenario, setFixtureMandateState } from '../src/modules/access/fixture-authority-scenario.ts';
import { grantFixtureAuthority } from '../src/modules/access/fixture-authority.ts';
import { ControlDenied } from '../src/modules/access/topology-control.ts';
import { configureDisclosure, DisclosureStore } from '../src/modules/disclosure/read.ts';
import { GLOBAL_CONTEXT, GovernanceStore } from '../src/modules/governance/store.ts';
import { ASSESS_ACTION, ASSESS_SCOPE, RightsDenied, RightsStore, type AssessmentInput } from '../src/modules/rights/store.ts';
import { SourceIntakeStore } from '../src/modules/source/intake.ts';
import type { RetainedConversionRequest, SuppliedLanguage } from '../src/modules/source/field-support-contract.ts';
import { SourceRetainedRecordEvidenceOwner, type VerifiedRetainedRecordEvidence } from '../src/modules/source/retained-evidence.ts';
import { canonicalDigest, sourceDigest } from '../src/modules/source/retained-record-normalization.ts';
import { SourceRetainedRecordStore } from '../src/modules/source/retained-record.ts';
import { VerificationStore } from '../src/modules/verification/store.ts';
import { retainedEvidenceFixture } from './support/retained-evidence-fixture.ts';

const ID = 'https://rezics.com/id/';
const snapshot = { id: 'retained-evidence-shape', digest: 'a'.repeat(64), fileSha256: 'b'.repeat(64) };
const pointer = '/record/data/summary';
const text = '  简介\r\n第二行 e\u0301  ';
let f: Awaited<ReturnType<typeof retainedEvidenceFixture>>;
let intake: SourceIntakeStore, records: SourceRetainedRecordStore, access: AccessAdmissionRegistry, rights: RightsStore;
const env = { fuseki: new FusekiClient('http://graph.invalid'), objectDirectory: '.temp/retained-evidence-owner',
  lineage: { dataEpoch: 'owner-test-data', routingEpoch: 'owner-test-routing' } };
beforeAll(async () => {
  f = await retainedEvidenceFixture('retained_record_evidence');
  intake = new SourceIntakeStore(f.pool);
  records = new SourceRetainedRecordStore(f.pool, intake);
  access = new AccessAdmissionRegistry(f.accessPool);
  rights = new RightsStore(f.pool, f.accessPool);
  configureDisclosure(env, new DisclosureStore(f.accessPool));
  // Source is a SQL owner. An unexpected graph dependency is not a fixture.
  env.fuseki.query = async () => { throw new Error('unexpected graph read'); };
}, 120_000);
afterAll(async () => { await f?.close(); });
const authority = () => fixtureAuthorityScenario(f.pool,
  { scope: 'work:create:root', action: 'work.create', mandate: 'work.create' });
const owner = () => new SourceRetainedRecordEvidenceOwner(f.pool, intake, access, rights, records, env);

async function retained(principalId: string, multipart = false) {
  const externalId = String(Math.floor(Math.random() * 1_000_000_000));
  const record: DatasetRecord = { key: `bangumi:subject:${externalId}`, provider: 'bangumi', kind: 'subject',
    externalId, title: 'Captured shape', language: 'ja', sourceUrl: `https://bgm.tv/subject/${externalId}`,
    native: 'work', data: { id: Number(externalId), summary: text, empty: '', zero: 0, missingLanguage: null,
      aliases: [{ name: '別名', language: null }, { name: 'Alias', language: 'en' }] } };
  const bytes = Buffer.from(canonicalJson({ format: 'rezics-dataset-record-v1', snapshot: snapshot.id,
    digest: snapshot.digest, record, edges: [], images: [] }));
  const pieces = multipart ? [bytes.subarray(0, 119), bytes.subarray(119)] : [bytes];
  const observations = [];
  for (const [index, part] of pieces.entries()) {
    const observedBytes = multipart ? Buffer.from(canonicalJson({ format: 'rezics-dataset-chunk-v1',
      digest: sourceDigest(bytes), byteLength: bytes.length, index, count: pieces.length,
      encoding: 'base64', bytes: part.toString('base64') })) : part;
    observations.push((await intake.submit(principalId, randomUUID(), {
      provider: record.provider, namespace: multipart ? 'subject-dataset-part' : 'subject',
      externalId: multipart ? `${externalId}:part:${index}` : externalId, sourceRevision: snapshot.digest,
      mediaType: 'application/json', retention: 'retained', rawBytesBase64: observedBytes.toString('base64'),
      coverage: { scope: 'captured-shape', complete: !multipart, omittedFields: [] },
      rightsEvidence: { basis: 'unknown', note: 'Shape fixture, not a public quotation grant' },
    })).observation);
  }
  const request: RetainedConversionRequest = { profile: 'source-retained-record-conversion-v1',
    mappingRevision: 'bangumi-subject-retained-map-v1', retained: {
      identity: { key: record.key, provider: record.provider, namespace: record.kind, externalId }, snapshot,
      record, recordDigest: canonicalDigest(record),
      payload: { format: multipart ? 'rezics-dataset-chunk-v1' : 'json', byteDigest: sourceDigest(bytes), byteLength: bytes.length },
      intakes: observations.map((item, index) => ({ index, record: item.record,
        observation: item.observation, byteDigest: item.byteDigest! })),
    } };
  const converted = await records.convert(principalId, observations[0]!.observation.slice(ID.length), request);
  const evidence = (await records.evidence(principalId, converted.conversion.conversion))!;
  expect(evidence).not.toBeNull();
  return evidence;
}
async function assessment(a: Awaited<ReturnType<typeof authority>>, evidence: VerifiedRetainedRecordEvidence,
  use: 'quotation' | 'reuse', outcome: AssessmentInput['outcome'] = 'supported', expected: string | null = null) {
  await grantFixtureAuthority(f.pool, { scope: ASSESS_SCOPE, requireDispatch: true,
    representations: [{ principalId: a.principalId, actor: a.actor, action: ASSESS_ACTION, lifetime: 'infinity' }],
    grant: { actor: a.actor, action: ASSESS_ACTION, lifetime: 'infinity' } });
  return rights.assess(a.principal, { actingSubject: a.actor, material: { scopeKind: 'source_record',
    provider: null, namespace: null, sourceRecordId: evidence.conversion.retainedRecord.sourceRecord.slice(ID.length),
    contentVariantId: null, mediaAsset: null, component: 'record' }, family: 'data_rights',
    useKind: use === 'quotation' ? 'quotation' : 'redistribution',
    useScope: use === 'quotation' ? 'rezics:export:quotation' : 'rezics:imports', expressionKind: 'fact',
    basis: outcome === 'undetermined' ? 'unknown' : outcome === 'not_supported' ? 'permission' : 'unprotected_fact',
    outcome, licenseInstrument: null,
    exceptionKind: null, rationale: 'Isolated owner factual-shape test', extent: {}, evidence: {}, obligations: [],
    expectedAssessment: expected, idempotencyKey: randomUUID() });
}

test('scoped reuse denial precedes private binding, record, value, coordinate and custody mismatch disclosure', async () => {
  const a = await authority(), evidence = await retained(a.principalId, true);
  const refused = await assessment(a, evidence, 'reuse', 'not_supported');
  const sourceRecord = evidence.conversion.retainedRecord.sourceRecord;
  const mutations = [
    (e: VerifiedRetainedRecordEvidence) => { e.conversion.retainedRecord.binding = `${ID}${randomUUID()}`; },
    (e: VerifiedRetainedRecordEvidence) => { e.record.title = 'private mismatch'; },
    (e: VerifiedRetainedRecordEvidence) => { e.payload.record = {}; },
    (e: VerifiedRetainedRecordEvidence) => { e.observations[1]!.byteDigest = 'c'.repeat(64); },
    (e: VerifiedRetainedRecordEvidence) => { e.observations[1]!.observation = `${ID}${randomUUID()}`; },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(evidence); mutate(changed);
    await expect(owner().projectPublicRetainedField(a.principal, a.actor, changed, '/bad~pointer', { state: 'omitted' }))
      .rejects.toThrow(new RightsDenied('Source field reuse is restricted'));
  }
  await expect(owner().authorizeRetainedFieldReuse(a.principal, a.actor, sourceRecord,
    [{ ...evidence.observations[0]!, record: `${ID}${randomUUID()}` }])).rejects.toBeInstanceOf(RightsDenied);
  await assessment(a, evidence, 'reuse', 'supported', refused.assessmentId);
  await expect(owner().authorizeRetainedFieldReuse(a.principal, a.actor, sourceRecord, evidence.observations))
    .resolves.toBeUndefined();
});

test('reuse consumes live scoped Access and actual principal-owned observations, not an assessor grant', async () => {
  const a = await authority(), evidence = await retained(a.principalId);
  await assessment(a, evidence, 'reuse');
  const sourceRecord = evidence.conversion.retainedRecord.sourceRecord;
  const other = await authority();
  await expect(owner().authorizeRetainedFieldReuse(other.principal, other.actor, sourceRecord, evidence.observations))
    .rejects.toThrow(expect.objectContaining({ status: 404, code: 'source_support_unavailable' }));
  await setFixtureMandateState(f.pool, a.representationId, 'revoked');
  await expect(owner().authorizeRetainedFieldReuse(a.principal, a.actor, sourceRecord, evidence.observations))
    .rejects.toBeInstanceOf(ControlDenied);
});

test('multipart public projection retains the payload digest and exact pointer without observation or full-record aliases', async () => {
  const a = await authority(), evidence = await retained(a.principalId, true);
  await assessment(a, evidence, 'quotation');
  const before = structuredClone(evidence), language: SuppliedLanguage = { state: 'value', value: 'zh-Hant' };
  const projection = await owner().projectPublicRetainedField(a.principal, a.actor, evidence, pointer, language);
  expect(projection).toMatchObject({ id: evidence.conversion.retainedRecord.sourceRecord, sourceWork: null,
    representationSha256: evidence.request.retained.payload.byteDigest, locator: { pointer },
    quote: text, quoteWithheld: false, language, rightsBasis: { result: 'supported' },
    attribution: { sourceName: 'bangumi', sourceUrl: evidence.record.sourceUrl, licence: null } });
  expect(projection!.representationSha256).not.toBe(evidence.request.retained.recordDigest);
  for (const observation of evidence.observations) {
    expect(projection!.representationSha256).not.toBe(observation.byteDigest);
    expect(observation.record).not.toBe(projection!.id);
    expect(JSON.stringify(projection)).not.toContain(observation.observation);
  }
  expect(await owner().projectPublicRetainedField(a.principal, a.actor, evidence, '/data/summary', language)).toBeNull();
  expect(await owner().projectPublicRetainedField(a.principal, a.actor, evidence, '/bytes', language)).toBeNull();
  expect(evidence).toEqual(before);
  expect(JSON.stringify(projection)).not.toMatch(/binding|intakes|rawBytes|certificate|principal|payload/);
});

test('projection preserves supplied language states and empty values; absent evidence remains absent', async () => {
  const a = await authority(), evidence = await retained(a.principalId);
  await assessment(a, evidence, 'quotation');
  for (const language of [{ state: 'omitted' }, { state: 'null' }, { state: 'value', value: 'JA-Latn' }] as const) {
    expect(await owner().projectPublicRetainedField(a.principal, a.actor, evidence, '/record/data/empty', language))
      .toMatchObject({ language, quote: '', quoteWithheld: false });
  }
  expect(await owner().projectPublicRetainedField(a.principal, a.actor, evidence, '/record/data/zero', { state: 'null' }))
    .toMatchObject({ quote: null, quoteWithheld: true });
  expect(await owner().projectPublicRetainedField(a.principal, a.actor, evidence, '/record/data/absent', { state: 'omitted' }))
    .toBeNull();
  await expect(owner().projectPublicRetainedField(a.principal, a.actor, evidence, '/bad~escape', { state: 'omitted' }))
    .rejects.toThrow(expect.objectContaining({ code: 'source_coordinate_invalid' }));
});

test('reuse and quotation use scopes stay separate and unknown/currently withdrawn rights never fabricate a quote', async () => {
  const a = await authority(), evidence = await retained(a.principalId);
  await assessment(a, evidence, 'reuse');
  const read = () => owner().projectPublicRetainedField(a.principal, a.actor, evidence, pointer, { state: 'omitted' });
  expect(await read()).toMatchObject({ quote: null, quoteWithheld: true, sourceWork: null,
    rightsBasis: { result: 'undetermined', basisRef: null }, attribution: { licence: null } });
  const granted = await assessment(a, evidence, 'quotation');
  expect(await read()).toMatchObject({ quote: text, quoteWithheld: false,
    rightsBasis: { basisRef: granted.assessmentId } });
  const unknown = await assessment(a, evidence, 'quotation', 'undetermined', granted.assessmentId);
  expect(await read()).toMatchObject({ quote: null, quoteWithheld: true,
    rightsBasis: { basisRef: unknown.assessmentId, result: 'undetermined' } });
});

test('persisted conversion composition refuses changed bindings, payloads and part order after authorization', async () => {
  const a = await authority(), evidence = await retained(a.principalId, true);
  for (const mutate of [
    (e: VerifiedRetainedRecordEvidence) => { e.conversion.retainedRecord.binding = `${ID}${randomUUID()}`; },
    (e: VerifiedRetainedRecordEvidence) => { e.payload.record = {}; },
    (e: VerifiedRetainedRecordEvidence) => { e.observations.reverse(); },
  ]) {
    const changed = structuredClone(evidence); mutate(changed);
    await expect(owner().projectPublicRetainedField(a.principal, a.actor, changed, pointer, { state: 'omitted' }))
      .rejects.toThrow(expect.objectContaining({ code: 'source_support_changed', basis: 'evidence' }));
  }
  const verification = new VerificationStore(f.pool);
  await verification.recordObservationDisposition(a.principalId, randomUUID(), evidence.observations[1]!.observation.slice(ID.length),
    { expectedHead: null, state: 'withdrawn', reason: 'Withdraw the non-first retained part' });
  await expect(owner().projectPublicRetainedField(a.principal, a.actor, evidence, pointer, { state: 'omitted' }))
    .rejects.toThrow(expect.objectContaining({ status: 404, code: 'source_support_unavailable' }));
});

test('current anonymous Source disclosure excludes the entire projection for any retained part', async () => {
  const a = await authority(), evidence = await retained(a.principalId, true);
  await assessment(a, evidence, 'quotation');
  const scope = 'governance:platform', rule = { ref: 'urn:rezics:rule:retained-evidence', revision: '1', digest: 'd'.repeat(64) };
  await grantFixtureAuthority(f.pool, { scope, requireDispatch: true,
    representations: [{ principalId: a.principalId, actor: a.actor, action: 'governance.moderate', lifetime: 'infinity' }],
    grant: { actor: a.actor, action: 'governance.moderate', lifetime: 'infinity' } });
  const part = evidence.observations[1]!;
  const target = { owner: 'source' as const, resource: part.record, component: 'record' as const,
    revision: part.observation, locator: null };
  const governance = new GovernanceStore(f.accessPool, { capture: async (_principal, _actor, item) => ({
    ...item, state: 'available', representation: 'Retained owner-test evidence',
    revisionDigest: 'e'.repeat(64), provenance: {} }) },
  { current: async () => part.observation }, { current: async () => rule });
  const report = await governance.submitReport(a.principal, { kind: 'content_report', actingSubject: a.actor,
    authority: { kind: 'platform', scopeId: scope }, context: GLOBAL_CONTEXT, target, disclosure: 'private',
    reasonCode: 'disclosure', statement: 'Owner-test restricted source', evidence: [target], idempotencyKey: randomUUID() });
  await governance.safety.claim(a.principal, a.actor, report.caseId);
  await governance.decide(a.principal, { caseId: report.caseId, expectedGeneration: report.caseGeneration,
    actingSubject: a.actor, outcome: 'restrict', targets: [{ ...target, scopeKind: 'exact_revision',
      expectedHead: part.observation, effect: 'disclosure' }], rule, evidenceDigest: report.evidenceDigest,
    reversesDecisionId: null, answersStepId: null, rationale: null, disclosure: 'private', idempotencyKey: randomUUID(),
    reasons: { facts: 'Reviewed retained fixture', scope: 'One exact retained part', duration: 'Until reconsidered',
      automation: false, contentLanguage: 'en', appealRoute: '/v1/public-reports/{caseId}/correspondence' } });
  expect(await owner().projectPublicRetainedField(a.principal, a.actor, evidence, pointer, { state: 'omitted' })).toBeNull();
});
