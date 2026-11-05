import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { savedQueryCollection as collection } from './factories/collections';
import { SavedQueryDirectory } from '../src/library/saved-query-directory';
import { savedQueryRuleReturn } from '../src/library/saved-query-results';
import { m } from '../src/paraglide/messages.js';

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

test.each(['rows', 'previews'] as const)(
  'lists and continues only current-owner saved queries in %s, without dynamic facts',
  (layout) => {
    const currentHref = `/en/library/collections?cursor=previous%2B%2F%3D%3D&layout=${layout}`;
    const html = directory({
      layout,
      currentHref,
      next: 'next+/cursor==',
      collections: [
        collection('saved/query'),
        collection('other-owner', { curatorAccountId: 'bob' }),
        collection('state-view', { builtinKind: 'state' }),
        collection('curated', { membershipKind: 'curated' }),
      ],
    });
    expect(html).toContain('Saved queries');
    expect(html).toContain(m.library_collection_open());
    expect(html).toContain(m.library_collection_more());
    expect(html).toContain(`href="/en/library/collections?cursor=next%2B%2Fcursor%3D%3D&amp;layout=${layout}"`);
    expect(html).toContain(`href="/en/collections/saved%2Fquery?returnTo=${encodeURIComponent(currentHref)}"`);
    const editHref = [...html.matchAll(/href="([^"]+)"/g)]
      .map((match) => match[1])
      .find((href) => href.includes('/rule?returnTo='));
    expect(editHref).toBeDefined();
    const resultAddress = new URL(editHref!, 'https://rezics.invalid').searchParams.get('returnTo');
    const expectedResultAddress = `/en/collections/saved%2Fquery?returnTo=${encodeURIComponent(currentHref)}`;
    expect(resultAddress).toBe(expectedResultAddress);
    expect(savedQueryRuleReturn(resultAddress!, 'saved/query', 'en')).toBe(expectedResultAddress);
    expect(html).not.toContain('other-owner');
    expect(html).not.toContain('state-view');
    expect(html).not.toContain('curated');
    expect(html).not.toContain('931');
    expect(html).not.toContain('2025-01-02');
  },
);

test('an empty current page continues with the existing cursor and layout', () => {
  expect(directory({ collections: [collection('saved')] })).not.toContain(m.library_collection_more());
  const html = directory({ next: 'next+/cursor==', layout: 'previews' });
  expect(html).toContain(m.library_saved_queries_empty_page());
  expect(html).toContain('cursor=next%2B%2Fcursor%3D%3D&amp;layout=previews');
  expect(html).not.toContain('predicate');
});

test('an empty admitted inventory is empty; unknown, denied and unavailable admission remain distinct', () => {
  expect(directory({ capability: 'available' })).toContain(m.library_saved_queries_empty_page());
  expect(directory({ capability: 'unknown' })).toContain('data-capability="unknown"');
  expect(directory({ capability: 'denied' })).toContain('data-capability="denied"');
  const html = directory({ capability: 'unavailable', next: 'more' });
  expect(html).toContain(m.library_saved_queries_unavailable());
  expect(html).not.toContain(m.library_saved_queries_empty_page());
  expect(html).toContain('href="/en/library/collections?layout=rows"');
  expect(html).toContain('cursor=more&amp;layout=rows');
});
