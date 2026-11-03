import { expect, test } from 'bun:test';
import type { PropertyDefinition, Release } from '@rezics/definitions';
import definitions from '../src/kernel/recorded/definitions-release.json';
import {
  genericCreateDescriptor,
  genericCreateFact,
  genericCreatePropertySupported,
  genericCreateSpecializedPath,
  prepareGenericCreate,
  type GenericCreateDescriptor,
} from '../src/features/catalogue/generic-create-facts';

const release = definitions.release as Release;

function descriptor(id: string): GenericCreateDescriptor {
  const definition = release.types[id]!;
  const propertyIds = new Set(definition.properties);
  for (const property of definition.properties)
    for (const qualifier of release.properties[property]?.qualifiers ?? []) propertyIds.add(qualifier);
  return {
    id,
    label: Object.values(definition.labels ?? {})[0] ?? id,
    description: '',
    releaseDigest: definitions.digest,
    definition,
    propertyDefinitions: Object.fromEntries(
      [...propertyIds].flatMap((property) =>
        release.properties[property] ? [[property, release.properties[property] as PropertyDefinition]] : [],
      ),
    ),
  };
}

const terms = [{ language: 'en', label: 'A food subject', description: '', aliases: '' }];

test('the actual released Food descriptor prepares complete scalar evidence and omits unsupported datatypes', () => {
  const food = descriptor('wd:Q2095');
  expect(food.definition.properties).toContain('schema:url');
  expect(food.definition.properties).toContain('schema:name');
  expect(food.definition.properties).toContain('schema:image');
  expect(genericCreateDescriptor(food)).toEqual(food);

  const website = genericCreateFact(food, 'schema:url', 'website')!;
  website.statement.value = { type: 'value', content: 'https://food.example/item' };
  website.statement.references[0]!.parts[0]!.value = {
    type: 'value',
    content: 'https://food.example/source',
  };
  const name = genericCreateFact(food, 'schema:name', 'name')!;
  name.statement.value = { type: 'value', content: { text: 'Meal name', language: 'en' } };
  name.statement.references[0]!.parts[0]!.value = {
    type: 'value',
    content: 'https://food.example/name-source',
  };

  const prepared = prepareGenericCreate(food.id, terms, [website, name], food);
  expect(prepared.errors).toEqual([]);
  expect(prepared.item.statements).toEqual({
    'schema:url': [
      expect.objectContaining({
        value: { type: 'value', content: 'https://food.example/item' },
        rank: 'normal',
        references: [
          { parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: 'https://food.example/source' } }] },
        ],
      }),
    ],
    'schema:name': [
      expect.objectContaining({
        value: { type: 'value', content: { text: 'Meal name', language: 'en' } },
        references: [
          { parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: 'https://food.example/name-source' } }] },
        ],
      }),
    ],
  });

  const unsupported = genericCreateFact(food, 'schema:image', 'image')!;
  unsupported.statement.value = { type: 'value', content: '01234567-89ab-4cde-8fab-0123456789ab' };
  const partial = prepareGenericCreate(food.id, terms, [website, unsupported], food);
  expect(partial.unsupported).toEqual(['image']);
  expect(partial.item.statements).not.toHaveProperty('schema:image');
  expect(partial.errors).toEqual([]);
});

test('blank scaffolds stay terms only and current item properties remain exact-target aware', () => {
  const food = descriptor('wd:Q2095');
  const blank = genericCreateFact(food, 'schema:url', 'blank')!;
  expect(prepareGenericCreate(food.id, terms, [blank], food).item).not.toHaveProperty('statements');

  const series = descriptor('wd:Q7725310');
  const targetProperty = series.definition.properties.find(
    (property) => series.propertyDefinitions[property]?.datatype === 'wikibase-item',
  );
  expect(targetProperty).toBeDefined();
  expect(genericCreatePropertySupported(series.propertyDefinitions[targetProperty!])).toBe(true);
  expect(genericCreateSpecializedPath('schema:Book')).toBe('/catalogue/literary');
  expect(genericCreateSpecializedPath('wd:Q2095')).toBeUndefined();
});
