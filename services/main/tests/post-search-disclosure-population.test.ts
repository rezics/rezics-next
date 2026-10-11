import { expect, test } from 'bun:test';
import type { ContentCore } from '../../content/src/core.ts';
import type { ContentProjectionCursor } from '../../content/src/projection-cursor.ts';
import { FusekiClient } from '../src/infrastructure/fuseki.ts';
import { configureDisclosure } from '../src/modules/disclosure/read.ts';
import { searchGraphSnapshot } from '../src/modules/search/snapshot-state.ts';
import { contentSearchEligibilityDecisionIri, contentSearchEligibilityDigest,
  contentSearchEligibilityReceiptIri } from '../src/modules/content-publication/eligibility.ts';
import { contentPublicationDecisionIri, contentPublicationReceiptIri }
  from '../src/modules/content-publication/publish.ts';
import { DATASET, RV, type WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import { queryPublicMainPhrase } from '../src/modules/work/search-public.ts';
import type { PublicTextPosition } from '../src/modules/work/search-readiness.ts';
import { pageCompletePublicRelation } from '../src/modules/work/search-continuation.ts';
import { profileRegistry } from '../../../packages/model/src/generated/profiles.ts';

const id = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const term = (value: string, type = 'literal') => ({ type, value });
const lineage = { dataEpoch: 'graph-epoch', routingEpoch: 'routing' };
const instance = '11111111-1111-4111-8111-111111111111';
const source = { owner: 'content' as const, dataEpoch: 'content-epoch', sequence: '1' };
type ProofRow = Record<string, { type: string; value: string }>;

function uuid(n: number) {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

function setProofField(row: ProofRow, name: string, value: string | undefined, type = 'literal') {
  row[`${name}Count`] = term(value === undefined ? '0' : '1');
  if (value !== undefined) row[name] = term(value, type);
}

function ownerRecords(unit: number) {
  const variant = `urn:rezics:variant:${uuid(8_000 + unit)}`;
  const resource = id(unit + 1_000);
  const revision = `urn:rezics:content:revision:${uuid(9_000 + unit)}`;
  const publicationAdmission = uuid(10_000 + unit);
  const eligibilityAdmission = uuid(11_000 + unit);
  const publication = contentPublicationDecisionIri(publicationAdmission);
  const eligibility = contentSearchEligibilityDecisionIri(eligibilityAdmission);
  const actor = id(99_000);
  const eligibilityInput = { resourceId: resource, variantId: variant,
    publicationDecision: publication, expectedEligibilityHead: null, actingSubject: actor,
    rightsBasis: 'original-contribution' as const, disclosure: 'public' as const };
  const publicationRow: ProofRow = { publication: term(publication, 'uri'),
    decisionTypeCount: term('1'), anchorTypeCount: term('1'), receiptCount: term('1'),
    receipt: term(contentPublicationReceiptIri(publicationAdmission), 'uri'), receiptTypeCount: term('1') };
  const publicationFields: Array<[string, string | undefined, string]> = [
    ['dComponent', variant, 'uri'], ['dResource', resource, 'uri'], ['dRevision', revision, 'uri'],
    ['dDigest', 'd'.repeat(64), 'literal'], ['dOwnerEpoch', source.dataEpoch, 'literal'],
    ['dOwnerSequence', source.sequence, 'literal'], ['dDataEpoch', lineage.dataEpoch, 'literal'],
    ['dSequence', '10', 'literal'],
    ['dModel', 'https://rezics.com/definition/content-publication-v1', 'uri'],
    ['dShape', 'https://rezics.com/definition/content-publication-v1', 'uri'],
    ['dDataset', DATASET, 'uri'], ['dPreparation', uuid(12_000 + unit), 'literal'],
    ['rOutcome', `${RV}Succeeded`, 'uri'], ['rReason', undefined, 'uri'],
    ['rRequestDigest', 'a'.repeat(64), 'literal'], ['rAdmissionId', publicationAdmission, 'literal'],
    ['rAuthorityEpoch', '2', 'literal'], ['rScope', `content:publish:${variant}`, 'literal'],
    ['rPreparation', uuid(12_000 + unit), 'literal'], ['rRevision', revision, 'uri'],
    ['rVariant', variant, 'uri'], ['rResource', resource, 'uri'], ['rByteDigest', 'd'.repeat(64), 'literal'],
    ['rOwnerEpoch', source.dataEpoch, 'literal'], ['rOwnerSequence', source.sequence, 'literal'],
    ['rExpectedHead', 'urn:rezics:none', 'uri'], ['rDataset', DATASET, 'uri'],
    ['rDataEpoch', lineage.dataEpoch, 'literal'], ['rSequence', '10', 'literal'],
    ['rDecision', publication, 'uri'],
  ];
  for (const [name, value, type] of publicationFields) setProofField(publicationRow, name, value, type);

  const eligibilityRow: ProofRow = { eligibility: term(eligibility, 'uri'),
    decisionTypeCount: term('1'), anchorTypeCount: term('1'), receiptCount: term('1'),
    receipt: term(contentSearchEligibilityReceiptIri(eligibilityAdmission), 'uri'), receiptTypeCount: term('1') };
  const eligibilityFields: Array<[string, string | undefined, string]> = [
    ['dComponent', variant, 'uri'], ['dVariant', variant, 'uri'], ['dResource', resource, 'uri'],
    ['dPublication', publication, 'uri'], ['dRightsBasis', `${RV}OriginalContribution`, 'uri'],
    ['dAssessment', undefined, 'uri'], ['dDisclosure', `${RV}Public`, 'uri'],
    ['dAdmissionId', eligibilityAdmission, 'literal'], ['dAuthorityEpoch', '2', 'literal'],
    ['dScope', `content:search-eligibility:${variant}`, 'literal'], ['dActor', actor, 'uri'],
    ['dModel', 'https://rezics.com/definition/content-search-eligibility-v1', 'uri'],
    ['dShape', 'https://rezics.com/definition/content-search-eligibility-v1', 'uri'],
    ['dDataset', DATASET, 'uri'], ['dDataEpoch', lineage.dataEpoch, 'literal'], ['dSequence', '11', 'literal'],
    ['rOutcome', `${RV}Succeeded`, 'uri'], ['rReason', undefined, 'uri'],
    ['rRequestDigest', contentSearchEligibilityDigest(eligibilityInput), 'literal'],
    ['rAdmissionId', eligibilityAdmission, 'literal'], ['rAuthorityEpoch', '2', 'literal'],
    ['rScope', `content:search-eligibility:${variant}`, 'literal'], ['rActor', actor, 'uri'],
    ['rResource', resource, 'uri'], ['rVariant', variant, 'uri'], ['rPublication', publication, 'uri'],
    ['rExpectedHead', 'urn:rezics:none', 'uri'], ['rRightsBasis', `${RV}OriginalContribution`, 'uri'],
    ['rAssessment', undefined, 'uri'], ['rDisclosure', `${RV}Public`, 'uri'], ['rDataset', DATASET, 'uri'],
    ['rDataEpoch', lineage.dataEpoch, 'literal'], ['rSequence', '11', 'literal'],
    ['rEligibility', eligibility, 'uri'],
  ];
  for (const [name, value, type] of eligibilityFields) setProofField(eligibilityRow, name, value, type);
  return { variant, resource, revision, publication, eligibility, publicationRow, eligibilityRow };
}

function fixture(placements: readonly { unit: number; book: number }[], unrelatedUnits = 0) {
  const unitCount = new Set(placements.map(row => row.unit)).size;
  const records = [...new Set(placements.map(row => row.unit))].map(ownerRecords);
  const byPublication = new Map(records.map(record => [record.publication, record.publicationRow]));
  const byEligibility = new Map(records.map(record => [record.eligibility, record.eligibilityRow]));
  const position: PublicTextPosition = { ...lineage, sequence: '1', population: unitCount + unrelatedUnits,
    generation: `urn:rezics:text-index-generation:${instance}`, serverInstanceId: instance, publicSearchWriteEpoch: '0' };
  const queries: string[] = [], hidden = new Set<string>();
  const graph = new FusekiClient('http://graph.invalid');
  graph.commandHealth = async () => ({ instanceId: instance, moduleVersion: 'test',
    profiles: Object.fromEntries(Object.entries(profileRegistry).map(([profileId, profile]) => [profileId, profile.sha256])),
    publicSearchWriteEpoch: '0', publicSearchWriteActive: false });
  graph.query = async query => {
    queries.push(query);
    if (query.includes('SELECT ?epoch ?routing ?sequence')) return { results: { bindings: [{
      epoch: term(lineage.dataEpoch), routing: term(lineage.routingEpoch), sequence: term('20'),
    }] } };
    if (query.includes('SELECT ?variant')) return { results: { bindings: records.map(record => ({
      variant: term(record.variant, 'uri'), resourceCount: term('1'), resource: term(record.resource, 'uri'),
      publicationCount: term('1'), publication: term(record.publication, 'uri'),
      eligibilityCount: term('1'), eligibility: term(record.eligibility, 'uri'),
    })) } };
    if (query.includes('SELECT ?eligibility')) {
      const ids = [...query.matchAll(/<([^>]+)>/gu)].map(match => match[1]!);
      return { results: { bindings: ids.flatMap(id => byEligibility.has(id) ? [byEligibility.get(id)!] : []) } };
    }
    if (query.includes('SELECT ?publication')) {
      const ids = [...query.matchAll(/<([^>]+)>/gu)].map(match => match[1]!);
      return { results: { bindings: ids.flatMap(id => byPublication.has(id) ? [byPublication.get(id)!] : []) } };
    }
    if (query.includes('SELECT ?epoch ?sequence ?generation ?declared')) return { results: { bindings: [{
      epoch: term(position.dataEpoch), sequence: term('20'), generation: term(position.generation),
      declared: term(String(records.length)), heads: term(String(records.length)), missing: term('0'),
      eligible: term(String(unitCount)), contentUnits: term(String(unitCount)),
    }] } };
    if (query.includes('SELECT ?candidateCount')) return { results: { bindings: placements.map(({ unit, book }) => {
      const record = records.find(item => item.resource === id(unit + 1000))!;
      return {
      epoch: term(position.dataEpoch), sequence: term('20'), indexGeneration: term(position.generation),
      candidateCount: term(String(unitCount)),
      unit: term(`urn:rezics:content:match-unit:${String(unit).padStart(64, '0')}`), score: term('1'),
      work: term(id(unit + 1000)), main: term(id(book + 2000)), contribution: term(id(unit + 1000)),
      revision: term(record.revision, 'uri'), selection: term(record.publication, 'uri'),
      language: term('en'), resultWork: term(id(book)), resultMain: term(id(book + 2000)), chapterTitle: term('Chapter'),
      contentProjection: term(`urn:rezics:projection:${unit}`), rightsBasis: term(`${RV}OriginalContribution`),
      variant: term(record.variant, 'uri'), contentDecision: term(record.publication, 'uri'),
      contentEligibility: term(record.eligibility, 'uri'),
    };
    }) } };
    if (query.includes('SELECT ?work ?head')) {
      const values = /VALUES \?work \{([^}]+)\}/u.exec(query)![1]!;
      const refs = [...values.matchAll(/<([^>]+)>/gu)].map(match => match[1]!);
      return { results: { bindings: refs.map(work => ({ work: term(work), head: term(id(10000)),
        ...(query.includes('?owningWork') && placements.some(row => id(row.book) === work)
          ? { owningWork: term(work), owningHead: term(id(10000)) } : {}),
      })) } };
    }
    throw new Error(`Unexpected population read: ${query.slice(0, 100)}`);
  };
  const env = { fuseki: graph, lineage, objectDirectory: '.temp/unused' } as WorkActivationEnvironment;
  configureDisclosure(env, { read: async targets => targets.map(target =>
    hidden.has(target.resource) || target.work && hidden.has(target.work) ? 'hidden' : 'visible') });
  const content = { ownerPosition: async () => source } as ContentCore;
  const cursor = { read: async () => source } as unknown as ContentProjectionCursor;
  const read = () => searchGraphSnapshot.run({ clients: new Set([graph]), lineage, position }, () =>
    queryPublicMainPhrase(env, { phrase: 'chapter', language: 'en', contentProjection: { content, cursor, consumer: 'search' } }));
  return { read, hidden, queries };
}

test('A reused Post expands the source census to disclosed Book mains before pagination', async () => {
  const run = fixture([{ unit: 1, book: 1 }, { unit: 1, book: 2 }]);
  expect(await run.read()).toMatchObject({ population: 2, total: 2 });
  run.hidden.add(id(1));
  expect(await run.read()).toMatchObject({ population: 1, total: 1, results: [{ work: id(2) }] });
  run.hidden.add(id(2));
  expect(await run.read()).toMatchObject({ population: 1, total: 0, results: [] });
  run.hidden.clear();
  const relation = await run.read();
  expect(relation).toMatchObject({ population: 2, total: 2 });
  const request = { profile: 'public-main-phrase-page-v1' as const, phrase: 'chapter', language: 'en', pageSize: 1 };
  const first = pageCompletePublicRelation(request, relation);
  expect(first.results).toHaveLength(1);
  expect(first.next).not.toBeNull();
  const second = pageCompletePublicRelation({ ...request, continuation: first.next! }, relation);
  expect(second.results).toHaveLength(1);
  expect(second.results[0]!.work).not.toBe(first.results[0]!.work);
  expect(second.next).toBeNull();
});

test('Several matching chapter units count their Book once while retaining the unrelated census', async () => {
  const run = fixture([{ unit: 1, book: 1 }, { unit: 2, book: 1 }], 7);
  expect(await run.read()).toMatchObject({ population: 8, total: 1 });
});

test('Maximum Book fanout uses only the bounded match and disclosure reads', async () => {
  const run = fixture(Array.from({ length: 512 }, (_, index) => ({ unit: 1, book: index + 1 })));
  expect(await run.read()).toMatchObject({ population: 512, total: 512 });
  expect(run.queries.length).toBeLessThanOrEqual(20);
});
