import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { libraryNavigation } from '../src/library/navigation';
import { PublicCollectionDiscoveryPage } from '../src/library/public-collection-discovery/page';
import { readPublicCollectionPage } from '../src/library/public-collection-discovery/read';
import { publicCollectionDiscoveryRequest } from '../src/library/public-collection-discovery/request';
import type { DiscoveryRequest } from '../src/search/discovery';
import { resolveNavigation } from '../src/shell/navigation';

function nativeHit(id: string, title: string) {
  return {
    key: { owner: 'semantic', kind: 'collection', route: 0, id },
    summary: {
      kind: 'subject',
      value: {
        id,
        type: 'collection',
        types: ['collection'],
        label: { value: title, language: 'en' },
        creativeWork: false,
        cover: null,
      },
    },
    labels: { en: title },
    descriptions: { en: `${title} description` },
  };
}

test('uses Search collection kind paging and keeps only native public summaries and order', async () => {
  let sent: DiscoveryRequest | undefined;
  const result = await readPublicCollectionPage('en', 'opaque+/=', async (request) => {
    sent = request;
    return {
      status: 200,
      data: {
        hits: [nativeHit('collection-1', 'First'), nativeHit('collection-2', 'Second')],
        kinds: {
          values: [{ id: 'collection', labels: { en: 'Collections' }, icon: 'collection', count: { kind: 'collection', value: 2, exact: true } }],
          next: null,
        },
        next: 'next+/=',
        as_of: 'native-checkpoint',
      },
    };
  });

  expect(sent).toMatchObject({
    representation: 'discovery-v1',
    limit: 24,
    cursor: 'opaque+/=',
    filter: { and: [{ kind: { in: ['collection'] } }] },
    kindPage: { limit: 8 },
  });
  expect(sent?.kindCountLeaf).toBeUndefined();
  expect(sent?.text).toBeUndefined();
  expect(result).toMatchObject({
    status: 'ready',
    collections: [
      { id: 'collection-1', title: 'First', description: 'First description' },
      { id: 'collection-2', title: 'Second', description: 'Second description' },
    ],
    next: 'next+/=',
  });
  expect(result).not.toHaveProperty('kinds');
});

test('an empty native continuation stays open and offers its exact next cursor', () => {
  const markup = renderToStaticMarkup(
    createElement(PublicCollectionDiscoveryPage, {
      state: { status: 'ready', collections: [], next: 'next+/=' },
      locale: 'en',
      onRetry: () => undefined,
    }),
  );

  expect(markup).toContain('There are no Collections on this page');
  expect(markup).toContain('href="/en/collections?cursor=next%2B%2F%3D"');
  expect(markup).toContain('More Collections');
  expect(markup).not.toContain('No public Collections are available yet');
});

test('a refused continuation has a localized first-page recovery link', () => {
  const markup = renderToStaticMarkup(
    createElement(PublicCollectionDiscoveryPage, {
      state: { status: 'denied' },
      locale: 'en',
      cursor: 'refused-cursor',
      onRetry: () => undefined,
    }),
  );

  expect(markup).toContain('This Collection page was refused');
  expect(markup).toContain('href="/en/collections"');
  expect(markup).toContain('Start over');
});

test('public Collections discovery is in the anonymous primary navigation slot', () => {
  const entry = resolveNavigation(libraryNavigation, { locale: 'ja', pathname: '/ja/collections' }).find(
    ({ id }) => id === 'library.discover-collections',
  );

  expect(entry).toMatchObject({
    kind: 'navigation',
    group: 'primary',
    href: '/ja/collections',
    current: true,
  });
  expect(entry).not.toHaveProperty('signedIn');
});
