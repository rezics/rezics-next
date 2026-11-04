import { expect, test } from 'bun:test';
import { bundledRelease } from '../src/bundled.ts';
import { checkStatementInput } from '../src/validate.ts';
import { validateRelease, valueSchema, type PropertyDefinition, type Release } from '../src/index.ts';

const gregorian = 'http://www.wikidata.org/entity/Q1985727';
const julian = 'http://www.wikidata.org/entity/Q1985786';
const property: PropertyDefinition = {
  iri: 'https://example.org/date',
  labels: { en: 'Date' },
  mappings: [],
  datatype: 'time',
  multivalued: false,
  qualifiers: [],
  value: valueSchema('time'),
};
const url: PropertyDefinition = {
  iri: 'https://schema.org/url',
  labels: { en: 'URL' },
  mappings: [],
  datatype: 'url',
  multivalued: false,
  qualifiers: [],
  value: valueSchema('url'),
};
const release = { properties: { 'ex:date': property, 'schema:url': url } };
const statement = (content: unknown) => ({
  property: { id: 'ex:date' },
  value: { type: 'value', content },
  references: [{ parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: 'https://example.org/source' } }] }],
});

test('portable time admits exact signed Julian partial dates and metadata, while rejecting unsupported forms', () => {
  const supported = {
    time: '-1234567890123456-02-29T00:00:00Z',
    precision: 11,
    calendarmodel: julian,
    timezone: -330,
    before: 2,
    after: 3,
  };
  expect(checkStatementInput(statement(supported), release).violations).toEqual([]);
  expect(checkStatementInput(statement({ ...supported, time: '+1900-02-29T00:00:00Z', calendarmodel: gregorian }), release).violations)
    .toContainEqual({ pointer: '/statement/value/content/time', code: 'invalid_format' });
  for (const content of [
    { ...supported, calendarmodel: 'https://example.org/unknown' },
    { ...supported, precision: 12 },
    { ...supported, timezone: 9007199254740992 },
    { ...supported, before: -1 },
    { ...supported, time: `+${'1'.repeat(17)}-02-29T00:00:00Z` },
  ])
    expect(checkStatementInput(statement(content), release).violations.length).toBeGreaterThan(0);
  expect(checkStatementInput(statement({ ...supported, precision: 9, time: '+2000-00-00T00:00:00Z' }), release).violations)
    .toEqual([]);
});

test('exact quantity schema and pinned Gregorian time releases retain their historical shape', () => {
  expect(valueSchema('quantity')).toEqual({
    type: 'object',
    required: ['amount', 'unit'],
    additionalProperties: false,
    properties: {
      amount: { type: 'string', pattern: '^[+-](?:0|[1-9][0-9]*)(?:\\.[0-9]+)?$' },
      lowerBound: { type: 'string', pattern: '^[+-](?:0|[1-9][0-9]*)(?:\\.[0-9]+)?$' },
      upperBound: { type: 'string', pattern: '^[+-](?:0|[1-9][0-9]*)(?:\\.[0-9]+)?$' },
      unit: { enum: [] },
    },
  });
  const historical = structuredClone(bundledRelease) as Release;
  const oldTimeSchema = {
    type: 'object',
    required: ['time', 'precision', 'calendarmodel'],
    additionalProperties: false,
    properties: {
      time: { type: 'string', pattern: '^[+-][0-9]{4,}-[0-9]{2}-[0-9]{2}T00:00:00Z$' },
      precision: { enum: [9, 10, 11] },
      calendarmodel: { const: gregorian },
    },
  };
  for (const definition of Object.values(historical.properties))
    if (definition.datatype === 'time') definition.value = structuredClone(oldTimeSchema);
  expect(validateRelease(historical)).toEqual([]);
});
