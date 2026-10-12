import { expect, test } from 'bun:test';
import type { SparqlResult } from '../src/infrastructure/fuseki.ts';
import { contentSearchEligibilityDecisionIri, contentSearchEligibilityDigest,
  contentSearchEligibilityReceiptIri, ContentEligibilityDenied, type ContentSearchEligibilityInput }
  from '../src/modules/content-publication/eligibility.ts';
import { readContentEligibilityStatesForVariants, readRetainedContentEligibilitySource,
  ContentEligibilityStateUnavailable }
  from '../src/modules/content-publication/eligibility-state.ts';
import { contentPublicationDecisionIri, contentPublicationReceiptIri }
  from '../src/modules/content-publication/publish.ts';
import { DATASET, RV, hash, type WorkActivationEnvironment }
  from '../src/modules/work/activate.ts';
import { contentRoutes } from '../src/routes/content.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';

const graphEpoch = '11111111-1111-4111-8111-111111111111';
const ownerEpoch = '22222222-2222-4222-8222-222222222222';
const publicationAdmission = '77777777-7777-4777-8777-777777777777';
const eligibilityAdmission = '88888888-8888-4888-8888-888888888888';
const publication = contentPublicationDecisionIri(publicationAdmission);
const eligibility = contentSearchEligibilityDecisionIri(eligibilityAdmission);
const revision = 'urn:rezics:content:revision:66666666-6666-4666-8666-666666666666';
const apiV1: ContentSearchEligibilityInput = {
  resourceId: 'https://rezics.com/id/33333333-3333-4333-8333-333333333333',
  variantId: 'urn:rezics:variant:44444444-4444-4444-8444-444444444444',
  publicationDecision: publication, expectedEligibilityHead: null,
  actingSubject: 'https://rezics.com/id/55555555-5555-4555-8555-555555555555',
  disclosure: 'public', rightsBasis: 'original-contribution',
};
const assessmentId = '99999999-9999-4999-8999-999999999999';
const apiV2: ContentSearchEligibilityInput = { ...apiV1, rightsBasis: 'public-domain',
  assessmentId, profile: 'content-search-eligibility-v2' };

// Reproduce the old writer independently, so canonicalization cannot silently
// update the historical digest expected by the compatibility tests.
function oldDigest(input: ContentSearchEligibilityInput): string {
  const family = input.rightsBasis === 'public-domain'
    ? 'content-search-eligibility-v2' : 'content-search-eligibility-v1';
  return hash(JSON.stringify({ family, ...input }));
}

const ownerV1: ContentSearchEligibilityInput = {
  resourceId: apiV1.resourceId, variantId: apiV1.variantId,
  publicationDecision: publication, expectedEligibilityHead: null,
  actingSubject: apiV1.actingSubject, rightsBasis: 'original-contribution', disclosure: 'public',
};
const retained = [
  { name: 'owner-v1', input: ownerV1 },
  { name: 'owner-v1-explicit-profile', input: { ...ownerV1,
    profile: 'content-search-eligibility-v1' as const } },
  { name: 'owner-v2', input: { ...ownerV1, profile: 'content-search-eligibility-v2' as const,
    rightsBasis: 'public-domain' as const, assessmentId } },
];

type Row = NonNullable<NonNullable<SparqlResult['results']>['bindings']>[number];
const uri = (value: string) => ({ type: 'uri', value });
const literal = (value: string) => ({ type: 'literal', value });
const integer = (value: string) => ({ ...literal(value),
  datatype: 'http://www.w3.org/2001/XMLSchema#integer' });

function setField(row: Row, name: string, value: string | undefined, type: 'uri' | 'literal' = 'uri') {
  row[`${name}Count`] = integer(value === undefined ? '0' : '1');
  if (value !== undefined) row[name] = name === 'dSequence' || name === 'rSequence'
    ? integer(value) : type === 'uri' ? uri(value) : literal(value);
}

function proofRow(idField: string, id: string, receipt: string): Row {
  return { [idField]: uri(id), decisionTypeCount: integer('1'), anchorTypeCount: integer('1'),
    receiptCount: integer('1'), receipt: uri(receipt), receiptTypeCount: integer('1') };
}

