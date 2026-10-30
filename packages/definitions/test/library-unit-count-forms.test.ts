import { expect, test } from 'bun:test';
import { validateRelease } from '../src/index.ts';
import { bundledRelease } from '../src/bundled.ts';

function withForms(forms: unknown) {
  const release = structuredClone(bundledRelease);
  const unit = release.libraryProfiles!['legacy-fixed-v1']!.progress!.allowed[0]!.units[0]!;
  unit.id = 'chapter-segment';
  Object.defineProperty(unit, 'countForms', { value: forms, enumerable: true, configurable: true });
  return release;
}

test('an arbitrary released unit accepts optional localized count forms without changing singular labels', () => {
  expect(validateRelease(bundledRelease)).toEqual([]);
  const release = withForms({ en: { one: 'segment', other: 'segments' }, ja: { other: '区間' } });
  const unit = release.libraryProfiles!['legacy-fixed-v1']!.progress!.allowed[0]!.units[0]!;
  expect(validateRelease(release)).toEqual([]);
  expect(unit.id).toBe('chapter-segment');
  expect(unit.labels).toEqual(
    bundledRelease.libraryProfiles!['legacy-fixed-v1']!.progress!.allowed[0]!.units[0]!.labels,
  );
});

for (const [name, forms] of [
  ['missing other', { en: { one: 'segment' } }],
  ['unknown category', { en: { other: 'segments', several: 'segments' } }],
  ['unknown locale', { xx: { other: 'segments' } }],
  ['empty text', { en: { other: '' } }],
  ['oversized text', { en: { other: 'x'.repeat(81) } }],
  ['non-string text', { en: { other: 5 } }],
] as const) {
  test(`localized count forms reject ${name}`, () => {
    expect(validateRelease(withForms(forms)).length).toBeGreaterThan(0);
  });
}
