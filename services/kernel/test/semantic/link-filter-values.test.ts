import { expect, test } from 'bun:test';
import { bundledRelease } from '@rezics/definitions/bundled';
import { linkChanges } from '../../src/semantic/link-changes.ts';
import { newId } from '../../src/route/route.ts';

const nil = '00000000-0000-0000-0000-000000000000';
test('filter projections deduplicate values across two qualifiers and retract obsolete rows', () => {
  const subject = newId(160);
  const target = newId(176);
  const role = newId(192);
  const arc = newId(208);
  const statement = newId(160);
  const fact = (values: [string, unknown][]) => ({
    kind: 'statement',
    operation: 'assert',
    property: 'schema:character',
    statement_id: statement,
    body: {
      rank: 'normal',
      value: { type: 'value', content: target },
      qualifiers: values.map(([property, content]) => ({ property, value: { type: 'value', content } })),
    },
  });
  const before = [
    fact([
      ['wdt:P3831', role],
      ['wdt:P518', arc],
      ['wdt:P518', arc],
      ['wdt:P518', role],
      ['wdt:P518', 'not-a-subject'],
      ['wdt:P1932', newId(224)],
    ]),
  ];
  const metadata = { subject, type: 'schema:TVSeries', release: bundledRelease };
  const dataTypes = { 'schema:character': 'wikibase-item' };
  const projected = linkChanges([], before, dataTypes, metadata);
  expect(projected.map((row) => row.filter_value).sort()).toEqual([nil, role, arc].sort());
  expect(projected.every((row) => row.present && row.project_outbound)).toBe(true);
  const after = [fact([['wdt:P3831', role]])];
  expect(linkChanges(before, after, dataTypes, metadata)).toEqual([
    { ...projected.find((row) => row.filter_value === arc)!, present: false },
  ]);
  expect(
    linkChanges(after, [], dataTypes, metadata)
      .map((row) => [row.filter_value, row.present])
      .sort(),
  ).toEqual(
    [
      [nil, false],
      [role, false],
    ].sort(),
  );
});
