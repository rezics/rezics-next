import { expect, mock, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { ManagedAccountDetailCard } from '../src/settings/managed-account-detail';
import {
  ManagedAccountReader,
  detailFailure,
  loadManagedAccountDetail,
  managedAccountTarget,
  managedAccountsBackHref,
  type DetailResult,
  type ManagementDetail,
} from '../src/settings/managed-account-detail-read';
import { m } from '../src/paraglide/messages.js';

const viewerId = '019a0000-0000-7000-8000-000000000001';
const accountId = '019a0000-0000-7000-8000-000000000002';
const actorId = '019a0000-0000-7000-8000-000000000003';
const reservationId = '019a0000-0000-7000-8000-000000000004';
const memberCursor = 'signed.members/+page==';
const operatorCursor = 'signed.operators/+page==';
const backHref = '/fr/settings?view=accounts&safe=a%2Bb#account';
function detail(): ManagementDetail {
  const member = { id: viewerId, kind: 'actor' as const, handle: null, displayName: 'Current native owner' };
  return {
    account: { id: accountId, kind: 'organization', handle: null, displayName: 'Atlas Editors' },
    self: false,
    role: 'owner',
    operator: null,
    relation: { operatorAccountId: viewerId, reservationId, version: 'private-relation-version' },
    members: { state: 'ready', items: [{ accountId: viewerId, account: member, role: 'owner' }], next: memberCursor },
    responsibilities: {
      items: [
        {
          reservationId,
          accountId: actorId,
          account: { ...member, id: actorId, displayName: 'Current indexer' },
          state: 'current',
        },
        {
          reservationId: '019a0000-0000-7000-8000-000000000005',
          accountId: '019a0000-0000-7000-8000-000000000006',
          account: null,
          state: 'reconciling',
        },
      ],
      next: operatorCursor,
    },
  };
}
const ready = (value = detail()): DetailResult => ({ ok: true, viewerId, value });
const markup = (reader: ManagedAccountReader | null) =>
  renderToStaticMarkup(createElement(ManagedAccountDetailCard, { reader, backHref }));

test('A native managed target opens from settings with independently paged current members and responsibilities; denied sections remain private and reconciling relations never become completed mutations', async () => {
  let body: unknown = detail();
  let status = 200;
  const requests: Request[] = [];
  const client = createKernelClient('https://kernel.example.test', {
    fetch: async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      return Response.json(body, { status, headers: { 'cache-control': 'private, no-store', 'retry-after': '3' } });
    },
  });
  const reader = new ManagedAccountReader(viewerId, accountId, (input) =>
    loadManagedAccountDetail(client, 'Bearer current-viewer', input),
  );
  await reader.load();
  let html = markup(reader);
  expect(html).toContain('Atlas Editors');
  expect(html).toContain('Current native owner');
  expect(html).toContain(m.managed_current());
  expect(html).toContain(m.managed_reconciling());
  expect(html).toContain(m.settings_managed_observation());
  expect(html).not.toContain('private-relation-version');
  expect(html).not.toContain(reservationId);
  expect(html).not.toContain(m.settings_saved());
  expect(html).not.toContain('<form');
  expect(requests).toHaveLength(1);

  const second = detail();
  second.members = { state: 'ready', items: [{ accountId: actorId, account: null, role: 'member' }], next: null };
  body = second;
  await reader.load('members', memberCursor);
  expect(reader.snapshot().members.page).toEqual(second.members);
  expect(reader.snapshot().responsibilities.page).toEqual(detail().responsibilities);
  expect(new URL(requests[1]!.url).searchParams.get('membersCursor')).toBe(memberCursor);
  expect(new URL(requests[1]!.url).searchParams.has('operatorsCursor')).toBe(false);
  body = { code: 'dependency_unavailable' };
  status = 503;
  await reader.load('responsibilities', operatorCursor);
  expect(reader.snapshot().responsibilities.failure).toMatchObject({
    status: 503,
    code: 'dependency_unavailable',
    retryAfter: '3',
  });
  expect(reader.snapshot().responsibilities.page).toEqual(detail().responsibilities);
  expect(reader.snapshot().members.page).toEqual(second.members);
  expect(new URL(requests[2]!.url).searchParams.get('operatorsCursor')).toBe(operatorCursor);
  expect(new URL(requests[2]!.url).searchParams.has('membersCursor')).toBe(false);
  expect(requests).toHaveLength(3); // no traversal, polling, or unrelated feed continuation
  for (const request of requests) {
    expect(request.method).toBe('GET');
    expect(new URL(request.url).pathname).toBe(`/v1/accounts/${accountId}/management`);
    expect(request.headers.get('authorization')).toBe('Bearer current-viewer');
    expect(request.headers.get('cache-control')).toBe('no-store');
    expect(request.cache).toBe('no-store');
  }

  const denied = detail();
  denied.role = 'member';
  denied.members = { state: 'denied', items: [], next: null };
  denied.responsibilities = null;
  body = denied;
  status = 200;
  await reader.load();
  html = markup(reader);
  expect(html).toContain(m.managed_holders_denied());
  expect(html).toContain(m.settings_managed_responsibilities_unavailable());
  expect(html).not.toContain('Current native owner');
  expect(html).not.toContain('Current indexer');
  expect(html).not.toContain(m.managed_no_holders());
  expect(html).not.toContain(m.managed_no_responsibilities());
});

