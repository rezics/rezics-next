import { expect, test } from 'bun:test';
import { musicReaderVisit } from '../../src/features/catalogue/music-reader';
import { screenReaderVisit } from '../../src/features/catalogue/screen-profile';
import { catalogueEntries } from '../../src/features/catalogue/catalogue-entry';
import { sealFacts, sendFacts, stageFact } from '../../src/features/catalogue/subject-facts';
import { listView } from '../../src/features/pages/views';
import { albumFixture, albumId, artistId, roleId } from '../../src/kernel/fake/catalogue-album-profile';
import { screenProfileFixture } from '../../src/kernel/fake/catalogue-screen-profile';

test('Imported MusicAlbum Movie and TVSeries readers expose admitted profile source evidence bounded relations correction and library pins', async () => {
  expect(listView('schema:contributor')).toBe('credits');
  const album = albumFixture();
  album.publicRead.subject.sourceRecords = [
    { name: 'Harbour liner notes', url: 'https://artist.example/harbour', attribution: 'Ensemble archive' },
  ];
  const music = musicReaderVisit({
    locale: 'en',
    release: album.release,
    public: album.publicRead,
    bounds: [{ property: 'schema:contributor', loaded: 1, next: 'cursor-1', complete: false }],
  });
  expect(music.state).toBe('ready');
  expect(music.type).toBe('schema:MusicAlbum');
  expect(music.grain.text.length).toBeGreaterThan(0);
  expect(music.unpublished).toEqual({ tracks: true, library: true });
  expect(music.library).toEqual({ admitted: false, states: [], copies: false, progress: false });
  expect(music.sources).toEqual([
    { name: 'Harbour liner notes', url: 'https://artist.example/harbour', attribution: 'Ensemble archive' },
  ]);
  expect(music.bounds).toEqual([{ property: 'schema:contributor', loaded: 1, next: 'cursor-1', complete: false }]);
  expect(music.correction).toEqual({
    id: albumId,
    href: catalogueEntries.album({ id: albumId, label: 'Harbour sessions', locale: 'en' }).href,
  });
  const credit = music.groups
    .flatMap((group) => group.fields)
    .find((field) => field.property === 'schema:contributor')
    ?.values[0];
  expect(credit).toMatchObject({
    state: 'value',
    targetId: artistId,
    targetLabel: 'The Harbour Ensemble',
    creditedAs: 'The Harbour Ensemble',
    roleLabel: 'Performer',
    position: '1',
  });
  expect(music.groups.some((group) => group.fields.some((field) => field.property === 'schema:datePublished'))).toBe(
    true,
  );
  expect(musicReaderVisit({ locale: 'en', reason: 'denied' }).state).toBe('denied');
  expect(musicReaderVisit({ locale: 'en', release: album.release }).state).toBe('empty');
  expect(musicReaderVisit({ locale: 'en' }).state).toBe('unavailable');

  const originalDate = album.publicRead.subject.statements['schema:datePublished']![0]!.value;
  const current = await album.editors.facts.read();
  if (!current.ok) throw new Error('Expected current album');
  const field = stageFact(current, 'schema:datePublished', current.public.subject.statements['schema:datePublished']![0]!.id)!;
  field.statement.value = {
    type: 'value',
    content: { time: '+2025-00-00T00:00:00Z', precision: 9, calendarmodel: 'http://www.wikidata.org/entity/Q1985727' },
  };
  const sealed = sealFacts(albumId, current.release, [field]);
  await sendFacts(sealed, album.editors.facts.propose, (_property, result) => {
    field.result = result;
  });
  expect(field.result).toMatchObject({ ok: true, kind: 'proposed-awaiting-review' });
  const proposed = field.result;
  if (!proposed?.ok) throw new Error('Expected proposed candidate');
  const review = await album.editors.review('schema:datePublished').read('schema:datePublished', undefined, proposed.session);
  expect(review.ok && review.page?.candidates.some((candidate) => candidate.id === proposed.candidate)).toBe(true);
  const reread = musicReaderVisit({ locale: 'en', release: album.release, public: album.publicRead });
  expect(reread.groups.flatMap((group) => group.fields).find((field) => field.property === 'schema:datePublished')?.values[0]).toMatchObject({
    state: 'value',
    time: originalDate.type === 'value' && typeof originalDate.content === 'object' && originalDate.content && 'time' in originalDate.content
      ? originalDate.content.time
      : undefined,
  });

  for (const type of ['schema:Movie', 'schema:TVSeries'] as const) {
    const screen = screenProfileFixture('ready', 'en', true, type);
    const loaded = await screen.transport.load();
    if (!loaded.ok || !loaded.public) throw new Error(`Expected ${type}`);
    loaded.public.subject.sourceRecords = [{ name: 'Observatory notes', url: 'https://screen.example/observatory' }];
    const visit = screenReaderVisit({
      locale: 'en',
      release: loaded.release,
      public: loaded.public,
      bounds: [{ property: 'schema:director', loaded: 8, next: 'page-2', complete: false }],
    });
    expect(visit.state).toBe('ready');
    expect(visit.type).toBe(type);
    expect(visit.unpublished.episodes).toBe(true);
    expect(visit.library.admitted).toBe(true);
    expect(visit.library.profileId).toBe(type === 'schema:Movie' ? 'anime.film' : 'anime.series');
    expect(visit.library.states.length).toBeGreaterThan(0);
    expect(visit.sources).toEqual([{ name: 'Observatory notes', url: 'https://screen.example/observatory' }]);
    expect(visit.bounds[0]).toEqual({ property: 'schema:director', loaded: 8, next: 'page-2', complete: false });
    expect(visit.correction?.href).toBe(
      catalogueEntries.screen({ id: loaded.public.subject.id, label: 'The observatory', locale: 'en' }).href,
    );
  }
  expect(screenReaderVisit({ locale: 'en', type: 'schema:Movie', reason: 'denied' }).library.admitted).toBe(false);
  expect(screenReaderVisit({ locale: 'en', type: 'wd:Q11424' }).state).toBe('unavailable');
});
