import { expect, test } from 'bun:test';
import type { ContentCore } from '../../content/src/core.ts';
import type { ContentProjectionCursor } from '../../content/src/projection-cursor.ts';
import { profileRegistry } from '../../../packages/model/src/generated/profiles.ts';
import { createMainApp, type MainWorkDependencies } from '../src/app.ts';
import { FusekiClient, type SparqlResult } from '../src/infrastructure/fuseki.ts';
import { AdmissionUnavailable } from '../src/modules/access/admission.ts';
import { contentSearchEligibilityDecisionIri, contentSearchEligibilityDigest,
  contentSearchEligibilityReceiptIri } from '../src/modules/content-publication/eligibility.ts';
import { contentPublicationDecisionIri, contentPublicationReceiptIri }
  from '../src/modules/content-publication/publish.ts';
import { DATASET, RV } from '../src/modules/work/activate.ts';

const graphEpoch = 'graph-epoch', contentEpoch = 'content-epoch';
const generation = 'urn:rezics:text-index-generation:11111111-1111-4111-8111-111111111111';
const resource = 'https://rezics.com/id/22222222-2222-4222-8222-222222222222';
const matchUnit = 'urn:rezics:match:retained-private-result';
const binding = (value: string) => ({ type: 'literal', value });
const uri = (value: string) => ({ type: 'uri', value });
const contentPosition = () => ({ owner: 'content' as const, dataEpoch: contentEpoch, sequence: '2' });
const variant = 'urn:rezics:variant:33333333-3333-4333-8333-333333333333';
const revision = 'urn:rezics:content:revision:44444444-4444-4444-8444-444444444444';
const publicationAdmission = '55555555-5555-4555-8555-555555555555';
const eligibilityAdmission = '66666666-6666-4666-8666-666666666666';
const decision = contentPublicationDecisionIri(publicationAdmission);
const publicationReceipt = contentPublicationReceiptIri(publicationAdmission);
const eligibility = contentSearchEligibilityDecisionIri(eligibilityAdmission);
const eligibilityReceipt = contentSearchEligibilityReceiptIri(eligibilityAdmission);
const actor = 'urn:rezics:actor:content-search-reviewer';
const preparation = '77777777-7777-4777-8777-777777777777';
const eligibilityInput = { resourceId: resource, variantId: variant, publicationDecision: decision,
  expectedEligibilityHead: null, actingSubject: actor,
  rightsBasis: 'original-contribution' as const, disclosure: 'public' as const };

function proofRow(key: string, id: string, receipt: string,
  fields: Array<[string, string | undefined, 'uri' | 'literal']>) {
  const row: Record<string, { type: string; value: string }> = { [key]: uri(id),
    decisionTypeCount: binding('1'), anchorTypeCount: binding('1'), receiptCount: binding('1'),
    receipt: uri(receipt), receiptTypeCount: binding('1') };
  for (const [name, value, type] of fields) {
    row[`${name}Count`] = binding(value === undefined ? '0' : '1');
    if (value !== undefined) row[name] = type === 'uri' ? uri(value) : binding(value);
  }
  return row;
}

const publicationOwnerRow = proofRow('publication', decision, publicationReceipt, [
  ['dComponent', variant, 'uri'], ['dResource', resource, 'uri'], ['dRevision', revision, 'uri'],
  ['dDigest', 'a'.repeat(64), 'literal'], ['dOwnerEpoch', contentEpoch, 'literal'],
  ['dOwnerSequence', '2', 'literal'], ['dDataEpoch', graphEpoch, 'literal'], ['dSequence', '6', 'literal'],
  ['dModel', 'https://rezics.com/definition/content-publication-v1', 'uri'],
  ['dShape', 'https://rezics.com/definition/content-publication-v1', 'uri'],
  ['dDataset', DATASET, 'uri'], ['dPreparation', preparation, 'literal'],
  ['rOutcome', `${RV}Succeeded`, 'uri'], ['rReason', undefined, 'uri'], ['rRequestDigest', 'b'.repeat(64), 'literal'],
  ['rAdmissionId', publicationAdmission, 'literal'], ['rAuthorityEpoch', '2', 'literal'],
  ['rScope', `content:publish:${variant}`, 'literal'], ['rPreparation', preparation, 'literal'],
  ['rRevision', revision, 'uri'], ['rVariant', variant, 'uri'], ['rResource', resource, 'uri'],
  ['rByteDigest', 'a'.repeat(64), 'literal'], ['rOwnerEpoch', contentEpoch, 'literal'],
  ['rOwnerSequence', '2', 'literal'], ['rExpectedHead', 'urn:rezics:none', 'uri'],
  ['rDataset', DATASET, 'uri'], ['rDataEpoch', graphEpoch, 'literal'],
  ['rSequence', '6', 'literal'], ['rDecision', decision, 'uri'],
]);

