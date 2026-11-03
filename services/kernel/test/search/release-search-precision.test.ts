import { expect, test } from 'bun:test';
import { bundledRelease } from '@rezics/definitions/bundled';
import { normalizeSourceStatement } from '../../src/semantic/scope-leaf-selection.ts';
import { validateIndexObservation } from '../../src/search/document.ts';
import { pendingFacts } from '../../src/search/hits.ts';
import { validateRequestSourceSnapshot } from '../../src/search/request-source-snapshot.ts';
import { subjectPartition, type IndexedSubject } from '../../src/search/source.ts';

const property = 'schema:datePublished';
const native = (time: string, precision: number) => ({
  value: {
    type: 'value',
    content: { time, precision, calendarmodel: 'http://www.wikidata.org/entity/Q1985727' },
  },
});

test('native dates retain distinct year/month/day precision through current hit fact projection', () => {
  const dates: [string, number][] = [
    ['+2024-00-00T00:00:00Z', 9],
    ['+2024-02-00T00:00:00Z', 10],
    ['+2024-02-29T00:00:00Z', 11],
  ];
  const statements = dates.map(([time, precision]) =>
    normalizeSourceStatement(property, native(time, precision), bundledRelease.properties)!,
  );
  const subject: IndexedSubject = {
    id: '018f0000-0000-7000-8000-000000000001',
    type: 'wd:Q20631656',
    visibility: 'visible',
    redirect: null,
    securityRevision: 1,
    labels: [],
    aliases: [],
    descriptions: [],
    statements: [statements[0]!, statements[0]!, ...statements.slice(1)],
  };
  const partition = subjectPartition(subject.id);
  const snapshot = { partition, position: 1n, subjects: [subject] };
  validateIndexObservation(snapshot, partition, [subject.id], 1n);
  validateRequestSourceSnapshot(snapshot, partition, [subject.id]);
  expect(pendingFacts(subject, [property]).get(property)).toEqual([
    { kind: 'time', year: 2024 },
    { kind: 'time', year: 2024, month: 2 },
    { kind: 'time', year: 2024, month: 2, day: 29 },
  ]);
  for (const facet of [
    { kind: 'time', year: 2024, day: 29 },
    { kind: 'time', year: 2023, month: 2, day: 29 },
  ]) {
    const invalid = structuredClone(snapshot);
    invalid.subjects[0]!.statements[0]!.facet = facet;
    expect(() => validateIndexObservation(invalid, partition, [subject.id], 1n)).toThrow();
    expect(() => validateRequestSourceSnapshot(invalid, partition, [subject.id])).toThrow();
  }
});

test('unknown and invalid native time never acquires a guessed filterable year', () => {
  for (const body of [native('+2023-02-29T00:00:00Z', 11), native('+2024-01-01T00:00:00Z', 9)]) {
    const statement = normalizeSourceStatement(property, body, bundledRelease.properties);
    expect(statement?.value).toBe(body.value.content.time);
    expect(statement?.facet).toBeUndefined();
  }
  expect(normalizeSourceStatement(property, { value: { type: 'somevalue' } }, bundledRelease.properties)).toBeNull();
});
