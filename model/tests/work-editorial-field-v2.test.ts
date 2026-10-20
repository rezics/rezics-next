import { expect, test } from 'bun:test';
import { Value } from 'typebox/value';
import { shapeSchemas } from '../../packages/model/src/generated/schemas.ts';
import { SYNOPSIS_TEXT_LIMIT } from '../../services/main/src/modules/source/field-control-language.ts';

const rv = 'https://rezics.com/vocab/', profile = 'https://rezics.com/definition/work-editorial-field-v2';
const value = { '@id': 'urn:editorial-test:value',
  'rdf:type': [`${rv}EditorialFieldRevision`,`${rv}RevisionAnchor`],
  'rv:component': ['urn:editorial-test:slot'], 'rv:fieldValue': [' First\r\nSecond\t' + '文'.repeat(9000)],
  'rv:rightsStatus': [`${rv}Undetermined`], 'rv:modelRevision': [profile], 'rv:shapeRevision': [profile],
  'rv:dataEpoch': ['test-epoch'], 'rv:sequence': [1] };

test('editorial v2 admits lossless text and exact source-language states without changing v1', () => {
  const schema = shapeSchemas[`${profile}/value-shape`];
  for (const state of ['omitted','null','value']) {
    expect(Value.Check(schema,{ ...value,'rv:sourceLanguageState': [state],
      ...(state === 'value' ? { 'rv:sourceLanguage': [''] } : {}) })).toBe(true);
  }
  expect(Value.Check(schema,{ ...value,'rv:sourceLanguageState': ['value'] })).toBe(false);
  expect(Value.Check(schema,{ ...value,'rv:sourceLanguageState': ['null'],'rv:sourceLanguage': ['ja'] })).toBe(false);
  expect(Value.Check(schema,{ ...value,'rv:fieldValue': ['a'.repeat(SYNOPSIS_TEXT_LIMIT + 1)] })).toBe(false);
  const oldProfile = 'https://rezics.com/definition/work-editorial-field-v1';
  expect(Value.Check(shapeSchemas[`${oldProfile}/value-shape`],{ ...value,
    'rv:modelRevision': [oldProfile],'rv:shapeRevision': [oldProfile] })).toBe(false);
});
