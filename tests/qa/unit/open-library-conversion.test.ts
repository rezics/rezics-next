import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { projectOpenLibraryWork, SourceConversionInvalid }
  from '../../../services/main/src/modules/source/open-library-conversion.ts';
import type { StagedSourceObservation } from '../../../services/main/src/modules/source/intake.ts';

const workId = 'OL45804W';
const raw = '{"key":"/works/OL45804W","type":{"key":"/type/work"},'
  + '"title":"Example","description":{"value":"Exact expression"},'
  + '"authors":[{"author":{"key":"/authors/OL1A"},"type":{"key":"/type/author_role"}}],'
  + '"subjects":["Foxes"],"revision":9007199254740993,"new_field":{"zero":0}}';

function observation(bytes = raw): StagedSourceObservation {
  const encoded = Buffer.from(bytes);
  return { profile: 'source-acquisition-v1', state: 'staged',
    record: `https://rezics.com/id/${randomUUID()}`,
    observation: `https://rezics.com/id/${randomUUID()}`,
    provider: 'open-library', namespace: 'work', externalId: workId,
    sourceRevision: null, mediaType: 'application/json', retention: 'retained',
    byteDigest: createHash('sha256').update(encoded).digest('hex'),
    byteLength: encoded.length, rawBytesBase64: encoded.toString('base64'),
    coverage: { scope: 'open-library-work-response-v1', complete: true,
      omittedFields: [] }, rightsEvidence: { basis: 'unknown', note: '' },
    submittedAt: new Date().toISOString(),
    capture: { profile: 'open-library-work-acquisition-v1',
      url: `https://openlibrary.org/works/${workId}.json`, status: 200,
      etag: null, lastModified: null, fetchedAt: new Date().toISOString() } };
}

test('LIVE01/LIVE07: conversion enumerates new fields and keeps only source-qualified values', () => {
  const input = observation();
  const converted = projectOpenLibraryWork(input);
  expect(converted.sourceDigest).toBe(input.byteDigest!);
  expect(converted.projection).toEqual({ sourceKey: `/works/${workId}`,
    title: 'Example', description: 'Exact expression',
    authorRefs: [{ sourceKey: '/authors/OL1A', roleKey: '/type/author_role' }],
    subjects: ['Foxes'] });
  expect(converted.fieldInventory.find(field => field.field === 'new_field'))
    .toEqual({ field: 'new_field', disposition: 'unmapped-retained' });
  expect(converted.fieldInventory.find(field => field.field === 'description')?.disposition)
    .toBe('source-expression');
  expect(converted.fieldInventory.find(field => field.field === 'revision')?.disposition)
    .toBe('source-metadata');
  expect(converted.fieldInventory).toHaveLength(Object.keys(JSON.parse(raw)).length);
  expect(Buffer.from(input.rawBytesBase64!, 'base64').toString('utf8'))
    .toContain('9007199254740993');
});

test('LIVE02: incomplete, wrong-grain and malformed source captures cannot convert', () => {
  const partial = observation();
  partial.coverage.complete = false;
  expect(() => projectOpenLibraryWork(partial)).toThrow(SourceConversionInvalid);
  const edition = observation(raw.replace('/type/work', '/type/edition'));
  expect(() => projectOpenLibraryWork(edition)).toThrow(SourceConversionInvalid);
  const wrongKey = observation(raw.replace('/works/OL45804W', '/works/OL1W'));
  expect(() => projectOpenLibraryWork(wrongKey)).toThrow(SourceConversionInvalid);
  const malformedAuthors = observation(raw.replace('/authors/OL1A', '/authors/not-a-key'));
  const converted = projectOpenLibraryWork(malformedAuthors);
  expect(converted.projection.authorRefs).toBeNull();
  expect(converted.fieldInventory.find(field => field.field === 'authors')?.disposition)
    .toBe('unmapped-retained');
});
