import { expect, test } from 'bun:test';
import type { ContentCore } from '../../content/src/core.ts';
import type { ContentProjectionCursor } from '../../content/src/projection-cursor.ts';
import type { SparqlResult } from '../src/infrastructure/fuseki.ts';
import { contentSearchEligibilityDecisionIri, contentSearchEligibilityDigest,
  contentSearchEligibilityReceiptIri } from '../src/modules/content-publication/eligibility.ts';
import { contentPublicationDecisionIri, contentPublicationReceiptIri }
  from '../src/modules/content-publication/publish.ts';
import { verifyQuarantinedContentIndex } from '../src/modules/content-publication/rebuild.ts';
import { DATASET, RV, type WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import type { ContentSearchEligibilityInput } from '../src/modules/content-publication/eligibility.ts';

const graphEpoch = '11111111-1111-4111-8111-111111111111';
const sourceEpoch = '22222222-2222-4222-8222-222222222222';
const generation = 'urn:rezics:text-index-generation:33333333-3333-4333-8333-333333333333';
const variant = 'urn:rezics:variant:44444444-4444-4444-8444-444444444444';
const resource = 'https://rezics.com/id/55555555-5555-4555-8555-555555555555';
const revisionId = '66666666-6666-4666-8666-666666666666';
const revision = `urn:rezics:content:revision:${revisionId}`;
const publicationAdmissionId = '77777777-7777-4777-8777-777777777777';
const eligibilityAdmissionId = '88888888-8888-4888-8888-888888888888';
const decision = contentPublicationDecisionIri(publicationAdmissionId);
const publicationReceipt = contentPublicationReceiptIri(publicationAdmissionId);
const eligibility = contentSearchEligibilityDecisionIri(eligibilityAdmissionId);
const eligibilityReceipt = contentSearchEligibilityReceiptIri(eligibilityAdmissionId);
const unit = 'urn:rezics:content:match-unit:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
const digest = 'd'.repeat(64);
const prep = '99999999-9999-4999-8999-999999999999';
const actor = 'https://rezics.com/id/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const input: ContentSearchEligibilityInput = { resourceId: resource, variantId: variant,
  publicationDecision: decision, expectedEligibilityHead: null, actingSubject: actor,
  rightsBasis: 'original-contribution', disclosure: 'public' };
const binding = (value: string, type = 'uri', language?: string) => ({ type, value,
  ...(language ? { 'xml:lang': language } : {}) });
type Row = Record<string, { type: string; value: string; 'xml:lang'?: string }>;

function setField(row: Row, name: string, value: string | undefined, type = 'literal') {
  row[`${name}Count`] = binding(value === undefined ? '0' : '1', 'literal');
  if (value !== undefined) row[name] = binding(value, type);
}

function publicationProofRow(): Row {
  const row: Row = { publication: binding(decision), decisionTypeCount: binding('1', 'literal'),
    anchorTypeCount: binding('1', 'literal'), receiptCount: binding('1', 'literal'),
    receipt: binding(publicationReceipt), receiptTypeCount: binding('1', 'literal') };
  const fields: Array<[string, string | undefined, string]> = [
    ['dComponent', variant, 'uri'], ['dResource', resource, 'uri'], ['dRevision', revision, 'uri'],
    ['dDigest', digest, 'literal'], ['dOwnerEpoch', sourceEpoch, 'literal'],
    ['dOwnerSequence', '5', 'literal'], ['dDataEpoch', graphEpoch, 'literal'],
    ['dSequence', '3', 'literal'], ['dModel', 'https://rezics.com/definition/content-publication-v1', 'uri'],
    ['dShape', 'https://rezics.com/definition/content-publication-v1', 'uri'],
    ['dDataset', DATASET, 'uri'], ['dPreparation', prep, 'literal'],
    ['rOutcome', `${RV}Succeeded`, 'uri'], ['rReason', undefined, 'uri'],
    ['rRequestDigest', 'a'.repeat(64), 'literal'], ['rAdmissionId', publicationAdmissionId, 'literal'],
    ['rAuthorityEpoch', '2', 'literal'], ['rScope', `content:publish:${variant}`, 'literal'],
    ['rPreparation', prep, 'literal'], ['rRevision', revision, 'uri'], ['rVariant', variant, 'uri'],
    ['rResource', resource, 'uri'], ['rByteDigest', digest, 'literal'],
    ['rOwnerEpoch', sourceEpoch, 'literal'], ['rOwnerSequence', '5', 'literal'],
    ['rExpectedHead', 'urn:rezics:none', 'uri'], ['rDataset', DATASET, 'uri'],
    ['rDataEpoch', graphEpoch, 'literal'], ['rSequence', '3', 'literal'],
    ['rDecision', decision, 'uri'],
  ];
  for (const [name, value, type] of fields) setField(row, name, value, type);
  return row;
}

