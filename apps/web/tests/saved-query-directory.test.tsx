import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { MineCollection } from '../src/library/mine-collections';
import { SavedQueryDirectory } from '../src/library/saved-query-directory';
import { m } from '../src/paraglide/messages.js';

function collection(id: string, changes: Partial<MineCollection> = {}): MineCollection {
  return {
    id,
    curatorAccountId: 'alice',
    title: id,
    membershipKind: 'dynamic',
    curator: null,
    memberCount: 931,
    updatedAt: '2025-01-02T03:04:05Z',
    ...changes,
  };
}

function directory(props: Partial<Parameters<typeof SavedQueryDirectory>[0]> = {}) {
  return renderToStaticMarkup(
    <SavedQueryDirectory
      collections={[]}
      capability="available"
      viewerId="alice"
      canEditRules
      currentHref="/en/library/collections?layout=rows"
      next={null}
      layout="rows"
      {...props}
    />,
  );
}

test('lists only current-owner saved queries with result and rule routes, without dynamic facts', () => {
  const html = directory({
    collections: [
      collection('saved/query'),
      collection('other-owner', { curatorAccountId: 'bob' }),
      collection('state-view', { builtinKind: 'state' }),
      collection('curated', { membershipKind: 'curated' }),
    ],
  });
  expect(html).toContain('Saved queries');
  expect(html).toContain(m.library_collection_open());
  expect(html).toContain(
    `href="/en/collections/saved%2Fquery?returnTo=${encodeURIComponent('/en/library/collections?layout=rows')}"`,
  );
  expect(html).toContain('href="/en/collections/saved%2Fquery/rule"');
  expect(html).not.toContain('other-owner');
  expect(html).not.toContain('state-view');
  expect(html).not.toContain('curated');
  expect(html).not.toContain('931');
  expect(html).not.toContain('2025-01-02');
});

test('an empty current page continues with the existing cursor and layout', () => {
  const html = directory({ next: 'next+/cursor==', layout: 'previews' });
  expect(html).toContain(m.library_saved_queries_empty_page());
  expect(html).toContain('cursor=next%2B%2Fcursor%3D%3D&amp;layout=previews');
  expect(html).not.toContain('predicate');
});

test('a missing dynamic owner DTO is unavailable rather than a confirmed empty directory', () => {
  const html = directory({ capability: 'unavailable', next: 'more' });
  expect(html).toContain(m.library_saved_queries_unavailable());
  expect(html).not.toContain(m.library_saved_queries_empty_page());
  expect(html).toContain('href="/en/library/collections?layout=rows"');
  expect(html).toContain('cursor=more&amp;layout=rows');
});
