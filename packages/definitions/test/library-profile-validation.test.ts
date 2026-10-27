import { expect, test } from 'bun:test';
import { Compile } from 'typebox/schema';
import schema from '../schema/release.json';
import { CatalogueError, compileCatalogue } from '../src/compile.ts';
import { validateRelease } from '../src/index.ts';
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
  expect(compileCatalogue(input)).rejects.toBeInstanceOf(CatalogueError);
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
  expect(release.libraryProfiles!['constructor']).toEqual(compiledProfile(source));
  expect(validateRelease(release)).toEqual([]);
  const invalid = releaseWith();
  Object.defineProperty(invalid.libraryProfiles!, '__proto__', { value: { id: '__proto__' }, enumerable: true });
  expect(validateRelease(invalid).some((error) => error.pointer.startsWith('/libraryProfiles'))).toBe(true);
});
