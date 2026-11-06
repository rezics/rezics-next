import { expect, test } from 'bun:test';
import { readCreditIndexSnapshot } from '../../src/search/credit-index.ts';
import { creditSearchFields } from '../../src/search/credit-search-document.ts';
import type { CreditSearchEntry, CreditSearchProjection } from '../../src/search/credit-search.ts';
import { discoverySubjectActions, documentActions } from '../../src/search/document.ts';
import {
  mixedCreditDiscoveryIndexDefinition,
  mixedDiscoveryDocumentCodec,
} from '../../src/search/discovery-documents.ts';
import { readSubjectCreditMappingFormatForIndex, subjectIndexDefinition } from '../../src/search/indices.ts';
import type { OpenSearch } from '../../src/search/opensearch.ts';
import {
  subjectPartition,
  type IndexedSubject,
  type SubjectSnapshot,
  type SubjectSource,
} from '../../src/search/source.ts';

const work = '018f0000-0000-7000-8000-00a000000001';
const person = '018f0000-0000-7000-8000-00a000000002';
const entry: CreditSearchEntry = {
  witness: {
    workId: work,
    statementId: 'statement-1',
    targetId: person,
    direction: 'outgoing',
    revision: 2,
    release: 'release-1',
    property: 'wdt:P725',
    qualifiers: [{ property: 'wdt:P3831', value: '0196a000-0000-7000-8000-000000000001' }],
    nameRevision: 'name-1',
  },
  names: [{ language: 'en', value: 'Ada Writer' }],
  namesComplete: true,
};
const complete: CreditSearchProjection = {
  state: 'complete',
  workId: work,
  observation: 'cut-1',
  names: [{ ...entry.witness, name: { language: 'en', value: 'Ada Writer' } }],
};

test('only a complete projection publishes names; every other state is an explicit incomplete cut', () => {
  expect(creditSearchFields(complete)).toEqual({
    credit_search_complete: true,
    credited_names: [
      {
        workId: work,
        statementId: 'statement-1',
        revision: 2,
        release: 'release-1',
        property: 'wdt:P725',
        targetId: person,
        direction: 'outgoing',
        nameRevision: 'name-1',
        qualifiers: [{ property: 'wdt:P3831', value: '0196a000-0000-7000-8000-000000000001' }],
        name: { language: 'en', value: 'Ada Writer' },
      },
    ],
  });
  for (const state of ['preparing', 'unsupported', 'unavailable', 'incomplete', 'restart'] as const)
    expect(creditSearchFields({ state })).toEqual({ credit_search_complete: false, credited_names: [] });
  expect(creditSearchFields(undefined)).toEqual({ credit_search_complete: false, credited_names: [] });
});

test('credit fields are written only for credit-successor generations and never change legacy documents', () => {
  const id = work;
  const subject: IndexedSubject = {
    id,
    type: 'schema:CreativeWork',
    visibility: 'visible',
    redirect: null,
    securityRevision: 1,
    labels: [{ language: 'en', value: 'Work' }],
    aliases: [],
    descriptions: [],
    statements: [],
  };
  const snapshot: SubjectSnapshot = {
    partition: subjectPartition(id),
    position: 7n,
    subjects: [subject],
    creditSearch: new Map([[id, complete]]),
  };
  const legacy = documentActions(snapshot, [id])[0]!;
  expect(legacy.op === 'index' && 'credited_names' in legacy.document).toBe(false);
  const successor = documentActions(snapshot, [id], undefined, undefined, 1)[0]!;
  expect(successor.op === 'index' && successor.document).toMatchObject({
    credit_search_complete: true,
    credited_names: [{ targetId: person, name: { value: 'Ada Writer' } }],
  });
  const family = discoverySubjectActions(snapshot, [id], undefined, undefined, 1)[0]!;
  expect(family.op === 'index' && family.document).toMatchObject({
    family: 'subject',
    credit_search_complete: true,
    credited_names: [{ targetId: person }],
  });
});

test('the discovery successor is its own codec and index-only reads attach one projection per visible Subject', async () => {
  const definition = mixedCreditDiscoveryIndexDefinition();
  expect(mixedDiscoveryDocumentCodec(definition.mappings)).toBe('mixed-credit-v1');
  expect(definition.mappings._meta.discovery_document_format).toBe(4);
  expect(definition.mappings.properties).toMatchObject({
    credit_search_complete: { type: 'boolean' },
    credited_names: { type: 'nested' },
  });
  const visible: IndexedSubject = { ...subject(work), statements: [] };
  const hidden: IndexedSubject = { ...subject(person), visibility: 'hidden', statements: [] };
  const source = {
    read: async (partition: number): Promise<SubjectSnapshot> => ({
      partition,
      position: 9n,
      subjects: [visible, hidden],
    }),
    creditSearch: {
      page: async () => ({ state: 'unsupported' as const }),
      current: async () => true as const,
      unchanged: async () => true,
    },
  } as unknown as SubjectSource;
  const snapshot = await readCreditIndexSnapshot(source, subjectPartition(work), [work, person]);
  expect([...snapshot.creditSearch!.keys()]).toEqual([work]);
  expect(snapshot.creditSearch!.get(work)).toEqual({ state: 'unsupported' });
});

test('credit writer selection follows the immutable physical mapping and leaves legacy generations unchanged', async () => {
  const index = 'credit-test-subjects-g4';
  let mapping: unknown = mixedCreditDiscoveryIndexDefinition().mappings;
  const search = {
    request: async (method: string, path: string) => {
      expect(method).toBe('GET');
      expect(path).toBe(`/${index}/_mapping`);
      return { status: 200, body: { [index]: { mappings: mapping } } };
    },
  } as unknown as OpenSearch;
  expect(await readSubjectCreditMappingFormatForIndex(search, index)).toBe(1);
  mapping = subjectIndexDefinition().mappings;
  expect(await readSubjectCreditMappingFormatForIndex(search, index)).toBeNull();
});

function subject(id: string): IndexedSubject {
  return {
    id,
    type: 'schema:CreativeWork',
    visibility: 'visible',
    redirect: null,
    securityRevision: 1,
    labels: [{ language: 'en', value: 'Subject' }],
    aliases: [],
    descriptions: [],
    statements: [],
  };
}
