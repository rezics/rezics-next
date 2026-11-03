import { expect, test } from 'bun:test';
import {
  MIXED_CALENDAR_DISCOVERY_DOCUMENT_FORMAT,
  MIXED_DISCOVERY_DOCUMENT_FORMAT,
  type DiscoveryRegistry,
} from '../../src/search/discovery.ts';
import {
  discoveryDocumentActions,
  mixedCalendarDiscoveryIndexDefinition,
  mixedDiscoveryIndexDefinition,
  validateDiscoveryDocument,
} from '../../src/search/discovery-documents.ts';
import { documentActions } from '../../src/search/document.ts';
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

test('mixed calendar successor preserves precise facts and leaves old mapping and codec intact', () => {
  const [oldMixed] = discoveryDocumentActions(registry, { owner: 'semantic', snapshot }, [key], undefined, 'mixed-public-v1');
  const [calendar] = discoveryDocumentActions(
    registry,
    { owner: 'semantic', snapshot },
    [key],
    undefined,
    'mixed-calendar-v1',
  );
  const [expected] = documentActions(snapshot, [id], undefined, 1);
  if (
    oldMixed?.op !== 'index' ||
    oldMixed.document.owner !== 'semantic' ||
    calendar?.op !== 'index' ||
    calendar.document.owner !== 'semantic' ||
    expected?.op !== 'index'
  )
    throw new Error('Expected mixed Subject projections');

  expect(oldMixed.document.document_format).toBe(MIXED_DISCOVERY_DOCUMENT_FORMAT);
  expect(oldMixed.document.facts).toEqual([{ property: 'schema:datePublished', year: 2024, qualifiers: [] }]);
  expect(calendar.document.document_format).toBe(MIXED_CALENDAR_DISCOVERY_DOCUMENT_FORMAT);
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

  const oldMapping = mixedDiscoveryIndexDefinition();
  const nextMapping = mixedCalendarDiscoveryIndexDefinition();
  expect(oldMapping.mappings._meta.discovery_document_format).toBe(MIXED_DISCOVERY_DOCUMENT_FORMAT);
  expect(nextMapping.mappings._meta.discovery_document_format).toBe(MIXED_CALENDAR_DISCOVERY_DOCUMENT_FORMAT);
  expect(oldMapping.mappings.properties.facts!.properties).not.toHaveProperty('time_lower');
  expect(nextMapping.mappings.properties.facts!.properties).toHaveProperty('time_lower', { type: 'keyword' });
});
