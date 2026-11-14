import { expect, test } from 'bun:test';
import { contentShelfTitleAccessBasis } from '../../src/access/adapters/shelf-title.ts';

test('the shelf title access basis covers every fixed authority home', () => {
  const rows = Array.from({ length: 4096 }, (_, homeNo) => ({
    homeNo,
    generation: '00000000-0000-4000-8000-000000000001',
    epoch: '0',
  }));
  const initial = contentShelfTitleAccessBasis(rows);
  expect(initial).not.toBeNull();

  const changed = [...rows];
  changed[4095] = { ...changed[4095]!, epoch: '1' };
  expect(contentShelfTitleAccessBasis(changed)).not.toBe(initial);
  expect(contentShelfTitleAccessBasis(rows.slice(0, -1))).toBeNull();
  expect(contentShelfTitleAccessBasis([...rows].reverse())).toBeNull();
});
