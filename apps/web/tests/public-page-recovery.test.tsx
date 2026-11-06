import { expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { createKernelClient } from '@rezics/client';

mock.module('cloudflare:workers', () => ({ env: {} }));
const { PageReadError, capturePageRead, admitPageRead } = await import('../src/features/pages/page-read-failure');
const { loadSubjectPage } = await import('../src/features/pages/subject');
const { RoutePage, loadRoutePage } = await import('../src/features/pages/route');
const { subjectPageMessages } = await import('../src/features/pages/route-support');
const { PageReadState } = await import('../src/features/pages/page-read-state');
const { loadPrivatePage } = await import('../src/session/private-page');
const { routeFailure } = await import('../src/shell/error-state');
const { isPreparingReadError, sessionRecoverySignInHref } = await import('../src/session/unavailable');
const { m } = await import('../src/paraglide/messages.js');
const { locales } = await import('../src/paraglide/runtime.js');

const id = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e01';
const requests: Request[] = [];
function native(status: number, body: unknown, retryAfter?: string) {
  return createKernelClient('https://kernel.test', {
    fetch: async (input, init) => {
      requests.push(new Request(input, init));
      return Response.json(body, { status, ...(retryAfter ? { headers: { 'retry-after': retryAfter } } : {}) });
    },
  });
}

// Integration evidence: real client, loaders, server-function result shape and shared composition.
// Native owner/HTTP evidence is separately exercised in kernel/presentation/pages.test.ts.
test('native failure status and retry survive a serialized server read and retain route HTTP semantics', async () => {
  requests.length = 0;
  for (const status of [202, 403, 503]) {
    const code = status === 202 ? 'links_preparing' : status === 403 ? 'forbidden' : 'dependency_unavailable';
    const transported = JSON.parse(
      JSON.stringify(
        await capturePageRead(() => loadSubjectPage(native(status, { status, code }, '7'), id, undefined, 'fr')),
      ),
    );
    expect(transported).toEqual({ kind: 'read-failed', failure: { status, code, retryAfter: '7' } });
    let error: unknown;
    try {
      admitPageRead(transported);
    } catch (failure) {
      error = failure;
    }
    expect(error).toBeInstanceOf(PageReadError);
    expect(routeFailure([{ status: 'error', error }])).toMatchObject({ status, retryAfter: '7' });
    expect(routeFailure([{ status: 'error', error }], 500)).toMatchObject({ status });
    expect(isPreparingReadError(error)).toBe(status === 202);
  }
  expect(requests).toHaveLength(3);
  expect(await requests[0]!.json()).toEqual({ target: { subject: id }, languages: ['fr'] });
  await expect(
    capturePageRead(async () => {
      throw new Error('unexpected defect');
    }),
  ).rejects.toThrow('unexpected defect');
});

test('route loaders distinguish cold preparation, missing, denied and owner outage without extra reads', async () => {
  requests.length = 0;
  for (const [status, code, kind] of [
    [202, 'links_preparing', 'preparing'],
    [503, 'presentation_not_ready', 'preparing'],
    [503, 'dependency_unavailable', 'unavailable'],
    [403, 'forbidden', 'rejected'],
  ] as const) {
    expect(await loadRoutePage(native(status, { status, code }, '3'), '/', 'ja')).toEqual({
      kind,
      status,
      code,
      retryAfter: '3',
    });
  }
  expect(await loadRoutePage(native(404, { code: 'not_found' }), '/')).toEqual({ kind: 'missing' });
  expect(requests).toHaveLength(5);
});

test('the real composition retains native preparation and retry, then admits a terminal native empty page', async () => {
  const document = {
    root: { props: {} },
    content: [{ type: 'TypeList', props: { id: 'books', title: { en: 'Books' }, types: ['schema:Book'] } }],
  };
  const page = (read: unknown) => ({
    profile: 'sha256:current',
    template: { scope: 'route', key: '/' },
    document,
    reads: { r0: read },
  });
  for (const locale of locales) {
    const prepared = await loadRoutePage(
      native(200, page({ status: 202, body: { code: 'links_preparing' }, headers: { 'retry-after': '60' } })),
      '/',
      locale,
    );
    if (prepared.kind !== 'page') throw new Error('Expected an admitted route');
    const html = renderToString(
      createElement(RoutePage, {
        page: prepared.page,
        locale,
        heading: 'Home',
        messages: subjectPageMessages(locale),
      }),
    );
    expect(html).toContain('data-page-read-state="preparing"');
    expect(html).toContain('data-response-status="202"');
    expect(html).toContain(m.public_read_preparing({}, { locale }));
    expect(html).toContain('disabled=""');
    expect(html).not.toContain(m.search_no_results({}, { locale }));
    const recovered = await loadRoutePage(
      native(200, page({ status: 200, body: { subjects: [], next: null } })),
      '/',
      locale,
    );
    if (recovered.kind !== 'page') throw new Error('Expected recovered route');
    const ready = renderToString(
      createElement(RoutePage, {
        page: recovered.page,
        locale,
        heading: 'Home',
        messages: subjectPageMessages(locale),
      }),
    );
    expect(ready).toContain(m.search_no_results({}, { locale }));
    expect(ready).not.toContain('data-page-read-state');
  }
});

test('each failure offers a keyboard-native recovery action with localized native meaning', () => {
  for (const locale of locales) {
    for (const [status, state] of [
      [202, 'preparing'],
      [403, 'denied'],
      [404, 'missing'],
      [503, 'unavailable'],
    ] as const) {
      const html = renderToString(
        createElement(PageReadState, { failure: { status }, locale, href: `/${locale}/subjects/${id}` }),
      );
      expect(html).toContain(`data-page-read-state="${state}"`);
      expect(html).toContain(`href="/${locale}/subjects/${id}"`);
      expect(html).toContain('focus-visible:outline');
      expect(html).toContain('min-h-11');
    }
  }
});

test('an indeterminate session never starts private work and its sign-in return contains no private operands', async () => {
  let calls = 0;
  await expect(
    loadPrivatePage({ state: 'unavailable', signInHref: '/auth/sign-in' }, async () => ++calls),
  ).rejects.toMatchObject({ code: 'session_unavailable', status: 503 });
  expect(calls).toBe(0);
  for (const locale of locales) {
    const href = sessionRecoverySignInHref(`/${locale}/settings?csrfToken=private&cursor=retired#credentials`);
    const target = new URL(href, 'https://site.test');
    expect(target.pathname).toBe('/auth/sign-in');
    expect(target.searchParams.get('return_to')).toBe(`/${locale}/settings`);
    expect(href).not.toContain('private');
    expect(href).not.toContain('retired');
  }
  expect(sessionRecoverySignInHref('//external.test/settings')).toBe('/auth/sign-in');
});
