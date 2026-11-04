import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { initialHeaderSearchState } from '../src/search/header-search/state';
import { HeaderSearchView } from '../src/search/header-search/header-search';
import { UnavailableAccountAction } from '../src/shell/top-bar';
import { loadPrivatePage, SessionUnavailablePrompt } from '../src/session/private-page';
import { m } from '../src/paraglide/messages.js';

test('unresolved private destinations show a localized sign-in prompt without starting private reads', async () => {
  const paths = ['/en/library', '/en/realms', '/en/settings', '/en/creator/sales'];
  for (const path of paths) {
    const signInHref = `/auth/sign-in?return_to=${encodeURIComponent(path)}`;
    let reads = 0;
    const page = await loadPrivatePage({ state: 'unavailable', signInHref }, () => {
      reads++;
      return { privateValue: 'must not load' };
    });
    expect(page).toEqual({ sessionUnavailable: true, signInHref });
    expect(reads).toBe(0);
  }
});

test('only the session boundary failure is softened into the prompt', async () => {
  const access = { state: 'signed-in' as const, signInHref: '/auth/sign-in?return_to=%2Fen%2Flibrary' };
  await expect(
    loadPrivatePage(access, () => Promise.reject({ problem: { code: 'session_unavailable' } })),
  ).resolves.toEqual({ sessionUnavailable: true, signInHref: access.signInHref });
  await expect(loadPrivatePage(access, () => Promise.reject(new Error('reader bug')))).rejects.toThrow('reader bug');
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

test('the unavailable prompt exposes its safe local sign-in destination', () => {
  const href = '/auth/sign-in?return_to=%2Fen%2Fsettings%3Ftab%3Dprofile';
  const html = renderToStaticMarkup(createElement(SessionUnavailablePrompt, { signInHref: href }));
  expect(html).toContain('role="status"');
  expect(html).toContain(m.shell_account_unavailable());
  expect(html).toContain(m.account_sign_in());
  expect(html).toContain(`href="${href}"`);
});
