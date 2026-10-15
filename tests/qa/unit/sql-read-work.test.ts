import { expect, test } from 'bun:test';
import { scanVisits } from '../integration/support/sql-read-work.ts';

test('SQL growth meter counts rejected scan rows and loops without multiplying ancestor rows', () => {
  expect(scanVisits({ 'Node Type': 'Limit', 'Actual Rows': 2, 'Actual Loops': 1, Plans: [
    { 'Node Type': 'Sort', 'Actual Rows': 2, 'Actual Loops': 1, Plans: [
      { 'Node Type': 'Seq Scan', 'Actual Rows': 2, 'Rows Removed by Filter': 98, 'Actual Loops': 1 },
    ] },
  ] })).toBe(100);
  expect(scanVisits({ 'Node Type': 'Nested Loop', Plans: [
    { 'Node Type': 'Index Scan', 'Actual Rows': 3, 'Actual Loops': 1 },
    { 'Node Type': 'Index Only Scan', 'Actual Rows': 1, 'Actual Loops': 3 },
  ] })).toBe(6);
});
