import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from 'bun:test';
import { launchCoverage } from './launch-coverage.ts';
import { verticalJourneys, verticalJourneyFilter } from './vertical-journeys.ts';

test('every scope vertical names one existing browser proof or explains its missing journey', () => {
  expect(verticalJourneys.map(journey => journey.kind).sort())
    .toEqual([...new Set(launchCoverage.map(row => row.kind).filter(kind => kind !== 'catalogue'))].sort());
  for (const journey of verticalJourneys) {
    if ('missing' in journey) { expect(journey.missing.trim()).not.toBe(''); continue; }
    expect(existsSync(resolve(import.meta.dir, '../../..', journey.file))).toBe(true);
    expect(launchCoverage.some(row => row.kind === journey.kind && 'file' in row.browser
      && row.browser.file === journey.file && row.browser.test === journey.test)).toBe(true);
  }
  const named = verticalJourneys.flatMap(journey => 'file' in journey ? [`${journey.file}:${journey.test}`] : []);
  expect(new Set(named).size).toBe(named.length);
});

test('the nightly filter escapes literal titles and rejects adjacent tests', () => {
  const filter = new RegExp(verticalJourneyFilter(['reader (phone) [en].', 'author + save?']));
  expect(filter.test('desktop-chrome file.e2e.ts reader (phone) [en].')).toBe(true);
  expect(filter.test('author + save?')).toBe(true);
  expect(filter.test('another reader (phone) [en]. expanded')).toBe(false);
  expect(filter.test('other-reader (phone) [en].')).toBe(false);
  expect(() => verticalJourneyFilter([])).toThrow('named journey');
});
