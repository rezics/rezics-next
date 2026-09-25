import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { contentDraftIntentDigest, type ContentCore,
  type ExactContentReference } from '../../content/src/core.ts';
import { FusekiClient, type SparqlResult } from '../src/infrastructure/fuseki.ts';
import type { ClaimedAdmission } from '../src/modules/access/admission.ts';
import { buildContentEligibilityUpdate, contentSearchEligibilityDecisionIri,
  contentSearchEligibilityDigest, ContentEligibilityConflict, ContentEligibilityDenied,
  ContentEligibilityProfileUnavailable, selectPublicContentSearch,
  ContentEligibilityStale,
  ContentEligibilityUnavailable,
  type ContentSearchEligibilityInput } from '../src/modules/content-publication/eligibility.ts';
import { mapContentOutboxEvent, OutboxIncomplete,
  type MainOutboxBatch } from '../src/modules/outbox/relay.ts';
import { RV, type WorkActivationEnvironment } from '../src/modules/work/activate.ts';

const literal = (value: string) => ({ type: 'literal', value });
const uri = (value: string) => ({ type: 'uri', value });

class EligibilityGraph extends FusekiClient {
  rows: SparqlResult['results'] = { bindings: [] };
  sourceRows: SparqlResult['results'] = { bindings: [] };
  commands = 0;
  constructor() { super('http://localhost:1/rezics'); }
  override async query(sparql: string): Promise<SparqlResult> {
    return { results: sparql.includes('SELECT ?revision ?digest') ? this.sourceRows : this.rows };
  }
  override async commandHealth() { return { moduleVersion: '0.5.21',
    instanceId: '11111111-1111-4111-8111-111111111111',
    publicSearchWriteEpoch: '0', publicSearchWriteActive: false, profiles: {} }; }
  override async commandWithReceipt(): Promise<never> {
    this.commands++;
    throw new Error('unexpected graph command');
  }
}

function fixture() {
  const graph = new EligibilityGraph();
  const input: ContentSearchEligibilityInput = {
    resourceId: `https://rezics.com/id/${randomUUID()}`,
    variantId: `urn:rezics:variant:${randomUUID()}`,
    publicationDecision: `urn:rezics:content-publication:${randomUUID()}`,
    expectedEligibilityHead: null,
    actingSubject: `https://rezics.com/id/${randomUUID()}`,
    rightsBasis: 'original-contribution', disclosure: 'public',
  };
  const admission: ClaimedAdmission = {
    id: randomUUID(), principalId: randomUUID(), actingSubject: input.actingSubject,
    scope: `content:search-eligibility:${input.variantId}`,
    action: 'content.search-eligibility', idempotencyKey: `eligibility-${randomUUID()}`,
    requestDigest: contentSearchEligibilityDigest(input), authorityEpoch: '3',
    expiresAt: new Date(Date.now() + 60_000).toISOString(), state: 'claimed',
    dispatchEligible: true, replayed: false, claimedAt: new Date().toISOString(),
  };
  const env: WorkActivationEnvironment = { fuseki: graph,
    lineage: { dataEpoch: randomUUID(), routingEpoch: '1' }, objectDirectory: '.temp' };
  const revisionId = randomUUID();
  const serializedJson = '{"body":"test"}';
  const reference: ExactContentReference = { owner: 'content', resourceId: input.resourceId,
    variantId: input.variantId, revisionId, format: 'rezics-content-json-v1',
    model: 'content-shape-v1', byteDigest: 'a'.repeat(64), byteLength: serializedJson.length,
    language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr',
    sourceRevision: null, predecessor: null, provenance: {} };
  const authorAdmissionId = randomUUID();
  const requestDigest = contentDraftIntentDigest({
    variant: { id: reference.variantId, resourceId: reference.resourceId,
      language: reference.language, direction: reference.direction },
    expectedHead: null, model: reference.model, sourceRevision: null, serializedJson,
  }, input.actingSubject);
  reference.provenance = { kind: 'admitted-original-contribution-v1',
    author: input.actingSubject, admissionId: authorAdmissionId, authorityEpoch: '2',
    scope: `content:draft:${input.resourceId}`, requestDigest,
    expectedHead: null, rightsBasis: 'original-contribution' };
  graph.sourceRows = { bindings: [{
    revision: uri(`urn:rezics:content:revision:${revisionId}`),
    digest: literal(reference.byteDigest),
  }] };
  const contentEpoch = randomUUID();
  const content = { readExactBatch: async () => [{ revisionId, status: 'available',
    reference, serializedJson, body: { body: 'test' } }],
  readDraftReceipt: async () => ({ outcome: 'succeeded', revisionId,
    position: { owner: 'content', dataEpoch: contentEpoch, sequence: '5' } }),
  ownerPosition: async () => ({ owner: 'content', dataEpoch: contentEpoch, sequence: '6' }),
  } as unknown as ContentCore;
  let proofValid = true;
  const access = { verifyContentDraftProof: async () => proofValid };
  return { graph, input, admission, env, content, access, reference,
    denyProof: () => { proofValid = false; } };
}

