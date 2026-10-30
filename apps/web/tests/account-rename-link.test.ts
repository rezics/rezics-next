import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readAccountRenameContext } from '../src/settings/account-rename-data';
import { AccountSafetyCard } from '../src/settings/account-safety';
import { accountRenameHref, securityHrefFromIssuer } from '../src/settings/account-safety-links';
import { m } from '../src/paraglide/messages.js';

const accountId = '123e4567-e89b-42d3-a456-426614174000';
const securityHref = securityHrefFromIssuer('https://auth.example.test');
const render = (renameAccount: Awaited<ReturnType<typeof readAccountRenameContext>>, issuer = securityHref) =>
  renderToStaticMarkup(
    createElement(AccountSafetyCard, {
      state: 'signed-in',
      securityHref: issuer,
      csrfToken: null,
      onReload() {},
      renameAccount,
    }),
  );

function transport(handle: string | null, resource?: object, profileId = accountId) {
  const requests: Request[] = [];
  const client = createKernelClient('https://kernel.example.test', {
    fetch: (async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      expect(request.headers.get('authorization')).toBe('Bearer private-website-token');
      expect(request.headers.get('cache-control')).toBe('no-store');
      if (request.method === 'POST') {
        expect(new URL(request.url).pathname).toBe('/v1/viewerActions');
        expect(await request.json()).toEqual({ resources: [{ type: 'access.account', id: accountId }] });
        return Response.json({
          resources: [
            resource ?? {
              type: 'access.account',
              id: accountId,
              viewerActions: [{ action: 'account:update', operations: ['account.update'] }],
            },
          ],
        });
      }
      expect(new URL(request.url).pathname).toBe(`/v1/accounts/${accountId}/profile`);
      return Response.json({
        profile: {
          id: profileId,
          kind: 'actor',
          handle,
          displayName: null,
          bio: null,
          links: [],
          avatar: null,
          publicViews: { posts: true, reviews: true, collections: true, realms: true },
        },
      });
    }) as typeof fetch,
  });
  return { read: () => readAccountRenameContext(client, 'Bearer private-website-token', accountId), requests };
}

test('Expose safe handle rename from the current Accounts settings journey preserves exact native authority current-account binding explicit confirmation and unavailable states', async () => {
  for (const handle of ['alice', null]) {
    const source = transport(handle);
    const context = await source.read();
    expect(context).toEqual({ accountId, handle, available: true });
    expect(source.requests).toHaveLength(2);
    const html = render(context);
    expect(html).toContain('href="https://auth.example.test/account/rename"');
    expect(html).toContain('referrerPolicy="no-referrer"');
    expect(html).toContain(accountId);
    expect(html).toContain(handle ? '@alice' : m.settings_account_rename_handleless());
    expect(html).toContain(m.settings_account_rename_confirmation());
    expect(html).toContain(m.settings_account_rename_policy());
    expect(html).toContain('href="https://auth.example.test/security"');
    expect(html).toContain('href="https://auth.example.test/account/delete"');
    expect(html).not.toContain('/@');
    expect(html).not.toContain('private-website-token');
    expect(html).not.toContain('account-operations/approve');
    expect(render(context, null)).not.toContain('/account/rename');
  }
});

test('missing, denied, malformed and foreign native capability cannot enable rename', async () => {
  for (const resource of [
    { type: 'access.account', id: accountId, viewerActions: [] },
    {
      type: 'access.account',
      id: accountId,
      viewerActions: [{ action: 'account:manage', operations: ['account.update'] }],
    },
    { type: 'access.account', id: accountId, viewerActions: [{ action: 'account:update', operations: ['unknown'] }] },
    {
      type: 'access.account',
      id: 'someone-else',
      viewerActions: [{ action: 'account:update', operations: ['account.update'] }],
    },
    { type: 'access.account', id: accountId, viewerActions: [{ action: 'account:update' }] },
    { type: 'access.account', id: accountId, error: 'not_found' },
  ]) {
    const context = await transport(null, resource).read();
    expect(context?.available).toBe(false);
    expect(render(context)).not.toContain('/account/rename');
    expect(render(context)).toContain(m.settings_account_rename_unavailable());
  }
  expect(await transport(null, undefined, 'someone-else').read()).toBeNull();
  expect(render(null)).not.toContain('/account/rename');
  const signedOut = renderToStaticMarkup(
    createElement(AccountSafetyCard, { state: 'signed-out', returnTo: '/settings' }),
  );
  expect(signedOut).not.toContain('/account/rename');
});

test('rename navigation allowlists the configured issuer route without callbacks or authority', () => {
  expect(accountRenameHref(securityHref)).toBe('https://auth.example.test/account/rename');
  for (const input of [
    null,
    '/security',
    'https://auth.example.test/other',
    'https://auth.example.test/security?return_to=https://evil.test',
    'https://auth.example.test/security#account_id=other',
    'https://user:secret@auth.example.test/security',
    'http://auth.example.test/security',
  ])
    expect(accountRenameHref(input)).toBeNull();
  expect(accountRenameHref('http://localhost:3001/security')).toBe('http://localhost:3001/account/rename');
});