function eligibilityProofRow(): Row {
  const row: Row = { eligibility: binding(eligibility), decisionTypeCount: binding('1', 'literal'),
    anchorTypeCount: binding('1', 'literal'), receiptCount: binding('1', 'literal'),
    receipt: binding(eligibilityReceipt), receiptTypeCount: binding('1', 'literal') };
  const fields: Array<[string, string | undefined, string]> = [
    ['dComponent', variant, 'uri'], ['dVariant', variant, 'uri'], ['dResource', resource, 'uri'],
    ['dPublication', decision, 'uri'], ['dRightsBasis', `${RV}OriginalContribution`, 'uri'],
    ['dAssessment', undefined, 'uri'], ['dDisclosure', `${RV}Public`, 'uri'],
    ['dAdmissionId', eligibilityAdmissionId, 'literal'], ['dAuthorityEpoch', '2', 'literal'],
    ['dScope', `content:search-eligibility:${variant}`, 'literal'], ['dActor', actor, 'uri'],
    ['dModel', 'https://rezics.com/definition/content-search-eligibility-v1', 'uri'],
    ['dShape', 'https://rezics.com/definition/content-search-eligibility-v1', 'uri'],
    ['dDataset', DATASET, 'uri'], ['dDataEpoch', graphEpoch, 'literal'], ['dSequence', '6', 'literal'],
    ['rOutcome', `${RV}Succeeded`, 'uri'], ['rReason', undefined, 'uri'],
    ['rRequestDigest', contentSearchEligibilityDigest(input), 'literal'],
    ['rAdmissionId', eligibilityAdmissionId, 'literal'], ['rAuthorityEpoch', '2', 'literal'],
    ['rScope', `content:search-eligibility:${variant}`, 'literal'], ['rActor', actor, 'uri'],
    ['rResource', resource, 'uri'], ['rVariant', variant, 'uri'], ['rPublication', decision, 'uri'],
    ['rExpectedHead', 'urn:rezics:none', 'uri'], ['rRightsBasis', `${RV}OriginalContribution`, 'uri'],
    ['rAssessment', undefined, 'uri'], ['rDisclosure', `${RV}Public`, 'uri'], ['rDataset', DATASET, 'uri'],
    ['rDataEpoch', graphEpoch, 'literal'], ['rSequence', '6', 'literal'], ['rEligibility', eligibility, 'uri'],
  ];
  for (const [name, value, type] of fields) setField(row, name, value, type);
  return row;
}

