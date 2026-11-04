import { expect, test } from 'bun:test';
import { bundledRelease } from '../src/bundled.ts';
import { checkStatementInput } from '../src/validate.ts';

const concept = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e01';
const sourceUrl = 'https://vndb.org/v17';
const snapshot = `unversioned:sha256:${'a'.repeat(64)}`;
const snak = (property: string, content: unknown) => ({ property: { id: property }, value: { type: 'value', content } });
const statement = (amount: string, metric = 'vndbTagsRating') => ({
  property: { id: 'schema:genre' },
  value: { type: 'value', content: concept },
  qualifiers: [
    snak('rezics:sourceTagWeight', { amount, unit: '1' }),
    snak('rezics:sourceTagWeightMetric', metric),
    snak('rezics:spoilerLevel', { amount: '+2', unit: '1' }),
  ],
  references: [
    { parts: [snak('schema:url', sourceUrl), snak('rezics:sourceSnapshot', snapshot)] },
    { parts: [snak('schema:url', 'https://api.vndb.org/kana#post-vn')] },
  ],
});

test('the bundled classification release admits only the typed VNDB aggregate on its exact source association', () => {
  const release = bundledRelease;
  const genre = release.properties['schema:genre']!;
  const keywords = release.properties['schema:keywords']!;
  expect(genre.qualifiers).toEqual(expect.arrayContaining(['rezics:sourceTagWeight', 'rezics:sourceTagWeightMetric']));
  expect(keywords.qualifiers).toEqual(expect.arrayContaining(['rezics:sourceTagWeight', 'rezics:sourceTagWeightMetric']));
  expect(release.properties['rezics:sourceTagWeight']).toMatchObject({
    datatype: 'quantity',
    units: ['1'],
    minimum: 0,
    minimumExclusive: true,
    maximum: 3,
  });
  expect(release.properties['rezics:sourceTagWeightMetric']?.value).toMatchObject({
    pattern: '^(?:vndbTagsRating)$(?![\\s\\S])',
  });
  expect(release.properties['rezics:sourceSnapshot']?.value).toMatchObject({
    pattern: '^unversioned:sha256:[0-9a-f]{64}$(?![\\s\\S])',
  });
});

test('the native value remains exact, bounded to (0,3], and does not admit another metric as a number fallback', () => {
  expect(checkStatementInput(statement('+2.59999990463257'), bundledRelease).violations).toEqual([]);
  expect(checkStatementInput(statement('+3.000'), bundledRelease).violations).toEqual([]);
  expect(checkStatementInput(statement('+0'), bundledRelease).violations).toContainEqual({
    pointer: '/statement/qualifiers/0/value/content/amount',
    code: 'out_of_range',
  });
  expect(checkStatementInput(statement('+3.0001'), bundledRelease).violations).toContainEqual({
    pointer: '/statement/qualifiers/0/value/content/amount',
    code: 'out_of_range',
  });
  expect(checkStatementInput(statement('+2.4', 'rawIndividualVote'), bundledRelease).violations).toContainEqual({
    pointer: '/statement/qualifiers/1/value/content',
    code: 'invalid_format',
  });
  const wrongDigest = structuredClone(statement('+2.4'));
  wrongDigest.references[0]!.parts[1]!.value.content = `unversioned:sha256:${'a'.repeat(63)}`;
  expect(checkStatementInput(wrongDigest, bundledRelease).violations).toContainEqual({
    pointer: '/statement/references/0/parts/1/value/content',
    code: 'invalid_format',
  });
});
