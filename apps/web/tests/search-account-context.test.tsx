import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { discoveryExample } from '../src/kernel/fake/search-discovery';
import { SearchResultsRegion } from '../src/search/search-regions/results';
import { parseDiscoveryPage, type DiscoveryPage, type DiscoveryState } from '../src/search/discovery';
import type { DiscoveryBoundPage } from '../src/search/discovery-personal-server';
import type { FollowWriteInput, FollowWriteResult } from '../src/library/follow-records';
import { discoveryExposureKey } from '../src/search/discovery-personal-capabilities';
import { viewerExposureQuery, viewerExposureLifetime } from '../src/kernel/viewer-exposure';
import { sessionQuery } from '../src/session/query';
import { locales } from '../src/paraglide/runtime.js';
import { m } from '../src/paraglide/messages.js';
mock.module('cloudflare:workers', () => ({ env: {} }));
const { useDiscoveryPersonalResults } = await import('../src/search/discovery-personal-host');
const reader = '01a1a000-0000-7000-8000-001000000011';
const account = '01a1a000-0000-7000-8000-002000000012';
const subject = '01a1a000-0000-7000-8000-003000000013';
const admitted = ['personal_library'];
function page(): DiscoveryPage {
  const page = structuredClone(discoveryExample);
  page.hits = page.hits.filter((hit) => hit.summary.kind !== 'account');
  for (const [index, id] of [account, reader].entries())
    page.hits.push({
      key: { owner: 'accounts', kind: 'account', route: index ? 16 : 32, id },
      summary: {
        kind: 'account',
        value: {
          id,
          accountKind: 'actor',
          displayName: 'Homonym',
          handle: index ? null : 'live_name',
          automated: !!index,
          operatorId: index ? account : null,
          avatar: null,
          verifiedAgent: index ? null : { id: subject, label: 'Represented person', type: 'schema:Person' },
          context: {
            biography: index
              ? { state: 'withheld' }
              : { state: 'available', text: 'Current public biography', truncated: true },
            followTarget: index
              ? { state: 'unavailable' }
              : {
                  state: 'available',
                  id: subject,
                  label: 'Represented person',
                  type: 'schema:Person',
                  source: 'a'.repeat(64),
                },
          },
        },
      },
    });
  delete page.viewerFacts;
  return page;
}
function bound(source: DiscoveryState, writable = true): DiscoveryBoundPage {
  if (source.status !== 'ready') throw new Error('Expected page');
  const page = structuredClone(source.page);
  page.accountFollows = {
    state: 'current',
    accountId: reader,
    partition: 1,
    rows: [
      {
        targetId: subject,
        targetType: 'subject',
        source: 'a'.repeat(64),
        following: false,
        actions: { follow: writable, unfollow: writable },
      },
    ],
  };
  return {
    state: { status: 'ready', page },
    capabilities: { release: 'release', exposure: discoveryExposureKey(admitted), entries: {}, vote: false },
  };
}
function region(state: DiscoveryState, locale = 'en', personal?: ReturnType<typeof useDiscoveryPersonalResults>) {
  return (
    <SearchResultsRegion
      query="Homonym"
      locale={locale}
      selectedFacets={{}}
      personal={personal}
      data={{
        discovery: state,
        queryState: { query: 'Homonym', facets: {} },
        sort: 'relevance',
        hitTypes: {},
        yearProperties: [],
        typeChoices: [],
        groups: [],
        selectedFacetLabels: {},
        facetRetry: false,
        facetIndexNotReady: false,
        staleCursorRestarted: false,
      }}
    />
  );
}
test('the actual mixed result distinguishes current biographies, handleless automation and representations in every locale', () => {
  for (const locale of locales) {
    const html = renderToStaticMarkup(region({ status: 'ready', page: page() }, locale));
    expect(html).toContain('/' + locale + '/@live_name');
    expect(html).toContain('Current public biography');
    expect(html).toContain(m.discovery_account_bio_truncated({}, { locale }));
    expect(html).toContain(m.discovery_account_bio_withheld({}, { locale }));
    expect(html).toContain(m.discovery_account_automated({}, { locale }));
    expect(html).toContain(m.discovery_verified_as({ name: 'Represented person' }, { locale }));
    expect(html).not.toContain('data-slot="account-follow"');
  }
  const privatePage = bound({ status: 'ready', page: page() }).state;
  if (privatePage.status !== 'ready' || privatePage.page.accountFollows?.state !== 'current')
    throw new Error('Expected advice');
  expect(parseDiscoveryPage(privatePage.page)).toBeDefined();
  privatePage.page.accountFollows.rows[0]!.targetId = account;
  expect(parseDiscoveryPage(privatePage.page)).toBeUndefined();
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { resolve, promise };
}
test('mounted mixed Search retries original uncertain operands and permanently retires hydration, advice and pending Follow on replacement', async () => {
  const require = createRequire(import.meta.url);
  const { Window } = await import(createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom'));
  const window = new Window({ url: 'https://site.invalid/en/search?q=Homonym#results' });
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
  const root = createRoot(host),
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const session = (credential = 'credential') => {
    client.setQueryData(sessionQuery.queryKey, { state: 'signed-in', subject: reader, csrfToken: credential });
    const lifetime = viewerExposureLifetime(client).getSnapshot();
    if (lifetime.state === 'signed-in')
      client.setQueryData(viewerExposureQuery(lifetime.observation).queryKey, { subject: reader, admitted });
  };
  session();
  client.setQueryData(viewerExposureQuery({ subject: reader, id: 1 }).queryKey, { subject: reader, admitted });
  let source: DiscoveryState = { status: 'ready', page: page() },
    locale = 'en',
    query = 'Homonym',
    writable = true;
  let pending = deferred<FollowWriteResult>(),
    hydration: ReturnType<typeof deferred<DiscoveryBoundPage>> | undefined;
  const commands: FollowWriteInput[] = [];
  function Live() {
    const personal = useDiscoveryPersonalResults({
      source,
      locale,
      enabled: true,
      returnTo: window.location.href,
      request: { representation: 'discovery-v1', text: query, limit: 24 },
      read: async () => (hydration ? hydration.promise : bound(source, writable)),
      writeFollow: async ({ data }) => {
        commands.push(data);
        return pending.promise;
      },
    });
    return region(personal.state!, locale, personal);
  }
  const render = () =>
    root.render(
      <QueryClientProvider client={client}>
        <Live />
      </QueryClientProvider>,
    );
  const button = () => host.querySelector<HTMLButtonElement>('[data-slot=account-follow] button')!;
  try {
    await act(async () => render());
    expect(host.querySelectorAll('[data-slot=account-follow] button')).toHaveLength(1);
    await act(async () => button().click());
    await act(async () => pending.resolve({ ok: false, reason: 'unavailable' }));
    pending = deferred();
    await act(async () => button().click());
    expect(commands[1]).toEqual(commands[0]);
    expect(commands[0]).toMatchObject({
      targetId: subject,
      following: true,
      expectedReader: reader,
      expectedCredential: 'credential',
    });
    await act(async () => pending.resolve({ ok: true, following: true }));
    expect(button().textContent).toContain('Unfollow');
    for (const replace of [
      () => {
        source = { status: 'ready', page: page() };
      },
      () => {
        locale = 'fr';
      },
      () => {
        query = 'other executed query';
      },
      () => {
        session('new-credential');
      },
    ]) {
      pending = deferred();
      await act(async () => button().click());
      expect(button().disabled).toBe(true);
      const old = pending;
      await act(async () => {
        replace();
        render();
      });
      await act(async () => old.resolve({ ok: true, following: true }));
      expect(button().disabled).toBe(false);
    }
    const stale = deferred<DiscoveryBoundPage>();
    hydration = stale;
    await act(async () => {
      source = { status: 'ready', page: page() };
      render();
    });
    expect(button()).toBeNull();
    const stalePage = bound(source);
    hydration = undefined;
    writable = false;
    await act(async () => {
      session('third-credential');
      render();
    });
    await act(async () => stale.resolve(stalePage));
    expect(button()).toBeNull();
    expect(host.textContent).toContain('Current public biography');
    await act(async () => {
      client.setQueryData(sessionQuery.queryKey, { state: 'signed-out', subject: null, csrfToken: null });
      render();
    });
    expect(button()).toBeNull();
    expect(window.location.search).toBe('?q=Homonym');
    expect(window.location.hash).toBe('#results');
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
