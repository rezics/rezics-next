import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { AccountHomeView } from '../src/account-home-view';
import { overwriteGetLocale } from '../src/paraglide/runtime.js';

test('the real home exposes complete fixed review navigation and explains exact-target work', () => {
  overwriteGetLocale(() => 'en');
  const html = renderToStaticMarkup(
    <AccountHomeView state={{ kind: 'signed-out' }} retry={() => {}} retryFocusVersion={0} />,
  );
  const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((match) => match[1]);
  expect([...new Set(hrefs)].sort()).toEqual(
    [
      '/',
      '/account/delete',
      '/account/rename',
      '/automated/new',
      '/login',
      '/organizations/new',
      '/recovery',
      '/security',
      '/signup',
    ].sort(),
  );
  expect(html).toContain('aria-current="page"');
  expect(html).toContain('This change is destructive');
  expect(html).toContain('no sign-in of its own');
  expect(html).toContain('You must be signed in as a human');
  expect(html).toContain('Start from the organization in its own flow');
  expect(html).toContain('destination manager');
  expect(html).toContain('Opening replaces your browser session');
  expect(html).toContain('A public profile or handle is not enough to manage an account');
  expect(html).toContain('This page does not know whether the action is available');
  expect(html).not.toContain('<form');
  expect(html).not.toContain('<input');
  expect(html).not.toContain('<button');
  expect(html).not.toContain('href="/organizations/members');
  expect(html).not.toContain('href="/operators/transfer');
});
