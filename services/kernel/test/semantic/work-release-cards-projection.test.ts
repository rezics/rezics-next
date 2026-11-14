import { expect, test } from 'bun:test';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { newId } from '../../src/route/route.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import type { FactRow } from '../../src/semantic/item.ts';
import { projectWorkReleaseCardFacts } from '../../src/semantic/work-release-cards.ts';

const edition = newId(0x2345);
const value = (content: unknown) => ({ type: 'value' as const, content });
const parts = [{ property: 'schema:url', value: value('https://example.org/edition') }];
const hash = '5feafa36f0343c363bebca7a3416c1fefa28f23c6d43a43922d3bc5cb98f4fd8';
const datatype = (property: string) => bundledRelease.properties[property]!.datatype;
const nativeBody = (content: unknown, qualifier?: [string, unknown], rank = 'normal') => ({
  rank,
  value: value(content),
  qualifiers: qualifier ? [{ property: qualifier[0], value: value(qualifier[1]) }] : [],
  references: qualifier ? [{ parts }] : [],
});
const native = (
  property: string,
  body: unknown,
  revision: number | null = 1,
  release: string | null = 'a'.repeat(64),
  id: string | null = newId(0x2345),
): FactRow => ({
  kind: 'statement',
  language: null,
  property,
  statement_id: id,
  operation: 'assert',
  body,
  fact_revision: revision,
  fact_release: release,
});
const project = (...rows: FactRow[]) =>
  projectWorkReleaseCardFacts(
    edition,
    'bf:Instance',
    bundledRelease,
    GLOBAL_CONTEXT,
    new Map(rows.map((row) => [row.property!, [row]])),
  );

test('native Book date, language and publisher retain canonical public data and evidence', () => {
  const dateValue = { time: '+2024-03-00T00:00:00Z', precision: 10 },
    publisherId = newId(0x3456);
  const date = native('schema:datePublished', nativeBody(dateValue, ['schema:inLanguage', 'ja']), 7, 'a'.repeat(64));
  const language = native('schema:inLanguage', nativeBody('ja'), 11, 'b'.repeat(64));
  const publisher = native('schema:publisher', nativeBody(publisherId, ['wdt:P1932', 'Imprint']), 19, bundledDigest);
  const fields = project(date, language, publisher);
  for (const [row, property, expected, revision, release, qualifier] of [
    [date, 'schema:datePublished', value(dateValue), 7, 'a'.repeat(64), 'schema:inLanguage'],
    [language, 'schema:inLanguage', value('ja'), 11, 'b'.repeat(64), ''],
    [publisher, 'schema:publisher', value(publisherId), 19, bundledDigest, 'wdt:P1932'],
  ] as const) {
    const statement = fields.get(property)!.statements[0]!;
    expect([statement.id, statement.value, statement.property.data_type, statement.rezics]).toEqual([
      row.statement_id!,
      expected,
      datatype(property),
      { release, revision },
    ]);
    if (qualifier)
      expect([
        statement.qualifiers[0]!.property.data_type,
        statement.references[0]!.hash,
        statement.references[0]!.parts[0]!.property.data_type,
      ]).toEqual([qualifier && datatype(qualifier), hash, datatype('schema:url')]);
  }
});

test('missing native ID, revision or release makes the populated field unavailable', () => {
  for (const row of [
    native('schema:inLanguage', nativeBody('ja'), 1, bundledDigest, null),
    native('schema:inLanguage', nativeBody('ja'), null),
    native('schema:inLanguage', nativeBody('ja'), 1, null),
  ])
    expect(project(row).get('schema:inLanguage')).toEqual({ statements: [], unavailable: true });
});