test('the native boundary validates identities, closed response shape and the twenty-row page bound, and preserves literal refusals', async () => {
  let body: unknown = detail();
  let status = 200;
  const client = createKernelClient('https://kernel.example.test', {
    fetch: async () => Response.json(body, { status }),
  });
  const read = () => loadManagedAccountDetail(client, 'Bearer viewer', { viewerId, accountId });
  for (const invalid of [
    { ...detail(), account: { ...detail().account, id: actorId } },
    { ...detail(), inventedOperation: 'complete' },
    {
      ...detail(),
      members: { state: 'ready', items: Array.from({ length: 21 }, () => detail().members.items[0]), next: null },
    },
    {
      ...detail(),
      members: {
        state: 'ready',
        items: [{ accountId: actorId, account: detail().members.items[0]!.account, role: 'member' }],
        next: null,
      },
    },
  ]) {
    body = invalid;
    expect(await read()).toEqual({ ok: false, failure: { status: 502, code: 'invalid_response', transient: false } });
  }
  for (const failure of [
    { status: 403, code: 'forbidden' },
    { status: 404, code: 'not_found' },
    { status: 400, code: 'invalid_cursor' },
    { status: 403, code: 'platform_closed' },
  ]) {
    status = failure.status;
    body = { code: failure.code };
    expect(await read()).toEqual({ ok: false, failure: { ...failure, transient: false } });
  }
});

test('identity changes and authority losses discard private pages and reject late responses; nontransient page failures clear only that section', async () => {
  const pending: ((result: DetailResult) => void)[] = [];
  let defer = false;
  const reader = new ManagedAccountReader(viewerId, accountId, async () =>
    defer ? new Promise((resolve) => pending.push(resolve)) : ready(),
  );
  await reader.load();
  defer = true;
  const lateMembers = reader.load('members', memberCursor);
  const denial = reader.load('responsibilities', operatorCursor);
  const restricted = detail();
  restricted.members = { state: 'denied', items: [], next: null };
  restricted.responsibilities = null;
  pending[1]!(ready(restricted));
  await denial;
  pending[0]!(ready());
  await lateMembers;
  expect(reader.snapshot().members.page?.state).toBe('denied');
  expect(reader.snapshot().responsibilities.page).toBeNull();
  expect(markup(reader)).not.toContain('Current indexer');

  const stale = reader.load();
  reader.clear(); // the connected region also drops this reader synchronously when its viewer/target key changes
  expect(reader.snapshot().detail).toBeUndefined();
  pending[2]!(ready());
  await stale;
  expect(reader.snapshot().detail).toBeUndefined();
  defer = false;
  await reader.load();
  defer = true;
  const foreign = reader.load();
  pending[3]!({ ok: true, viewerId: actorId, value: detail() });
  await foreign;
  expect(reader.snapshot().detail).toBeUndefined();
  defer = false;
  await reader.load();
  defer = true;
  const invalidPage = reader.load('members', memberCursor);
  pending[4]!({ ok: false, failure: detailFailure(400, { code: 'invalid_cursor' }) });
  await invalidPage;
  expect(reader.snapshot().members.page).toBeUndefined();
  expect(reader.snapshot().responsibilities.page).toEqual(detail().responsibilities);
  const invisible = reader.load('responsibilities', operatorCursor);
  pending[5]!({ ok: false, failure: detailFailure(403, { code: 'forbidden' }) });
  await invisible;
  expect(reader.snapshot().detail).toBeUndefined();
  expect(markup(reader)).not.toContain('Atlas Editors');
});

test('the existing localized settings account region selects only an immutable ID and Back removes only managedAccount', async () => {
  const href = `/fr/settings?view=accounts&managedAccount=${accountId}&safe=a%2Bb#account`;
  expect(managedAccountTarget(href)).toBe(accountId);
  expect(managedAccountsBackHref(href)).toBe(backHref);
  expect(managedAccountTarget('/fr/settings?view=accounts#account')).toBeUndefined();
  for (const value of [
    'atlas-editors',
    '',
    '00000000-0000-0000-0000-000000000000',
    `${accountId}&managedAccount=${actorId}`,
  ])
    expect(managedAccountTarget(`/fr/settings?managedAccount=${value}`)).toBeNull();

  mock.module('cloudflare:workers', () => ({ env: {} }));
  const { SettingsPageView } = await import('../src/settings/settings-page');
  const queryClient = new QueryClient();
  const root = createRootRoute({
    component: () =>
      createElement(SettingsPageView, {
        page: { signedIn: true, state: 'unavailable', failure: { status: 503 }, securityHref: null },
        csrfToken: null,
      }),
  });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: [href] }) });
  try {
    await router.load();
    const html = renderToStaticMarkup(
      createElement(QueryClientProvider, { client: queryClient }, createElement(RouterProvider, { router })),
    );
    const region = html.slice(html.indexOf('<section id="account"'));
    expect(region).toContain(m.managed_detail_title());
    expect(region).toContain(backHref.replaceAll('&', '&amp;'));
    expect(region).not.toContain('/auth/sign-out');
    expect(region).not.toContain('Atlas Editors'); // unknown server session cannot hydrate private target content
    expect(queryClient.isFetching()).toBe(0);
  } finally {
    queryClient.clear();
  }
});