const eligibilityOwnerRow = proofRow('eligibility', eligibility, eligibilityReceipt, [
  ['dComponent', variant, 'uri'], ['dVariant', variant, 'uri'], ['dResource', resource, 'uri'],
  ['dPublication', decision, 'uri'], ['dRightsBasis', `${RV}OriginalContribution`, 'uri'],
  ['dAssessment', undefined, 'uri'], ['dDisclosure', `${RV}Public`, 'uri'],
  ['dAdmissionId', eligibilityAdmission, 'literal'], ['dAuthorityEpoch', '2', 'literal'],
  ['dScope', `content:search-eligibility:${variant}`, 'literal'], ['dActor', actor, 'uri'],
  ['dModel', 'https://rezics.com/definition/content-search-eligibility-v1', 'uri'],
  ['dShape', 'https://rezics.com/definition/content-search-eligibility-v1', 'uri'],
  ['dDataset', DATASET, 'uri'], ['dDataEpoch', graphEpoch, 'literal'],
  ['dSequence', '7', 'literal'], ['rOutcome', `${RV}Succeeded`, 'uri'], ['rReason', undefined, 'uri'],
  ['rRequestDigest', contentSearchEligibilityDigest(eligibilityInput), 'literal'],
  ['rAdmissionId', eligibilityAdmission, 'literal'], ['rAuthorityEpoch', '2', 'literal'],
  ['rScope', `content:search-eligibility:${variant}`, 'literal'], ['rActor', actor, 'uri'],
  ['rResource', resource, 'uri'], ['rVariant', variant, 'uri'], ['rPublication', decision, 'uri'],
  ['rExpectedHead', 'urn:rezics:none', 'uri'], ['rRightsBasis', `${RV}OriginalContribution`, 'uri'],
  ['rAssessment', undefined, 'uri'], ['rDisclosure', `${RV}Public`, 'uri'],
  ['rDataset', DATASET, 'uri'], ['rDataEpoch', graphEpoch, 'literal'],
  ['rSequence', '7', 'literal'], ['rEligibility', eligibility, 'uri'],
]);

/** Keeps the native projection, source and cursor coherent so only Access closes the route. */
class SearchGraph extends FusekiClient {
  matched = false;
  constructor() { super('http://search-custody.invalid'); }
  override async commandHealth() {
    return { moduleVersion: 'test', instanceId: '11111111-1111-4111-8111-111111111111',
      publicSearchWriteEpoch: '0', publicSearchWriteActive: false,
      profiles: Object.fromEntries(Object.entries(profileRegistry).map(([id, profile]) => [id, profile.sha256])) };
  }
  override async query(query: string): Promise<SparqlResult> {
    if (query.includes('ASK {')) return { boolean: true };
    if (query.includes('SELECT ?generation WHERE') && query.includes('"occurrence-lucene-v1"')) {
      return { results: { bindings: [] } };
    }
    if (query.includes('SELECT ?epoch ?routing ?sequence WHERE')) {
      return { results: { bindings: [{ epoch: binding(graphEpoch), routing: binding('1'), sequence: binding('7') }] } };
    }
    if (query.includes('(COUNT(DISTINCT ?resource) AS ?resourceCount)')) {
      return { results: { bindings: [{ variant: uri(variant), resourceCount: binding('1'), resource: uri(resource),
        publicationCount: binding('1'), publication: uri(decision), eligibilityCount: binding('1'),
        eligibility: uri(eligibility) }] } };
    }
    if (query.includes('SELECT ?eligibility') && query.includes('?decisionTypeCount')) {
      return { results: { bindings: [eligibilityOwnerRow] } };
    }
    if (query.includes('SELECT ?publication') && query.includes('?decisionTypeCount')) {
      return { results: { bindings: [publicationOwnerRow] } };
    }
    if (query.includes('?probeScore')) return { results: { bindings: [{
      epoch: binding(graphEpoch), sequence: binding('7'), generation: binding(generation), population: binding('1'),
    }] } };
    if (query.includes('rv:publicTextInventory()')) return { results: { bindings: [{ population: binding('1') }] } };
    if (query.includes('SELECT ?epoch ?sequence ?generation ?declared')) return { results: { bindings: [{
      epoch: binding(graphEpoch), sequence: binding('7'), generation: binding(generation),
      declared: binding('1'), heads: binding('1'), missing: binding('0'), eligible: binding('1'), contentUnits: binding('1'),
    }] } };
    if (query.includes('?candidateCount')) {
      this.matched = true;
      return { results: { bindings: [{ epoch: binding(graphEpoch), sequence: binding('7'),
        generation: binding(generation), candidateCount: binding('1'), unit: binding(matchUnit), score: binding('2.5'),
        resource: binding(resource), variant: binding(variant), revision: binding(revision),
        decision: binding(decision), language: binding('en'),
        eligibility: binding(eligibility), rightsBasis: binding(`${RV}OriginalContribution`),
      }] } };
    }
    throw new Error(`unexpected search custody query: ${query.slice(0, 80)}`);
  }
}

