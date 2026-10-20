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
import { ensureFixturePrincipal } from './support/access-fixture-identity.ts';
import { retainedEvidenceFixture } from './support/retained-evidence-fixture.ts';

const ID = 'https://rezics.com/id/';
const snapshot = { id: 'retained-evidence-shape', digest: 'a'.repeat(64), fileSha256: 'b'.repeat(64) };
const pointer = '/record/data/summary';
const text = '  简介\r\n第二行 e\u0301  ';
let f: Awaited<ReturnType<typeof retainedEvidenceFixture>>;
let intake: SourceIntakeStore, records: SourceRetainedRecordStore, access: AccessAdmissionRegistry, rights: RightsStore;
const env = { fuseki: new FusekiClient('http://graph.invalid'), objectDirectory: '.temp/public-retained-evidence-owner',
  lineage: { dataEpoch: 'owner-test-data', routingEpoch: 'owner-test-routing' } };
beforeAll(async () => {
  f = await retainedEvidenceFixture('public_retained_evidence');
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

async function ordinaryReader() {
  const principal = { issuer: 'https://account.public-evidence.test', subject: randomUUID() };
  await ensureFixturePrincipal(f.pool, principal);
  return principal;
}
const read = (evidence: VerifiedRetainedRecordEvidence, language: SuppliedLanguage = { state: 'omitted' }) =>
  owner().projectPublicRetainedFieldForReader({ principal: null }, evidence, pointer, language);

async function restrictPart(a: Awaited<ReturnType<typeof authority>>, evidence: VerifiedRetainedRecordEvidence) {
  const scope = 'governance:platform', rule = { ref: 'urn:rezics:rule:public-retained-evidence', revision: '1', digest: 'd'.repeat(64) };
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
}

/** Schedule a real owner mutation after the first quotation assessment. The
 * adapter delegates every policy decision to Rights, using persisted state. */
function changingOwner(change: () => Promise<unknown>) {
  let first = true;
  return new SourceRetainedRecordEvidenceOwner(f.pool, intake, access, {
    retainedFieldReusePermitted: rights.retainedFieldReusePermitted.bind(rights),
    exportScope: async (...args: Parameters<RightsStore['exportScope']>) => {
      const result = await rights.exportScope(...args);
      if (first) { first = false; await change(); }
      return result;
    },
  }, records, env);
}

test('anonymous reads use verified private custody without importer/reuse authority', async () => {
  const a = await authority(), evidence = await retained(a.principalId, true);
  await assessment(a, evidence, 'reuse', 'not_supported');
  const quotation = await assessment(a, evidence, 'quotation');
  await setFixtureMandateState(f.pool, a.representationId, 'revoked');
  await expect(owner().authorizeRetainedFieldReuse(a.principal, a.actor,
    evidence.conversion.retainedRecord.sourceRecord, evidence.observations)).rejects.toBeInstanceOf(ControlDenied);
  expect(await read(evidence)).toMatchObject({ quote: text, quoteWithheld: false,
    rightsBasis: { basisRef: quotation.assessmentId }, sourceWork: null });
});

test('an unrelated ordinary reader has no custody or import grant and still reads public evidence', async () => {
  const a = await authority(), evidence = await retained(a.principalId, true), principal = await ordinaryReader();
  await assessment(a, evidence, 'quotation');
  const readerId = await access.activePrincipalId(principal);
  expect(readerId).not.toBe(a.principalId);
  expect(await records.evidence(readerId!, evidence.conversion.conversion)).toBeNull();
  expect(await access.hasNonBaselineWorkCreateAuthority(principal, a.actor)).toBe(false);
  expect(await owner().projectPublicRetainedFieldForReader({ principal }, evidence, pointer, { state: 'null' }))
    .toMatchObject({ quote: text, language: { state: 'null' }, sourceWork: null });
});

test('raw supplied language preserves omitted, null, empty and 36 through 255 code units independently of quotation', async () => {
  const a = await authority(), evidence = await retained(a.principalId);
  const languages: SuppliedLanguage[] = [{ state: 'omitted' }, { state: 'null' },
    ...['', 'x'.repeat(36), '原'.repeat(255), '  JA-Latn  '].map(value => ({ state: 'value' as const, value }))];
  for (const language of languages) {
    expect(await read(evidence, language)).toMatchObject({ language, quote: null, quoteWithheld: true,
      rightsBasis: { result: 'undetermined', basisRef: null } });
  }
  await assessment(a, evidence, 'quotation');
  for (const language of languages) {
    expect(await read(evidence, language)).toMatchObject({ language, quote: text, quoteWithheld: false });
    expect(await owner().projectPublicRetainedFieldForReader({ principal: null }, evidence, '/record/data/empty', language))
      .toMatchObject({ language, quote: '', quoteWithheld: false });
  }
  for (const value of ['x'.repeat(256), 'ja\nJP', '\u007f']) {
    await expect(read(evidence, { state: 'value', value }))
      .rejects.toThrow(expect.objectContaining({ code: 'source_coordinate_invalid' }));
  }
});

test('public projection keeps exact multipart payload coordinates and exposes no private binding or citation invention', async () => {
  const a = await authority(), evidence = await retained(a.principalId, true);
  await assessment(a, evidence, 'quotation');
  const before = structuredClone(evidence), projection = await read(evidence);
  expect(projection).toMatchObject({ id: evidence.conversion.retainedRecord.sourceRecord, sourceWork: null,
    representationSha256: evidence.request.retained.payload.byteDigest, locator: { pointer },
    quote: text, attribution: { sourceName: 'bangumi', sourceUrl: evidence.record.sourceUrl, licence: null } });
  expect(projection!.representationSha256).not.toBe(evidence.request.retained.recordDigest);
  for (const observation of evidence.observations) {
    expect(projection!.representationSha256).not.toBe(observation.byteDigest);
    expect(JSON.stringify(projection)).not.toContain(observation.observation);
    expect(JSON.stringify(projection)).not.toContain(observation.record);
  }
  expect(JSON.stringify(projection)).not.toMatch(/binding|intakes|rawBytes|certificate|principal|method|modality|submitter/);
  for (const alias of ['/data/summary', '/bytes', '/record/data/absent']) {
    expect(await owner().projectPublicRetainedFieldForReader({ principal: null }, evidence, alias, { state: 'omitted' })).toBeNull();
  }
  expect(evidence).toEqual(before);
});

test('public reads reject changed binding, record, payload or ordered multipart observations without disclosing differences', async () => {
  const a = await authority(), evidence = await retained(a.principalId, true);
  for (const mutate of [
    (e: VerifiedRetainedRecordEvidence) => { e.conversion.retainedRecord.binding = `${ID}${randomUUID()}`; },
    (e: VerifiedRetainedRecordEvidence) => { e.conversion.retainedRecord.sourceRecord = `${ID}${randomUUID()}`; },
    (e: VerifiedRetainedRecordEvidence) => { e.payload.record = {}; },
    (e: VerifiedRetainedRecordEvidence) => { e.observations.reverse(); },
    (e: VerifiedRetainedRecordEvidence) => { e.observations.pop(); },
  ]) {
    const changed = structuredClone(evidence); mutate(changed);
    expect(await read(changed)).toBeNull();
  }
});

test('write reuse keeps rights_denied ahead of private binding/value/coordinate mismatches', async () => {
  const a = await authority(), evidence = await retained(a.principalId, true);
  await assessment(a, evidence, 'reuse', 'not_supported');
  const changed = structuredClone(evidence);
  changed.conversion.retainedRecord.binding = `${ID}${randomUUID()}`;
  changed.payload.record = {};
  changed.observations[1]!.record = `${ID}${randomUUID()}`;
  await expect(owner().authorizeRetainedFieldReuse(a.principal, a.actor,
    changed.conversion.retainedRecord.sourceRecord, changed.observations)).rejects.toBeInstanceOf(RightsDenied);
  await expect(owner().projectPublicRetainedField(a.principal, a.actor, changed, '/bad~pointer', { state: 'omitted' }))
    .rejects.toBeInstanceOf(RightsDenied);
});

test('private non-first-part disclosure withholds all evidence from anonymous and ordinary readers', async () => {
  const a = await authority(), evidence = await retained(a.principalId, true), principal = await ordinaryReader();
  await assessment(a, evidence, 'quotation');
  expect(await read(evidence)).not.toBeNull();
  await restrictPart(a, evidence);
  expect(await read(evidence)).toBeNull();
  expect(await owner().projectPublicRetainedFieldForReader({ principal }, evidence, pointer, { state: 'omitted' })).toBeNull();
});

test('a quotation rights change during projection withholds that read and subsequent quotes', async () => {
  const a = await authority(), evidence = await retained(a.principalId, true);
  const granted = await assessment(a, evidence, 'quotation');
  const changing = changingOwner(() => assessment(a, evidence, 'quotation', 'not_supported', granted.assessmentId));
  expect(await changing.projectPublicRetainedFieldForReader({ principal: null }, evidence, pointer, { state: 'value', value: '' }))
    .toBeNull();
  expect(await read(evidence, { state: 'value', value: '' })).toMatchObject({ quote: null, quoteWithheld: true,
    language: { state: 'value', value: '' }, rightsBasis: { result: 'prohibited' } });
});

test('the final disclosure fence refuses a non-first-part restriction introduced during projection', async () => {
  const a = await authority(), evidence = await retained(a.principalId, true);
  await assessment(a, evidence, 'quotation');
  const changing = changingOwner(() => restrictPart(a, evidence));
  expect(await changing.projectPublicRetainedFieldForReader({ principal: null }, evidence, pointer, { state: 'omitted' })).toBeNull();
});

test('non-first-part withdrawal before or during projection invalidates the whole retained evidence', async () => {
  for (const during of [false, true]) {
    const a = await authority(), evidence = await retained(a.principalId, true);
    await assessment(a, evidence, 'quotation');
    const withdraw = () => new VerificationStore(f.pool).recordObservationDisposition(a.principalId, randomUUID(),
      evidence.observations[1]!.observation.slice(ID.length),
      { expectedHead: null, state: 'withdrawn', reason: 'Withdraw non-first public retained part' });
    if (!during) await withdraw();
    const reader = during ? changingOwner(withdraw) : owner();
    expect(await reader.projectPublicRetainedFieldForReader({ principal: null }, evidence, pointer, { state: 'omitted' })).toBeNull();
    expect(await read(evidence)).toBeNull();
  }
});