function proofFixture(input: ContentSearchEligibilityInput, requestDigest: string) {
  const rights = `${RV}${input.rightsBasis === 'public-domain' ? 'PublicDomain' : 'OriginalContribution'}`;
  const assessment = input.assessmentId ? `urn:rezics:rights:assessment:${input.assessmentId}` : undefined;
  const profile = `https://rezics.com/definition/content-search-eligibility-${input.rightsBasis === 'public-domain' ? 'v2' : 'v1'}`;
  const approval = proofRow('eligibility', eligibility, contentSearchEligibilityReceiptIri(eligibilityAdmission));
  for (const prefix of ['d', 'r']) {
    for (const [field, value] of Object.entries({ Resource: input.resourceId, Variant: input.variantId,
      Publication: input.publicationDecision, RightsBasis: rights, Assessment: assessment,
      Disclosure: `${RV}Public`, Actor: input.actingSubject, Dataset: DATASET })) {
      setField(approval, `${prefix}${field}`, value);
    }
    for (const [field, value] of Object.entries({ AdmissionId: eligibilityAdmission,
      AuthorityEpoch: '2', Scope: `content:search-eligibility:${input.variantId}`,
      DataEpoch: graphEpoch, Sequence: '6' })) {
      setField(approval, `${prefix}${field}`, value, 'literal');
    }
  }
  setField(approval, 'dComponent', input.variantId);
  setField(approval, 'dModel', profile);
  setField(approval, 'dShape', profile);
  setField(approval, 'rOutcome', `${RV}Succeeded`);
  setField(approval, 'rReason', undefined);
  setField(approval, 'rRequestDigest', requestDigest, 'literal');
  setField(approval, 'rExpectedHead', input.expectedEligibilityHead ?? 'urn:rezics:none');
  setField(approval, 'rEligibility', eligibility);

  const pin = proofRow('publication', input.publicationDecision,
    contentPublicationReceiptIri(publicationAdmission));
  const fields: Array<[string, string | undefined, 'uri' | 'literal']> = [
    ['dComponent', input.variantId, 'uri'], ['dResource', input.resourceId, 'uri'],
    ['dRevision', revision, 'uri'], ['dDigest', 'a'.repeat(64), 'literal'],
    ['dOwnerEpoch', ownerEpoch, 'literal'], ['dOwnerSequence', '5', 'literal'],
    ['dDataEpoch', graphEpoch, 'literal'], ['dSequence', '3', 'literal'],
    ['dModel', 'https://rezics.com/definition/content-publication-v1', 'uri'],
    ['dShape', 'https://rezics.com/definition/content-publication-v1', 'uri'],
    ['dDataset', DATASET, 'uri'], ['dPreparation', 'preparation', 'literal'],
    ['rOutcome', `${RV}Succeeded`, 'uri'], ['rReason', undefined, 'uri'],
    ['rRequestDigest', 'b'.repeat(64), 'literal'], ['rAdmissionId', publicationAdmission, 'literal'],
    ['rAuthorityEpoch', '2', 'literal'], ['rScope', `content:publish:${input.variantId}`, 'literal'],
    ['rPreparation', 'preparation', 'literal'], ['rRevision', revision, 'uri'],
    ['rVariant', input.variantId, 'uri'], ['rResource', input.resourceId, 'uri'],
    ['rByteDigest', 'a'.repeat(64), 'literal'], ['rOwnerEpoch', ownerEpoch, 'literal'],
    ['rOwnerSequence', '5', 'literal'], ['rExpectedHead', 'urn:rezics:none', 'uri'],
    ['rDataset', DATASET, 'uri'], ['rDataEpoch', graphEpoch, 'literal'], ['rSequence', '3', 'literal'],
    ['rDecision', input.publicationDecision, 'uri'],
  ];
  for (const [name, value, type] of fields) setField(pin, name, value, type);
  const read = async (step: string): Promise<SparqlResult> => {
      let rows: Row[];
      if (step.startsWith('snapshot')) rows = [{ epoch: literal(graphEpoch),
        routing: literal('1'), sequence: integer('20') }];
      else if (step.startsWith('candidate page')) rows = [{ variant: uri(input.variantId),
        resourceCount: integer('1'), resource: uri(input.resourceId), publicationCount: integer('1'),
        publication: uri(input.publicationDecision), eligibilityCount: integer('1'), eligibility: uri(eligibility) }];
      else if (step === 'eligibility owner records') rows = [approval];
      else if (step === 'publication owner records') rows = [pin];
      else throw new Error(`unexpected proof read: ${step}`);
      return { results: { bindings: rows } };
  };
  const queries: string[] = [];
  const env = { lineage: { dataEpoch: graphEpoch, routingEpoch: '1' }, objectDirectory: '.temp',
    fuseki: { query: async (sparql: string) => {
      queries.push(sparql);
      if (sparql.includes('SELECT ?epoch')) return read('snapshot before');
      if (sparql.includes('SELECT ?eligibility')) return read('eligibility owner records');
      if (sparql.includes('SELECT ?publication')) return read('publication owner records');
      throw new Error('unexpected retained proof query');
    } } } as unknown as WorkActivationEnvironment;
  const owner = { dataEpoch: ownerEpoch, sequence: '10' };
  const source = { eligibilityDecision: eligibility, publicationDecision: input.publicationDecision,
    variant: input.variantId, resource: input.resourceId,
    receiptId: contentSearchEligibilityReceiptIri(eligibilityAdmission), requestDigest,
    graphDataEpoch: graphEpoch, graphSequence: '6' };
  return { env, owner, source, approval, read, queries };
}

