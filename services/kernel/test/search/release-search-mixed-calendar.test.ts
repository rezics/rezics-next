import { expect, test } from 'bun:test';
import { DISCOVERY_DOCUMENT_FORMAT, type DiscoveryRegistry } from '../../src/search/discovery.ts';
import {
  discoveryDocumentActions,
  discoveryIndexDefinition,
  hasDiscoveryDocumentFormat,
  validateDiscoveryDocument,
} from '../../src/search/discovery-documents.ts';
import { documentActions } from '../../src/search/document.ts';
import { createDiscoveryIndex, requireDiscoveryIndexFormat } from '../../src/search/indices.ts';
import { subjectPartition, type IndexedSubject } from '../../src/search/source.ts';
import { routeOf } from '../../src/route/route.ts';

const id = '018f0000-0000-7000-8000-000000000001';
const kind = 'schema:Person';
const subject: IndexedSubject = {
  id,
  type: kind,
  visibility: 'visible',
  redirect: null,
  securityRevision: 1,
  labels: [{ language: 'en', value: 'Release date' }],
  aliases: [],
  descriptions: [],
  statements: [
    {
      property: 'schema:datePublished',
      value: '+2024-02-29T00:00:00Z',
      facet: { kind: 'time', year: 2024, month: 2, day: 29 },
    },
  ],
};
const registry = {
  entries: [{ owner: 'semantic', kind }],
  key: (value: unknown) => value,
} as unknown as DiscoveryRegistry;
const partition = subjectPartition(id);
const route = routeOf(id)!;
const snapshot = { partition, position: 1n, subjects: [subject] };
const key = { owner: 'semantic' as const, kind, id, route };

test('canonical discovery retains precise calendar facts and rejects a damaged interval', () => {
  const [calendar] = discoveryDocumentActions(registry, { owner: 'semantic', snapshot }, [key]);
  const [expected] = documentActions(snapshot, [id]);
  if (calendar?.op !== 'index' || calendar.document.owner !== 'semantic' || expected?.op !== 'index')
    throw new Error('Expected canonical Subject projections');
  expect(calendar.document.document_format).toBe(DISCOVERY_DOCUMENT_FORMAT);
  expect(calendar.document.facts).toEqual(expected.document.facts);
  expect(calendar.document.facts[0]).toMatchObject({ year: 2024, month: 2, day: 29 });
  expect(calendar.document.facts[0]).toHaveProperty('time_lower');
  expect(calendar.document.facts[0]).toHaveProperty('time_upper');
  validateDiscoveryDocument(registry, calendar.document);
  const damaged = structuredClone(calendar.document);
  const fact = damaged.facts[0];
  if (!fact || !('time_lower' in fact)) throw new Error('Expected an interval-backed date fact');
  fact.time_lower = 'invalid';
  expect(() => validateDiscoveryDocument(registry, damaged)).toThrow('Invalid Subject discovery fact value');
  const mapping = discoveryIndexDefinition();
  expect(mapping.mappings._meta.discovery_document_format).toBe(1);
  expect(mapping.mappings.properties.facts!.properties).toHaveProperty('time_lower', { type: 'keyword' });
  expect(hasDiscoveryDocumentFormat(mapping.mappings)).toBe(true);
  const incomplete = structuredClone(mapping.mappings);
  delete incomplete.properties.credited_names;
  expect(hasDiscoveryDocumentFormat(incomplete)).toBe(false);
});

test('new physical discovery generations allocate one complete canonical mapping', async () => {
  let definition: unknown;
  const index = 'test-discovery-g2';
  const search = {
    async request(method: string, _path: string, body?: unknown) {
      if (method === 'PUT') {
        definition = body;
        return { status: 200, body: { acknowledged: true } };
      }
      return { status: 200, body: { [index]: { mappings: (definition as { mappings: unknown }).mappings } } };
    },
  };
  await createDiscoveryIndex(search as never, 'test-', 2, 'incarnation-2');
  if (!definition || typeof definition !== 'object' || !('mappings' in definition))
    throw new Error('Expected a versioned mixed mapping');
  expect(hasDiscoveryDocumentFormat(definition.mappings)).toBe(true);
  await expect(requireDiscoveryIndexFormat(search as never, index)).resolves.toBeUndefined();
});
