import { expect, test } from 'bun:test';
import { derivedId, routeOf } from '../../src/route/route.ts';
import { placement } from '../support/growth-seed.ts';
import { subjectHistoryPopulation } from './growth-subject-history.ts';

test('selected-subject history grows at 32/128/512 without substituting same-route neighbours', () => {
  const subject = derivedId('00000000-0000-8000-8000-000000000099', 'selected', 456);
  const population = subjectHistoryPopulation(subject, 7);
  const transactions = new Set<unknown>();
  for (const scale of [32, 128, 512]) {
    let count = 0;
    for (let ordinal = 0; ordinal < scale; ordinal++) {
      const rows = population.rows!(placement(population, ordinal))['semantic.revision']!;
      for (const row of rows) {
        expect(row.subject_id).toBe(subject);
        expect(row.route).toBe(routeOf(subject));
        expect(row.revision).toBe(8 + count++);
        expect(row.source).toBeNull();
        transactions.add(row.recorded_transaction_id);
      }
    }
    expect(count).toBe(32 * scale);
    expect(transactions.size).toBe(count);
  }
});

test('a new immutable history range begins after the actual latest native revision', () => {
  const subject = derivedId('00000000-0000-8000-8000-000000000099', 'selected', 456);
  const population = subjectHistoryPopulation(subject, 16400);
  const rows = population.rows!(placement(population, 0))['semantic.revision']!;
  expect(rows[0]!.revision).toBe(16401);
  expect(rows.at(-1)!.revision).toBe(16432);
});
