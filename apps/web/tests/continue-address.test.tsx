import { afterAll, expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { createKernelClient } from '@rezics/client';
import * as start from '../.storybook/react-start';
import { continueAddress, continueNewestHref } from '../src/library/continue-address';
import { nativeContinueSource } from '../src/library/continue-adapter';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
const { readContinueEntries, loadContinueState } = await import('../src/library/continue-read');
const { Route } = await import('../src/routes/library/continue');
const { ContinueSection } = await import('../src/library/continue');
const { m } = await import('../src/paraglide/messages.js');
afterAll(() => mock.restore());

test('served route and server reject malformed positions before any native read instead of opening an empty first page', async () => {
  const validate = Route.options.validateSearch as (search: Record<string, unknown>) => { cursor?: unknown };
  const load = Route.options.loader as (context: { deps: { cursor?: unknown } }) => Promise<unknown>;
  const client = createKernelClient('https://kernel.test', {
    fetch: mock(() => {
      throw new Error('Unexpected read');
    }),
  });
  for (const cursor of ['', null, false, 0, ['opaque'], {}, 'x'.repeat(4097)]) {
    const input = validate({ cursor });
    expect(input.cursor).toEqual(cursor);
    const failure = { state: 'unavailable', reason: 'invalid-address' };
    expect(await load({ deps: input })).toEqual(failure);
    expect(await readContinueEntries({ data: { cursor } })).toEqual(failure);
    expect(await loadContinueState(client, new Request('https://site.test'), {}, { cursor })).toEqual(failure);
  }
});

test('absent and bounded opaque positions retain exact text through admission and one native read', async () => {
  const cursor = `${'x'.repeat(4078)}+/==?&% 漢字#opaque`;
  const calls: Request[] = [];
  const client = createKernelClient('https://kernel.test', {
    async fetch(input, init) {
      calls.push(new Request(input, init));
      return Response.json({ subjects: [], next: null });
    },
  });
  expect(continueAddress({})).toEqual({});
  expect(continueAddress({ cursor: 'x'.repeat(4096) })).toEqual({ cursor: 'x'.repeat(4096) });
  expect(continueAddress({ cursor })).toEqual({ cursor });
  expect(await nativeContinueSource(client, 'Bearer original-reader', { limit: 6, cursor })).toEqual({
    state: 'loaded',
    entries: [],
    next: null,
  });
  expect(calls).toHaveLength(1);
  expect(new URL(calls[0]!.url).searchParams.get('cursor')).toBe(cursor);
  expect(calls[0]!.headers.get('authorization')).toBe('Bearer original-reader');
});

test('only native position refusals offer a localized deliberate newest page; denial and outage never become empty success', async () => {
  const href = continueNewestHref('fr', '?cursor=expired&display=compact&tag=a&tag=b', 'resume');
  expect(href).toBe('/fr/library/continue?display=compact&tag=a&tag=b#resume');
  for (const [status, code, recover] of [
    [400, 'invalid_cursor', true],
    [409, 'stale_cursor', true],
    [400, 'invalid_request', false],
    [409, 'precondition_failed', false],
    [401, 'invalid_credentials', false],
    [403, 'insufficient_scope', false],
    [503, 'unavailable', false],
  ] as const) {
    const calls: Request[] = [];
    const client = createKernelClient('https://kernel.test', {
      async fetch(input, init) {
        calls.push(new Request(input, init));
        return Response.json({ code }, { status });
      },
    });
    const result = await nativeContinueSource(client, 'Bearer original-reader', { limit: 6, cursor: 'saved+/==' });
    expect(result.state).toBe(status === 401 || status === 403 ? 'denied' : 'unavailable');
    const html = renderToStaticMarkup(
      <ContinueSection state={result} locale="fr" destination newestHref={href} onRetry={() => {}} />,
    );
    expect(html.includes(m.library_continue_address_expired({}, { locale: 'fr' }))).toBe(recover);
    expect(html.includes('href="/fr/library/continue?display=compact&amp;tag=a&amp;tag=b#resume"')).toBe(recover);
    expect(html).not.toContain(m.library_continue_empty({}, { locale: 'fr' }));
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0]!.url).searchParams.get('cursor')).toBe('saved+/==');
  }
  const malformed = renderToStaticMarkup(
    <ContinueSection state={{ state: 'unavailable', reason: 'invalid-address' }} locale="en" destination />,
  );
  expect(malformed).toContain(m.library_continue_address_malformed({}, { locale: 'en' }));
  expect(malformed).toContain('href="/en/library/continue"');
});
