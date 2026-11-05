import { expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { slug } from '@rezics/definitions/slug';
import { createKernelClient, type KernelClient } from '@rezics/client';
import { createFakeKernelFetch, createStoryRecordedKernelFetch } from '../src/kernel/fake.ts';
import fixtures from '../src/kernel/fixtures.json';

mock.module('cloudflare:workers', () => ({ env: {} }));
const { loadRoutePage } = await import('../src/features/pages/route.tsx');
const { HomeCatalogue } = await import('../src/features/pages/home-catalogue');
const { m } = await import('../src/paraglide/messages.js');

const messages = {
  unknown: '不明',
  none: 'なし',
  unlabelled: '名称未設定',
  sources: '出典',
  aliases: '別名',
  search: '検索',
};
const kokoro = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e01';

test('the Home catalogue consumes the native route template from one page read', async () => {
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
  const html = renderToString(createElement(HomeCatalogue, { result: loaded, locale: 'ja' }));
  expect(html).not.toMatch(/<form/);
  expect(html).not.toMatch(/<input[^>]*name="q"/);
  expect(html).toContain('href="/ja/search/list?list=books');
  expect(html).toContain('href="/ja/search/list?list=anime');
  expect(html).toContain('href="/ja/search/list?list=visual-novels');
  expect(html).toContain('href="/ja/search/list?list=recipes');
});

test('the Home catalogue keeps native list headings without adding type subtitles', async () => {
  const fake = createStoryRecordedKernelFetch();
  const client = createKernelClient('https://kernel.invalid', { fetch: fake });
  const loaded = await loadRoutePage(client, '/', 'ja');
  if (loaded.kind !== 'page') throw new Error('expected the home page');
  const html = renderToString(createElement(HomeCatalogue, { result: loaded, locale: 'ja' }));
  expect([...html.matchAll(/data-slot="type-list"/g)]).toHaveLength(4);
  expect(html).toContain('books-title');
  expect(html).toContain('anime-title');
  expect(html).toContain('visual-novels-title');
  expect(html).toContain('recipes-title');
  expect(html).not.toContain('schema:Book');
  expect(html).not.toContain('schema:Recipe');
});

test('only an absent page is missing; an inactive publication is unavailable', async () => {
  for (const [status, code, expected] of [
    [404, 'not_found', { kind: 'missing' }],
    [503, 'presentation_not_ready', { kind: 'unavailable', status: 503, code: 'presentation_not_ready' }],
  ] as const) {
    const answer = (async () =>
      new Response(JSON.stringify({ type: 'about:blank', title: code, status, code }), {
        status,
        headers: { 'content-type': 'application/problem+json' },
      })) as unknown as typeof fetch;
    const client = createKernelClient('https://kernel.invalid', { fetch: answer });
    expect(await loadRoutePage(client, '/')).toEqual(expected);
  }
});

test('Home preserves rejected, missing and unavailable page reads as separate outcomes with deliberate recovery', async () => {
  const response = (status: number, code: string) =>
    createKernelClient('https://kernel.invalid', {
      fetch: (async () =>
        Response.json({ type: 'about:blank', title: code, status, code }, { status })) as typeof fetch,
    });
  const rejected = await loadRoutePage(response(400, 'unsupported_query'), '/');
  const unavailable = await loadRoutePage(response(503, 'presentation_not_ready'), '/');
  expect(rejected).toEqual({ kind: 'rejected', status: 400, code: 'unsupported_query' });
  expect(unavailable).toEqual({ kind: 'unavailable', status: 503, code: 'presentation_not_ready' });
  const network = await loadRoutePage(
    {
      pages: {
        $read: {
          post: async () => {
            throw new TypeError('Failed to fetch');
          },
        },
      },
    } as unknown as KernelClient,
    '/',
  );
  expect(network).toEqual({ kind: 'unavailable', code: 'dependency_unavailable' });

  const rejectedHtml = renderToString(createElement(HomeCatalogue, { result: rejected, locale: 'en' }));
  const unavailableHtml = renderToString(createElement(HomeCatalogue, { result: unavailable, locale: 'en' }));
  expect(rejectedHtml).toContain('data-home-catalogue-state="rejected"');
  expect(rejectedHtml).toContain('data-response-code="unsupported_query"');
  expect(unavailableHtml).toContain('data-home-catalogue-state="unavailable"');
  expect(unavailableHtml).toContain(m.catalogue_result_read_unavailable());
  expect(unavailableHtml).toContain(m.catalogue_retry_loading_result());
});

test('the home route renders the route page', async () => {
  const route = await Bun.file(new URL('../src/routes/index.tsx', import.meta.url)).text();
  expect(route).toContain('HomeCatalogue');
  expect(route).toContain('HomeFeedConsumer');
  expect(route).toContain('homePageQuery(');
  expect(route).not.toContain('HomePage');
});
