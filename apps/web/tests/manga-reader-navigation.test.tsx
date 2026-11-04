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

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { dirname } from 'node:path';
import type { Subject } from '../src/subject/types';
import { defaultReader } from '../src/subject/reader';
import { MangaReaderEntry } from '../src/features/catalogue/manga-reader/entry';
import {
  mangaOccurrenceFragment,
  mangaOccurrenceFromFragment,
  mangaOccurrenceKey,
  mangaSelectedAddress,
  mangaRestartAddress,
} from '../src/features/catalogue/manga-reader/navigation';

const occurrence = {
  node: 'chapter-window',
  direction: 'inverse' as const,
  property: 'schema:isPartOf',
  holder: volumeId,
  statement: 'original-assertion',
  target: volumeId,
};

test('an occurrence opener remains a finite single-hop intent through actual part and holder destinations', () => {
  const address = mangaReaderAddress({
    id: seriesId,
    label: 'The Harbour Atlas',
    locale: 'ja',
    view: 'contents',
    realm: realmId,
    continuation: { node: 'chapter-window', cursor: 'opaque/first?native' },
  });
  const origin = mangaSelectedAddress(address, occurrence);
  expect(subjectVisitReturn(origin, 'ja')).toBe(origin);
  expect(mangaOccurrenceFromFragment(new URL(origin, 'https://rezics.test').hash)).toEqual(occurrence);
  for (const destination of [
    `/ja/subjects/${volumeId}/volume-1`,
    `/ja/subjects/${volumeId}/volume-1/relation-edit?realm=${realmId}`,
  ]) {
    const href = withSubjectVisitReturn(destination, origin, 'ja');
    const receiving = new URL(href, 'https://rezics.test');
    const returned = subjectVisitReturn(receiving.searchParams.get('via'), 'ja');
    expect(returned).toBe(origin);
    expect(withSubjectVisitReturn(href, address, 'ja')).toBe(href);
    const url = new URL(returned!, receiving);
    expect(url.searchParams.get('realm')).toBe(realmId);
    expect(url.searchParams.get('node')).toBe('chapter-window');
    expect(url.searchParams.get('cursor')).toBe('opaque/first?native');
    expect(mangaOccurrenceKey(mangaOccurrenceFromFragment(url.hash)!)).toBe(mangaOccurrenceKey(occurrence));
  }
  const restart = new URL(mangaRestartAddress(origin), 'https://rezics.test');
  expect(restart.searchParams.has('cursor')).toBe(false);
  expect(restart.searchParams.get('node')).toBe('chapter-window');
  expect(restart.searchParams.get('realm')).toBe(realmId);
  for (const bad of [
    `${mangaOccurrenceFragment(occurrence)}&statement=other`,
    mangaOccurrenceFragment(occurrence).replace('direction=inverse', 'direction=sideways'),
    '#manga-reader?holder=only-a-holder',
    '#manga-reader?' + 'x'.repeat(2048),
  ]) {
    expect(mangaOccurrenceFromFragment(bad)).toBeUndefined();
    expect(subjectVisitReturn(`${address.split('#')[0]}${bad}`, 'ja')).toBeUndefined();
  }
});

