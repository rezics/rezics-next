import { expect, mock, test } from 'bun:test';
import { bundledRelease } from '@rezics/definitions/bundled';
import { catalogueEntries } from '../src/features/catalogue/catalogue-entry';
import { musicContextCreateFields, musicContextCreateTypes } from '../src/features/catalogue/music-context-create';
import { musicContextKind } from '../src/features/catalogue/music-context-profile';

mock.module('cloudflare:workers', () => ({ env: {} }));

test('music-context creation exposes only real released grains and emitted fields', () => {
  const offered = musicContextCreateTypes(bundledRelease, 'en');
  expect(offered.map(({ id }) => id).sort()).toEqual(
    Object.keys(bundledRelease.types)
      .filter((id) => musicContextKind(bundledRelease, id) !== 'unsupported')
      .sort(),
  );
  for (const type of offered) {
    expect(type.bases).toEqual(bundledRelease.types[type.id]!.bases);
    expect(
      musicContextCreateFields(bundledRelease, type.id).every((id) =>
        bundledRelease.types[type.id]!.properties.includes(id),
      ),
    ).toBe(true);
  }
});

test('generic creation links to the localized music-context visit', () => {
  expect(catalogueEntries.musicContextCreate({ locale: 'fr' })).toMatchObject({
    group: 'create',
    href: '/fr/catalogue/music-context',
  });
});