async function readProof(input: ContentSearchEligibilityInput, requestDigest: string) {
  const { env, owner, read } = proofFixture(input, requestDigest);
  return (await readContentEligibilityStatesForVariants(env, [input.variantId], owner, { read }))[0]!;
}

test('retained eligibility reports an unresolved Main proof and its failing predicate', async () => {
  const digest = contentSearchEligibilityDigest(apiV1);
  const fixture = proofFixture(apiV1, digest);
  const read = () => readRetainedContentEligibilitySource(fixture.env, fixture.owner, fixture.source);
  setField(fixture.approval, 'rRequestDigest', 'f'.repeat(64), 'literal');
  const failure = await read().catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(ContentEligibilityStateUnavailable);
  expect((failure as Error).message).toBe(
    'retained eligibility proof did not resolve: not a verified Main owner proof (digest predicate)');
  expect(fixture.queries).toHaveLength(2);
  setField(fixture.approval, 'rRequestDigest', digest, 'literal');
  fixture.approval.receiptTypeCount = integer('0');
  await expect(read()).rejects.toThrow(
    'retained eligibility proof did not resolve: not a verified Main owner proof (type or count predicate (receiptType))');
  fixture.approval.receiptTypeCount = integer('1');
  setField(fixture.approval, 'rOutcome', `${RV}Stale`);
  setField(fixture.approval, 'rRequestDigest', 'f'.repeat(64), 'literal');
  await expect(read()).rejects.toThrow(
    'retained eligibility proof did not resolve: not a verified Main owner proof (field predicate (rOutcome))');
  setField(fixture.approval, 'rOutcome', `${RV}Succeeded`);
  setField(fixture.approval, 'rRequestDigest', digest, 'literal');
  await expect(readRetainedContentEligibilitySource(fixture.env, fixture.owner,
    { ...fixture.source, resource: `${apiV1.resourceId}-foreign` })).rejects.toThrow(
      'retained eligibility proof did not resolve: not a verified Main owner proof (field predicate (dResource))');
});

test('retained eligibility reports which verified proof fields differ from the event', async () => {
  const fixture = proofFixture(apiV2, contentSearchEligibilityDigest(apiV2));
  const verified = await readRetainedContentEligibilitySource(fixture.env, fixture.owner, fixture.source);
  expect(verified.eligibility.requestDigest).toBe(fixture.source.requestDigest);
  const mismatches = [
    { field: 'publicationDecision', source: { publicationDecision: `${publication}-changed` } },
    { field: 'sourceReceiptId', source: { receiptId: `${fixture.source.receiptId}-changed` } },
    { field: 'requestDigest', source: { requestDigest: 'e'.repeat(64) } },
    { field: 'graphSequence', source: { graphSequence: '7' } },
  ];
  for (const mismatch of mismatches) {
    const before = fixture.queries.length;
    const read = () => readRetainedContentEligibilitySource(fixture.env, fixture.owner,
      { ...fixture.source, ...mismatch.source });
    const failure = await read().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ContentEligibilityStateUnavailable);
    expect((failure as Error).message).toBe(
      `retained eligibility proof resolved but differs from retained event (${mismatch.field})`);
    expect(fixture.queries).toHaveLength(before + 2);
  }
});

test('canonical v1 matches the retained API receipt from the projection diagnosis', () => {
  const input: ContentSearchEligibilityInput = {
    resourceId: 'https://rezics.com/id/01a12d9c-e8a4-75ce-bbdd-e036b23eb6fb',
    variantId: 'urn:rezics:variant:07120b74-9296-4fdf-8e05-2ddf1d1a63ca',
    publicationDecision: 'urn:rezics:content-publication:04d287d40798380cd73a70fc4933b0275aaa492b3290136ba63f0746c99aa4eb',
    expectedEligibilityHead: null, actingSubject: 'https://rezics.com/id/8acf14fb-fefc-4d78-8bed-7130cef82ecd',
    disclosure: 'public', rightsBasis: 'original-contribution',
  };
  expect(contentSearchEligibilityDigest(input))
    .toBe('0cfd677bc63568c0c4ee12f7a8023099493baa9c33e7ddc8d3156e2071496582');
});

