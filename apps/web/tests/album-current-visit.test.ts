import { expect, test } from 'bun:test';
import {
  albumCurrentVisitMatches,
  createAlbumCurrentVisitLink,
  parseAlbumCurrentVisitSearch,
  type AlbumCurrentReading,
  type AlbumCurrentVisitOrigin,
} from '../src/features/catalogue/album-current-visit-model';
import { subjectVisitReturn } from '../src/features/pages/subject-visit-navigation';
import { candidateContext } from '../src/subject/candidates';

const subjectId = '00000000-0000-4000-8000-00000000a101';
const address = `/en/subjects/${subjectId}/harbour-sessions#connections`;
const validateAddress = (value: unknown, locale: string) => subjectVisitReturn(value, locale);

function origin(): AlbumCurrentVisitOrigin {
  return {
    version: 1,
    subject: { id: subjectId, type: 'schema:MusicAlbum', label: 'Harbour sessions' },
    address,
    locale: 'en',
    context: { id: candidateContext, population: 'global', label: 'Global' },
    release: 'release-1',
    reader: 'reader-1',
  };
}

test('public Album intent is closed, byte-bounded and never selects an assertion', () => {
  const visit = origin();
  const entry = createAlbumCurrentVisitLink(
    `/en/subjects/${subjectId}/harbour-sessions/album`,
    visit,
    'en',
    validateAddress,
  );
  expect(entry.token).not.toBe('unsupported');
  expect(new TextEncoder().encode(`visit=${entry.token}`).byteLength).toBeLessThanOrEqual(2048);
  expect(parseAlbumCurrentVisitSearch(`?visit=${entry.token}`, 'en', validateAddress)).toEqual({
    state: 'origin',
    token: entry.token,
    origin: visit,
  });
  expect(parseAlbumCurrentVisitSearch(`?visit=${entry.token}&visit=${entry.token}`, 'en', validateAddress)).toEqual({
    state: 'unsupported',
  });
  expect(parseAlbumCurrentVisitSearch(`?visit=${entry.token}&source=assertion`, 'en', validateAddress)).toEqual({
    state: 'unsupported',
  });
  expect(
    createAlbumCurrentVisitLink(
      `/en/subjects/${subjectId}/harbour-sessions/album`,
      { ...visit, privateDraft: 'must not be retained' },
      'en',
      validateAddress,
    ).token,
  ).toBe('unsupported');
  expect(
    createAlbumCurrentVisitLink(
      `/en/subjects/${subjectId}/harbour-sessions/album`,
      { ...visit, subject: { ...visit.subject, label: 'é'.repeat(257) } },
      'en',
      validateAddress,
    ).token,
  ).toBe('unsupported');
});

test('a deliberate return matches only the freshly admitted Album visit', () => {
  const visit = origin();
  const current: AlbumCurrentReading = {
    subjectId,
    locale: 'en',
    context: visit.context,
    release: visit.release,
    reader: visit.reader,
    address,
  };
  expect(albumCurrentVisitMatches(visit, current)).toBe(true);
  for (const changed of [
    { ...current, context: { ...current.context, id: '00000000-0000-4000-8000-00000000b101' } },
    { ...current, reader: 'reader-2' },
    { ...current, release: 'release-2' },
    { ...current, address: `${address}?realm=00000000-0000-4000-8000-00000000b101` },
  ])
    expect(albumCurrentVisitMatches(visit, changed)).toBe(false);
});
