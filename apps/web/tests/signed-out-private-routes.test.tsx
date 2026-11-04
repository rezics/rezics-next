import { afterAll, expect, mock, test } from 'bun:test';
import { isRedirect } from '@tanstack/react-router';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { initialHeaderSearchState } from '../src/search/header-search/state';
import { UnavailableAccountAction } from '../src/shell/top-bar';
import { loadPrivatePage, SessionUnavailablePrompt } from '../src/session/private-page';
import { requirePrivatePageAccess } from '../src/session/guard';
import { SessionUnavailableError } from '../src/session/unavailable';
import { m } from '../src/paraglide/messages.js';

mock.module('../src/kernel/exposure', () => ({
  Exposure: ({ children }: { children: ReactNode }) => children,
  operationIsAdmitted: () => false,
  useOperation: () => false,
}));
const { HeaderSearchView } = await import('../src/search/header-search/header-search');

afterAll(() => mock.restore());

test('indeterminate private access uses the shared recovery state without starting private reads', async () => {
  const paths = ['/en/library', '/en/realms', '/en/settings', '/en/creator/sales'];
  for (const path of paths) {
    const signInHref = `/auth/sign-in?return_to=${encodeURIComponent(path)}`;
    let reads = 0;
    await expect(
      loadPrivatePage({ state: 'unavailable', signInHref }, () => {
        reads++;
        return { privateValue: 'must not load' };
      }),
    ).rejects.toBeInstanceOf(SessionUnavailableError);
    expect(reads).toBe(0);
  }
});

test('a private read that loses session authority becomes a typed shared failure', async () => {
  const access = { state: 'signed-in' as const, signInHref: '/auth/sign-in?return_to=%2Fen%2Flibrary' };
  await expect(
    loadPrivatePage(access, () => Promise.reject({ problem: { code: 'session_unavailable' } })),
  ).rejects.toBeInstanceOf(SessionUnavailableError);
  await expect(loadPrivatePage(access, () => Promise.reject(new Error('reader bug')))).rejects.toThrow('reader bug');
});

test('known signed-out private visitors keep the established sign-in redirect', async () => {
  const path = '/en/library?tab=recent';
  const signInHref = `/auth/sign-in?return_to=${encodeURIComponent(path)}`;
  const queryClient = {
    ensureQueryData: async () => ({ state: 'signed-out', csrfToken: null }),
    getQueryState: () => ({
      status: 'success',
      fetchStatus: 'idle',
      isInvalidated: false,
      data: { state: 'signed-out', csrfToken: null },
    }),
  };
  let failure: unknown;
  try {
    await requirePrivatePageAccess({
      context: { queryClient } as never,
      location: { publicHref: path },
    });
  } catch (error) {
    failure = error;
  }
  expect(isRedirect(failure)).toBe(true);
  expect(failure).toMatchObject({ options: { href: signInHref, statusCode: 302, reloadDocument: true } });
});

test('failed or retired session observations cannot admit a private route', async () => {
  const staleReader = { state: 'signed-in', subject: 'reader-1', csrfToken: 'token-1' };
  for (const queryState of [
    { status: 'error', fetchStatus: 'idle', isInvalidated: false, data: staleReader },
    { status: 'success', fetchStatus: 'fetching', isInvalidated: false, data: staleReader },
    { status: 'success', fetchStatus: 'idle', isInvalidated: true, data: staleReader },
  ]) {
    const queryClient = {
      ensureQueryData: async () => staleReader,
      getQueryState: () => queryState,
    };
    await expect(
      requirePrivatePageAccess({ context: { queryClient } as never, location: { publicHref: '/en/library' } }),
    ).rejects.toBeInstanceOf(SessionUnavailableError);
  }
});

test('the phone shell keeps an accessible status, a sign-in target, and a search affordance', () => {
  const account = renderToStaticMarkup(
    createElement(UnavailableAccountAction, { signIn: '/auth/sign-in?return_to=%2Fen%2Flibrary' }),
  );
  expect(account).toContain('role="status"');
  expect(account).toContain(m.shell_account_unavailable());
  expect(account).toContain('href="/auth/sign-in?return_to=%2Fen%2Flibrary"');
  expect(account).toContain('min-h-11 min-w-11');

  const search = renderToStaticMarkup(
    createElement(HeaderSearchView, {
      id: 'phone-search',
      state: initialHeaderSearchState(),
      locale: 'en',
      region: null,
    }),
  );
  expect(search).toContain('header-search-trigger');
  expect(search).toContain('h-11');
  expect(search).toContain('size-4 shrink-0 text-muted-foreground');
  expect(search).not.toContain('REZICS');
});

test('the private session failure adapter uses the shared unavailable page and safe Home destination', () => {
  const html = renderToStaticMarkup(createElement(SessionUnavailablePrompt));
  expect(html).toContain('data-route-state="unavailable"');
  expect(html).toContain(m.dependency_unavailable_heading());
  expect(html).toContain(`href="/${'en'}"`);
  expect(html).not.toContain('/auth/sign-in');
});
