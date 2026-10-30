import { expect, test } from 'bun:test';
import { Compile } from 'typebox/schema';
import schema from '../schema/release.json';
import { CatalogueError, compileCatalogue } from '../src/compile.ts';
import { validateRelease } from '../src/index.ts';
import type { LibraryCountForms, LibraryLabels } from '../src/index.ts';
import { compiledProfile, fixture, libraryProfile, releaseWith, unitData } from './support/library-profiles.ts';

test('an optional empty library registry accepts no capabilities and never resolves a missing reference', () => {
  const release = releaseWith();
  release.libraryProfiles = {};
  expect(validateRelease(release)).toContainEqual({ pointer: '/types/ex:Child/library', code: 'invalid' });
  delete release.types['ex:Child']!.library;
  expect(validateRelease(release)).toEqual([]);
});

test('a minimal id-only profile compiles without invented capabilities or label homes', async () => {
  const release = await compileCatalogue(fixture({ id: 'fixture.reading' }));
  expect(release.libraryProfiles!['fixture.reading']).toEqual({ id: 'fixture.reading' });
  expect(release.types['ex:Child']!.library).toEqual({ profileId: 'fixture.reading' });
  expect(validateRelease(release)).toEqual([]);
  const input = fixture({ id: 'fixture.reading' });
  const labels = JSON.parse(input.presentation['fixture/en']!);
  labels.libraryProfiles['fixture.reading'].states = {};
  input.presentation['fixture/en'] = JSON.stringify(labels);
  await expect(compileCatalogue(input)).rejects.toBeInstanceOf(CatalogueError);
});

test('library labels count supplementary Unicode characters as code points', async () => {
  const input = fixture();
  const labels = JSON.parse(input.presentation['fixture/en']!);
  labels.libraryProfiles['fixture.reading'].states.planned = '🌱'.repeat(80);
  input.presentation['fixture/en'] = JSON.stringify(labels);
  const release = await compileCatalogue(input);
  expect(release.libraryProfiles!['fixture.reading']!.entryStateSet!.states[0]!.labels.en).toBe('🌱'.repeat(80));
  expect(validateRelease(release)).toEqual([]);
  release.libraryProfiles!['fixture.reading']!.entryStateSet!.states[0]!.labels.en += '🌱';
  expect(validateRelease(release)).toContainEqual({
    pointer: '/libraryProfiles/fixture.reading/entryStateSet/states/0/labels/en',
    code: 'invalid',
  });
});

test('closed JSON schema independently rejects mode-specific descriptor and total policy mismatches', () => {
  const validator = Compile(schema);
  for (const mode of ['scalar_amount', 'cursor_position', 'completed_units']) {
    const source = libraryProfile();
    source.progress.allowed = [{ mode, units: [unitData('page', mode)] }];
    const valid = releaseWith(compiledProfile(source));
    expect(validator.Check(valid)).toBe(true);
    const invalid = structuredClone(valid);
    invalid.libraryProfiles!['fixture.reading']!.progress!.allowed[0]!.units[0]!.identity = {
      kind: mode === 'completed_units' ? 'none' : 'session_local',
    };
    expect(validator.Check(invalid)).toBe(false);
    if (mode !== 'scalar_amount') {
      valid.libraryProfiles!['fixture.reading']!.progress!.allowed[0]!.units[0]!.totalPolicy = 'required';
      expect(validator.Check(valid)).toBe(false);
    }
  }
});

test('valid data identifiers that shadow object prototypes compile as ordinary own registry keys', async () => {
  const source = libraryProfile('constructor', 'prototype');
  source.entryStateSet.states[0].id = 'constructor';
  const release = await compileCatalogue(fixture(source));
  expect(Object.hasOwn(release.libraryProfiles!, 'constructor')).toBe(true);
  expect(compiledProfile(source)).toEqual(release.libraryProfiles!['constructor']!);
  expect(validateRelease(release)).toEqual([]);
  const invalid = releaseWith();
  Object.defineProperty(invalid.libraryProfiles!, '__proto__', { value: { id: '__proto__' }, enumerable: true });
  expect(validateRelease(invalid).some((error) => error.pointer.startsWith('/libraryProfiles'))).toBe(true);
});

// The frozen count-forms acceptance is complemented here through the real catalogue binder.
const countHome = '/libraryProfiles/fixture.reading/units/scalar_amount/chapter-segment';
function countInput() {
  return fixture(libraryProfile('fixture.reading', 'chapter-segment'));
}
function present(input: ReturnType<typeof fixture>, locale: string, leaf: unknown) {
  const key = `fixture/${locale}`;
  const body = JSON.parse(input.presentation[key] ?? input.presentation['fixture/en']!);
  body.libraryProfiles['fixture.reading'].units.scalar_amount['chapter-segment'] = leaf;
  input.presentation[key] = JSON.stringify(body);
}
async function countErrors(input: ReturnType<typeof fixture>) {
  try {
    await compileCatalogue(input);
  } catch (error) {
    expect(error).toBeInstanceOf(CatalogueError);
    return (error as CatalogueError).violations;
  }
  throw new Error('Malformed count presentation compiled');
}

