import { expect, test } from 'bun:test';
import { bundledRelease } from '../src/bundled.ts';

const locales = ['de', 'en', 'es', 'fr', 'ja', 'ko', 'zh-Hans', 'zh-Hant'];
const propertyId = 'rezics:stylisticallyComparableTo';
const inverseId = 'rezics:comparedWork';
const { types, properties } = bundledRelease;

function isOrInherits(type: string, base: string): boolean {
  return type === base || (types[type]?.bases.includes(base) ?? false);
}

test('comparative Works are one directed association over only the Book and VideoGame Work union', () => {
  const property = properties[propertyId]!;
  expect(property).toMatchObject({
    datatype: 'wikibase-item',
    multivalued: true,
    relation: { inverse: inverseId, group: 'association', order: 'name' },
  });
  expect(property.relation?.symmetric).toBeUndefined();
  expect(property.relation?.acyclic).toBeUndefined();
  expect(properties[inverseId]).toBeUndefined();

  const workTypes = Object.keys(types).filter(
    (type) => isOrInherits(type, 'schema:Book') || isOrInherits(type, 'schema:VideoGame'),
  );
  expect(property.targets).toEqual(['schema:Book', 'schema:VideoGame']);
  expect(workTypes).toContain('wd:Q689445');
  for (const [typeId, type] of Object.entries(types)) {
    const admitted = workTypes.includes(typeId);
    expect(type.properties.includes(propertyId), `${typeId} slot`).toBe(admitted);
    expect(type.facets.includes(propertyId), `${typeId} facet`).toBe(admitted);
    expect(type.properties).not.toContain(inverseId);
  }

  for (const type of ['schema:CreativeWork', 'bf:Instance', 'wd:Q20631656', 'skos:Concept']) {
    expect(types[type]?.properties).not.toContain(propertyId);
    expect(types[type]?.facets).not.toContain(propertyId);
  }
  expect(types['schema:VideoGame']?.properties).toContain('wdt:P179');
  expect(types['schema:VideoGame']?.facets).toContain('wdt:P179');
  expect(types['schema:VideoGame']?.facets).toHaveLength(17);
});

test('both relation directions carry released labels in every bundled locale', () => {
  const property = properties[propertyId]!;
  expect(Object.keys(property.labels).sort()).toEqual(locales);
  expect(Object.keys(property.relation?.inverseLabels ?? {}).sort()).toEqual(locales);
  for (const label of Object.values(property.labels)) expect(label.trim()).not.toBe('');
  for (const label of Object.values(property.relation?.inverseLabels ?? {})) expect(label.trim()).not.toBe('');
});
