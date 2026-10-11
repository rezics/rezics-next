import { expect, test } from 'bun:test';
import type { ContentCore, ExactContentReference } from '../../content/src/core.ts';
import type { ContentProjectionCursor } from '../../content/src/projection-cursor.ts';
import type { SparqlResult } from '../src/infrastructure/fuseki.ts';
import { contentSearchEligibilityDecisionIri, contentSearchEligibilityDigest,
  contentSearchEligibilityReceiptIri, type ContentSearchEligibilityInput }
  from '../src/modules/content-publication/eligibility.ts';
import { contentPublicationDecisionIri, contentPublicationReceiptIri }
  from '../src/modules/content-publication/publish.ts';
import { verifyQuarantinedContentIndex } from '../src/modules/content-publication/rebuild.ts';
import { DATASET, RV, type WorkActivationEnvironment } from '../src/modules/work/activate.ts';

const epoch = '11111111-1111-4111-8111-111111111111';
const generation = 'urn:rezics:text-index-generation:22222222-2222-4222-8222-222222222222';
const source = { owner: 'content' as const, dataEpoch: epoch, sequence: '3' };
const bind = (value: string, language?: string) => ({ type: language ? 'literal' : 'uri', value,
  ...(language ? { 'xml:lang': language } : {}) });
const literal = (value: string) => ({ type: 'literal', value });
const uri = (value: string) => ({ type: 'uri', value });

