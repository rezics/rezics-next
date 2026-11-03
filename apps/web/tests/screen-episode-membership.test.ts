import { expect, mock, test } from 'bun:test';
import type { Release } from '@rezics/definitions';
import definitions from '../src/kernel/recorded/definitions-release.json';

mock.module('cloudflare:workers', () => ({ env: {} }));

const {
  episodeJourneyFromCreate,
  episodeMembershipAdmission,
  locateCreatedChild,
  markEpisodeLinked,
  membershipCreateStatement,
  screenSeriesId,
  seriesEpisodeEntry,
  seriesPartsHref,
} = await import('../src/features/catalogue/screen-episode-membership.ts');
type CreatedReader = import('../src/features/catalogue/create-subject').CreatedReader;

const release = definitions.release as Release;
const series = '00000000-0000-4000-8000-000000000301';
const episode = '00000000-0000-4000-8000-000000000302';
const ready: CreatedReader = { state: 'ready', href: `/en/subjects/${episode}/pilot` };

test('series context ignores unrelated route text and only TVSeries may open episode membership', () => {
  expect(screenSeriesId('not-a-uuid')).toBeUndefined();
  expect(screenSeriesId(series)).toBe(series);
  expect(seriesEpisodeEntry(release, 'schema:TVSeries')).toBe(true);
  expect(seriesEpisodeEntry(release, 'schema:TVSeason')).toBe(false);
  expect(seriesEpisodeEntry(release, 'schema:Movie')).toBe(false);
  expect(episodeMembershipAdmission(release, 'schema:TVSeries')).toEqual({
    property: 'schema:isPartOf',
    admitted: true,
    positionAdmitted: false,
    seriesAdmitted: true,
  });
});

test('confirmed admitted membership may enter create; omitted membership and unread stay unlinked', () => {
  expect(membershipCreateStatement(release, 'schema:TVSeries', undefined)).toBeUndefined();
  expect(
    membershipCreateStatement(release, 'schema:TVSeries', { target: 'not-a-uuid', position: '1' }),
  ).toBeUndefined();
  const included = membershipCreateStatement(release, 'schema:TVSeries', { target: series, position: 'S2.5' });
  expect(included).toMatchObject({
    property: { id: 'schema:isPartOf' },
    value: { type: 'value', content: series },
    qualifiers: [],
  });
  expect(
    episodeJourneyFromCreate(
      { ok: true, id: episode, reader: { state: 'unavailable' } },
      { target: series, position: '' },
      false,
    ),
  ).toEqual({ stage: 'unread', id: episode });
  expect(
    episodeJourneyFromCreate({ ok: true, id: episode, reader: ready }, { target: series, position: '' }, false),
  ).toEqual({ stage: 'unlinked', id: episode, reader: ready });
  expect(
    episodeJourneyFromCreate({ ok: true, id: episode, reader: ready }, { target: series, position: '' }, true),
  ).toEqual({
    stage: 'created',
    id: episode,
    reader: ready,
  });
  expect(markEpisodeLinked({ stage: 'unread', id: episode })).toEqual({ stage: 'unread', id: episode });
  expect(markEpisodeLinked({ stage: 'unlinked', id: episode, reader: ready })).toEqual({
    stage: 'linked',
    id: episode,
    reader: ready,
  });
});

test('return highlights a child on the current page and otherwise locates its identity', () => {
  expect(seriesPartsHref({ id: series, label: 'Night Watch' }, 'en', episode)).toBe(
    `/en/subjects/${series}/night-watch/work-parts?child=${episode}`,
  );
  const onPage = { holder: episode, statementId: 's1', summary: { id: episode }, related: {} } as never;
  const other = { holder: series, statementId: 's1', summary: { id: series }, related: {} } as never;
  expect(locateCreatedChild([onPage], episode)?.holder).toBe(episode);
  expect(locateCreatedChild([other], episode)).toBeUndefined();
});
