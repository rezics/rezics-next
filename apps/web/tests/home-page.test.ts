import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { slug } from '@rezics/definitions/slug';
import { createKernelClient } from '@rezics/client';
import { createFakeKernelFetch, createStoryRecordedKernelFetch } from '../src/kernel/fake.ts';
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
  expect(html).not.toMatch(/<form/);
  expect(html).not.toMatch(/<input[^>]*name="q"/);
  expect(html).toContain('href="/ja/search?type=schema%3ABook"');
  expect(html).toContain(`href="/ja/subjects/${kokoro}/${slug('こころ')}"`);
  expect(html).toContain('こころ');
  expect(html).toContain('"@type":"WebSite"');
  expect(html).toContain('"query-input":"required name=search_term_string"');
});

test('the home type rows keep their heading and cards without repeating the type under each title', async () => {
  const fake = createStoryRecordedKernelFetch();
  const client = createKernelClient('https://kernel.invalid', { fetch: fake });
  const loaded = await loadRoutePage(client, '/', 'ja');
  if (loaded.kind !== 'page') throw new Error('expected the home page');
  const html = renderToString(createElement(RoutePage, { page: loaded.page, locale: 'ja', messages }));
  expect(html).toContain('href="/ja/search?type=schema%3ABook"');
  expect(html).toContain('href="/ja/search?type=schema%3ARecipe"');
  const booksStart = html.indexOf('<section data-slot="type-list"');
  const booksEnd = html.indexOf('</section>', booksStart);
  const books = html.slice(booksStart, booksEnd);
  const booksInOrder = [...books.matchAll(/href="\/ja\/subjects\/([^/"]+)/g)].map((match) => match[1]);
  expect(booksInOrder).toEqual([
    '01a17dfd-5dbf-738a-9405-9dfa9a8ec069',
    '01a1773a-f700-7071-b5ef-2b02f7d0e8c6',
    '01a1773a-f6ff-7684-8e44-1a013af60d4b',
    '01a1773a-f700-7078-8000-000000000003',
    '01a17a3b-6c01-77c8-94fd-810a3ae73369',
    '01a1773a-f700-7078-8000-000000000001',
  ]);
  expect(html).toContain('吾輩は猫である');
  expect(html).not.toContain('data-slot="cover-card-secondary"');
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
