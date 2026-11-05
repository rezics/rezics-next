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
  expect(html).toContain('Destructive change');
  expect(html).toContain('no sign-in of its own');
  expect(html).toContain('current authenticated human');
  expect(html).toContain('exact organization');
  expect(html).toContain('destination manager');
  expect(html).toContain('replaces your browser session');
  expect(html).toContain('A public profile or handle is not a management selector');
  expect(html).toContain('Availability is unknown');
  expect(html).not.toContain('<form');
  expect(html).not.toContain('<input');
  expect(html).not.toContain('<button');
  expect(html).not.toContain('href="/organizations/members');
  expect(html).not.toContain('href="/operators/transfer');
});
