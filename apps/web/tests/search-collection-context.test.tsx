import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { discoveryExample } from '../src/kernel/fake/search-discovery';
import { viewerExposureLifetime, viewerExposureQuery } from '../src/kernel/viewer-exposure';
import { sessionQuery } from '../src/session/query';
import { locales } from '../src/paraglide/runtime.js';
import { m } from '../src/paraglide/messages.js';
import {
  parseDiscoveryPage,
  type DiscoveryPage,
  type DiscoveryState,
  type PublicCollectionSummary,
} from '../src/search/discovery';
import { collectionFollowSource } from '../src/search/collection-context/schema';
import { DiscoveryResults } from '../src/search/discovery-results';
import { discoveryExposureKey } from '../src/search/discovery-personal-capabilities';
import { CollectionFollowControl } from '../src/search/collection-context/follow';
import type { FollowWriteResult } from '../src/library/follow-records';
import type { DiscoveryBoundPage } from '../src/search/discovery-personal-server';

mock.module('cloudflare:workers', () => ({ env: {} }));
const { useDiscoveryPersonalResults } = await import('../src/search/discovery-personal-host');

const reader = '01a1a000-0000-7000-8000-001000000011';
const curator = '01a1a000-0000-7000-8000-002000000012';
const collection = '01a1a000-0000-7000-8000-003000000013';
const member = '01a1a000-0000-7000-8000-004000000014';
const admitted = ['personal_library'];
function page(): DiscoveryPage {
  const page = structuredClone(discoveryExample);
  const card: PublicCollectionSummary['card'] = {
    kind: 'collection',
    id: collection,
    destination: `/collections/${collection}`,
    title: 'Current shelf',
    description: 'A selection',
    visibility: 'public',
    revision: 1,
    sourceGeneration: '1',
    membershipKind: 'curated',
    memberCount: 12,
    orderEpoch: 7,
    createdAt: '2026-11-01T00:00:00Z',
    updatedAt: '2026-11-01T00:00:00Z',
    presentationKind: null,
    presentationKindSource: 'mixed',
    cover: null,
    coverSource: 'none',
    curator: { state: 'available', id: curator, label: 'Current curator', destination: '/@curator' },
    preview: {
      state: 'available',
      partial: true,
      truncated: true,
      members: [
        {
          id: '01a1a000-0000-7000-8000-003000000015',
          subject: {
            id: member,
            type: 'schema:Book',
            types: ['schema:Book'],
            label: { value: 'Admitted book', language: 'en' },
          },
        },
      ],
    },
  };
  page.hits = [
    {
      key: { owner: 'library', kind: 'collection', route: 48, id: collection },
      summary: {
        kind: 'collection',
        value: { id: collection, title: card.title, description: card.description, card },
      },
    },
  ];
  const otherId = '01a1a000-0000-7000-8000-003000000016';
  page.hits.push({
    key: { owner: 'library', kind: 'collection', route: 48, id: otherId },
    summary: {
      kind: 'collection',
      value: {
        id: otherId,
        title: 'Other shelf',
        description: null,
        card: {
          ...card,
          id: otherId,
          destination: `/collections/${otherId}`,
          title: 'Other shelf',
          description: null,
          memberCount: 0,
          curator: { state: 'unavailable', reason: 'withheld' },
          preview: { state: 'empty' },
        },
      },
    },
  });
  page.next = 'same-continuation';
  delete page.viewerFacts;
  return page;
}
function bound(source: DiscoveryState): DiscoveryBoundPage {
  if (source.status !== 'ready') throw new Error('Expected a page');
  const page = structuredClone(source.page);
  page.collectionFollows = {
    state: 'current',
    accountId: reader,
    partition: 1,
    rows: page.hits.flatMap((hit) =>
      hit.summary.kind === 'collection'
        ? [
            {
              targetId: hit.key.id,
              targetType: 'collection',
              source: collectionFollowSource(hit.summary.value.card),
              following: false,
              actions: { follow: true, unfollow: true },
            },
          ]
        : [],
    ),
  };
  return {
    state: { status: 'ready', page },
    capabilities: { release: 'release', exposure: discoveryExposureKey(admitted), entries: {}, vote: false },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  return {
    promise: new Promise<T>((done) => {
      resolve = done;
    }),
    resolve: (value: T) => resolve(value),
  };
}

test('real mixed row retains cover/count, actual curator/member links and honest preview states in eight locales', () => {
  const current = page();
  expect(parseDiscoveryPage(current)).toBeDefined();
  const hit = current.hits[0]!;
  if (hit.summary.kind !== 'collection') throw new Error('Expected Collection');
  for (const locale of locales) {
    const control = renderToStaticMarkup(
      <CollectionFollowControl
        row={{
          targetId: collection,
          targetType: 'collection',
          source: 'source',
          following: false,
          actions: { follow: true, unfollow: true },
        }}
        binding={{ expectedReader: reader, expectedCredential: 'credential' }}
        lifetime="page"
        current={() => true}
        locale={locale}
        rowKey="row"
        title="Current shelf"
        reviewed={true}
        refresh={async () => {}}
        write={async () => ({ ok: false, reason: 'unavailable' })}
      />,
    );
    expect(control).toContain(m.library_follow({}, { locale }));
    expect(control).toContain(m.library_follow_conflict_recovery_ready({}, { locale }));
    expect(control).toContain(`Current shelf (${collection})`);
    const html = renderToStaticMarkup(<DiscoveryResults state={{ status: 'ready', page: current }} locale={locale} />);
    expect(html).toContain(`href="/${locale}/@curator"`);
    expect(html).toContain(`/${locale}/subjects/${member}`);
    expect(html).toContain(`/${locale}/collections/${collection}`);
    expect(html).toContain('Current curator');
    expect(html).toContain('Admitted book');
    expect(html).toContain('schema:Book');
    expect(html).toContain(m.library_collection_item_count({ count: 12 }, { locale }));
    expect(html).toContain(m.discovery_collection_partial({}, { locale }));
    expect(html).toContain(m.discovery_collection_truncated({}, { locale }));
    expect(html).toContain('data-slot="cover"');
    for (const state of ['empty', 'withheld', 'unavailable'] as const) {
      const copy = structuredClone(current);
      const row = copy.hits[0]!;
      if (row.summary.kind !== 'collection') throw new Error('Expected Collection');
      row.summary.value.card.preview = { state };
      row.summary.value.card.curator = { state: 'unavailable', reason: 'deidentified' };
      const hidden = renderToStaticMarkup(<DiscoveryResults state={{ status: 'ready', page: copy }} locale={locale} />);
      expect(hidden).not.toContain('Current curator');
      expect(hidden).not.toContain(member);
      expect(hidden).toContain(m.discovery_collection_curator_unavailable({}, { locale }));
      expect(hidden).toContain(
        state === 'empty'
          ? m.discovery_collection_empty({}, { locale })
          : state === 'withheld'
            ? m.discovery_collection_withheld({}, { locale })
            : m.discovery_collection_preview_unavailable({}, { locale }),
      );
    }
  }
  const privatePage = bound({ status: 'ready', page: current }).state;
  if (privatePage.status !== 'ready' || privatePage.page.collectionFollows?.state !== 'current')
    throw new Error('Expected private advice');
  expect(parseDiscoveryPage(privatePage.page)).toBeDefined();
  privatePage.page.collectionFollows.rows[0]!.source = 'old-source';
  expect(parseDiscoveryPage(privatePage.page)).toBeUndefined();
  const injected = structuredClone(current);
  const card = injected.hits[0]!.summary;
  if (card.kind !== 'collection' || card.value.card.curator.state !== 'available') throw new Error('Expected curator');
  card.value.card.curator.destination = '/private/account';
  expect(parseDiscoveryPage(injected)).toBeUndefined();
  expect(
    parseDiscoveryPage({
      ...current,
      hits: [
        {
          ...hit,
          summary: {
            kind: 'collection',
            value: { ...hit.summary.value, card: { ...hit.summary.value.card, following: true } },
          },
        },
      ],
    }),
  ).toBeUndefined();
});

test('mounted Search uses one aggregate read, native command results and terminal reader/source lifetimes without changing the visit', async () => {
  const require = createRequire(import.meta.url);
  const { Window } = await import(createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom'));
  const window = new Window({ url: 'https://site.invalid/en/search?q=title&cursor=same-continuation#context' });
  const keys = ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'IS_REACT_ACT_ENVIRONMENT'];
  const saved = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const key of keys)
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value: key === 'window' ? window : key === 'IS_REACT_ACT_ENVIRONMENT' ? true : window[key],
    });
  const { createRoot } = await import('react-dom/client');
  const host = window.document.createElement('main') as HTMLElement;
  window.document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(sessionQuery.queryKey, { state: 'signed-in', subject: reader, csrfToken: 'credential' });
  client.setQueryData(viewerExposureQuery({ subject: reader, id: 1 }).queryKey, { subject: reader, admitted });
  let source: DiscoveryState = { status: 'ready', page: page() };
  let reads = 0;
  let nativeFollowing = false;
  let write = deferred<FollowWriteResult>();
  const commands: unknown[] = [];
  function Live() {
    const personal = useDiscoveryPersonalResults({
      enabled: true,
      source,
      request: { representation: 'discovery-v1', text: 'title', cursor: 'same-continuation', limit: 24 },
      locale: 'en',
      returnTo: window.location.href,
      read: async () => {
        reads++;
        const result = bound(source);
        if (result.state.status === 'ready' && result.state.page.collectionFollows?.state === 'current')
          result.state.page.collectionFollows.rows[0]!.following = nativeFollowing;
        return result;
      },
      writeFollow: async ({ data }) => {
        commands.push(data);
        return write.promise;
      },
    });
    return (
      <section ref={personal.regionRef}>
        <DiscoveryResults state={personal.state!} locale="en" renderPersonal={personal.renderPersonal} />
      </section>
    );
  }
  const render = () =>
    root.render(
      <QueryClientProvider client={client}>
        <Live />
      </QueryClientProvider>,
    );
  const button = () => host.querySelector<HTMLButtonElement>('[data-slot=collection-follow] button')!;
  try {
    await act(async () => render());
    expect(reads).toBe(1);
    expect(host.querySelectorAll('[data-slot=collection-follow] button')).toHaveLength(2);
    expect(button().textContent).toContain('Follow');
    await act(async () => button().click());
    expect(button().disabled).toBe(true);
    expect(host.querySelectorAll<HTMLButtonElement>('[data-slot=collection-follow] button')[1]!.disabled).toBe(false);
    expect(host.textContent).not.toContain('Following');
    // No refresh or invented state after the first uncertain dispatch.
    await act(async () => write.resolve({ ok: false, reason: 'unavailable' }));
    expect(button().disabled).toBe(false);
    expect(button().textContent).toContain('Follow');
    expect(reads).toBe(1);
    const original = structuredClone(commands[0]);
    write = deferred();
    await act(async () => button().click());
    expect(commands[1]).toEqual(original);
    expect(commands).toHaveLength(2);
    nativeFollowing = true;
    await act(async () => write.resolve({ ok: true, following: false }));
    // Only aggregate native observation is installed, even if the command response differs.
    expect(reads).toBe(2);
    expect(button().textContent).toContain('Unfollow');
    expect(host.querySelectorAll('[data-slot=collection-follow] button')[1]!.textContent).not.toContain('Unfollow');
    expect(commands).toMatchObject([
      { targetId: collection, following: true, expectedReader: reader, expectedCredential: 'credential' },
      { targetId: collection, following: true, expectedReader: reader, expectedCredential: 'credential' },
    ]);
    write = deferred();
    await act(async () => button().click());
    await act(async () => write.resolve({ ok: false, reason: 'conflict' }));
    expect(button().disabled).toBe(true);
    expect(reads).toBe(2);
    const review = [...host.querySelectorAll<HTMLButtonElement>('[data-slot=collection-follow] button')].find((item) =>
      item.textContent?.includes('Review current follow'),
    )!;
    review.focus();
    await act(async () => review.click());
    expect(reads).toBe(3);
    expect(button().disabled).toBe(false);
    expect(button().textContent).toContain('Unfollow');
    expect(host.textContent).toContain('Current follow reviewed');
    expect(window.document.activeElement).toBe(button());
    write = deferred();
    await act(async () => button().click());
    expect(commands[3]).not.toEqual(commands[2]);
    await act(async () => write.resolve({ ok: false, reason: 'forbidden' }));
    expect(host.querySelector('[role=alert]')?.textContent).toContain('permissions');
    expect(button().disabled).toBe(true);
    nativeFollowing = false;
    source = { status: 'ready', page: page() };
    await act(async () => render());
    expect(reads).toBe(4);
    write = deferred();
    await act(async () => button().click());
    const oldWrite = write;
    source = { status: 'ready', page: page() };
    const changed = source.page.hits[0]!.summary;
    if (changed.kind === 'collection') changed.value.card.sourceGeneration = '2';
    await act(async () => render());
    await act(async () => oldWrite.resolve({ ok: true, following: true }));
    expect(button().textContent).not.toContain('Unfollow');
    write = deferred();
    await act(async () => button().click());
    await act(async () => {
      client.setQueryData(sessionQuery.queryKey, { state: 'signed-in', subject: curator, csrfToken: 'other' });
      client.setQueryData(sessionQuery.queryKey, { state: 'signed-in', subject: reader, csrfToken: 'credential' });
      const lifetime = viewerExposureLifetime(client).getSnapshot();
      if (lifetime.state === 'signed-in')
        client.setQueryData(viewerExposureQuery(lifetime.observation).queryKey, { subject: reader, admitted });
    });
    await act(async () => write.resolve({ ok: true, following: true }));
    expect(button().textContent).not.toContain('Unfollow');
    await act(async () =>
      client.setQueryData(sessionQuery.queryKey, { state: 'signed-out', subject: null, csrfToken: null }),
    );
    expect(host.querySelectorAll('[data-slot=collection-follow] button')).toHaveLength(0);
    expect(host.querySelector('a[href^="/auth/sign-in?return_to="]')).not.toBeNull();
    expect(window.location.search).toBe('?q=title&cursor=same-continuation');
    expect(window.location.hash).toBe('#context');
  } finally {
    await act(async () => root.unmount());
    client.clear();
    await window.happyDOM.abort();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
