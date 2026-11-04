import { expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { albumFixture, albumId, artistId, roleId } from '../src/kernel/fake/catalogue-album-profile';
import { RecordingReader } from '../src/features/catalogue/recording-reader/view';
import { recordingReaderVisit, recordingType } from '../src/features/catalogue/recording-reader/model';
import { connectionReturnHref, subjectVisitReturn } from '../src/features/pages/subject-visit-navigation';
import { m } from '../src/paraglide/messages.js';

mock.module('cloudflare:workers', () => ({ env: {} }));

function fixture(admitted: boolean) {
  const value = albumFixture('ready', 'en');
  value.publicRead.subject.type = recordingType;
  if (admitted) {
    const album = value.release.types['schema:MusicAlbum'];
    if (!album) throw new Error('The fixture release has no album definition');
    value.release.types[recordingType] = {
      ...structuredClone(album),
      labels: { en: 'recording' },
      properties: ['schema:contributor', 'schema:datePublished'],
    };
  }
  return value;
}

test('the current release leaves Recording honest and unsupported', () => {
  const value = fixture(false);
  const visit = recordingReaderVisit({
    locale: 'en',
    public: value.publicRead,
    release: value.release,
    releaseDigest: value.publicRead.subject.release,
  });
  const html = renderToStaticMarkup(
    createElement(RecordingReader, { visit, read: value.publicRead, release: value.release, locale: 'en' }),
  );

  expect(visit.state).toBe('unsupported');
  expect(visit.type).toBe(recordingType);
  expect(visit.type).not.toBe('schema:MusicAlbum');
  expect(visit.grain.text).toBe('');
  expect(html).toContain(m.recording_reader_unsupported({}, { locale: 'en' }));
  expect(html).toContain('/details');
  expect(html).toContain('/relations');
});

test('admitted credits retain exact targets, qualifiers, partial dates and return through bounded continuation', () => {
  const value = fixture(true);
  const returnTo = connectionReturnHref(albumId, 'Harbour sessions', 'en');
  const visit = recordingReaderVisit({
    locale: 'en',
    public: value.publicRead,
    release: value.release,
    releaseDigest: value.publicRead.subject.release,
    bounds: [{ property: 'schema:contributor', loaded: 1, next: 'private-cursor', complete: false }],
  });
  const html = renderToStaticMarkup(
    createElement(RecordingReader, {
      visit,
      read: value.publicRead,
      release: value.release,
      locale: 'en',
      returnTo,
    }),
  );
  const links = [...html.matchAll(/href="([^"]+)"/g)].map(
    (match) => new URL(match[1]!.replaceAll('&amp;', '&'), 'https://rezics.test'),
  );
  const target = (id: string) => links.find((link) => link.pathname.includes(`/subjects/${id}/`));

  expect(visit.state).toBe('ready');
  expect(visit.grain.text).toBe('recording');
  expect(value.publicRead.subject.type).toBe(recordingType);
  expect(visit.type).not.toBe('schema:MusicAlbum');
  expect(visit.groups.details.map((field) => field.property)).toContain('schema:datePublished');
  expect(visit.groups.contributions.map((field) => field.property)).toContain('schema:contributor');
  expect(visit.groups.associations).toEqual([]);
  expect(html).toContain('The Harbour Ensemble');
  expect(html).toContain('Performer');
  expect(html).toContain('2024');
  const contribution = value.publicRead.subject.statements['schema:contributor']![0]!;
  const contributionMarkup = html.slice(html.indexOf(`data-statement="${contribution.id}"`)).split('</li>', 1)[0]!;
  expect(contributionMarkup).toContain('Performer');
  expect(contributionMarkup).toContain('The Harbour Ensemble');
  expect(contributionMarkup).toContain('1');
  expect(contributionMarkup).toContain('Harbour story arc');
  expect(html).not.toContain('artist.example');
  expect(target(artistId)?.searchParams.get('via')).toBe(returnTo);
  expect(target(roleId)?.searchParams.get('via')).toBe(returnTo);
  expect(target(artistId)?.pathname).not.toContain(albumId);
  const continuation = links.find((link) => link.pathname.endsWith('/relations'));
  expect(continuation?.searchParams.get('via')).toBe(returnTo);
  expect(html).not.toContain('private-cursor');
});

