import { expect, test } from 'bun:test';
import { bundledRelease, bundledSources } from '../src/bundled.ts';
import { compileCatalogue } from '../src/compile.ts';
import { validateRelease } from '../src/index.ts';
import { checkStatementInput, checkSubjectStructure } from '../src/validate.ts';

const { properties, types } = bundledRelease;
const snak = (id: string, content: unknown) => ({ property: { id }, value: { type: 'value', content } });
const ingredient = (content: unknown) => ({
  property: { id: 'wdt:P186' },
  value: { type: 'somevalue' },
  qualifiers: [snak('wdt:P1114', content)],
  references: [{ parts: [snak('schema:url', 'https://example.org/materials')] }],
});

test('the release declares general materials, quantities, notes and list sections with recipe instructions', () => {
  expect(types['wd:Q2095']).toMatchObject({ iri: 'http://www.wikidata.org/entity/Q2095', bases: ['schema:Thing'] });
  expect(types['schema:Recipe']!.properties).toContain('wdt:P186');
  expect(types['schema:Recipe']!.properties).toContain('schema:recipeInstructions');
  expect(properties['wdt:P186']).toMatchObject({
    iri: 'http://www.wikidata.org/prop/direct/P186',
    datatype: 'wikibase-item',
    multivalued: true,
    targets: ['schema:Recipe', 'wd:Q2095'],
    qualifiers: ['rezics:listSection', 'rezics:note', 'schema:position', 'schema:sameAs', 'wdt:P1114', 'wdt:P1932'],
    relation: {
      group: 'derivation',
      order: 'position',
      inverse: 'rezics:usedIn',
      inverseLabels: {
        de: 'Verwendet in',
        en: 'Used in',
        es: 'Se usa en',
        fr: 'Utilisé dans',
        ja: '使用先',
        ko: '사용되는 곳',
        'zh-Hans': '用于',
        'zh-Hant': '用於',
      },
    },
  });
  expect(properties['wdt:P1114']).toMatchObject({ datatype: 'quantity', units: ['*'] });
  for (const id of ['rezics:note', 'rezics:listSection']) expect(properties[id]!.datatype).toBe('monolingualtext');
  expect(properties['schema:recipeInstructions']!.datatype).toBe('document');
  expect(properties['schema:recipeIngredient']!.datatype).toBe('monolingualtext');
  expect(properties['schema:recipeYield']).toMatchObject({ datatype: 'quantity', units: ['1'], minimum: 1 });
});

test('exact decimal quantities admit arbitrary unit IRIs and optional enclosing bounds', () => {
  for (const content of [
    { amount: '+0.125', unit: 'http://www.wikidata.org/entity/Q41803' },
    { amount: '+1.5', unit: 'https://example.org/units/scoop' },
    { amount: '+2.50', unit: '1', lowerBound: '+2.00', upperBound: '+3.000' },
    {
      amount: '+0.123456789012345678901234567890',
      unit: 'urn:unit:pinch',
      lowerBound: '+0.123456789012345678901234567889',
    },
  ])
    expect(checkStatementInput(ingredient(content), bundledRelease).violations).toEqual([]);
  for (const [content, member] of [
    [{ amount: 0.125, unit: '1' }, 'amount'],
    [{ amount: '+2', unit: 'spoon' }, 'unit'],
    [{ amount: '+2', unit: 'https://example.org/bad unit' }, 'unit'],
    [{ amount: '+2', unit: '1', lowerBound: '+3' }, 'lowerBound'],
    [{ amount: '+2', unit: '1', upperBound: '+1' }, 'upperBound'],
    [{ amount: '+2', unit: '1', lowerBound: '+1.2e0' }, 'lowerBound'],
    [{ amount: '+2', unit: '1', upperBound: '+3'.repeat(128) }, 'upperBound'],
  ] as const) {
    expect(checkStatementInput(ingredient(content), bundledRelease).violations).toEqual([
      {
        pointer: `/statement/qualifiers/0/value/content/${member}`,
        code:
          member === 'amount'
            ? 'invalid_type'
            : member === 'unit' || (member === 'lowerBound' && content.lowerBound === '+1.2e0')
              ? 'invalid_format'
              : 'out_of_range',
      },
    ]);
  }
  const restricted = { ...snak('schema:recipeYield', { amount: '+4', unit: 'urn:unit:bowl' }), references: [] };
  expect(checkStatementInput(restricted, bundledRelease).violations).toContainEqual({
    pointer: '/statement/value/content/unit',
    code: 'invalid_format',
  });
});

test('any-unit wildcard is exclusive in source and release contracts', async () => {
  const release = structuredClone(bundledRelease);
  release.properties['wdt:P1114']!.units = ['*', '1'];
  expect(validateRelease(release)).toContainEqual({ pointer: '/properties/wdt:P1114/units', code: 'invalid' });
  const sources = bundledSources();
  sources.schemas['core.yaml'] = sources.schemas['core.yaml']!.replace("units: '*'", "units: '* 1'");
  await expect(compileCatalogue(sources)).rejects.toEqual(
    expect.objectContaining({
      violations: expect.arrayContaining([
        expect.objectContaining({ message: 'Any-unit wildcard must be used alone' }),
      ]),
    }),
  );
});

test('relation statements are capped per target slot while the subject fact budget stays bounded', () => {
  const input = (values: unknown[]) => ({
    type: 'schema:Recipe',
    labels: { en: 'Materials' },
    statements: { 'wdt:P186': values },
  });
  const target = (index: number) => snak('wdt:P186', `00000000-0000-7000-8000-${String(index).padStart(12, '0')}`);
  const distinct = Array.from({ length: 40 }, (_, index) => target(index));
  expect(checkSubjectStructure(input(distinct), bundledRelease).violations).toEqual([]);
  expect(checkSubjectStructure(input(Array(32).fill(target(0))), bundledRelease).violations).toEqual([]);
  const overfull = [{ pointer: '/statements/wdt:P186', code: 'out_of_range' as const }];
  expect(checkSubjectStructure(input(Array(33).fill(target(0))), bundledRelease).violations).toEqual(overfull);
  expect(
    checkSubjectStructure(input(Array(33).fill({ ...target(0), value: { type: 'somevalue' } })), bundledRelease)
      .violations,
  ).toEqual(overfull);
  const external = (index: number) => ({
    ...target(0),
    value: { type: 'somevalue' },
    qualifiers: [snak('schema:sameAs', `https://example.org/material/${index}`)],
  });
  expect(
    checkSubjectStructure(input(Array.from({ length: 40 }, (_, index) => external(index))), bundledRelease).violations,
  ).toEqual([]);
  expect(checkSubjectStructure(input(Array(33).fill(external(0))), bundledRelease).violations).toEqual(overfull);
  expect(
    checkSubjectStructure(input(Array.from({ length: 512 }, (_, index) => target(index))), bundledRelease).violations,
  ).toEqual([{ pointer: '', code: 'out_of_range' }]);
  const credits = (key: string) => ({
    ...snak('wdt:P725', target(0).value.content),
    qualifiers: [snak('wdt:P453', key)],
  });
  expect(
    checkSubjectStructure(
      {
        type: 'schema:Recipe',
        labels: { en: 'Credits' },
        statements: { 'wdt:P725': [...Array(32).fill(credits('one')), ...Array(32).fill(credits('two'))] },
      },
      bundledRelease,
    ).violations,
  ).toEqual([]);
});
