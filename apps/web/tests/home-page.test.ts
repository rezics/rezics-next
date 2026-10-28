import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { slug } from '@rezics/definitions/slug';
import { createKernelClient } from '@rezics/client';
import { createFakeKernelFetch } from '../src/kernel/fake.ts';
import fixtures from '../src/kernel/fixtures.json';
import { loadRoutePage, RoutePage } from '../src/features/pages/route.tsx';

const messages = {
  unknown: '不明',
  none: 'なし',
  unlabelled: '名称未設定',
  sources: '出典',
  aliases: '別名',
  search: '検索',
};
const kokoro = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e01';

test('the home is the platform route template from one page read', async () => {
  const fake = createFakeKernelFetch(fixtures as never);
  const calls: string[] = [];
  const counting = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    calls.push(`${request.method} ${new URL(request.url).pathname}`);
    return fake(input, init);
  }) as typeof fetch;
  const client = createKernelClient('https://kernel.invalid', { fetch: counting });
  const loaded = await loadRoutePage(client, '/', 'ja');
  expect(calls).toEqual(['POST /v1/pages:read']);
  if (loaded.kind !== 'page') throw new Error('expected the home page');
  expect(loaded.page.template).toEqual({ scope: 'route', key: '/' });
  const html = renderToString(createElement(RoutePage, { page: loaded.page, locale: 'ja', messages }));
  expect(html).toMatch(/<form[^>]*action="\/ja\/search"/);
  expect(html).toMatch(/<input[^>]*name="q"/);
  expect(html).toContain('検索');
  expect(html).toContain('href="/ja/search?type=schema%3ABook"');
  expect(html).toContain(`href="/ja/subjects/${kokoro}/${slug('こころ')}"`);
  expect(html).toContain('こころ');
  expect(html).toContain('"@type":"WebSite"');
  expect(html).toContain('"query-input":"required name=search_term_string"');
});

test('a kernel without a home page falls back to the static home', async () => {
  for (const [status, code] of [
    [404, 'not_found'],
    [503, 'presentation_not_ready'],
  ] as const) {
    const answer = (async () =>
      new Response(JSON.stringify({ type: 'about:blank', title: code, status, code }), {
        status,
        headers: { 'content-type': 'application/problem+json' },
      })) as unknown as typeof fetch;
    const client = createKernelClient('https://kernel.invalid', { fetch: answer });
    expect(await loadRoutePage(client, '/')).toEqual({ kind: 'missing' });
  }
});

test('the home route renders the route page', async () => {
  const route = await Bun.file(new URL('../src/routes/index.tsx', import.meta.url)).text();
  expect(route).toContain('features/pages/route');
  expect(route).toContain('loadRoutePage(');
  expect(route).toContain('<RoutePage');
  expect(route).not.toContain('HomePage');
});
