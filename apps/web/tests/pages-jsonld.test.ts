import { expect, test } from 'bun:test';
import { slug } from '@rezics/definitions/slug';
import { serializeJsonLd, subjectJsonLd } from '../src/features/pages/jsonld.ts';

const id = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e01';
const author = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e02';
const hidden = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e09';
const merged = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e05';
const survivor = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e06';
let sequence = 0;
const statement = (property: string, dataType: string, value: unknown, rank = 'normal') => ({
  id: `0192f3a0-6c1e-8b2a-9d4e-${String(++sequence).padStart(12, '0')}`,
  rank,
  property: { id: property, data_type: dataType },
  value,
  qualifiers: [],
  references: [],
});
const time = (value: string, precision: number) => ({
  type: 'value',
  content: { time: value, precision, calendarmodel: 'http://www.wikidata.org/entity/Q1985727' },
});

const subject = {
  id,
  type: 'schema:Book',
  labels: { en: 'Kokoro', ja: 'こころ', 'zh-Hans': '心' },
  descriptions: { en: '1914 novel by Natsume Sōseki', ja: '夏目漱石の長編小説' },
  aliases: { en: ['Heart'], ja: ['こゝろ', '心'] },
  statements: {
    'schema:author': [
      statement('schema:author', 'wikibase-item', { type: 'value', content: author }),
      statement('schema:author', 'wikibase-item', { type: 'value', content: hidden }),
      statement('schema:author', 'wikibase-item', { type: 'value', content: merged }),
    ],
    'schema:datePublished': [statement('schema:datePublished', 'time', time('+1914-04-20T00:00:00Z', 11))],
    'schema:dateModified': [statement('schema:dateModified', 'time', time('+1914-04-00T00:00:00Z', 10))],
    'schema:version': [statement('schema:version', 'time', time('+1900-00-00T00:00:00Z', 7))],
    'schema:isbn': [
      statement('schema:isbn', 'external-id', { type: 'value', content: '978-4-10-101013-7' }),
      statement('schema:isbn', 'external-id', { type: 'value', content: '978-0-00-000000-2' }, 'deprecated'),
    ],
    'schema:numberOfPages': [
      statement('schema:numberOfPages', 'quantity', { type: 'value', content: { amount: '+248', unit: '1' } }),
    ],
    'schema:cookTime': [
      statement('schema:cookTime', 'quantity', {
        type: 'value',
        content: { amount: '+45', unit: 'http://www.wikidata.org/entity/Q7727' },
      }),
    ],
    'schema:name': [
      statement(
        'schema:name',
        'monolingualtext',
        { type: 'value', content: { language: 'ja', text: 'こゝろ' } },
        'preferred',
      ),
      statement('schema:name', 'monolingualtext', { type: 'value', content: { language: 'en', text: 'Kokoro' } }),
    ],
    'schema:url': [statement('schema:url', 'url', { type: 'value', content: 'https://example.org/kokoro' })],
    'schema:translator': [statement('schema:translator', 'wikibase-item', { type: 'somevalue' })],
    'schema:publisher': [statement('schema:publisher', 'wikibase-item', { type: 'novalue' })],
    'schema:abstract': [
      statement('schema:abstract', 'document', {
        type: 'value',
        content: { language: 'ja', document: { type: 'doc', content: [] } },
      }),
    ],
    'schema:image': [
      statement('schema:image', 'media', { type: 'value', content: '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5eff' }),
    ],
    'wdt:P648': [statement('wdt:P648', 'external-id', { type: 'value', content: 'OL45804W' })],
    'wdt:P5732': [statement('wdt:P5732', 'string', { type: 'value', content: '253' })],
    'rezics:note': [statement('rezics:note', 'string', { type: 'value', content: 'internal' })],
  },
};
const related = {
  'schema:author': { labels: { en: 'author' } },
  [author]: { labels: { en: 'Natsume Sōseki', ja: '夏目漱石' } },
  [merged]: { labels: { en: 'Old record' }, redirect: survivor },
};
const url = `https://rezics.com/en/subjects/${id}/${slug('Kokoro')}`;
const build = (overrides: Record<string, unknown> = {}, locale = 'en') =>
  subjectJsonLd({ subject: { ...subject, ...overrides }, related, locale, url } as never) as Record<string, unknown>;

test("a subject's public representation becomes schema.org JSON-LD", () => {
  expect(build()).toEqual({
    '@context': 'https://schema.org',
    '@type': 'Book',
    '@id': `https://rezics.com/id/${id}`,
    url,
    name: 'Kokoro',
    description: '1914 novel by Natsume Sōseki',
    alternateName: ['Heart'],
    author: [
      { '@id': `https://rezics.com/id/${author}`, name: 'Natsume Sōseki' },
      { '@id': `https://rezics.com/id/${survivor}`, name: 'Old record' },
    ],
    datePublished: '1914-04-20',
    dateModified: '1914-04',
    isbn: '978-4-10-101013-7',
    numberOfPages: 248,
    cookTime: 'PT45M',
    identifier: [{ '@type': 'PropertyValue', propertyID: 'http://www.wikidata.org/entity/P648', value: 'OL45804W' }],
  });
});

