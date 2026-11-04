import { expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { albumFixture, albumId, artistId, roleId } from '../src/kernel/fake/catalogue-album-profile';
import { RecordingReader } from '../src/features/catalogue/recording-reader/view';
import { recordingReaderVisit, recordingType } from '../src/features/catalogue/recording-reader/model';
import { connectionReturnHref } from '../src/features/pages/subject-visit-navigation';
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
  expect(html).toContain(m.recording_reader_unsupported({}, { locale: 'en' }));
  expect(html).toContain('/details');
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
  expect(html).toContain('The Harbour Ensemble');
  expect(html).toContain('Performer');
  expect(html).toContain('2024');
  expect(target(artistId)?.searchParams.get('via')).toBe(returnTo);
  expect(target(roleId)?.searchParams.get('via')).toBe(returnTo);
  const continuation = links.find((link) => link.pathname.endsWith('/relations'));
  expect(continuation?.searchParams.get('via')).toBe(returnTo);
  expect(html).not.toContain('private-cursor');
});
