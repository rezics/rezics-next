import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { currentLinkRefusal, discoveryExample } from '../src/kernel/fake/search-discovery';
import { discoveryKey, parseDiscoveryPage, readDiscovery, type DiscoveryRequest } from '../src/search/discovery';
import { discoveryAccountHref, DiscoveryResults } from '../src/search/discovery-results';

const request: DiscoveryRequest = { representation: 'discovery-v1', text: 'Mira', limit: 100, languages: ['en'] };

test('the mixed journey uses one current native response and keeps Person, Account and handleless identities distinct', async () => {
  const calls: { url: string; body: string }[] = [];
  const client = createKernelClient('http://kernel.local', {
    fetch: async (input, init) => {
      calls.push({ url: String(input), body: String(init?.body) });
      return Response.json(discoveryExample);
    },
  });
  const { discovery } = await readDiscovery(request, (body) => client.subjects.$search.post(body));
  expect(calls).toEqual([{ url: 'http://kernel.local/v1/subjects:search', body: JSON.stringify(request) }]);
  expect(discovery.status).toBe('ready');
  if (discovery.status !== 'ready') throw new Error('Mixed results unavailable');
  expect(discovery.page.hits.map(discoveryKey)).toEqual([
    JSON.stringify(['semantic', 'schema:Person', 0, discoveryExample.hits[0]!.key.id]),
    JSON.stringify(['accounts', 'account', 0, discoveryExample.hits[0]!.key.id]),
    JSON.stringify(['accounts', 'account', 0, discoveryExample.hits[2]!.key.id]),
    JSON.stringify(['semantic', 'schema:Book', 0, discoveryExample.hits[3]!.key.id]),
  ]);
  const html = renderToStaticMarkup(createElement(DiscoveryResults, { state: discovery, locale: 'en' }));
  expect(html.match(/data-slot="list-row"/g)).toHaveLength(4);
  expect(html).toContain('/en/@mira');
  expect(html).toContain(`/en/subjects/${discoveryExample.hits[0]!.key.id}/mira`);
  expect(html).toContain('Mira Reading Room');
  expect(html).not.toContain('@Mira%20Reading%20Room');
  expect(html).not.toContain('followers');
  expect(calls).toHaveLength(1); // Rendering issues no detail, handle lookup or count requests.
});

test('current native refusal removes account and verification links without inventing a name or ID target', () => {
  const page = currentLinkRefusal();
  for (const hit of page.hits) {
    if (hit.summary.kind !== 'account') throw new Error('Expected an Account');
    expect(discoveryAccountHref(hit.summary.value, 'en')).toBeUndefined();
  }
  const html = renderToStaticMarkup(
    createElement(DiscoveryResults, { state: { status: 'ready', page }, locale: 'en' }),
  );
  expect(html).toContain('Mira Reading Room');
  expect(html).not.toContain('href=');
  expect(html).not.toContain('Verified');
});

test('empty, unavailable, not-ready and loading are different; legacy or incomplete responses cannot become success', async () => {
  const states = [
    await readDiscovery(request, async () => ({ status: 200, data: { ...discoveryExample, hits: [] } })),
    await readDiscovery(request, async () => ({ status: 503, error: { value: { code: 'unavailable' } } })),
    await readDiscovery(request, async () => ({ status: 503, error: { value: { code: 'index_not_ready' } } })),
    await readDiscovery(request, async () => ({
      status: 200,
      data: { subjects: [], next: null, as_of: discoveryExample.as_of },
    })),
  ];
  expect(states.map(({ discovery }) => discovery.status)).toEqual(['ready', 'unavailable', 'not-ready', 'unavailable']);
  const messages = [...states.slice(0, 3).map(({ discovery }) => discovery), { status: 'loading' as const }].map(
    (state) => renderToStaticMarkup(createElement(DiscoveryResults, { state, locale: 'en' })),
  );
  expect(new Set(messages).size).toBe(4);
  const incomplete = structuredClone(discoveryExample);
  expect(
    parseDiscoveryPage({ ...incomplete, hits: [{ key: incomplete.hits[0]!.key, summary: null }] }),
  ).toBeUndefined();
  expect(messages.join('')).not.toContain('0 results');
});

test('one native cursor and language chain survive continuation; only Top rated gets one stale-cursor restart', async () => {
  const calls: DiscoveryRequest[] = [];
  const first = { ...request, sort: 'rating' as const, cursor: 'opaque-native-cursor', languages: ['ja', 'en'] };
  const read = await readDiscovery(first, async (body) => {
    calls.push(body);
    return calls.length === 1
      ? { status: 409, error: { code: 'search_restart_required' } }
      : { status: 200, data: { ...discoveryExample, next: 'opaque-next' } };
  });
  const { cursor: _cursor, ...restarted } = first;
  expect(calls).toEqual([first, restarted]);
  expect(read.restarted).toBe(true);
  expect(read.discovery.status === 'ready' && read.discovery.page.next).toBe('opaque-next');
  const abort = new DOMException('Cancelled', 'AbortError');
  await expect(
    readDiscovery(request, async () => {
      throw abort;
    }),
  ).rejects.toBe(abort);
});

test('native summary identity must agree with its key, and private fields never enter card output', () => {
  const page = structuredClone(discoveryExample);
  const first = page.hits[0]!;
  expect(parseDiscoveryPage({ ...page, hits: [{ ...first, key: { ...first.key, id: 'wrong-id' } }] })).toBeUndefined();
  expect(parseDiscoveryPage({ ...page, hits: [first, first] })).toBeUndefined();
  const html = renderToStaticMarkup(
    createElement(DiscoveryResults, {
      state: { status: 'ready', page },
      locale: 'en',
    }),
  );
  expect(html).not.toContain('operatorId');
  expect(html).not.toContain('accountKind');
});