function uuid(n: number) {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

type OwnerRow = Record<string, { type: string; value: string }>;
type ContentRecord = { body: Record<string, string>; text: string; reference: ExactContentReference;
  revision: string; decision: string; eligibility: string; publicationAdmission: string;
  eligibilityAdmission: string; publicationReceipt: string; eligibilityReceipt: string;
  preparation: string; actor: string; eligibilityInput: ContentSearchEligibilityInput; unit: string };

function setField(row: OwnerRow, name: string, value: string | undefined, type: 'uri' | 'literal' = 'literal') {
  row[`${name}Count`] = literal(value === undefined ? '0' : '1');
  if (value !== undefined) row[name] = type === 'uri' ? uri(value) : literal(value);
}

function publicationOwnerRow(record: ContentRecord): OwnerRow {
  const row: OwnerRow = { publication: uri(record.decision), decisionTypeCount: literal('1'),
    anchorTypeCount: literal('1'), receiptCount: literal('1'), receipt: uri(record.publicationReceipt),
    receiptTypeCount: literal('1') };
  const fields: Array<[string, string | undefined, 'uri' | 'literal']> = [
    ['dComponent', record.reference.variantId, 'uri'], ['dResource', record.reference.resourceId, 'uri'],
    ['dRevision', record.revision, 'uri'], ['dDigest', record.reference.byteDigest, 'literal'],
    ['dOwnerEpoch', epoch, 'literal'], ['dOwnerSequence', '3', 'literal'],
    ['dDataEpoch', epoch, 'literal'], ['dSequence', '5', 'literal'],
    ['dModel', 'https://rezics.com/definition/content-publication-v1', 'uri'],
    ['dShape', 'https://rezics.com/definition/content-publication-v1', 'uri'],
    ['dDataset', DATASET, 'uri'], ['dPreparation', record.preparation, 'literal'],
    ['rOutcome', `${RV}Succeeded`, 'uri'], ['rReason', undefined, 'uri'],
    ['rRequestDigest', 'b'.repeat(64), 'literal'], ['rAdmissionId', record.publicationAdmission, 'literal'],
    ['rAuthorityEpoch', '2', 'literal'], ['rScope', `content:publish:${record.reference.variantId}`, 'literal'],
    ['rPreparation', record.preparation, 'literal'], ['rRevision', record.revision, 'uri'],
    ['rVariant', record.reference.variantId, 'uri'], ['rResource', record.reference.resourceId, 'uri'],
    ['rByteDigest', record.reference.byteDigest, 'literal'], ['rOwnerEpoch', epoch, 'literal'],
    ['rOwnerSequence', '3', 'literal'], ['rExpectedHead', 'urn:rezics:none', 'uri'],
    ['rDataset', DATASET, 'uri'], ['rDataEpoch', epoch, 'literal'], ['rSequence', '5', 'literal'],
    ['rDecision', record.decision, 'uri'],
  ];
  for (const [name, value, type] of fields) setField(row, name, value, type);
  return row;
}

function eligibilityOwnerRow(record: ContentRecord): OwnerRow {
  const row: OwnerRow = { eligibility: uri(record.eligibility), decisionTypeCount: literal('1'),
    anchorTypeCount: literal('1'), receiptCount: literal('1'), receipt: uri(record.eligibilityReceipt),
    receiptTypeCount: literal('1') };
  const fields: Array<[string, string | undefined, 'uri' | 'literal']> = [
    ['dComponent', record.reference.variantId, 'uri'], ['dVariant', record.reference.variantId, 'uri'],
    ['dResource', record.reference.resourceId, 'uri'], ['dPublication', record.decision, 'uri'],
    ['dRightsBasis', `${RV}OriginalContribution`, 'uri'], ['dAssessment', undefined, 'uri'],
    ['dDisclosure', `${RV}Public`, 'uri'], ['dAdmissionId', record.eligibilityAdmission, 'literal'],
    ['dAuthorityEpoch', '2', 'literal'],
    ['dScope', `content:search-eligibility:${record.reference.variantId}`, 'literal'],
    ['dActor', record.actor, 'uri'],
    ['dModel', 'https://rezics.com/definition/content-search-eligibility-v1', 'uri'],
    ['dShape', 'https://rezics.com/definition/content-search-eligibility-v1', 'uri'],
    ['dDataset', DATASET, 'uri'], ['dDataEpoch', epoch, 'literal'], ['dSequence', '6', 'literal'],
    ['rOutcome', `${RV}Succeeded`, 'uri'], ['rReason', undefined, 'uri'],
    ['rRequestDigest', contentSearchEligibilityDigest(record.eligibilityInput), 'literal'],
    ['rAdmissionId', record.eligibilityAdmission, 'literal'], ['rAuthorityEpoch', '2', 'literal'],
    ['rScope', `content:search-eligibility:${record.reference.variantId}`, 'literal'],
    ['rActor', record.actor, 'uri'], ['rResource', record.reference.resourceId, 'uri'],
    ['rVariant', record.reference.variantId, 'uri'], ['rPublication', record.decision, 'uri'],
    ['rExpectedHead', 'urn:rezics:none', 'uri'], ['rRightsBasis', `${RV}OriginalContribution`, 'uri'],
    ['rAssessment', undefined, 'uri'], ['rDisclosure', `${RV}Public`, 'uri'], ['rDataset', DATASET, 'uri'],
    ['rDataEpoch', epoch, 'literal'], ['rSequence', '6', 'literal'], ['rEligibility', record.eligibility, 'uri'],
  ];
  for (const [name, value, type] of fields) setField(row, name, value, type);
  return row;
}

test('SEARCH20 rebuild verifies each Content MatchUnit with its exact model recipe', async () => {
  const templates: Array<{ model: string; body: Record<string, string>; text: string }> = [
    { model: 'content-shape-v1', body: { body: 'single text Work source' }, text: 'single text Work source' },
    { model: 'rezics-prompt-v1', body: { content: 'Hub prompt source' }, text: 'Hub prompt source' },
    { model: 'rezics-skill-package-v1', body: { instructions: 'Hub skill source' },
      text: 'Hub skill source' },
  ];
  const records: ContentRecord[] = Array.from({ length: 9 }, (_, index) => templates[index % templates.length]!).map((item, index) => {
    const suffix = String(index + 1).repeat(36);
    const publicationAdmission = uuid(index + 1);
    const eligibilityAdmission = uuid(index + 101);
    const preparation = uuid(index + 201);
    const actor = 'https://rezics.com/id/99999999-9999-4999-8999-999999999999';
    const reference: ExactContentReference = { owner: 'content',
      resourceId: `https://rezics.com/id/${suffix}`, variantId: `urn:rezics:variant:${suffix}`,
      revisionId: suffix, format: 'rezics-content-json-v1', model: item.model,
      byteDigest: 'a'.repeat(64), byteLength: 10,
      language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr',
      sourceRevision: null, predecessor: null, provenance: {} };
    const revision = `urn:rezics:content:revision:${suffix}`;
    const decision = contentPublicationDecisionIri(publicationAdmission);
    const eligibility = contentSearchEligibilityDecisionIri(eligibilityAdmission);
    const eligibilityInput: ContentSearchEligibilityInput = { resourceId: reference.resourceId,
      variantId: reference.variantId, publicationDecision: decision, expectedEligibilityHead: null,
      actingSubject: actor, rightsBasis: 'original-contribution', disclosure: 'public' };
    return { ...item, reference, revision, decision, eligibility, publicationAdmission, eligibilityAdmission,
      publicationReceipt: contentPublicationReceiptIri(publicationAdmission),
      eligibilityReceipt: contentSearchEligibilityReceiptIri(eligibilityAdmission), preparation, actor, eligibilityInput,
      unit: `urn:rezics:content:match-unit:${suffix}` };
  });
  const heads = records.map(record => ({ variant: bind(record.reference.variantId),
    resource: bind(record.reference.resourceId), revision: bind(record.revision),
    digest: bind(record.reference.byteDigest), decision: bind(record.decision),
    eligibility: bind(record.eligibility) }));
  const rdf = () => records.map(record => ({ unit: bind(record.unit), body: bind(record.text, 'en'),
    resource: bind(record.reference.resourceId),
    variant: bind(record.reference.variantId), revision: bind(record.revision),
    decision: bind(record.decision), eligibility: bind(record.eligibility) }));
  const env = { lineage: { dataEpoch: epoch, routingEpoch: epoch }, fuseki: {
    async query(sparql: string): Promise<SparqlResult> {
      if (sparql.includes('ASK { GRAPH <urn:rezics:search:public>')) return { boolean: false };
      if (sparql.includes('ASK { GRAPH <urn:rezics:graph:receipts>')) return { boolean: true };
      if (sparql.includes('SELECT ?epoch ?routing')) return { results: { bindings: [{
        epoch: bind(epoch), routing: bind(epoch), sequence: bind('9'), generation: bind(generation) }] } };
      if (sparql.includes('(COUNT(DISTINCT ?resource) AS ?resourceCount)')) {
        return { results: { bindings: records.map(record => ({
          variant: uri(record.reference.variantId), resourceCount: literal('1'),
          resource: uri(record.reference.resourceId), publicationCount: literal('1'),
          publication: uri(record.decision), eligibilityCount: literal('1'), eligibility: uri(record.eligibility),
        })) } };
      }
      if (sparql.includes('SELECT ?eligibility') && sparql.includes('?decisionTypeCount')) {
        return { results: { bindings: records.map(eligibilityOwnerRow) } };
      }
      if (sparql.includes('SELECT ?publication') && sparql.includes('?decisionTypeCount')) {
        return { results: { bindings: records.map(publicationOwnerRow) } };
      }
      if (sparql.includes('SELECT ?variant WHERE')) return { results: { bindings: records.map(record => ({
        variant: bind(record.reference.variantId) })) } };
      if (sparql.includes('SELECT ?variant ?resource')) return { results: { bindings: heads } };
      if (sparql.includes('SELECT ?unit ?body')) return { results: { bindings: rdf() } };
      if (sparql.includes('publicTextInventory()')) return { results: { bindings: [{ population: bind(String(records.length)) }] } };
      if (sparql.includes('ASK { GRAPH <urn:rezics:search:probe>')) return { boolean: true };
      throw new Error(`unexpected rebuild query: ${sparql}`);
    },
  } } as unknown as WorkActivationEnvironment;
  const content = { ownerPosition: async () => source,
    readExactBatch: async (ids: string[]) => {
      expect(ids.length).toBeLessThanOrEqual(4);
      return ids.map(id => {
        const record = records.find(item => item.reference.revisionId === id)!;
        return { revisionId: id, status: 'available' as const, reference: record.reference,
          body: record.body, serializedJson: JSON.stringify(record.body) };
      });
    } } as unknown as ContentCore;
  const cursor = { read: async () => source } as unknown as ContentProjectionCursor;
  const job = { id: '33333333-3333-4333-8333-333333333333', cut: source, consumer: 'fixture' };
  expect((await verifyQuarantinedContentIndex(env, content, cursor, job)).contentUnitCount).toBe(records.length);
  records[1]!.text = 'wrong prompt text';
  await expect(verifyQuarantinedContentIndex(env, content, cursor, job))
    .rejects.toThrow('Content MatchUnit differs from exact approved source');
});
