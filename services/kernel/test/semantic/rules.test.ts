import { expect, test } from 'bun:test';
import { fromPlainText } from '@rezics/document';
import { valueSchema, type Release } from '@rezics/definitions';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import type { Violation } from '../../src/semantic/item.ts';
import { checkTyped } from '../../src/semantic/rules.ts';

const GREGORIAN = 'http://www.wikidata.org/entity/Q1985727';
const MINUTE = 'http://www.wikidata.org/entity/Q7727';
const SOSEKI = '019a1b2c-3d4e-7f00-8a00-000000000101';
const SHINCHOSHA = '019a1b2c-3d4e-7f00-8a00-000000000202';
const KOKORO = '019a1b2c-3d4e-7f00-8a00-000000000303';
const value = (content: unknown) => ({ type: 'value', content });
const snak = (property: string, content: unknown, extra: Record<string, unknown> = {}) => ({
  property: { id: property },
  value: value(content),
  ...extra,
});
const date = (time: string, precision = 11) => ({ time, precision, calendarmodel: GREGORIAN });
const check = (input: unknown, release: Release = bundledRelease, digest = bundledDigest) =>
  checkTyped(release, digest, input);
const violations = (input: unknown, release?: Release) => check(input, release).violations;
const book = (statements: Record<string, unknown>) => ({ type: 'schema:Book', labels: { en: 'Kokoro' }, statements });
const edition = (statements: Record<string, unknown>) => ({
  type: 'bf:Instance',
  labels: { ja: 'こころ' },
  statements,
});

test("a subject's type and properties must be in the release", () => {
  expect(check({ type: 'schema:Person', labels: { en: 'Natsume Sōseki' } })).toEqual({ violations: [], items: [] });
  expect(violations({ labels: { en: 'Kokoro' } })).toEqual([{ pointer: '/type', code: 'required' }]);
  expect(violations({ type: 7 })).toEqual([{ pointer: '/type', code: 'invalid_type' }]);
  expect(
    violations({ type: 'schema:NotInRelease', statements: { 'schema:isbn': [snak('schema:isbn', 'x')] } }),
  ).toEqual([{ pointer: '/type', code: 'unsupported' }]);
  expect(
    violations(
      book({
        'schema:isbn': [snak('schema:isbn', '978-4-10-101013-7')],
        'schema:inLanguage': [snak('schema:inLanguage', 'ja')],
      }),
    ),
  ).toEqual([{ pointer: '/statements/schema:isbn', code: 'unsupported' }]);
  expect(violations(book({ 'schema:url': 'not a list', 'schema:author': [null] }))).toEqual([]);
});

test('qualifiers, reference parts, ranks and counts follow the property definitions', () => {
  const isbn = snak('schema:isbn', '978-4-10-101013-7');
  const source = (property: string, content: unknown) => ({ parts: [snak(property, content)] });
  expect(
    violations(
      book({
        'schema:author': [
          snak('schema:author', SOSEKI, { qualifiers: [snak('schema:position', '1'), isbn] }),
          snak('schema:author', SOSEKI, {
            rank: 'deprecated',
            references: [source('schema:homepage', 'https://example.org')],
          }),
          snak('schema:author', SOSEKI, {
            rank: 'preferred',
            references: [source('schema:isbn', '978-4-10-101013-7')],
          }),
        ],
      }),
    ),
  ).toEqual([
    { pointer: '/statements/schema:author/0/qualifiers/1/property/id', code: 'unsupported' },
    { pointer: '/statements/schema:author/1/rank', code: 'unsupported' },
    { pointer: '/statements/schema:author/1/references/0/parts/0/property/id', code: 'unsupported' },
  ]);
  const work = (id: string) => snak('schema:exampleOfWork', id);
  expect(violations(edition({ 'schema:exampleOfWork': [work(KOKORO), work(KOKORO), work(KOKORO)] }))).toEqual([
    { pointer: '/statements/schema:exampleOfWork/1', code: 'out_of_range' },
    { pointer: '/statements/schema:exampleOfWork/2', code: 'out_of_range' },
  ]);
  const many = Array.from({ length: 20 }, () => work(KOKORO));
  expect(violations(edition({ 'schema:exampleOfWork': many }))).toHaveLength(16);
});

