import { expect, test } from 'bun:test';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import {
  parseSelectedSynopsis,
  redactSynopsisFact,
  selectedSynopsisFact,
} from '../../src/semantic/selected-synopsis.ts';
import type { Item, Statement } from '../../src/semantic/item.ts';

const input = {
  statement: '00000000-0000-4000-8000-000000000102',
  document: '00000000-0000-4000-8000-000000000202',
  digest: 'a'.repeat(64),
  language: 'EN',
  context: GLOBAL_CONTEXT,
  release: `sha256:${'b'.repeat(64)}`,
};

test('selected HTTP intent is closed, duplicate-free and preserves supplied language spelling', () => {
  expect(parseSelectedSynopsis(JSON.stringify(input))).toEqual(input);
  for (const value of [
    { ...input, language: 'not a language' },
    { ...input, pageRelease: 'old' },
    { ...input, body: 'foreign field' },
    { ...input, digest: 'A'.repeat(64) },
    { ...input, statement: 'not a UUID' },
  ])
    expect(parseSelectedSynopsis(JSON.stringify(value))).toBeUndefined();
  expect(parseSelectedSynopsis(JSON.stringify(input).replace('{', '{"language":"ja",'))).toBeUndefined();
  expect(parseSelectedSynopsis(JSON.stringify(input).replace('{', '{"lang\\u0075age":"ja",'))).toBeUndefined();
});

test('one exact current best-rank row owns its empty citations and every locator is redacted', () => {
  const fact: Statement = {
    id: input.statement,
    rank: 'normal',
    property: { id: 'schema:abstract', data_type: 'document' },
    value: { type: 'value', content: { document: input.document, digest: input.digest, language: input.language } },
    qualifiers: [],
    references: [],
    rezics: { release: input.release, revision: 1 },
  };
  const subject: Item = {
    id: '00000000-0000-4000-8000-000000000001',
    type: 'schema:Book',
    revision: 1,
    release: input.release,
    context: GLOBAL_CONTEXT,
    labels: {},
    descriptions: {},
    aliases: {},
    resolution: {},
    relationCounts: {},
    sourceRecords: [],
    statements: { 'schema:abstract': [fact] },
  };
  expect(selectedSynopsisFact(subject, input)).toBe(fact);
  const redacted = redactSynopsisFact(fact);
  expect(redacted.value).toEqual({ type: 'somevalue' });
  expect(redacted.references).toEqual([]);
  for (const secret of [input.document, input.digest, 'rezics']) expect(JSON.stringify(redacted)).not.toContain(secret);
  for (const replacement of [{ language: 'en' }, { document: input.statement }, { digest: 'c'.repeat(64) }])
    expect(selectedSynopsisFact(subject, { ...input, ...replacement })).toBeUndefined();
  subject.statements['schema:abstract']!.push({ ...fact, id: input.document, rank: 'preferred' });
  expect(selectedSynopsisFact(subject, input)).toBeUndefined();
});
