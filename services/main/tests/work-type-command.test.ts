import { expect, test } from 'bun:test';
import { checkedWorkTypes, WORK_TYPE_OPTIONS } from '../src/modules/work/type-schema.ts';
import { workTypeEditDigest } from '../src/modules/work/edit.ts';

test('G398: Work type command binds an exact head and canonical replacement type set', () => {
  const work = 'https://rezics.com/id/00000000-0000-0000-0000-000000000001';
  const head = 'https://rezics.com/id/00000000-0000-0000-0000-000000000002';
  const types = ['https://rezics.com/vocab/ModPackage', 'https://schema.org/SoftwareApplication'];
  expect(checkedWorkTypes(types)).toEqual([...types].sort());
  expect(workTypeEditDigest(work, head, types)).toBe(workTypeEditDigest(work, head, [...types].reverse()));
  expect(workTypeEditDigest(work, head, types)).not.toBe(workTypeEditDigest(work, work, types));
  expect(WORK_TYPE_OPTIONS).toContain('https://schema.org/Book');
  expect(() => checkedWorkTypes(['https://schema.org/Book', 'https://schema.org/Movie'])).toThrow();
  expect(() => checkedWorkTypes(['https://schema.org/Book', 'https://schema.org/Book'])).toThrow();
  for (const concept of ['https://rezics.com/vocab/Guide', 'https://rezics.com/vocab/WebNovel',
    'https://rezics.com/vocab/Fiction']) {
    expect(() => checkedWorkTypes([concept])).toThrow();
  }
});