test('empty and withheld facts keep their released meanings and generic destinations', () => {
  const empty = fixture(true);
  empty.publicRead.subject.statements = {};
  const emptyVisit = recordingReaderVisit({
    locale: 'en',
    public: empty.publicRead,
    release: empty.release,
    releaseDigest: empty.publicRead.subject.release,
  });
  const emptyHtml = renderToStaticMarkup(
    createElement(RecordingReader, { visit: emptyVisit, read: empty.publicRead, release: empty.release, locale: 'en' }),
  );
  expect(emptyVisit.state).toBe('empty');
  expect(emptyHtml).toContain(m.recording_reader_empty({}, { locale: 'en' }));
  expect(emptyHtml).toContain('/details');
  expect(emptyHtml).toContain('/relations');

  const withheld = fixture(true);
  withheld.publicRead.subject.statements['schema:contributor']![0]!.value = { type: 'somevalue' };
  withheld.publicRead.subject.statements['schema:datePublished']![0]!.value = { type: 'novalue' };
  const withheldVisit = recordingReaderVisit({
    locale: 'en',
    public: withheld.publicRead,
    release: withheld.release,
    releaseDigest: withheld.publicRead.subject.release,
  });
  const withheldHtml = renderToStaticMarkup(
    createElement(RecordingReader, {
      visit: withheldVisit,
      read: withheld.publicRead,
      release: withheld.release,
      locale: 'en',
    }),
  );
  expect(withheldHtml).toContain(m.subject_value_unknown({}, { locale: 'en' }));
  expect(withheldHtml).toContain(m.subject_value_none({}, { locale: 'en' }));
});

test('invalid recording grain is not described as a failed release or offered a release retry', () => {
  const value = fixture(true);
  value.publicRead.subject.type = 'schema:MusicAlbum';
  const visit = recordingReaderVisit({
    locale: 'en',
    public: value.publicRead,
    release: value.release,
    releaseDigest: value.publicRead.subject.release,
  });
  const html = renderToStaticMarkup(
    createElement(RecordingReader, { visit, read: value.publicRead, release: value.release, locale: 'en', retryAvailable: true }),
  );

  expect(visit.state).toBe('invalid');
  expect(html).toContain(m.recording_reader_invalid({}, { locale: 'en' }));
  expect(html).not.toContain(m.recording_reader_retry({}, { locale: 'en' }));
  expect(html).toContain('/details');
  expect(html).toContain('/relations');
});

test('a statement return keeps the supported recording address and one existing return intent', () => {
  const value = fixture(true);
  const statement = value.publicRead.subject.statements['schema:contributor']![0]!;
  const realm = '00000000-0000-4000-8000-00000000a109';
  const outer = connectionReturnHref(seriesId, 'Harbour concerts', 'en');
  const current = `/en/subjects/${albumId}/harbour-recording?realm=${realm}&via=${encodeURIComponent(outer)}`;
  const visit = recordingReaderVisit({
    locale: 'en',
    public: value.publicRead,
    release: value.release,
    releaseDigest: value.publicRead.subject.release,
  });
  const html = renderToStaticMarkup(
    createElement(RecordingReader, {
      visit,
      read: value.publicRead,
      release: value.release,
      locale: 'en',
      currentHref: current,
    }),
  );
  const artist = [...html.matchAll(/href="([^"]+)"/g)]
    .map((match) => new URL(match[1]!.replaceAll('&amp;', '&'), 'https://rezics.test'))
    .find((url) => url.pathname.includes(`/subjects/${artistId}/`));

  expect(artist?.searchParams.get('via')).toContain(`/subjects/${albumId}/harbour-recording`);
  const returned = artist?.searchParams.get('via');
  expect(returned).toContain(`realm=${realm}`);
  expect(returned).toContain(`via=${encodeURIComponent(outer)}`);
  expect(returned).toContain(`#recording-statement-${statement.id}`);
  expect(subjectVisitReturn(returned, 'en')).toBe(returned);
  const tooDeep = `/en/subjects/${albumId}/harbour-recording?via=${encodeURIComponent(
    `/en/subjects/${seriesId}/harbour-concerts?via=${encodeURIComponent(outer)}`,
  )}`;
  expect(subjectVisitReturn(tooDeep, 'en')).toBeUndefined();
});