test('the mounted Entry re-admits an exact return and recovery never revives a retired page on click', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const browser = new Window({ url: 'https://rezics.test/' });
  const globals = {
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    HTMLElement: browser.HTMLElement,
    Element: browser.Element,
    Node: browser.Node,
    MutationObserver: browser.MutationObserver,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const host = browser.document.createElement('div');
  browser.document.body.append(host);
  const root = createRoot(host);
  const address = mangaReaderAddress({
    id: seriesId,
    label: 'The Harbour Atlas',
    locale: 'ja',
    view: 'contents',
    realm: realmId,
    continuation: { node: 'chapter-window', cursor: 'opaque/first?native' },
  });
  const origin = mangaSelectedAddress(address, occurrence);
  const nativeRow = {
    subject: volumeId,
    property: 'schema:isPartOf',
    statement: 'original-assertion',
    label: 'Volume 1',
    summary: { id: volumeId, type: 'schema:PublicationVolume', label: { value: 'Volume 1', language: 'en' } },
    assertion: {
      id: 'original-assertion',
      rank: 'normal',
      property: { id: 'schema:isPartOf', data_type: 'wikibase-item' },
      value: { type: 'value', content: seriesId },
      qualifiers: [],
      references: [],
      rezics: { release: 'release-a', revision: 1 },
    },
  };
  const source = {};
  const props = {
    source,
    subject: {
      id: seriesId,
      type: 'schema:ComicSeries',
      labels: { en: 'The Harbour Atlas' },
      statements: {},
      context: realmId,
    } as unknown as Subject,
    label: 'The Harbour Atlas',
    locale: 'ja',
    view: 'contents',
    realm: realmId,
    context: realmId,
    continuation: { node: 'chapter-window', cursor: 'opaque/first?native' },
    viewer: 'viewer-a',
    admission: 'credential-a',
    definitions: {
      'schema:isPartOf': { label: 'Volumes', forwardLabel: 'Part of', group: 'membership' as const, symmetric: false },
    },
    windows: [
      {
        node: 'chapter-window',
        property: 'schema:isPartOf',
        direction: 'inverse' as const,
        rows: [nativeRow],
        status: 200,
        valid: true,
        complete: true,
      },
    ],
    reader: defaultReader,
    currentHref: origin,
  };
  try {
    await act(async () => root.render(createElement(MangaReaderEntry, props)));
    expect(host.querySelector('[data-selected="true"]')?.getAttribute('data-statement-id')).toBe('original-assertion');
    expect(browser.document.activeElement).toBe(host.querySelector('button'));
    const part = host.querySelector(`a[href*="${volumeId}"]`)!;
    const partUrl = new URL(part.getAttribute('href')!, 'https://rezics.test');
    expect(partUrl.searchParams.get('via')).toBe(origin);
    const correction = host.querySelector('a[href*="relation-edit"]')!;
    expect(new URL(correction.getAttribute('href')!, 'https://rezics.test').searchParams.get('via')).toBe(origin);

    // An equal successful source replacement retires this instance, even with the same row object.
    await act(async () => root.render(createElement(MangaReaderEntry, { ...props, source: {} })));
    expect(host.querySelector('[data-state="stale"]')).not.toBeNull();
    expect(host.querySelector('button')).toBeNull();
    const recovery = host.querySelector('a')!;
    expect(recovery.getAttribute('href')).toBe(address);
    recovery.addEventListener('click', (event) => event.preventDefault());
    await act(async () => recovery.click());
    expect(host.querySelector('[data-state="stale"]')).not.toBeNull();
    expect(host.querySelector('button')).toBeNull();
    await act(async () => root.render(createElement(MangaReaderEntry, props)));
    expect(host.querySelector('[data-state="stale"]')).not.toBeNull();

    // A newly admitted document mounts a new reader; no old observation is reset in place.
    await act(async () =>
      root.render(createElement(MangaReaderEntry, { ...props, key: 'fresh-document', source: {} })),
    );
    expect(host.querySelector('[data-selected="true"]')).not.toBeNull();
    await act(async () => browser.dispatchEvent(new browser.Event('pagehide')));
    await act(async () => browser.dispatchEvent(new browser.Event('pageshow')));
    expect(host.querySelector('[data-state="stale"]')).not.toBeNull();
    expect(host.querySelector('button')).toBeNull();

    const unrelated = browser.document.createElement('button');
    browser.document.body.append(unrelated);
    unrelated.focus();
    await act(async () =>
      root.render(
        createElement(MangaReaderEntry, {
          ...props,
          key: 'removed-occurrence',
          source: {},
          windows: [{ ...props.windows[0]!, rows: [] }],
        }),
      ),
    );
    expect(host.querySelector('[data-selected="true"]')).toBeNull();
    expect(host.querySelector('[role="status"]')?.textContent).toContain('元の関連');
    expect(browser.document.activeElement).toBe(unrelated);
    unrelated.remove();
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of previous)
      descriptor ? Object.defineProperty(globalThis, key, descriptor) : Reflect.deleteProperty(globalThis, key);
    await browser.happyDOM.close();
  }
});
