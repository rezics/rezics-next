import { expect, mock, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { authManagementPageHref } from '../src/session/auth-page-routes';
import {
  accountRenameNavigation,
  accountRenameSetupFailure,
  runAccountRenameHandler,
  serializeAccountRenameResult,
} from '../src/settings/account-rename-actions';
import {
  accountRenamePresentedFailure,
  readAccountRenameContext,
  readAccountRenameContextResult,
} from '../src/settings/account-rename-data';
import { AccountSafetyCard } from '../src/settings/account-safety';
import { accountRenameHref, securityHrefFromIssuer } from '../src/settings/account-safety-links';
import { m } from '../src/paraglide/messages.js';
import { officialProfileRead } from '../src/settings/editable-profile-source';

const accountId = '123e4567-e89b-42d3-a456-426614174000';
const securityHref = securityHrefFromIssuer('https://auth.example.test');
const deployment = {
  AUTH_ISSUER: 'https://auth.example.test',
  AUTH_MANAGEMENT_PAGE_ROUTES: JSON.stringify(['/account/rename']),
};
const render = (
  renameAccount: Awaited<ReturnType<typeof readAccountRenameContext>>,
  env: Parameters<typeof authManagementPageHref>[0] = deployment,
) =>
  renderToStaticMarkup(
    createElement(AccountSafetyCard, {
      state: 'signed-in',
      securityHref: securityHrefFromIssuer(env.AUTH_ISSUER),
      csrfToken: null,
      onReload() {},
      renameAccount: accountRenameNavigation(env, renameAccount),
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
      return Response.json(
        officialProfileRead({
          id: profileId,
          kind: 'actor',
          handle,
          displayName: null,
          bio: null,
          links: [],
          avatar: null,
          publicViews: { posts: true, reviews: true, collections: true, realms: true },
        }),
      );
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
    expect(render(context, {})).not.toContain('/account/rename');
  }
});

test('rename stays unavailable without an explicit valid deployment even with current native capability', () => {
  const context = { accountId, handle: 'alice', available: true };
  for (const AUTH_MANAGEMENT_PAGE_ROUTES of [undefined, 'not JSON', '["/organizations/members"]']) {
    const html = render(context, { ...deployment, AUTH_MANAGEMENT_PAGE_ROUTES });
    expect(html).not.toContain('/account/rename');
    expect(html).toContain(m.settings_account_rename_unavailable());
    expect(html).toContain('href="https://auth.example.test/security"');
    expect(html).toContain('href="https://auth.example.test/account/delete"');
  }
  expect(context).toEqual({ accountId, handle: 'alice', available: true });
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

test('native profile and capability failures retain bounded status/problem/delay metadata in a serializable region result', async () => {
  for (const failedMethod of ['GET', 'POST']) {
    for (const [status, retryAfter] of [
      [429, '7'],
      [503, new Date(Date.now() + 60_000).toUTCString()],
    ] as const) {
      const requests: Request[] = [];
      const problem = {
        type: 'https://rezics.com/problems/dependency_unavailable',
        title: 'Unavailable',
        code: 'dependency_unavailable',
        retryable: true,
        request_id: 'native-account-read',
        detail: 'private-website-token',
        arbitrary: 'not-for-transport',
      };
      const client = createKernelClient('https://kernel.example.test', {
        fetch: (async (input, init) => {
          const request = new Request(input, init);
          requests.push(request);
          expect(request.headers.get('authorization')).toBe('Bearer private-website-token');
          expect(request.headers.get('cache-control')).toBe('no-store');
          expect(request.cache).toBe('no-store');
          if (request.method === failedMethod)
            return Response.json(problem, { status, headers: { 'retry-after': retryAfter } });
          return request.method === 'POST'
            ? Response.json({
                resources: [
                  {
                    type: 'access.account',
                    id: accountId,
                    viewerActions: [{ action: 'account:update', operations: ['account.update'] }],
                  },
                ],
              })
            : Response.json(
                officialProfileRead({
                  id: accountId,
                  kind: 'actor',
                  handle: 'alice',
                  displayName: null,
                  bio: null,
                  links: [],
                  avatar: null,
                  publicViews: { posts: true, reviews: true, collections: true, realms: true },
                }),
              );
        }) as typeof fetch,
      });
      const result = JSON.parse(
        JSON.stringify(await readAccountRenameContextResult(client, 'Bearer private-website-token', accountId)),
      );
      expect(requests).toHaveLength(2);
      expect(requests.map((request) => `${request.method} ${new URL(request.url).pathname}`).sort()).toEqual([
        `GET /v1/accounts/${accountId}/profile`,
        'POST /v1/viewerActions',
      ]);
      expect(result.failures).toEqual([
        { kind: 'failed', status, code: problem.code, retryable: true, requestId: 'native-account-read', retryAfter },
      ]);
      expect(result.context).toEqual(failedMethod === 'GET' ? null : { accountId, handle: 'alice', available: false });
      expect(JSON.stringify(result)).not.toContain(problem.detail);
      expect(JSON.stringify(result)).not.toContain(problem.arbitrary);
      const html = renderToStaticMarkup(
        createElement(AccountSafetyCard, {
          state: 'signed-in',
          securityHref,
          csrfToken: 'current-csrf',
          onReload() {},
          renameAccount: accountRenameNavigation(deployment, result.context),
          renameRead: { loading: false, reload() {}, failures: result.failures },
        }),
      );
      expect(html).toContain(m.settings_account_rename_failed());
      expect(html).toContain(m.settings_retry_wait());
      expect(html).not.toContain('/account/rename');
      expect(html).not.toContain(problem.detail);
      if (failedMethod === 'POST') expect(html).toContain('@alice');
    }
  }
});

test('explicit native denial differs from unavailable capability and absent deployment without enabling navigation', async () => {
  for (const [status, code, message] of [
    [403, 'forbidden', m.settings_account_rename_denied()],
    [403, 'platform_closed', m.settings_account_rename_unavailable()],
    [404, 'not_found', m.settings_account_rename_unavailable()],
  ] as const) {
    const client = createKernelClient('https://kernel.example.test', {
      fetch: (async () =>
        Response.json(
          { type: 'https://rezics.com/problems/' + code, title: 'Unavailable', code },
          { status },
        )) as typeof fetch,
    });
    const result = await readAccountRenameContextResult(client, 'Bearer private-website-token', accountId);
    expect(result.failures).toHaveLength(2);
    const html = renderToStaticMarkup(
      createElement(AccountSafetyCard, {
        state: 'signed-in',
        securityHref,
        csrfToken: 'current-csrf',
        onReload() {},
        renameAccount: null,
        renameRead: { loading: false, reload() {}, failures: result.failures },
      }),
    );
    expect(html).toContain(message);
    expect(html).not.toContain('/account/rename');
    expect(html).not.toContain(m.settings_retry_wait());
  }
  expect(accountRenameNavigation(deployment, null)).toBeNull();
  expect(
    accountRenameNavigation({ AUTH_ISSUER: deployment.AUTH_ISSUER }, { accountId, handle: 'alice', available: true }),
  ).toEqual({ accountId, handle: 'alice', available: true, href: null });
});

test('mixed native failures present unavailable before denied and never enable navigation', () => {
  const failures = [
    { kind: 'denied' as const, status: 403, code: 'forbidden' },
    { kind: 'unavailable' as const, status: 404, code: 'not_found' },
    { kind: 'failed' as const, status: 503, retryAfter: '7' },
  ];
  expect(accountRenamePresentedFailure(failures)).toEqual(failures[1]);
  const html = renderToStaticMarkup(
    createElement(AccountSafetyCard, {
      state: 'signed-in',
      securityHref,
      csrfToken: 'current-csrf',
      onReload() {},
      renameAccount: { accountId, handle: 'alice', available: true, href: 'https://auth.example.test/account/rename' },
      renameRead: { loading: false, reload() {}, failures },
    }),
  );
  expect(html).toContain(m.settings_account_rename_unavailable());
  expect(html).not.toContain(m.settings_account_rename_denied());
  expect(html).not.toContain('/account/rename');
  expect(html).toContain(m.settings_retry_wait());
});

test('thrown setup yields a serializable unavailable result rather than an escaped transport failure', async () => {
  const leaked = 'private-setup-token';
  const headers: string[] = [];
  mock.module('@tanstack/react-start/server', () => ({
    getRequest() {
      throw new Error(leaked);
    },
    setResponseHeader(name: string, value: string) {
      headers.push(`${name}: ${value}`);
    },
  }));
  mock.module('cloudflare:workers', () => ({
    get env() {
      throw new Error(leaked);
    },
  }));
  const setup = serializeAccountRenameResult(accountRenameSetupFailure(new Error(leaked)));
  expect(setup).toEqual({ context: null, failures: [{ kind: 'unavailable', status: null }] });
  expect(JSON.stringify(setup)).not.toContain(leaked);
  const result = JSON.parse(JSON.stringify(await runAccountRenameHandler()));
  expect(result).toEqual(setup);
  expect(JSON.stringify(result)).not.toContain(leaked);
  expect(headers).toEqual(['cache-control: private, no-store']);
});
