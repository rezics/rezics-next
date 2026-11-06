import { expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { planReads, platformRegistry, type CompositionDocument } from '@rezics/composition';
import * as start from '../.storybook/react-start';

mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
const { PageData } = await import('../src/features/pages/data');
const { CollectionList } = await import('../src/features/pages/overview');
const { sessionQuery } = await import('../src/session/query');
const { m } = await import('../src/paraglide/messages.js');

const row = { id: 'native /+?=#版%', title: 'Native collection', multiplicity: 3 };
const page = (collections: unknown = [row], count: unknown = { value: 9, exact: true }, next: unknown = null) => ({
  collections,
  count,
  next,
});
function render(body: Record<string, unknown>, paged = false) {
  const document: CompositionDocument = {
    root: { props: {} },
    content: [{ type: 'CollectionList', props: { id: 'lists', limit: 1, ...(paged ? { paged: true } : {}) } }],
  };
  const subject = 'subject';
  const key = planReads(platformRegistry, document, { subject }).nodes.lists!;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(sessionQuery.queryKey, { state: 'signed-out', subject: null, csrfToken: null });
  client.setQueryData(['exposure', 'anonymous'], { state: 'ready', admitted: ['collections'] });
  try {
    return renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <PageData
          locale="en"
          subject={subject}
          document={document as never}
          reads={{ [key]: { status: 200, body } }}
          messages={{
            unknown: 'Unknown',
            none: 'None',
            unlabelled: 'Untitled',
            sources: 'Sources',
            aliases: 'Aliases',
            search: 'Search',
          }}
        >
          <CollectionList id="lists" limit={1} {...(paged ? { paged: true } : {})} />
        </PageData>
      </QueryClientProvider>,
    );
  } finally {
    client.clear();
  }
}

test('native rows retain exact destinations, optional attribution, zero counts and opaque cursors; native empty stays empty', () => {
  for (const curator of [undefined, null, { id: 'unbound', displayName: null, handle: 'reader' }]) {
    const html = render(
      page([{ ...row, curatorAccountId: 'different', curator }], { value: 0, exact: true }, 'opaque/?#%'),
    );
    expect(html).toContain(`href="/en/collections/${encodeURIComponent(row.id)}"`);
    expect(html).toContain('Native collection');
    expect(html).toContain('data-slot="count"');
    expect(html).toContain('data-slot="see-all"');
    if (curator) expect(html).toContain('@reader');
  }
  for (const html of [
    render(page([], { value: 0, exact: true })),
    render(page([], { value: 9, exact: true }, 'still-native')),
  ]) {
    expect(html).not.toContain('data-slot="collection-list"');
    expect(html).not.toContain('Native collection');
    expect(html).not.toContain('data-slot="continue-stream"');
  }
});

test('paged CollectionList empty is terminal; a sparse page keeps its native continuation', () => {
  const empty = render(page([], { value: 0, exact: true }), true);
  expect(empty).toContain('data-slot="collection-list"');
  expect(empty).toContain(m.public_read_empty());
  expect(empty).not.toContain('data-slot="continue-stream"');
  const sparse = render(page([], { value: 9, exact: true }, 'still-native'), true);
  expect(sparse).toContain(m.public_read_sparse());
  expect(sparse).toContain('data-slot="continue-stream"');
  expect(sparse).toContain(`cursor=${encodeURIComponent('still-native')}`);
});

test('one malformed row fails the whole native page, including beyond the preview, without destinations or counts', () => {
  const { id: _id, ...missingId } = row;
  const badRows = [
    null,
    [],
    'row',
    {},
    missingId,
    { ...row, id: 1 },
    { ...row, title: null },
    { ...row, curator: { handle: 5, displayName: null } },
  ];
  for (const bad of badRows) {
    for (const collections of [[bad], [row, bad]]) {
      const html = render(page(collections));
      expect(html).toContain('data-state="failed"');
      expect(html).toContain('data-slot="retry"');
      expect(html).not.toMatch(/<ul|\/collections\/|data-slot="count"/);
    }
  }
});

test('contract-invalid multiplicity and page metadata cannot certify a collection list or empty page', () => {
  const invalid = [NaN, Infinity, -Infinity, -1, 0.5, '2', undefined];
  const bodies = [
    ...[...invalid, 0].map((multiplicity) => page([{ ...row, multiplicity }])),
    ...invalid.map((value) => page([], { value, exact: true })),
    ...[null, undefined, {}, { value: 0, exact: false }, { value: 0, exact: 1 }].map((count) => ({
      ...page([]),
      count,
    })),
    ...[undefined, 5, {}].map((next) => ({ ...page([]), next })),
  ];
  for (const body of bodies) expect(render(body)).toContain('data-state="failed"');
});