test('arbitrary unit forms bind only the authored label language and preserve structural descriptors', async () => {
  const input = countInput();
  present(input, 'en', { label: 'segment', countForms: { one: 'segment', other: 'segments' } });
  present(input, 'ja', '区間');
  const original = structuredClone(input);
  const release = await compileCatalogue(input);
  const unit = release.libraryProfiles!['fixture.reading']!.progress!.allowed[0]!.units[0]!;
  expect(unit).toEqual({
    ...unitData('chapter-segment'),
    labels: {
      en: 'segment',
      de: 'chapter-segment',
      es: 'chapter-segment',
      fr: 'chapter-segment',
      ja: '区間',
      ko: 'chapter-segment',
      'zh-Hans': 'chapter-segment',
      'zh-Hant': 'chapter-segment',
    },
    countForms: { en: { one: 'segment', other: 'segments' } },
  });
  expect(unit.countForms?.ja).toBeUndefined();
  expect(validateRelease(release)).toEqual([]);
  expect(input).toEqual(original);
  expect(await compileCatalogue(input)).toEqual(release);
  expect(release.types['ex:Child']!.library).toEqual({ profileId: 'fixture.reading' });
});

test('forms need no English counterpart and old scalar string syntax emits no invented metadata', async () => {
  const input = countInput();
  present(input, 'ja', { label: '区間', countForms: { other: '区間' } });
  const release = await compileCatalogue(input);
  const unit = release.libraryProfiles!['fixture.reading']!.progress!.allowed[0]!.units[0]!;
  expect(unit.countForms).toEqual({ ja: { other: '区間' } });
  expect(unit.countForms?.en).toBeUndefined();
  expect(validateRelease(release)).toEqual([]);
  present(input, 'ja', '区間');
  const old = await compileCatalogue(input);
  expect(old.libraryProfiles!['fixture.reading']!.progress!.allowed[0]!.units[0]!).not.toHaveProperty('countForms');
  expect(validateRelease(old)).toEqual([]);
});

for (const [leaf, suffix] of [
  [{ label: 'segment', countForms: { one: 'segment' } }, '/countForms/other'],
  [{ label: 'segment', countForms: { other: 'segments', several: 'segments' } }, '/countForms/several'],
  [{ label: 'segment', countForms: { other: '' } }, '/countForms/other'],
  [{ label: 'segment', countForms: { other: '🌱'.repeat(81) } }, '/countForms/other'],
  [{ label: 'segment', countForms: { other: 5 } }, '/countForms/other'],
  [{ label: 'segment', countForms: [] }, '/countForms'],
  [{ label: 'segment' }, '/countForms'],
  [{ countForms: { other: 'segments' } }, '/label'],
  [{ label: '', countForms: { other: 'segments' } }, '/label'],
  [{ label: 'segment', countForms: { other: 'segments' }, extra: true }, '/extra'],
] as const) {
  test(`unit presentation reports the exact malformed leaf pointer ${suffix}: ${JSON.stringify(leaf)}`, async () => {
    const input = countInput();
    present(input, 'en', leaf);
    expect(await countErrors(input)).toContainEqual(
      expect.objectContaining({ file: 'presentation/fixture/en', pointer: countHome + suffix, code: 'invalid' }),
    );
  });
}

test('unknown locale and unit home fail at their exact presentation pointer', async () => {
  const input = countInput();
  present(input, 'xx', { label: 'segment', countForms: { other: 'segments' } });
  expect(await countErrors(input)).toContainEqual(
    expect.objectContaining({
      file: 'presentation/fixture/xx',
      pointer: '/libraryProfiles/fixture.reading',
      code: 'invalid',
    }),
  );
  delete input.presentation['fixture/xx'];
  const body = JSON.parse(input.presentation['fixture/en']!);
  body.libraryProfiles['fixture.reading'].units.scalar_amount.invented = {
    label: 'segment',
    countForms: { other: 'segments' },
  };
  input.presentation['fixture/en'] = JSON.stringify(body);
  expect(await countErrors(input)).toContainEqual(
    expect.objectContaining({
      pointer: '/libraryProfiles/fixture.reading/units/scalar_amount/invented',
      code: 'invalid',
    }),
  );
});