test('only values the representation discloses are emitted', () => {
  const document = build({}, 'ja');
  expect(document.name).toBe('こころ');
  expect(document.description).toBe('夏目漱石の長編小説');
  expect(document.alternateName).toEqual(['こゝろ', '心']);
  expect(document.author).toEqual([
    { '@id': `https://rezics.com/id/${author}`, name: '夏目漱石' },
    { '@id': `https://rezics.com/id/${survivor}`, name: 'Old record' },
  ]);
  expect(JSON.stringify(document)).not.toContain(hidden);
  expect(JSON.stringify(document)).not.toContain('978-0-00-000000-2');
  expect(JSON.stringify(document)).not.toContain('internal');
  expect(document).not.toHaveProperty('translator');
  expect(document).not.toHaveProperty('publisher');
  expect(document).not.toHaveProperty('abstract');
  expect(document).not.toHaveProperty('image');
  expect(document).not.toHaveProperty('version');
  expect(document.identifier).toEqual([
    { '@type': 'PropertyValue', propertyID: 'http://www.wikidata.org/entity/P648', value: 'OL45804W' },
  ]);
  expect(build({}, 'zh-Hant').name).toBe('心');
  expect(build({ labels: { fr: 'Le Pauvre Cœur des hommes' }, descriptions: {}, aliases: {} }, 'ja')).toMatchObject({
    name: 'Le Pauvre Cœur des hommes',
  });
  const bare = build({ labels: {}, descriptions: {}, aliases: {}, statements: {} });
  expect(Object.keys(bare).sort()).toEqual(['@context', '@id', '@type', 'url']);
});

test('types outside schema.org keep their meaning as an additional type', () => {
  expect(build({ type: 'wd:Q689445' })).toMatchObject({
    '@type': 'Thing',
    additionalType: 'http://www.wikidata.org/entity/Q689445',
  });
  expect(build({ type: 'bf:Instance' })).toMatchObject({
    '@type': 'Thing',
    additionalType: 'http://id.loc.gov/ontologies/bibframe/Instance',
  });
  const unknown = build({ type: 'ex:Widget' });
  expect(unknown['@type']).toBe('Thing');
  expect(unknown).not.toHaveProperty('additionalType');
});

test('the serialized JSON-LD cannot close its script element', () => {
  const text = serializeJsonLd({ name: '</script><script>alert(1)</script> &   ' });
  expect(text).not.toContain('<');
  expect(text).not.toContain('>');
  expect(text).not.toContain('&');
  expect(text).not.toContain(' ');
  expect(text).not.toContain(' ');
  expect(JSON.parse(text)).toEqual({ name: '</script><script>alert(1)</script> &   ' });
  const page = serializeJsonLd(build({ labels: { en: 'A <b>bold</b> title' } }));
  expect(page).toContain('\\u003cb\\u003ebold\\u003c/b\\u003e');
});

test('only exact nonnegative safe integer minutes become durations without changing other quantities', () => {
  const duration = (content: unknown, type = 'value', dataType = 'quantity') =>
    build({ statements: { 'schema:cookTime': [statement('schema:cookTime', dataType, { type, content })] } });
  const minute = 'http://www.wikidata.org/entity/Q7727';
  for (const amount of ['+0', '+1', '+25', '+60', '+9007199254740991']) {
    expect(duration({ amount, unit: minute }).cookTime).toBe(`PT${amount.slice(1)}M`);
  }
  expect(duration({ amount: '+25', unit: minute, lowerBound: '+25', upperBound: '+25' }).cookTime).toBe('PT25M');
  for (const content of [
    null,
    {},
    '+25',
    { amount: 25, unit: minute },
    ...[
      '-1',
      '-0',
      '+1.5',
      '+25.0000000000000001',
      '+9007199254740992',
      '+9007199254740993',
      'NaN',
      'Infinity',
      '+1e2',
      ' 25 ',
      '+025',
      '',
    ].map((amount) => ({ amount, unit: minute })),
    ...['1', 'minute', 'minutes', 'wd:Q7727', 'https://www.wikidata.org/entity/Q7727', '', null].map((unit) => ({
      amount: '+25',
      unit,
    })),
    { amount: '+25', unit: minute, lowerBound: '+24' },
    { amount: '+25', unit: minute, upperBound: '+26' },
    { amount: '+25', unit: minute, extra: 'malformed' },
  ])
    expect(duration(content)).not.toHaveProperty('cookTime');
  for (const type of ['somevalue', 'novalue'])
    expect(duration({ amount: '+25', unit: minute }, type)).not.toHaveProperty('cookTime');
  expect(duration('PT25M', 'value', 'string')).not.toHaveProperty('cookTime');
  const quantities = build({
    statements: {
      'schema:recipeYield': [
        statement('schema:recipeYield', 'quantity', { type: 'value', content: { amount: '+4', unit: '1' } }),
      ],
      'schema:weight': [
        statement('schema:weight', 'quantity', { type: 'value', content: { amount: '+2.5', unit: 'kg' } }),
      ],
    },
  });
  expect(quantities.recipeYield).toBe(4);
  expect(quantities.weight).toEqual({ '@type': 'QuantitativeValue', value: 2.5, unitText: 'kg' });
});

test('duration rank and spoiler controls never fall back to an undisclosed value', () => {
  const normal = statement('schema:cookTime', 'quantity', {
    type: 'value',
    content: { amount: '+25', unit: 'http://www.wikidata.org/entity/Q7727' },
  });
  const preferred = { ...normal, rank: 'preferred', value: { type: 'somevalue' } };
  expect(build({ statements: { 'schema:cookTime': [normal, preferred] } })).not.toHaveProperty('cookTime');
  expect(build({ statements: { 'schema:cookTime': [{ ...normal, rank: 'deprecated' }] } })).not.toHaveProperty(
    'cookTime',
  );
  const qualified = {
    ...normal,
    qualifiers: [
      {
        property: { id: 'rezics:spoilerLevel', data_type: 'quantity' },
        value: { type: 'value', content: { amount: '+1', unit: '1' } },
      },
    ],
  };
  expect(build({ statements: { 'schema:cookTime': [qualified] } })).not.toHaveProperty('cookTime');
});
