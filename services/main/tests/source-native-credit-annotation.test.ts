import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { DataFactory, Parser, Store, type Term } from 'n3';
import { profileRegistry } from '@rezics/model';
import type { CommandEnvelope, SparqlResult } from '../src/infrastructure/fuseki.ts';
import { AccessAdmissionRegistry } from '../src/modules/access/admission.ts';
import { grantFixtureAuthority } from '../src/modules/access/fixture-authority.ts';
import { GLOBAL_CONTEXT, GovernanceStore } from '../src/modules/governance/store.ts';
import { fixtureAuthorityScenario, setFixtureMandateState } from '../src/modules/access/fixture-authority-scenario.ts';
import { configureDisclosure, DisclosureStore } from '../src/modules/disclosure/read.ts';
import { RightsStore, ASSESS_ACTION, ASSESS_SCOPE, rightsExportUseScope, type AssessmentInput } from '../src/modules/rights/store.ts';
import { createNativeCredit } from '../src/modules/profiles/credits.ts';
import { GRAPHS, RV, type WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import { workEditReceiptIri } from '../src/modules/work/edit.ts';
import { readCreditOwnerWitness } from '../src/modules/work/credit-verification.ts';
import { creditAttributionOwner } from '../src/modules/work/credit-attribution.ts';
import type { ExactDefinition } from '../src/modules/relation/change.ts';
import type { AttributedParticipation } from '../src/modules/relation/v2-schema.ts';
import { SourceNativeCreditAnnotationStore, type NativeCreditAnnotationRequest } from '../src/modules/source/native-credit-annotation.ts';
import { createMainApp } from '../src/app.ts';
import { FusekiClient } from '../src/infrastructure/fuseki.ts';
import { PlatformClosed } from '../src/modules/access/exposure.ts';
import { VerificationStore } from '../src/modules/verification/store.ts';
import { sourceSupportRoutes } from '../src/routes/source-supports.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import { SourceIntakeStore } from '../src/modules/source/intake.ts';
import { canonicalDigest } from '../src/modules/source/retained-record-normalization.ts';
import { retainedEvidenceFixture } from './support/retained-evidence-fixture.ts';

const id = () => `https://rezics.com/id/${randomUUID()}`;
let fixture: Awaited<ReturnType<typeof retainedEvidenceFixture>>;
beforeAll(async () => { fixture = await retainedEvidenceFixture('credit_annotation'); }, 120_000);
afterAll(async () => { await fixture?.close(); });

/** Actual native command and SQL Access/Source owners. The graph transport stores
 * the writer's generated INSERT quads; it does not claim live Jena validation. */
async function authored() {
  const work = id(), workHead = id(), credit = id();
  const authority = await fixtureAuthorityScenario(fixture.accessPool,
    { scope: `work:edit:${work}`, action: 'work.edit', mandate: 'work.edit' });
  const access = new AccessAdmissionRegistry(fixture.accessPool);
  const graph = new Store(), { namedNode, literal } = DataFactory;
  const get = (subject: string, predicate: string, layer: string) => graph.getObjects(namedNode(subject), namedNode(RV + predicate), namedNode(layer))[0];
  const term = (value: Term) => ({ type: value.termType === 'NamedNode' ? 'uri' : 'literal', value: value.value });
  const row = (value: Record<string, Term | undefined>): SparqlResult => ({ results: { bindings: [Object.fromEntries(
    Object.entries(value).flatMap(([key, value]) => value ? [[key, term(value)]] : []))] } });
  graph.addQuad(namedNode(work), namedNode(RV + 'head'), namedNode(workHead), namedNode(GRAPHS.current));
  let envelope: CommandEnvelope | null = null;
  const environment = { lineage: { dataEpoch: 'annotation-owner-test', routingEpoch: '1' }, fuseki: {
    async commandHealth() { return { profiles: Object.fromEntries(Object.entries(profileRegistry).map(([key, value]) => [key, value.sha256])) }; },
    async commandWithReceipt(input: CommandEnvelope) {
      expect(input.validations.length).toBe(2);
      envelope = input;
      const prefix = input.update.slice(0, input.update.indexOf('DELETE'));
      const insert = input.update.slice(input.update.indexOf('INSERT {') + 8, input.update.lastIndexOf('WHERE {')).trim().slice(0, -1);
      graph.addQuads(new Parser({ format: 'TriG' }).parse(prefix + insert.replaceAll('?next', '2')));
      return { status: 'committed' as const };
    },
    async query(query: string): Promise<SparqlResult> {
      if (query.includes('ASK')) return { boolean: !query.includes('rv:Cancelled') };
      const receipt = envelope?.receipt;
      if (query.includes('SELECT ?outcome ?reason')) return receipt ? row(Object.fromEntries(Object.entries({
        outcome: 'outcome', digest: 'requestDigest', admissionId: 'admissionId', authorityEpoch: 'authorityEpoch',
        scope: 'admittedScope', work: 'work', revision: 'workRevision', predecessor: 'expectedHead', sequence: 'sequence', epoch: 'dataEpoch',
      }).map(([key, predicate]) => [key, get(receipt, predicate, GRAPHS.receipts)]))) : { results: { bindings: [] } };
      const revision = get(credit, 'creditRevision', GRAPHS.current)?.value;
      if (query.includes('SELECT DISTINCT ?credit ?revision ?intent')) return row({ credit: namedNode(credit),
        revision: revision ? namedNode(revision) : undefined, intent: receipt ? get(receipt, 'sourceIntent', GRAPHS.receipts) : undefined });
      if (query.includes('SELECT ?revision ?kind')) return revision && query.includes(`<${credit}>`)
        ? row({ revision: namedNode(revision), kind: namedNode(RV + 'AuthorCredit') }) : { results: { bindings: [] } };
      if (query.includes('SELECT ?work ?head ?key')) return row({ work: get(credit, 'work', GRAPHS.current),
        head: revision ? get(revision, 'workRevision', GRAPHS.revisions) : undefined,
        key: get(credit, 'externalKey', GRAPHS.current), creditRole: graph.getObjects(namedNode(credit), namedNode('https://schema.org/roleName'), namedNode(GRAPHS.current))[0],
        provider: get(credit, 'externalProvider', GRAPHS.current), namespace: get(credit, 'externalNamespace', GRAPHS.current),
        ordinal: graph.getObjects(namedNode(credit), namedNode('https://schema.org/position'), namedNode(GRAPHS.current))[0],
        actor: revision ? get(revision, 'confirmedBy', GRAPHS.revisions) : undefined,
        epoch: revision ? get(revision, 'dataEpoch', GRAPHS.revisions) : undefined,
        sequence: revision ? get(revision, 'sequence', GRAPHS.revisions) : undefined,
        model: revision ? get(revision, 'modelRevision', GRAPHS.revisions) : undefined,
        shape: revision ? get(revision, 'shapeRevision', GRAPHS.revisions) : undefined,
      });
      if (query.includes('SELECT DISTINCT ?receipt ?admission')) return receipt ? row({ receipt: namedNode(receipt),
        admission: get(receipt, 'admissionId', GRAPHS.receipts), nativeCommand: literal('true') }) : { results: { bindings: [] } };
      if (query.includes('SELECT ?workHead ?creditHead')) return row({ workHead: get(work, 'head', GRAPHS.current),
        creditHead: revision ? namedNode(revision) : undefined, epoch: literal('annotation-owner-test'), routing: literal('1') });
      throw new Error(`Unexpected native command/read query: ${query}`);
    },
  } } as unknown as WorkActivationEnvironment;
  configureDisclosure(environment, new DisclosureStore(fixture.accessPool));
  const deps = { environment, account: { verify: async () => authority.principal }, access } as unknown as MainWorkDependencies;
  const created = await createNativeCredit(deps, new Request('http://localhost/native-command'), { work, credit,
    expectedWorkHead: workHead, actingSubject: authority.actor, role: 'artist', ordinal: 2,
    participant: { kind: 'external-reference', provider: 'vndb', namespace: 'staff', key: 's17' } }, randomUUID());
  const witness = await readCreditOwnerWitness(environment, created.credit);
  expect(witness?.receipt.receipt).toBe(workEditReceiptIri(witness!.receipt.admissionId));
  expect((await fixture.accessPool.query('SELECT state FROM access.admission WHERE id=$1', [witness!.receipt.admissionId])).rows[0].state).toBe('sealed');
  return { authority, environment, deps, witness: witness!, workHead, access, graph };
}

async function scenario() {
  const native = await authored(), principalId = native.authority.principalId;
  const intake = new SourceIntakeStore(fixture.pool);
  const raw = { staff: [{ alias: '別名', eid: 'edition-17', note: 'Character art', empty: '', absentValue: null, language: 'ja', nullLanguage: null }] };
  const observed = (await intake.submit(principalId, randomUUID(), {
    provider: 'manual-wiki', namespace: 'staff', externalId: `document-${randomUUID()}`, sourceRevision: null,
    mediaType: 'application/json', retention: 'retained', rawBytesBase64: Buffer.from(JSON.stringify(raw)).toString('base64'),
    coverage: { scope: 'selected-staff-record', complete: false, omittedFields: [] },
    rightsEvidence: { basis: 'facts', note: 'Independent manual annotation test' },
  })).observation;
  const value = native.witness.value;
  const body: NativeCreditAnnotationRequest = {
    profile: 'source-native-credit-annotation-v1', actingSubject: native.authority.actor, expectedAnnotation: null,
    native: { work: value.work, workHead: native.workHead, credit: value.credit, revision: value.revision, receipt: native.witness.receipt.receipt,
      participation: { role: 'artist', participant: { kind: 'external', provider: 'vndb', namespace: 'staff', key: 's17' }, position: 2 } },
    field: 'alias', selected: { presence: 'value', value: '別名', language: { state: 'omitted' } },
    source: { record: observed.record, observation: observed.observation,
      byteDigest: observed.byteDigest!, recordDigest: canonicalDigest(raw),
      pointer: '/staff/0/alias', valueDigest: canonicalDigest('別名') },
  };
  const rights = new RightsStore(fixture.pool, fixture.accessPool);
  const store = new SourceNativeCreditAnnotationStore(fixture.pool, intake, native.environment, native.access, rights);
  const app = sourceSupportRoutes({} as never, { ...native.deps, sourceNativeCreditAnnotations: store });
  const write = (input = body, key = randomUUID()) => app.handle(new Request('http://localhost/v1/sources/field-supports', {
    method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify(input),
  }));
  return { ...native, store, rights, observed, principalId, body, app, write };
}

test('manual retained Source annotation addresses an actually authored native credit without conversion', async () => {
  const f = await scenario();
  const response = await f.write();
  if (response.status !== 201) throw new Error(`Annotation admission returned ${response.status}: ${await response.text()}`);
  expect(response.status).toBe(201);
  const result = await response.json();
  expect(result.support.request).toEqual(f.body);
  expect(result.support.receipt).not.toBe(f.witness.receipt.receipt);
  expect(result.support.nativeEffect).toBe('none');
  expect(await f.store.read(randomUUID(), result.support.support)).toBeNull();
});

test('lost response replay preserves the independent receipt and changed intent conflicts', async () => {
  const f = await scenario(), key = randomUUID();
  const first = await (await f.write(f.body, key)).json();
  const replayResponse = await f.write(f.body, key), replay = await replayResponse.json();
  expect(replayResponse.status).toBe(200);
  expect(replay.support).toEqual(first.support);
  expect(replay.replayed).toBe(true);
  const changed = structuredClone(f.body); changed.field = 'note';
  expect((await f.write(changed, key)).status).toBe(409);
  expect((await f.write()).status).toBe(409);
  expect((await fixture.pool.query('SELECT count(*)::int AS count FROM source.native_credit_annotation WHERE principal_id=$1', [f.principalId])).rows[0].count).toBe(1);
});

test('annotation refuses wrong exact credit, receipt, revision, Work head, full tuple, role, ordinal, field and Source digest', async () => {
  const mutations: Array<(body: NativeCreditAnnotationRequest) => void> = [
    body => { body.native.credit = id(); }, body => { body.native.revision = id(); },
    body => { body.native.receipt = `urn:rezics:receipt:${'f'.repeat(64)}`; }, body => { body.native.workHead = id(); },
    body => { body.native.participation.role = 'author'; }, body => { body.native.participation.position = 3; },
    body => { if (body.native.participation.participant.kind === 'external') body.native.participation.participant.namespace = 'character'; },
    body => { body.source.byteDigest = 'a'.repeat(64); }, body => { body.source.recordDigest = 'b'.repeat(64); },
    body => { body.source.valueDigest = 'c'.repeat(64); }, body => { body.source.pointer = '/staff/0/eid'; },
    body => { body.selected.presence = 'null'; }, body => { body.field = 'provider'; },
  ];
  const f = await scenario();
  for (const mutate of mutations) {
    const input = structuredClone(f.body); mutate(input);
    const response = await f.write(input);
    expect([404, 409]).toContain(response.status);
  }
  expect((await fixture.pool.query('SELECT count(*)::int AS count FROM source.native_credit_annotation WHERE principal_id=$1', [f.principalId])).rows[0].count).toBe(0);
});

test('foreign Source custody and revoked Work edit authority cannot admit annotations', async () => {
  const f = await scenario(), foreign = await scenario();
  const changed = structuredClone(f.body); changed.source = foreign.body.source;
  expect((await f.write(changed)).status).toBe(404);
  await setFixtureMandateState(fixture.accessPool, f.authority.representationId, 'revoked');
  expect((await f.write()).status).toBe(403);
});


async function quotation(f: Awaited<ReturnType<typeof scenario>>, outcome: 'supported' | 'not_supported' = 'supported', expectedAssessment: string | null = null) {
  const authority = await fixtureAuthorityScenario(fixture.accessPool,
    { scope: ASSESS_SCOPE, action: ASSESS_ACTION, mandate: ASSESS_ACTION });
  const input: AssessmentInput = { actingSubject: authority.actor,
    material: { scopeKind: 'source_record', provider: null, namespace: null, sourceRecordId: f.observed.record.slice(-36),
      contentVariantId: null, mediaAsset: null, component: 'record' },
    expressionKind: 'expression', family: 'data_rights', useKind: 'quotation', useScope: rightsExportUseScope('quotation'),
    basis: 'permission', outcome, licenseInstrument: null, exceptionKind: null, rationale: 'Exact independent annotation quotation',
    extent: {}, evidence: {}, obligations: [], expectedAssessment, idempotencyKey: randomUUID() };
  return f.rights.assess(authority.principal, input);
}
function supportFor(f: Awaited<ReturnType<typeof scenario>>, evidence: string[]) {
  return { basis: { kind: 'native-credit' as const, credit: f.body.native.credit, revision: f.body.native.revision },
    fields: ['alias' as const], evidence };
}

test('anonymous optional annotation requires current quotation Rights and exact native participant', async () => {
  const f = await scenario(), admitted = await (await f.write()).json();
  const support = supportFor(f, [admitted.support.support]);
  expect(await f.store.proof(f.body.native.participation, support)).toBeNull();
  const allowed = await quotation(f);
  expect(await f.store.proof(f.body.native.participation, support)).toMatchObject({ state: 'current',
    receipt: admitted.support.receipt, fields: { alias: '別名' }, basis: support.basis });
  expect(await f.store.proof({ ...f.body.native.participation, position: 3 }, support)).toBeNull();
  await quotation(f, 'not_supported', allowed.assessmentId);
  expect(await f.store.proof(f.body.native.participation, support)).toBeNull();
  expect((await readCreditOwnerWitness(f.environment, f.body.native.credit))?.value).toEqual(f.witness.value);
});

test('actual withdrawal preserves original proof as withdrawn and supports exact receipt replay', async () => {
  const f = await scenario(), admitted = await (await f.write()).json();
  await quotation(f);
  const support = supportFor(f, [admitted.support.support]);
  expect((await f.store.proof(f.body.native.participation, support))?.state).toBe('current');
  const key = randomUUID(), body = { support: admitted.support.support, expectedSupport: admitted.support.support, reason: 'Remove optional attribution' };
  const withdrawn = await f.store.withdraw(f.principalId, key, body);
  if (!withdrawn) throw new Error('Owned annotation withdrawal must settle');
  expect(withdrawn.support.state).toBe('withdrawn');
  expect(await f.store.withdraw(f.principalId, key, body)).toEqual({ ...withdrawn, replayed: true });
  await expect(f.store.withdraw(f.principalId, key, { ...body, reason: 'Different intent' })).rejects.toMatchObject({ status: 409 });
  expect(await f.store.proof(f.body.native.participation, support)).toMatchObject({ state: 'withdrawn',
    receipt: admitted.support.receipt, fields: { alias: '別名' }, basis: support.basis, evidence: support.evidence });
  expect((await readCreditOwnerWitness(f.environment, f.body.native.credit))?.value).toEqual(f.witness.value);
  expect((await f.write(f.body, randomUUID())).status).toBe(409);
  const replaced = structuredClone(f.body); replaced.expectedAnnotation = admitted.support.support;
  expect((await f.write(replaced)).status).toBe(201);
  expect(await f.store.proof(f.body.native.participation, support)).toBeNull();
});

test('retention disposition removes optional evidence without withdrawing or changing the native credit', async () => {
  const f = await scenario(), admitted = await (await f.write()).json();
  await quotation(f);
  const support = supportFor(f, [admitted.support.support]);
  expect((await f.store.proof(f.body.native.participation, support))?.state).toBe('current');
  const verification = new VerificationStore(fixture.pool);
  await verification.recordObservationDisposition(f.principalId, randomUUID(), f.observed.observation.slice(-36),
    { state: 'inaccessible', reason: 'Retained observation is no longer available', expectedHead: null });
  expect(await f.store.proof(f.body.native.participation, support)).toBeNull();
  expect((await f.store.read(f.principalId, admitted.support.support))?.state).toBe('recorded');
  expect((await readCreditOwnerWitness(f.environment, f.body.native.credit))?.value).toEqual(f.witness.value);
});

test('bound Main exposure admits ordinary native annotation while preserving legacy import gates', async () => {
  const f = await scenario(), gates: string[] = [];
  const work = { ...f.deps, sourceNativeCreditAnnotations: f.store, platformAccess: {
    groupOpened: () => false,
    require: async (_principal: unknown, exposure: string, operation: string) => {
      if (exposure === 'public') return;
      gates.push(operation); throw new PlatformClosed();
    },
  } } as unknown as MainWorkDependencies;
  const app = createMainApp(new FusekiClient('http://127.0.0.1:1/rezics'), work);
  const call = (path: string, body?: unknown) => app.handle(new Request(`http://localhost${path}`, {
    method: body === undefined ? 'GET' : 'POST', headers: { authorization: 'Bearer ordinary-native-editor',
      'content-type': 'application/json', 'idempotency-key': randomUUID() }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  const created = await call('/v1/sources/field-supports', f.body);
  if (created.status !== 201) throw new Error(`Bound annotation admission returned ${created.status}: ${await created.text()}`);
  const admitted = await created.json(), short = admitted.support.support.slice(-36);
  expect((await call(`/v1/sources/field-supports/${short}`)).status).toBe(200);
  expect((await call(`/v1/sources/supports/${short}`)).status).toBe(200);
  const legacy = { profile: 'source-field-support-attachment-v1', target: f.body.native.work, slot: 'synopsis', occurrence: null,
    context: 'global', sourceRecord: f.body.source.record, conversion: id(), grain: 'work', sourceField: 'description',
    sourceOccurrence: null, sourcePointer: '/description', expectedHead: f.body.native.workHead, actingSubject: f.body.actingSubject };
  expect((await call('/v1/sources/field-supports', legacy)).status).toBe(403);
  expect((await call(`/v1/sources/field-supports/${randomUUID()}`)).status).toBe(403);
  expect((await call(`/v1/sources/supports/${randomUUID()}`)).status).toBe(403);
  expect((await call('/v1/sources/withdrawals', { profile: 'source-field-withdrawal-v1', support: id(), expectedSupport: id(), reason: 'Legacy' })).status).toBe(403);
  expect(gates).toEqual(['postV1SourcesField-supports', 'getV1SourcesField-supportsBySupport',
    'getV1SourcesSupportsBySupport', 'postV1SourcesWithdrawals']);
  expect((await call('/v1/sources/withdrawals', { profile: 'source-field-withdrawal-v1', support: admitted.support.support,
    expectedSupport: admitted.support.support, reason: 'Native annotation withdrawal' })).status).toBe(201);
});


test('actual private Source disclosure withholds optional values after admission', async () => {
  const f = await scenario(), admitted = await (await f.write()).json();
  await quotation(f);
  const support = supportFor(f, [admitted.support.support]);
  expect((await f.store.proof(f.body.native.participation, support))?.fields).toEqual({ alias: '別名' });
  const scope = 'governance:platform', rule = { ref: 'urn:rezics:rule:native-credit-annotation', revision: '1', digest: 'd'.repeat(64) };
  await grantFixtureAuthority(fixture.accessPool, { scope, requireDispatch: true,
    representations: [{ principalId: f.principalId, actor: f.authority.actor, action: 'governance.moderate', lifetime: 'infinity' }],
    grant: { actor: f.authority.actor, action: 'governance.moderate', lifetime: 'infinity' } });
  const target = { owner: 'source' as const, resource: f.observed.record, component: 'record' as const,
    revision: f.observed.observation, locator: null };
  const governance = new GovernanceStore(fixture.accessPool, { capture: async (_principal, _actor, item) => ({
    ...item, state: 'available', representation: 'Retained annotation evidence', revisionDigest: 'e'.repeat(64), provenance: {} }) },
    { current: async () => f.observed.observation }, { current: async () => rule });
  const report = await governance.submitReport(f.authority.principal, { kind: 'content_report', actingSubject: f.authority.actor,
    authority: { kind: 'platform', scopeId: scope }, context: GLOBAL_CONTEXT, target, disclosure: 'private',
    reasonCode: 'disclosure', statement: 'Restricted exact retained annotation', evidence: [target], idempotencyKey: randomUUID() });
  await governance.safety.claim(f.authority.principal, f.authority.actor, report.caseId);
  await governance.decide(f.authority.principal, { caseId: report.caseId, expectedGeneration: report.caseGeneration,
    actingSubject: f.authority.actor, outcome: 'restrict', targets: [{ ...target, scopeKind: 'exact_revision',
      expectedHead: f.observed.observation, effect: 'disclosure' }], rule, evidenceDigest: report.evidenceDigest,
    reversesDecisionId: null, answersStepId: null, rationale: null, disclosure: 'private', idempotencyKey: randomUUID(),
    reasons: { facts: 'Reviewed retained annotation', scope: 'Exact Source observation', duration: 'Until reconsidered',
      automation: false, contentLanguage: 'en', appealRoute: '/v1/public-reports/{caseId}/correspondence' } });
  expect(await f.store.proof(f.body.native.participation, support)).toBeNull();
  expect((await readCreditOwnerWitness(f.environment, f.body.native.credit))?.value).toEqual(f.witness.value);
  expect((await f.store.read(f.principalId, admitted.support.support))?.state).toBe('recorded');
});

test('Source annotation preserves explicit null, empty text and supplied language without inventing absence', async () => {
  for (const [pointer, presence, value] of [['/staff/0/absentValue', 'null', null], ['/staff/0/empty', 'empty-string', '']] as const) {
    const f = await scenario(), body = structuredClone(f.body); body.field = 'note';
    body.selected = { presence, value, language: { state: 'omitted' } };
    body.source.pointer = pointer; body.source.valueDigest = canonicalDigest(value);
    const response = await f.write(body); expect(response.status).toBe(201);
    const admitted = await response.json(); await quotation(f);
    expect(admitted.support.request.selected).toEqual(body.selected);
    expect(await f.store.proof(body.native.participation, { ...supportFor(f, [admitted.support.support]), fields: ['note'] }))
      .toMatchObject({ state: 'current', fields: { note: value } });
  }
  for (const language of [{ state: 'omitted' }, { state: 'null' }, { state: 'value', value: 'ja' }] as const) {
    const f = await scenario(), body = structuredClone(f.body); body.field = 'creditedName'; body.selected.language = language;
    if (language.state !== 'omitted') body.source.languagePointer = language.state === 'null' ? '/staff/0/nullLanguage' : '/staff/0/language';
    const response = await f.write(body); expect(response.status).toBe(201);
    const admitted = await response.json(); expect(admitted.support.request.selected.language).toEqual(language);
    await quotation(f);
    const proof = await f.store.proof(body.native.participation, { ...supportFor(f, [admitted.support.support]), fields: ['creditedName'] });
    expect(proof?.fields.creditedName).toEqual({ lexical: '別名', language: language.state === 'value' ? 'ja' : null });
    const binding = await f.store.nativeAttribution()({ nativeCredit: f.witness, attributionSupports: [{
      ...supportFor(f, [admitted.support.support]), fields: ['creditedName'],
    }] });
    expect(binding).toEqual(language.state === 'value' ? { creditedName: { lexical: '別名', language: 'ja' } } : null);
    const wrong = structuredClone(body); wrong.selected.language = { state: 'value', value: 'en' }; wrong.source.languagePointer = '/staff/0/language';
    expect((await f.write(wrong)).status).toBe(409);
  }
});


test('real independent annotations feed the existing native origin adapter without fabricating Source identity fields', async () => {
  const f = await scenario(), evidence: string[] = [];
  for (const [field, value] of [['alias', '別名'], ['eid', 'edition-17'], ['note', 'Character art']] as const) {
    const body = structuredClone(f.body); body.field = field; body.selected.value = value;
    body.source.pointer = `/staff/0/${field}`; body.source.valueDigest = canonicalDigest(value);
    const admitted = await f.write(body); expect(admitted.status).toBe(201);
    evidence.push((await admitted.json()).support.support);
  }
  await quotation(f);
  const support = { ...supportFor(f, evidence), fields: ['alias', 'eid', 'note'] as Array<'alias' | 'eid' | 'note'> };
  const loaded = await f.store.nativeAttribution()({ nativeCredit: f.witness, attributionSupports: [support] });
  expect(loaded).toEqual({ sourceIdentity: { provider: 'vndb', namespace: 'staff', key: 's17',
    alias: '別名', eid: 'edition-17', note: 'Character art' } });
  if (!loaded) throw new Error('Actual annotation receipts must load the exact Source identity');
  // The Definition is the trusted exact-reader boundary here. Native command,
  // Access admission, retained Source and annotation receipts are actual owners.
  const definitionId = id(), artistRole = `${definitionId}/role/artist`, workRole = `${definitionId}/role/work`;
  const definition: ExactDefinition = { definition: definitionId, revision: id(), lifecycle: 'active',
    workSubjectRole: 'work', roleKeys: { [artistRole]: 'artist', [workRole]: 'work' },
    roles: [{ role: artistRole, minParticipants: 1, maxParticipants: 1, ordered: true },
      { role: workRole, minParticipants: 1, maxParticipants: 1, ordered: false }],
    association: { kind: 'credit', workRole: 'work', subjectRoles: ['artist'] },
    retainedCredit: { origin: f.witness.profile, storedRole: 'artist', subjectRole: 'artist' } };
  const artist: AttributedParticipation = { ...f.body.native.participation, role: artistRole,
    ...loaded, attributionSupports: [support] };
  const work: AttributedParticipation = { role: workRole,
    participant: { kind: 'resource', ref: f.body.native.work }, attributionSupports: [] };
  const owner = creditAttributionOwner(f.environment, f.store.attributionOwner());
  const verify = (participation = artist, selected = support, workParticipation = work) => owner.verify({
    principal: f.authority.principal, actingSubject: f.authority.actor, definition,
    participations: [workParticipation, participation], requests: [{ participation, support: selected }] });
  const verified = await verify();
  expect(verified?.proofs[0]).toMatchObject({ state: 'current', basis: support.basis,
    fields: { alias: '別名', eid: 'edition-17', note: 'Character art' }, evidence });
  expect(verified?.guard).toContain(f.witness.receipt.receipt);
  expect(await verify({ ...artist, role: `${definitionId}/role/director` })).toBeNull();
  expect(await verify({ ...artist, position: 3 })).toBeNull();
  expect(await verify(artist, { ...support, evidence: [f.witness.receipt.receipt] })).toBeNull();
  expect(await verify(artist, support, { ...work, participant: { kind: 'resource', ref: id() } })).toBeNull();
  expect(await f.store.nativeAttribution()({ nativeCredit: f.witness,
    attributionSupports: [supportFor(f, [evidence[0]!])] })).toBeNull();
  const changed = structuredClone(f.witness); changed.value.revision = id();
  expect(await f.store.nativeAttribution()({ nativeCredit: changed, attributionSupports: [support] })).toBeNull();
  await f.store.withdraw(f.principalId, randomUUID(), { support: evidence[0]!, expectedSupport: evidence[0]!, reason: 'Withdraw exact alias proof' });
  expect(await f.store.nativeAttribution()({ nativeCredit: f.witness, attributionSupports: [support] })).toBeNull();
  expect((await readCreditOwnerWitness(f.environment, f.body.native.credit))?.value).toEqual(f.witness.value);
});
