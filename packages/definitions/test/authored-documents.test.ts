import { expect, test } from 'bun:test';
import { fromPlainText } from '@rezics/document';
import { bundledRelease } from '../src/bundled.ts';
import { checkStatementInput, checkSubjectInput } from '../src/validate.ts';

const value = { document: fromPlainText('An editor summary.'), licence: 'LicenseRef-editor', language: 'zh-Hant' };
const statement = (content: unknown) => ({
  property: { id: 'schema:abstract' },
  value: { type: 'value', content },
  references: [
    { parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: 'https://example.org/' } }] },
  ],
});
const check = (content: unknown) =>
  checkStatementInput(statement(content), bundledRelease, { authoredDocuments: true }).violations;

test('authored document validation accepts the explicit envelope without widening bulk values', () => {
  expect(check(value)).toEqual([]);
  const item = { type: 'schema:Book', labels: { en: 'Book' }, statements: { 'schema:abstract': [statement(value)] } };
  expect(checkSubjectInput(item, bundledRelease, undefined, true).violations).toEqual([]);
  expect(checkStatementInput(statement(value), bundledRelease).violations).toEqual([
    { pointer: '/statement/value/content/licence', code: 'unknown_field' },
  ]);
});

test('authored document validation names invalid snapshots and metadata precisely', () => {
  for (const document of [
    null,
    'text',
    {},
    { version: 'rezics-document-v1', profile: 'blocks', doc: { type: 'doc', content: [] } },
  ])
    expect(check({ ...value, document })).toEqual([
      { pointer: '/statement/value/content/document', code: 'invalid_format' },
    ]);
  expect(check({ ...value, licence: 'made-up' })).toEqual([
    { pointer: '/statement/value/content/licence', code: 'invalid_format' },
  ]);
  expect(check({ ...value, language: 'en_US' })).toEqual([
    { pointer: '/statement/value/content/language', code: 'invalid_format' },
  ]);
  const { licence: _, ...missing } = value;
  expect(check(missing)).toEqual([{ pointer: '/statement/value/content/licence', code: 'required' }]);
});
