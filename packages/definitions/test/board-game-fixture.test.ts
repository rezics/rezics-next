import { expect, test } from 'bun:test';
import { platformRegistry, validateZoneStarter } from '@rezics/composition';
import { bundledRelease, bundledSources } from '../src/bundled.ts';
import { compileCatalogue } from '../src/compile.ts';
import { releaseDigest, validateRelease } from '../src/index.ts';
import {
  boardGameFixture as fixture,
  boardGameFixtureSources,
  boardGameLocales,
  boardGameZoneStarter,
} from '../src/board-game-fixture.ts';

test('an authored board-game vertical compiles with all eight locales and preserves launch catalogue data', async () => {
  const sources = bundledSources();
  const before = structuredClone(sources);
  const release = await compileCatalogue(boardGameFixtureSources(sources));
  expect(sources).toEqual(before);
  expect(validateRelease(release)).toEqual([]);
  expect(releaseDigest(release)).not.toBe(releaseDigest(bundledRelease));
  for (const type of ['schema:Book', 'schema:Recipe', 'schema:Person'])
    expect(release.types[type]).toEqual(bundledRelease.types[type]);
  const type = release.types[fixture.type]!;
  expect(type.facets).toEqual([fixture.players, fixture.duration]);
  expect(type.listPresentation).toEqual({ imageAspect: 'square', keyFacts: [fixture.players, fixture.duration] });
  for (const locale of boardGameLocales) {
    expect(type.labels[locale]).toBeTruthy();
    expect(type.descriptions?.[locale]).toBeTruthy();
    for (const property of [fixture.players, fixture.duration])
      expect(release.properties[property]!.labels[locale]).toBeTruthy();
  }
  expect(release.filters?.[fixture.filter]?.filter).toEqual({ type: { in: [fixture.type] } });
  expect(
    validateZoneStarter(platformRegistry, boardGameZoneStarter(), {
      filters: new Set(Object.keys(release.filters ?? {})),
    }),
  ).toEqual([]);
}, 120_000);