function fixture() {
  const graph = new SearchGraph();
  const state = { held: false, sourceReads: 0, closeAfterMatch: false, closeOnSource: false };
  const content = { ownerPosition: async () => {
    state.sourceReads++;
    if (state.closeOnSource || state.closeAfterMatch && graph.matched) state.held = true;
    return contentPosition();
  } } as unknown as ContentCore;
  const cursor = { read: async () => contentPosition() } as unknown as ContentProjectionCursor;
  const deps = { environment: { fuseki: graph, objectDirectory: '.temp/erasure-custody-tests',
    lineage: { dataEpoch: graphEpoch, routingEpoch: '1' } },
  access: { assertRecoveryOpen: async () => {
    if (state.held) throw new AdmissionUnavailable('Access is held for recovery');
  } }, contentProjection: { content, cursor, consumer: 'public-search' } } as unknown as MainWorkDependencies;
  const app = createMainApp(graph, deps);
  const search = () => app.handle(new Request('http://main.local/v1/queries', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ profile: 'public-content-phrase-v1', phrase: 'needle', language: null }),
  }));
  const ready = () => app.handle(new Request('http://main.local/health/search-ready'));
  return { graph, state, search, ready };
}

test('OPS12: coherent Content phrase search and readiness open only with Access recovery custody', async () => {
  const f = fixture();
  const response = await f.search();
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ profile: 'public-content-phrase-v1',
    results: [{ matchUnit }], graphPosition: { dataEpoch: graphEpoch, sequence: '7' } });
  expect((await f.ready()).status).toBe(200);
});

test('OPS12: a held Access owner refuses Content phrase and search-ready before source reads', async () => {
  const f = fixture();
  f.state.held = true;
  const response = await f.search();
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain(matchUnit);
  expect((await f.ready()).status).toBe(503);
  expect(f.state.sourceReads).toBe(0);
  expect(f.graph.matched).toBe(false);
});

test('OPS12: Access closure during the matched Content projection fence withholds the completed search result', async () => {
  const f = fixture();
  f.state.closeAfterMatch = true;
  const response = await f.search();
  expect(f.graph.matched).toBe(true);
  expect(f.state.sourceReads).toBeGreaterThan(1);
  expect(f.state.held).toBe(true);
  expect(response.status).toBe(503);
  const result = await response.text();
  expect(result).not.toContain(matchUnit);
  expect(result).not.toContain('graphPosition');
});

test('OPS12: search-ready withholds its ready proof if Access closes during source lookup', async () => {
  const f = fixture();
  f.state.closeOnSource = true;
  const response = await f.ready();
  expect(f.state.sourceReads).toBeGreaterThan(0);
  expect(f.state.held).toBe(true);
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ status: 'unavailable' });
});