test('value contents are checked by the value schemas of the release', () => {
  const pages = (content: unknown) => edition({ 'schema:numberOfPages': [snak('schema:numberOfPages', content)] });
  expect(violations(edition({ 'schema:isbn': [snak('schema:isbn', '4-10-101013-0')] }))).toEqual([
    { pointer: '/statements/schema:isbn/0/value/content', code: 'invalid_format' },
  ]);
  expect(violations(edition({ 'schema:isbn': [snak('schema:isbn', 9784101010137)] }))).toEqual([
    { pointer: '/statements/schema:isbn/0/value/content', code: 'invalid_type' },
  ]);
  expect(violations(pages({ amount: '+12.5', unit: '1' }))).toEqual([
    { pointer: '/statements/schema:numberOfPages/0/value/content/amount', code: 'invalid_format' },
  ]);
  expect(violations(pages({ amount: '+120', unit: MINUTE }))).toEqual([
    { pointer: '/statements/schema:numberOfPages/0/value/content/unit', code: 'invalid_format' },
  ]);
  expect(violations(pages({ amount: '+120', unit: '1', upperBound: '+121' }))).toEqual([]);
  expect(violations(pages({ amount: '+120', unit: '1', upperBound: '+119' }))).toEqual([
    { pointer: '/statements/schema:numberOfPages/0/value/content/upperBound', code: 'out_of_range' },
  ]);
  expect(violations(edition({ 'schema:url': [snak('schema:url', 'ftp://example.org/kokoro')] }))).toEqual([
    { pointer: '/statements/schema:url/0/value/content', code: 'invalid_format' },
  ]);
  expect(
    violations(
      edition({
        'schema:datePublished': [snak('schema:datePublished', { ...date('+1952-00-00T00:00:00Z', 9), precision: 8 })],
      }),
    ),
  ).toEqual([{ pointer: '/statements/schema:datePublished/0/value/content/precision', code: 'invalid_format' }]);
  const recipe = (content: unknown) => ({
    type: 'schema:Recipe',
    labels: { ja: '肉じゃが' },
    statements: { 'schema:recipeIngredient': [snak('schema:recipeIngredient', content)] },
  });
  expect(violations(recipe({ text: 'じゃがいも' }))).toEqual([
    { pointer: '/statements/schema:recipeIngredient/0/value/content/language', code: 'required' },
  ]);
  expect(violations(recipe({ text: 'じゃがいも', language: 'ja' }))).toEqual([]);
  const qualified = snak('schema:author', SOSEKI, {
    qualifiers: [snak('schema:position', '0')],
    references: [{ parts: [snak('schema:url', 'mailto:a@example.org')] }],
  });
  expect(violations(book({ 'schema:author': [qualified] }))).toEqual([
    { pointer: '/statements/schema:author/0/qualifiers/0/value/content', code: 'invalid_format' },
    { pointer: '/statements/schema:author/0/references/0/parts/0/value/content', code: 'invalid_format' },
  ]);
  const unknown = { property: { id: 'schema:numberOfPages' }, value: { type: 'somevalue' } };
  const none = { property: { id: 'schema:isbn' }, value: { type: 'novalue' } };
  expect(violations(edition({ 'schema:numberOfPages': [unknown], 'schema:isbn': [none] }))).toEqual([]);
});

test('quantity bounds compare exact decimals and dates must exist at their precision', () => {
  const pages = (amount: string) =>
    edition({ 'schema:numberOfPages': [snak('schema:numberOfPages', { amount, unit: '1' })] });
  expect(violations(pages('+1'))).toEqual([]);
  for (const amount of ['+0', '-0', '-384'])
    expect(violations(pages(amount))).toEqual([
      { pointer: '/statements/schema:numberOfPages/0/value/content/amount', code: 'out_of_range' },
    ]);
  const cook = (amount: string) => ({
    type: 'schema:Recipe',
    labels: { en: 'Tea' },
    statements: { 'schema:cookTime': [snak('schema:cookTime', { amount, unit: MINUTE })] },
  });
  expect(violations(cook('-0'))).toEqual([]);
  const bounded = structuredClone(bundledRelease) as Release & { properties: Record<string, any> };
  bounded.properties['schema:cookTime'] = {
    ...bounded.properties['schema:cookTime'],
    value: valueSchema('quantity', { units: [MINUTE] }),
    maximum: 0.3,
  };
  const tight = (amount: string) => check(cook(amount), bounded, `sha256:${'a'.repeat(64)}`).violations;
  expect(tight('+0.3')).toEqual([]);
  expect(tight('+0.29999999999999999')).toEqual([]);
  expect(tight('+0.30000000000000001')).toEqual([
    { pointer: '/statements/schema:cookTime/0/value/content/amount', code: 'out_of_range' },
  ]);
  expect(check(cook('+0.30000000000000001')).violations).toEqual([
    { pointer: '/statements/schema:cookTime/0/value/content/amount', code: 'invalid_format' },
  ]);
  const published = (time: string, precision: number) =>
    edition({ 'schema:datePublished': [snak('schema:datePublished', date(time, precision))] });
  const bad: Violation[] = [
    { pointer: '/statements/schema:datePublished/0/value/content/time', code: 'invalid_format' },
  ];
  for (const [time, precision] of [
    ['+2024-02-29T00:00:00Z', 11],
    ['+1914-09-20T00:00:00Z', 11],
    ['+1914-09-00T00:00:00Z', 10],
    ['+1914-00-00T00:00:00Z', 9],
  ] as const)
    expect(violations(published(time, precision))).toEqual([]);
  for (const [time, precision] of [
    ['+1906-02-30T00:00:00Z', 11],
    ['+1900-02-29T00:00:00Z', 11],
    ['+1914-13-01T00:00:00Z', 11],
    ['+1914-09-00T00:00:00Z', 11],
    ['+1914-09-20T00:00:00Z', 10],
    ['+1914-00-00T00:00:00Z', 10],
    ['+1914-09-00T00:00:00Z', 9],
  ] as const)
    expect(violations(published(time, precision))).toEqual(bad);
});

