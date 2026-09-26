import { expect, test } from 'bun:test';
import type { OpenLibraryConversion } from '../../services/main/src/modules/source/open-library-conversion.ts';
import type { StagedSourceObservation } from '../../services/main/src/modules/source/intake.ts';
import { sourceFieldClaims, sourceReificationBounds, sourceStatementTriples }
  from '../../services/main/src/modules/source/reification.ts';
import { sourceReificationProfile } from '../definitions/source-reification-v1.ts';

const conversion = (description: string | null) => ({
  profile: 'open-library-work-source-conversion-v1', state: 'staged',
  conversion: 'https://rezics.com/id/00000000-0000-4000-8000-000000000001',
  observation: 'https://rezics.com/id/00000000-0000-4000-8000-000000000002',
  mappingRevision: 'open-library-work-map-v1', sourceDigest: 'a'.repeat(64),
  projection: { sourceKey: '/works/OL1W', title: 'Exact title', description,
    authorRefs: null, subjects: null }, fieldInventory: [], createdAt: '2026-09-27T00:00:00.000Z',
} as OpenLibraryConversion);
const observation = { observation: 'https://rezics.com/id/00000000-0000-4000-8000-000000000002' } as unknown as StagedSourceObservation;

test('MODEL09: reified source claims use stable IDs, exact provenance and no native acceptance predicates', () => {
  const value = conversion('Exact description');
  const claims = sourceFieldClaims(value, observation);
  expect(claims.map(item => item.field)).toEqual(['title', 'description']);
  expect(sourceFieldClaims(value, observation)).toEqual(claims);
  const triples = sourceStatementTriples(value, observation);
  expect(triples).toContain('a rdf:Statement');
  expect(triples).toContain('prov:wasDerivedFrom');
  expect(triples).toContain('"structured-source-only"');
  expect(triples).not.toContain('https://schema.org/name');
  expect(triples).not.toContain('https://rezics.com/vocab/accepted');
  expect(sourceReificationBounds.maximumStatementsPerConversion).toBe(2);
  expect(sourceReificationBounds.maximumGeneratedTriples).toBe(24);
  const shape = sourceReificationProfile.shapes[0]!;
  const properties = new Map(shape.properties.map(property => [property.path, property]));
  expect(properties.get('rdf:subject')?.class).toBe('rv:SourceConversion');
  expect(properties.get('prov:wasDerivedFrom')?.class).toBe('rv:SourceObservation');
  expect(properties.get('rv:fieldDisposition')?.hasValue).toBe('"structured-source-only"');
});

test('MODEL09: missing source description produces only the observed title Statement', () => {
  const claims = sourceFieldClaims(conversion(null), observation);
  expect(claims.map(item => item.field)).toEqual(['title']);
});