function verifyFixture(options: { missingEligibilityReceipt?: boolean; text?: string;
  population?: string; eligibilityHead?: boolean; contentUnit?: boolean } = {}) {
  const { missingEligibilityReceipt = false, text = '... !!!', population = '1',
    eligibilityHead = true, contentUnit = true } = options;
  const candidate: Row = { variant: binding(variant), resourceCount: binding('1', 'literal'),
    resource: binding(resource), publicationCount: binding('1', 'literal'), publication: binding(decision),
    eligibilityCount: binding(eligibilityHead ? '1' : '0', 'literal'),
    ...(eligibilityHead ? { eligibility: binding(eligibility) } : {}) };
  const eligibilityRow = eligibilityProofRow();
  if (missingEligibilityReceipt) {
    eligibilityRow.receiptCount = binding('0', 'literal');
    eligibilityRow.receiptTypeCount = binding('0', 'literal');
    delete eligibilityRow.receipt;
  }
  const fuseki = { async query(sparql: string): Promise<SparqlResult> {
    if (sparql.includes('ASK { GRAPH <urn:rezics:search:public>')) return { boolean: false };
    if (sparql.includes('ASK { GRAPH <urn:rezics:graph:receipts>')) return { boolean: true };
    if (sparql.includes('publicTextInventory()')) return { results: { bindings: [{ population: binding(population, 'literal') }] } };
    if (sparql.includes('ASK { GRAPH <urn:rezics:search:probe>')) return { boolean: true };
    if (sparql.includes('SELECT ?epoch ?routing ?sequence ?generation')) return { results: { bindings: [{
      epoch: binding(graphEpoch), routing: binding(graphEpoch), sequence: binding('20', 'literal'),
      generation: binding(generation),
    }] } };
    if (sparql.includes('SELECT ?epoch ?routing ?sequence')) return { results: { bindings: [{
      epoch: binding(graphEpoch), routing: binding(graphEpoch), sequence: binding('20', 'literal'),
    }] } };
    if (sparql.includes('SELECT ?variant')) return { results: { bindings: [candidate] } };
    if (sparql.includes('SELECT ?eligibility')) return { results: { bindings: [eligibilityRow] } };
    if (sparql.includes('SELECT ?publication')) return { results: { bindings: [publicationProofRow()] } };
    if (sparql.includes('SELECT ?unit ?body')) return { results: { bindings: contentUnit ? [{
      unit: binding(unit), body: binding(text, 'literal', 'en'), resource: binding(resource), variant: binding(variant),
      revision: binding(revision), decision: binding(decision), eligibility: binding(eligibility),
    }] : [] } };
    throw new Error(`unexpected rebuild query: ${sparql.slice(0, 80)}`);
  } } as unknown as WorkActivationEnvironment['fuseki'];
  const position = { owner: 'content' as const, dataEpoch: sourceEpoch, sequence: '10' };
  const content = { ownerPosition: async () => position,
    readExactBatch: async () => [{ status: 'available',
      reference: { variantId: variant, resourceId: resource, byteDigest: digest,
        model: 'content-shape-v1', language: { kind: 'tag', tag: 'en' } }, body: { body: text } }],
  } as unknown as ContentCore;
  const cursor = { read: async () => position } as unknown as ContentProjectionCursor;
  return verifyQuarantinedContentIndex({ fuseki,
    lineage: { dataEpoch: graphEpoch, routingEpoch: graphEpoch }, objectDirectory: '' },
  content, cursor, { id: graphEpoch, cut: position, consumer: 'content-rebuild.fixture' });
}

test('SEARCH20 activation rejects an eligibility head lacking its succeeded owner receipt', async () => {
  await expect(verifyFixture({ missingEligibilityReceipt: true }))
    .rejects.toThrow('Content eligibility owner inventory is unresolved');
});

test('Rebuild verifies tokenless body membership through the native stored-field audit', async () => {
  expect(await verifyFixture()).toMatchObject({ unitCount: 1, contentUnitCount: 1 });
  await expect(verifyFixture({ text: '... !!!', population: '0' })).rejects.toThrow('Lucene membership differs');
});

test('proved closed publications require no physical Content MatchUnit', async () => {
  expect(await verifyFixture({ eligibilityHead: false, contentUnit: false, population: '0' }))
    .toMatchObject({ unitCount: 0, contentUnitCount: 0 });
  await expect(verifyFixture({ eligibilityHead: false }))
    .rejects.toThrow('Content MatchUnit remains for a closed publication');
});