test('unit object syntax is refused for states, copy kinds and statuses', async () => {
  for (const path of [
    ['states', 'planned'],
    ['copyKinds', 'physical'],
    ['copyStatuses', 'physical', 'owned'],
  ]) {
    const input = countInput();
    const body = JSON.parse(input.presentation['fixture/en']!);
    let parent = body.libraryProfiles['fixture.reading'];
    for (const key of path.slice(0, -1)) parent = parent[key]!;
    parent[path.at(-1)!] = { label: 'item', countForms: { other: 'items' } };
    input.presentation['fixture/en'] = JSON.stringify(body);
    expect(await countErrors(input)).toContainEqual(
      expect.objectContaining({ pointer: `/libraryProfiles/fixture.reading/${path.join('/')}`, code: 'invalid' }),
    );
  }
});

test('countForms is recursively refused by source declarations and LinkML annotations', async () => {
  const { validateLibraryProfileSource } = await import('../src/library-profile.ts');
  for (const path of [
    [],
    ['progress', 'allowed', 0, 'units', 0],
    ['entryStateSet', 'states', 0],
    ['copies', 'kinds', 0],
    ['copies', 'kinds', 0, 'statuses', 0],
  ]) {
    const source = libraryProfile('fixture.reading', 'chapter-segment');
    let parent: any = source;
    for (const key of path) parent = parent[key]!;
    parent.countForms = { en: { other: 'segments' } };
    const pointers: string[] = [];
    expect(validateLibraryProfileSource(source, (p) => pointers.push(p))).toBe(false);
    const pointer = `/${[...path, 'countForms'].join('/')}`;
    expect(pointers).toContain(pointer);
    expect(await countErrors(fixture(source))).toContainEqual(
      expect.objectContaining({
        file: 'fixture.yaml',
        pointer: '/classes/Parent/annotations/library' + pointer,
        code: 'invalid',
      }),
    );
  }
});

test('release form validation uses exact locale/category pointers and Unicode code point bounds', async () => {
  const release = await compileCatalogue(countInput());
  const unit = release.libraryProfiles!['fixture.reading']!.progress!.allowed[0]!.units[0]!;
  const home = '/libraryProfiles/fixture.reading/progress/allowed/0/units/0/countForms';
  for (const [forms, pointer] of [
    [{ xx: { other: 'segments' } }, '/xx'],
    [{ en: { one: 'segment' } }, '/en/other'],
    [{ en: { other: 'segments', several: 'segments' } }, '/en/several'],
    [{ en: { other: '' } }, '/en/other'],
    [{ en: { other: 5 } }, '/en/other'],
    [{ en: { other: '🌱'.repeat(81) } }, '/en/other'],
  ] as const) {
    Object.defineProperty(unit, 'countForms', { value: forms, enumerable: true, configurable: true });
    expect(validateRelease(release)).toContainEqual({ pointer: home + pointer, code: 'invalid' });
  }
  Object.defineProperty(unit, 'countForms', {
    value: { en: { zero: 'none', one: 'single', two: 'pair', few: 'few', many: 'many', other: '🌱'.repeat(80) } },
    enumerable: true,
    configurable: true,
  });
  expect(validateRelease(release)).toEqual([]);
  const input = countInput();
  present(input, 'en', { label: '🌱'.repeat(80), countForms: unit.countForms!.en });
  expect(validateRelease(await compileCatalogue(input))).toEqual([]);
});

test('bundled countable units carry all eight authored locale maps and percent descriptors stay unchanged', async () => {
  const { bundledSources, bundledRelease } = await import('../src/bundled.ts');
  const expected: Record<keyof LibraryLabels, Record<string, LibraryCountForms>> = (
    await import('./fixtures/library-count-forms.json')
  ).default;
  const release = await compileCatalogue(bundledSources());
  expect(release).toEqual(bundledRelease);
  for (const profile of Object.values(release.libraryProfiles!))
    for (const mode of profile.progress?.allowed ?? [])
      for (const unit of mode.units) {
        if (unit.dimension === 'percent') {
          expect(unit).not.toHaveProperty('countForms');
          continue;
        }
        expect(Object.keys(unit.countForms!).sort()).toEqual([
          'de',
          'en',
          'es',
          'fr',
          'ja',
          'ko',
          'zh-Hans',
          'zh-Hant',
        ]);
        for (const locale of Object.keys(expected) as (keyof typeof expected)[]) {
          expect(unit.countForms![locale]).toEqual((expected[locale] as Record<string, LibraryCountForms>)[unit.id]);
          expect(unit.labels[locale]).toBe(unit.countForms![locale]!.one ?? unit.countForms![locale]!.other);
        }
      }
});
