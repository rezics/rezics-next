import { expect, test } from 'bun:test';
import type { BatchCommand } from '@rezics/definitions/bulk';
import { bundledRelease } from '@rezics/definitions/bundled';
import { checkStatementInput } from '@rezics/definitions/validate';
import { ConversionError } from '../src/index.ts';
import { converter_revision, convertOpenLibrary } from '../src/open-library.ts';

const subjectId = '00000000-0000-4000-8000-000000000001';
const gregorian = 'http://www.wikidata.org/entity/Q1985727';
const work = {
  type: { key: '/type/work' as const },
  key: '/works/OL66554W',
  revision: 120,
  last_modified: { value: '2026-09-18T13:25:31.962669' },
  title: 'Pride and Prejudice',
};
const input = (record: Record<string, unknown>) => ({
  external_id: record.key as string,
  record_revision: String(record.revision),
  record,
});
type Proposal = Extract<BatchCommand, { op: 'propose' }>;
const dateCandidates = (record: Record<string, unknown>) =>
  convertOpenLibrary(input(record), { subjectId }).proposals.filter(
    (command): command is Proposal => command.op === 'propose' && command.statement.property.id === 'schema:datePublished',
  );

test('Work first_publish_date retains source precision, citation and independent review identity', () => {
  expect(converter_revision).toBe('open-library@5');
  const output = convertOpenLibrary(
    input({ ...work, publish_date: 'May 1813', first_publish_date: '1853' }),
    { subjectId },
  );
  const dates = dateCandidates({ ...work, publish_date: 'May 1813', first_publish_date: '1853' });
  expect(dates).toHaveLength(2);
  if (dates[0]?.op !== 'propose' || dates[1]?.op !== 'propose') throw new Error('Expected both date candidates');
  const content = (command: (typeof dates)[number]) =>
    command.op === 'propose' && command.statement.value.type === 'value' ? command.statement.value.content : null;
  const original = dates.find((command) =>
    JSON.stringify(content(command)) ===
    JSON.stringify({ time: '+1813-05-00T00:00:00Z', precision: 10, calendarmodel: gregorian }),
  );
  const first = dates.find((command) =>
    JSON.stringify(content(command)) ===
    JSON.stringify({ time: '+1853-00-00T00:00:00Z', precision: 9, calendarmodel: gregorian }),
  );
  expect(original).toBeDefined();
  expect(first).toBeDefined();
  expect(first!.key).not.toBe(original!.key);
  expect(output.normalizedRecord.first_publish_date).toBe('1853');
  expect(output.digest).not.toBe(
    convertOpenLibrary(input({ ...work, publish_date: 'May 1813' }), { subjectId }).digest,
  );
  expect(checkStatementInput(first!.statement, bundledRelease).violations).toEqual([]);
  const reference = first!.statement.references[0]!;
  expect(reference.parts.map((part) => [part.property.id, part.value.type === 'value' ? part.value.content : null])).toEqual([
    ['schema:url', 'https://openlibrary.org/works/OL66554W.json'],
    ['wdt:P648', 'OL66554W'],
    ['schema:version', '120'],
    ['schema:dateModified', { time: '+2026-09-18T00:00:00Z', precision: 11, calendarmodel: gregorian }],
  ]);
  for (const [source, precision, time] of [
    ['1853-07', 10, '+1853-07-00T00:00:00Z'],
    ['1853-07-06', 11, '+1853-07-06T00:00:00Z'],
  ] as const) {
    expect(dateCandidates({ ...work, first_publish_date: source })[0]!.statement.value).toEqual({
      type: 'value',
      content: { time, precision, calendarmodel: gregorian },
    });
  }
});

test('malformed and unsupported values withhold only that evidence; oversized and Edition values stay bounded', () => {
  for (const [value, code] of [
    [1853, 'invalid_source_string_or_limit'],
    [['1853'], 'invalid_source_string_or_limit'],
    [new Proxy({}, {}), 'invalid_source_string_or_limit'],
    ['circa 1853', 'unsupported_publication_date_format'],
    ['1900-02-29', 'invalid_publication_date'],
  ] as const) {
    const record = { ...work, first_publish_date: value };
    const output = convertOpenLibrary(input(record), { subjectId });
    expect(output.diagnostics).toContainEqual({ pointer: '/first_publish_date', code });
    expect(output.proposals.some((command) => command.op === 'propose' && command.statement.property.id === 'schema:name')).toBe(
      true,
    );
    expect(dateCandidates(record)).toHaveLength(0);
  }
  expect(() => convertOpenLibrary(input({ ...work, first_publish_date: 'x'.repeat(1501) }), { subjectId })).toThrow(
    ConversionError,
  );

  const absent = convertOpenLibrary(input(work), { subjectId });
  expect(absent.diagnostics.some((entry) => entry.pointer === '/first_publish_date')).toBe(false);
  expect(absent.proposals.some((command) => command.op === 'propose' && command.statement.property.id === 'schema:datePublished')).toBe(
    false,
  );

  let read = 0;
  const accessor = { ...work } as Record<string, unknown>;
  Object.defineProperty(accessor, 'first_publish_date', { enumerable: true, get: () => (read++, '1853') });
  const withheld = convertOpenLibrary(input(accessor), { subjectId });
  expect(read).toBe(0);
  expect(withheld.diagnostics).toContainEqual({ pointer: '/first_publish_date', code: 'invalid_source_data_property' });

  const edition = {
    type: { key: '/type/edition' as const },
    key: '/books/OL7353617M',
    revision: 28,
    last_modified: { value: '2025-12-15T09:37:45.661490' },
    title: 'Edition',
    publish_date: 'May 1980',
    first_publish_date: '1853',
  };
  const output = convertOpenLibrary(input(edition), { subjectId });
  expect(output.normalizedRecord).not.toHaveProperty('first_publish_date');
  expect(dateCandidates(edition)).toHaveLength(1);
  const date = dateCandidates(edition)[0];
  expect(date?.op === 'propose' && date.statement.value.type === 'value' ? date.statement.value.content : null).toEqual({
    time: '+1980-05-00T00:00:00Z',
    precision: 10,
    calendarmodel: gregorian,
  });
});
