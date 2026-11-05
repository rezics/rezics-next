import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { AccountHome } from '../src/account-home-view';
import { AuthShell } from '../src/frame';
import { Route } from '../src/routes/index';

test('the root route renders the localized account page without a server-side identity read', () => {
  const previousFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = (async () => {
    requests++;
    throw new Error('server rendering must not read private identity');
  }) as typeof fetch;
  try {
    const head = Route.options.head?.({} as never);
    const html = renderToString(createElement(AuthShell, null, createElement(AccountHome)));
    expect(head?.meta?.[0]?.title).toBe('Account · REZICS');
    expect(html).toContain('href="/"');
    expect(html).toContain('href="/security"');
    expect(html).toContain('href="/account/rename"');
    expect(html).toContain('href="/account/delete"');
    expect(html).toContain('role="status"');
    expect(requests).toBe(0);
  } finally {
    globalThis.fetch = previousFetch;
  }
});
