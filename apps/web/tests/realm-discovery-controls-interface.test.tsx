import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createKernelClient } from '@rezics/client';
import {
  RealmDiscoverySection,
  loadRealmDiscovery,
  type RealmDiscoverySectionProps,
} from '../src/community/realm-discovery';
import { createSearchRealmDiscoveryPage } from '../src/search/realm-discovery-section';
import { discoveryRealm as card } from '../src/stories/patterns/realm-discovery/fixtures';
import { m } from '../src/paraglide/messages.js';

test('installed discovery retains rows through an actual page failure and retries exactly once before continuing', async () => {
  const cursor = 'failed signed +/= cursor';
  const failed = Promise.withResolvers<Response>();
  const responses = [
    Response.json({ realms: [card], next: cursor }),
    failed.promise,
    Response.json({ realms: [card, card], next: null }),
  ];
  const calls: URL[] = [];
  const client = createKernelClient('https://kernel.test', {
    fetch: async (input, init) => {
      calls.push(new URL(new Request(input, init).url));
      return (await responses.shift()) ?? new Response(null, { status: 500 });
    },
  });
  let view: Pick<RealmDiscoverySectionProps, 'state' | 'pending' | 'retry'> = { state: { kind: 'loading' } };
  const page = createSearchRealmDiscoveryPage(
    ({ sort, limit, cursor }) =>
      loadRealmDiscovery(client, { sort, limit, ...(cursor === undefined ? {} : { cursor }) }),
    'en',
    (state, progress) => {
      view = { state, ...progress };
    },
  );
  const html = () =>
    renderToStaticMarkup(
      createElement(RealmDiscoverySection, {
        ...view,
        sort: 'trending',
        locale: 'en',
        onNext: () => void page.next(),
        onRetry: () => void page.retry(),
      }),
    );
  await page.start();
  const request = page.next();
  void page.next();
  void page.retry();
  expect(calls).toHaveLength(2);
  expect(html()).toContain(card.name);
  expect(html()).toContain('aria-busy="true"');
  expect(html()).toContain('disabled=""');
  failed.resolve(Response.json({ code: 'dependency_unavailable' }, { status: 503 }));
  await request;
  expect(html()).toContain(card.name);
  expect(html()).toContain(m.realm_discovery_retry());
  expect(html()).not.toContain(m.realm_discovery_continue());
  await page.next();
  expect(calls).toHaveLength(2);
  const retry = page.retry();
  void page.retry();
  await retry;
  expect(html().match(/data-slot="realm-discovery-title"/gu)).toHaveLength(1);
  await page.next();
  expect(html()).toContain(card.name);
  expect(html()).not.toContain(m.realm_discovery_continue());
  expect(calls.map((url) => url.searchParams.get('cursor'))).toEqual([null, cursor, cursor]);
  page.dispose();
});