for (const input of [apiV1, apiV2]) {
  test(`${input.rightsBasis}: the API admission binds the canonical digest`, async () => {
    let admittedDigest: string | undefined;
    const fuseki = { query: async () => ({ boolean: true }) } as unknown as WorkActivationEnvironment['fuseki'];
    const work = { environment: { fuseki, lineage: { dataEpoch: graphEpoch, routingEpoch: '1' } },
      contentAuthoring: {}, rights: { store: {} }, account: { verify: async () => ({}) },
      access: { verifyContentDraftProof: async () => true,
        register: async (admission: { requestDigest: string }) => {
          admittedDigest = admission.requestDigest;
          throw new ContentEligibilityDenied('admission captured before owner effect');
        } } } as unknown as MainWorkDependencies;
    const app = contentRoutes(fuseki, work);
    const payload = { profile: input.profile ?? 'content-search-eligibility-v1',
      ...Object.fromEntries(Object.entries(input).reverse()) };
    const response = await app.handle(new Request('http://localhost/v1/content-search-eligibility', {
      method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'canonical-proof' },
      body: JSON.stringify(payload),
    }));
    expect(response.status).toBe(403);
    expect(admittedDigest).toBe(oldDigest(input));
    expect((await readProof(input, admittedDigest!)).kind).toBe('public-current');
  });

  test(`${input.rightsBasis}: API receipt round-trips independently of caller property order`, async () => {
    const digest = oldDigest(input);
    expect(contentSearchEligibilityDigest(input)).toBe(digest);
    const reversed = Object.fromEntries(Object.entries(input).reverse()) as unknown as ContentSearchEligibilityInput;
    expect(contentSearchEligibilityDigest(reversed)).toBe(digest);
    expect((await readProof(input, digest)).kind).toBe('public-current');
    const replacement = { ...input, expectedEligibilityHead: 'urn:rezics:content-search-eligibility:prior' };
    expect((await readProof(replacement, contentSearchEligibilityDigest(replacement))).kind).toBe('public-current');
  });
}

test('explicit v1 profile uses the same canonical receipt as the API', () => {
  expect(contentSearchEligibilityDigest({ profile: 'content-search-eligibility-v1', ...ownerV1 }))
    .toBe(oldDigest(apiV1));
});

for (const { name, input } of retained) {
  test(`${name}: a retained serialization verifies without rewriting its digest`, async () => {
    const digest = oldDigest(input);
    expect(digest).not.toBe(contentSearchEligibilityDigest(input));
    expect((await readProof(input, digest)).kind).toBe('public-current');
  });
}

for (const { name, input } of [{ name: 'api-v1', input: apiV1 }, { name: 'api-v2', input: apiV2 }, ...retained]) {
  test(`${name}: canonical and retained proofs refuse tampered fields`, async () => {
    const digest = oldDigest(input);
    const mutations: Partial<ContentSearchEligibilityInput>[] = [
      { resourceId: `${input.resourceId}-changed` }, { variantId: `${input.variantId}-changed` },
      { publicationDecision: `${input.publicationDecision}-changed` },
      { expectedEligibilityHead: 'urn:rezics:content-search-eligibility:changed' },
      { actingSubject: `${input.actingSubject}-changed` },
      input.rightsBasis === 'original-contribution'
        ? { rightsBasis: 'public-domain', profile: 'content-search-eligibility-v2', assessmentId }
        : { rightsBasis: 'original-contribution', profile: undefined, assessmentId: undefined },
      ...(input.rightsBasis === 'public-domain'
        ? [{ assessmentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }] : []),
    ];
    for (const mutation of mutations) {
      expect((await readProof({ ...input, ...mutation }, digest)).kind).toBe('unresolved');
    }
    expect((await readProof(input, 'f'.repeat(64))).kind).toBe('unresolved');
  });
}

for (const input of [apiV1, apiV2]) {
  test(`${input.rightsBasis}: an unlisted historical order refuses`, async () => {
    const unlisted = Object.fromEntries(Object.entries(input).reverse()) as unknown as ContentSearchEligibilityInput;
    expect((await readProof(input, oldDigest(unlisted))).kind).toBe('unresolved');
  });
}