test('item values are collected with their target types for the caller to check', () => {
  const targets = (property: string) => bundledRelease.properties[property]!.targets!;
  const statements = {
    'schema:exampleOfWork': [snak('schema:exampleOfWork', KOKORO)],
    'schema:publisher': [
      snak('schema:publisher', SHINCHOSHA, { references: [{ parts: [snak('schema:publisher', SHINCHOSHA)] }] }),
    ],
    'schema:translator': [snak('schema:translator', 'not-a-uuid', { qualifiers: [snak('schema:position', '1')] })],
  };
  expect(check(edition(statements))).toEqual({
    violations: [{ pointer: '/statements/schema:translator/0/value/content', code: 'invalid_format' }],
    items: [
      {
        pointer: '/statements/schema:exampleOfWork/0/value/content',
        id: KOKORO,
        targets: targets('schema:exampleOfWork'),
      },
      {
        pointer: '/statements/schema:publisher/0/value/content',
        id: SHINCHOSHA,
        targets: targets('schema:publisher'),
      },
      {
        pointer: '/statements/schema:publisher/0/references/0/parts/0/value/content',
        id: SHINCHOSHA,
        targets: targets('schema:publisher'),
      },
    ],
  });
  const authors = book({ 'schema:author': [snak('schema:author', SOSEKI)] });
  expect(check(authors).items).toEqual([
    {
      pointer: '/statements/schema:author/0/value/content',
      id: SOSEKI,
      targets: targets('schema:author'),
    },
  ]);
});

test('authored documents are accepted and media stays unsupported, including nested snaks', () => {
  for (const property of ['schema:abstract', 'schema:image']) {
    // Media rejection still precedes value validation; authored values require an envelope.
    for (const content of [null, 'not a snapshot or media id', KOKORO])
      expect(violations(book({ [property]: [snak(property, content)] }))).toEqual([
        {
          pointer: `/statements/${property}/0/value/content`,
          code: property === 'schema:abstract' ? 'invalid_type' : 'unsupported',
        },
      ]);
    expect(violations(book({ [property]: [{ property: { id: property }, value: { type: 'somevalue' } }] }))).toEqual(
      [],
    );
    const content =
      property === 'schema:abstract'
        ? { document: fromPlainText('An editor summary.'), licence: 'CC-BY-4.0', language: 'en' }
        : null;
    expect(violations(book({ [property]: [snak(property, content)] }))).toEqual(
      property === 'schema:abstract'
        ? []
        : [{ pointer: `/statements/${property}/0/value/content`, code: 'unsupported' }],
    );
    expect(
      violations(
        book({
          'schema:author': [
            snak('schema:author', SOSEKI, {
              references: [{ parts: [snak(property, content)] }],
            }),
          ],
        }),
      ),
    ).toEqual(
      property === 'schema:abstract'
        ? []
        : [{ pointer: '/statements/schema:author/0/references/0/parts/0/value/content', code: 'unsupported' }],
    );
    const release = structuredClone(bundledRelease);
    release.properties['schema:author']!.qualifiers.push(property);
    expect(
      check(
        book({
          'schema:author': [
            snak('schema:author', SOSEKI, {
              qualifiers: [snak(property, content)],
            }),
          ],
        }),
        release,
      ).violations,
    ).toEqual(
      property === 'schema:abstract'
        ? []
        : [{ pointer: '/statements/schema:author/0/qualifiers/0/value/content', code: 'unsupported' }],
    );
  }
});