test('SEARCH19: public Content release requires a claimed admission and reviewed native profile', async () => {
  const { graph, input, admission, env, content, access } = fixture();
  await expect(selectPublicContentSearch(env, content, access,
    { ...admission, state: 'registered' } as ClaimedAdmission,
    input)).rejects.toBeInstanceOf(ContentEligibilityDenied);
  await expect(selectPublicContentSearch(env, content, access,
    { ...admission, dispatchEligible: false },
    input)).rejects.toBeInstanceOf(ContentEligibilityDenied);
  await expect(selectPublicContentSearch(env, content, access, { ...admission,
    expiresAt: new Date(Date.now() - 1000).toISOString() },
  input)).rejects.toBeInstanceOf(ContentEligibilityDenied);
  await expect(selectPublicContentSearch(env, content, access, admission,
    { ...input, rightsBasis: 'unverified' as 'original-contribution' })).rejects.toThrow();
  await expect(selectPublicContentSearch(env, content, access, admission, input))
    .rejects.toBeInstanceOf(ContentEligibilityProfileUnavailable);
  expect(graph.commands).toBe(0);
});

test('SEARCH19: public eligibility rejects forged author proof, missing source and unavailable bytes', async () => {
  const { graph, input, admission, env, content, access, reference, denyProof } = fixture();
  denyProof();
  await expect(selectPublicContentSearch(env, content, access, admission, input))
    .rejects.toBeInstanceOf(ContentEligibilityDenied);
  const unavailable = { readExactBatch: async () => [{ status: 'unavailable' }] } as unknown as ContentCore;
  await expect(selectPublicContentSearch(env, unavailable, access, admission, input))
    .rejects.toBeInstanceOf(ContentEligibilityUnavailable);
  reference.provenance = { ...reference.provenance, author: `https://rezics.com/id/${randomUUID()}` };
  await expect(selectPublicContentSearch(env, content, access, admission, input))
    .rejects.toBeInstanceOf(ContentEligibilityDenied);
  reference.provenance = {};
  await expect(selectPublicContentSearch(env, content, access, admission, input))
    .rejects.toBeInstanceOf(ContentEligibilityDenied);
  graph.sourceRows = { bindings: [] };
  await expect(selectPublicContentSearch(env, content, access, admission, input))
    .rejects.toBeInstanceOf(ContentEligibilityUnavailable);
  expect(graph.commands).toBe(0);
});

test('SEARCH19/SYS10: stale graph receipt is terminal and cannot become a public release', async () => {
  const { graph, input, admission, env, content, access } = fixture();
  graph.rows = { bindings: [{
    outcome: uri(`${RV}Cancelled`), reason: uri(`${RV}StaleHead`),
    digest: literal(admission.requestDigest), id: literal(admission.id),
    authority: literal(admission.authorityEpoch), scope: literal(admission.scope),
    actor: uri(input.actingSubject), resource: uri(input.resourceId),
    variant: uri(input.variantId), publication: uri(input.publicationDecision),
    expected: uri('urn:rezics:none'), rights: uri(`${RV}OriginalContribution`),
    disclosure: uri(`${RV}Public`), epoch: literal(env.lineage.dataEpoch),
    sequence: literal('10'),
  }] };
  await expect(selectPublicContentSearch(env, content, access, admission, input))
    .rejects.toBeInstanceOf(ContentEligibilityStale);
  expect(graph.commands).toBe(0);
});

