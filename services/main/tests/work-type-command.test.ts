import { expect, test } from 'bun:test';
import { checkedWorkTypes, WORK_TYPE_OPTIONS } from '../src/modules/work/type-schema.ts';
import { workTypeEditDigest } from '../src/modules/work/edit.ts';
import { assertNativeWorkTypeCombination } from '../src/modules/work/activate.ts';
import { workKinds } from '../src/modules/work/work-kinds.ts';

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

test('native type compatibility retains admission policy when homepage interests change', () => {
  const book = 'https://schema.org/Book', series = 'https://schema.org/BookSeries';
  const original = workKinds[series]!.interest;
  try {
    workKinds[series]!.interest = 'software';
    expect(() => assertNativeWorkTypeCombination([book, series])).not.toThrow();
    expect(() => assertNativeWorkTypeCombination([book, 'https://schema.org/SoftwareApplication'])).toThrow();
    expect(() => assertNativeWorkTypeCombination(['https://schema.org/VideoGame', 'https://schema.org/Movie'])).not.toThrow();
    expect(() => assertNativeWorkTypeCombination(['https://schema.org/VideoGame', 'https://schema.org/SoftwareApplication'])).toThrow();
    expect(() => assertNativeWorkTypeCombination(['https://rezics.com/vocab/SkillPackage', 'https://rezics.com/vocab/PromptTemplate'])).toThrow();
  } finally { workKinds[series]!.interest = original; }
});
