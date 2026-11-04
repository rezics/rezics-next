import { expect, test } from 'bun:test';
import { mangaReaderAddress } from '../src/features/catalogue/manga-reader/navigation';
import {
  subjectRouteSearchLimit,
  subjectVisitReturn,
  withSubjectVisitReturn,
} from '../src/features/pages/subject-visit-navigation';
import { subjectHref } from '../src/subject/subject-href';

const seriesId = '0192f3a0-6c1e-7b2a-9d4e-000000000901';
const volumeId = '0192f3a0-6c1e-7b2a-9d4e-000000000902';
const realmId = '0192f3a0-6c1e-7b2a-9d4e-000000000999';

test('part navigation returns to the exact localized subject, Realm, view and opaque page window', () => {
  const cursor = `opaque/${'x'.repeat(4000)}?next`;
  const returnTo = mangaReaderAddress({
    id: seriesId,
    label: 'The Harbour Atlas',
    locale: 'ja',
    view: 'contents',
    realm: realmId,
    continuation: { node: 'chapter-window', cursor },
  });
  const parsed = new URL(returnTo, 'https://rezics.test');
  expect(parsed.pathname).toBe(`/ja/subjects/${seriesId}/the-harbour-atlas/contents`);
  expect(parsed.searchParams.get('realm')).toBe(realmId);
  expect(parsed.searchParams.get('node')).toBe('chapter-window');
  expect(parsed.searchParams.get('cursor')).toBe(cursor);
  expect(parsed.hash).toBe('#manga-reader');
  expect(subjectVisitReturn(returnTo, 'ja')).toBe(returnTo);

  const destination = subjectHref({ id: volumeId, label: 'Volume 1' }, 'ja').href;
  const linked = new URL(withSubjectVisitReturn(destination, returnTo, 'ja'), 'https://rezics.test');
  expect(linked.pathname).toBe(`/ja/subjects/${volumeId}/volume-1`);
  expect(linked.searchParams.get('via')).toBe(returnTo);
  const search = `?via=${encodeURIComponent(returnTo)}`;
  expect(search.length).toBeLessThanOrEqual(subjectRouteSearchLimit(search));
});

test('return links reject foreign, mismatched, nested or malformed windows', () => {
  const valid = `/en/subjects/${seriesId}/the-harbour-atlas/editions?node=edition-window&cursor=opaque%2Fpage#connections`;
  expect(subjectVisitReturn(valid, 'en')).toBe(valid);
  for (const unsafe of [
    '//attacker.test/en/subjects/x/y',
    'https://attacker.test/en/subjects/x/y',
    `/ja/subjects/${seriesId}/title/contents`,
    `/en/subjects/${seriesId}/unknown-view`,
    `/en/subjects/${seriesId}/title?node=edition-window&cursor=opaque`,
    `/en/subjects/${seriesId}/title/contents?node=bad%20node&cursor=opaque`,
    `/en/subjects/${seriesId}/title/contents?node=edition-window&cursor=opaque&cursor=other`,
    `/en/subjects/${seriesId}/title/contents?node=edition-window&cursor=opaque&via=nested`,
  ])
    expect(subjectVisitReturn(unsafe, 'en')).toBeUndefined();
  expect(subjectRouteSearchLimit(`?via=${encodeURIComponent('x'.repeat(40000))}`)).toBe(2048);
});