test('SEARCH19/SYS02: same-key graph receipt replay binds exact reviewer, publication and graph epoch', async () => {
  const { graph, input, admission, env, content, access } = fixture();
  const row = {
    outcome: uri(`${RV}Succeeded`), digest: literal(admission.requestDigest),
    id: literal(admission.id), authority: literal(admission.authorityEpoch),
    scope: literal(admission.scope), actor: uri(input.actingSubject),
    resource: uri(input.resourceId), variant: uri(input.variantId),
    publication: uri(input.publicationDecision), expected: uri('urn:rezics:none'),
    decision: uri(contentSearchEligibilityDecisionIri(admission.id)),
    rights: uri(`${RV}OriginalContribution`), disclosure: uri(`${RV}Public`),
    epoch: literal(env.lineage.dataEpoch), sequence: literal('9'),
  };
  graph.rows = { bindings: [row] };
  await expect(selectPublicContentSearch(env, content, access, admission, input)).resolves.toMatchObject({
    outcome: 'succeeded', replayed: true, graphSequence: '9',
    decision: contentSearchEligibilityDecisionIri(admission.id),
  });
  graph.rows = { bindings: [{ ...row, actor: uri(`https://rezics.com/id/${randomUUID()}`) }] };
  await expect(selectPublicContentSearch(env, content, access, admission, input))
    .rejects.toBeInstanceOf(ContentEligibilityConflict);
  expect(graph.commands).toBe(0);
});

test('SEARCH19: eligibility command binds one exact head change, revision, receipt and typed event', () => {
  const { env, input, admission } = fixture();
  const update = buildContentEligibilityUpdate(env, admission, input);
  expect(update).toContain('rv:contentPublicationHead <' + input.publicationDecision + '>');
  expect(update).toContain('rv:publicSearchEligibilityHead <' +
    contentSearchEligibilityDecisionIri(admission.id) + '>');
  expect(update).toContain('rv:ContentSearchEligibilityDecision, rv:RevisionAnchor');
  expect(update).toContain('rv:admittedScope "' + admission.scope + '"');
  expect(update).toContain('rv:rightsBasis rv:OriginalContribution ; rv:disclosure rv:Public');
  expect(update).toContain('rv:eventCount 1 ; rv:event');
  expect(update).toContain('a rv:ContentSearchEligibilityEvent ; rv:ordinal 0');
  expect(update).toContain('FILTER(COALESCE(?prior, <urn:rezics:none>) = <urn:rezics:none>)');
});

test('SEARCH19: Content projection outbox mapper accepts exact receipt and rejects missing binding', () => {
  const batch: MainOutboxBatch = { batchId: `urn:rezics:outbox:${randomUUID()}`,
    dataEpoch: randomUUID(), sequence: '12', routingEpoch: '1',
    eventIds: [`urn:rezics:event:${randomUUID()}`] };
  const fields: Record<string, string> = {
    kind: `${RV}ContentProjectionEvent`, action: 'content.project',
    outcome: `${RV}Succeeded`, receipt: `urn:rezics:receipt:${randomUUID()}`,
    digest: 'a'.repeat(64), epoch: batch.dataEpoch, sequence: batch.sequence,
    resource: `https://rezics.com/id/${randomUUID()}`,
    variant: `urn:rezics:variant:${randomUUID()}`,
    publicationDecision: `urn:rezics:content-publication:${randomUUID()}`,
    contentRevision: `urn:rezics:content:revision:${randomUUID()}`,
    eligibility: `urn:rezics:content-search-eligibility:${randomUUID()}`,
    projection: `urn:rezics:content:projection:${randomUUID()}`,
    matchUnit: `urn:rezics:content:match-unit:${randomUUID()}`,
    ownerDataEpoch: randomUUID(), ownerSequence: '5',
  };
  fields.eventVariant = fields.variant!;
  fields.eventContentRevision = fields.contentRevision!;
  const mapped = mapContentOutboxEvent(batch, batch.eventIds[0]!, name => fields[name], 0);
  expect(mapped.type).toBe('com.rezics.content.projected.v1');
  expect(mapped.data.receipt.matchUnit).toBe(fields.matchUnit);
  expect(mapped.data.receipt.admission).toBeUndefined();
  delete fields.matchUnit;
  expect(() => mapContentOutboxEvent(batch, batch.eventIds[0]!, name => fields[name], 0))
    .toThrow(OutboxIncomplete);
});
