import { expect, test } from 'bun:test';
import { bundledRelease, bundledSources } from '../src/bundled.ts';

test('bundled works use the approved portrait frame and retain specialized frames', () => {
  for (const type of [
    'schema:Book',
    'bf:Instance',
    'schema:ComicSeries',
    'schema:PublicationVolume',
    'schema:TVSeries',
    'schema:Movie',
    'schema:TVSeason',
    'schema:Episode',
    'schema:BookSeries',
    'wd:Q7725310',
    'wd:Q2620972',
    'schema:VideoGame',
    'wd:Q689445',
    'wd:Q209163',
    'wd:Q20631656',
  ])
    expect(bundledRelease.types[type]?.coverRatio).toBe('5:7');
  expect(bundledRelease.types['wd:Q95074']?.coverRatio).toBe('3:4');
  expect(bundledRelease.types['schema:Person']?.coverRatio).toBe('3:4');
  const core = Bun.YAML.parse(bundledSources().schemas['core.yaml']!) as {
    classes: { Character: { annotations: { cover_ratio: string } } };
  };
  expect(core.classes.Character.annotations.cover_ratio).toBe('3:4');
  expect(bundledRelease.types['schema:MusicAlbum']?.coverRatio).toBe('1:1');
  expect(bundledRelease.types['schema:Recipe']?.coverRatio).toBe('4:3');
  expect(bundledRelease.types['schema:Organization']?.coverRatio).toBe('1:1');
});
