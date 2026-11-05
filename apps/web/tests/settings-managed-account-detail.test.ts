import { expect, mock, spyOn, test } from 'bun:test';
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
  type DetailRequest,
  type DetailResult,
  type DetailSection,
  type ManagementDetail,
} from '../src/settings/managed-account-detail-read';
import { m } from '../src/paraglide/messages.js';
import { AnonymousSessionContext } from '../src/session/query';

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
  renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: new QueryClient() },
      createElement(
        AnonymousSessionContext,
        { value: true },
        createElement(ManagedAccountDetailCard, { reader, backHref }),
      ),
    ),
  );

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
  const clock = spyOn(Date, 'now').mockReturnValue(reader.snapshot().retryAt!);
  try {
    await reader.load();
  } finally {
    clock.mockRestore();
  }
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
  const read = async (): Promise<DetailResult> => (defer ? new Promise((resolve) => pending.push(resolve)) : ready());
  let reader = new ManagedAccountReader(viewerId, accountId, read);
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
  await reader.load(); // Disposal never permits another request on that lifetime.
  reader = new ManagedAccountReader(viewerId, accountId, read);
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

test('Connect exact native Auth entries to deployed management destinations preserving the current native and draft/recovery contracts', async () => {
  const env = {
    AUTH_ISSUER: 'https://auth.test',
    AUTH_MANAGEMENT_PAGE_ROUTES: '["/organizations/members","/organizations/delete"]',
  };
  const operations = [
    {
      operationId: 'auth.organization.membership',
      action: 'organization:membership',
      resource: { route: 0, id: accountId },
    },
    { operationId: 'auth.organization.delete', action: 'account:delete', resource: { route: 0, id: accountId } },
  ];
  let body: unknown = detail();
  const requests: Request[] = [];
  const client = createKernelClient('https://kernel.test', {
    fetch: async (input, init) => {
      requests.push(new Request(input, init));
      return Response.json(body);
    },
  });
  const read = () => loadManagedAccountDetail(client, 'Bearer current-viewer', { viewerId, accountId }, env);
  const legacy = await read();
  expect(legacy.ok && legacy.value).toEqual(detail());
  expect(legacy.ok && legacy.authNavigation?.actions.members.state).toBe('unavailable');
  for (const authActions of [
    { state: 'unavailable' },
    { state: 'ready', operations: 'invalid' },
    { state: 'ready', operations: [{ ...operations[0], resource: { route: -1, id: accountId } }] },
  ]) {
    body = { ...detail(), authActions };
    const result = await read();
    expect(result.ok && result.value).toEqual(detail());
    expect(result.ok && result.authNavigation?.actions.members.state).toBe('unavailable');
  }
  body = { ...detail(), authActions: { state: 'ready', operations } };
  const positive = await read();
  expect(positive.ok && positive.value).toEqual(detail());
  expect(positive.ok && positive.authNavigation?.actions.members).toEqual({
    state: 'available',
    href: `https://auth.test/organizations/members?organizationId=${accountId}`,
  });
  expect(positive.ok && positive.authNavigation?.actions.delete.state).toBe('available');
  expect(positive.ok && positive.value).not.toHaveProperty('authActions');
  expect(requests).toHaveLength(5); // Exactly the existing management GET per requested observation.
  for (const request of requests) {
    expect(new URL(request.url).pathname).toBe(`/v1/accounts/${accountId}/management`);
    expect(request.method).toBe('GET');
    expect(request.headers.get('authorization')).toBe('Bearer current-viewer');
    expect(request.cache).toBe('no-store');
    expect(new URL(request.url).search).toBe('');
  }
});

test('detail Refresh and feed reads drop stale Auth links immediately and older replies cannot override newer missing or denied observations', async () => {
  const { projectManagedAuthNavigation } = await import('../src/settings/managed-account-actions-read');
  const value = detail();
  value.account.displayName = 'Older target';
  const operations = [
    { operationId: 'auth.organization.delete', action: 'account:delete', resource: { route: 0, id: accountId } },
  ];
  const projectNavigation = (snapshot: ManagementDetail) =>
    projectManagedAuthNavigation(
      { state: 'ready', operations },
      snapshot,
      viewerId,
      { AUTH_ISSUER: 'https://auth.test', AUTH_MANAGEMENT_PAGE_ROUTES: '["/organizations/delete"]' },
    );
  const authNavigation = projectNavigation(value);
  const positive: DetailResult = { ok: true, viewerId, value, authNavigation };
  const current = detail();
  current.account.displayName = 'Current target';
  current.account.kind = 'actor';
  current.self = true;
  current.role = 'member';
  current.operator = { ...current.account, id: actorId, displayName: 'Current operator' };
  current.relation = null;
  const pending: ((result: DetailResult) => void)[] = [];
  let defer = false;
  const reader = new ManagedAccountReader(viewerId, accountId, async () =>
    defer ? new Promise((resolve) => pending.push(resolve)) : positive,
  );
  await reader.load();
  expect(reader.snapshot().authNavigation?.actions.delete.state).toBe('available');
  defer = true;
  const refresh = reader.load();
  expect(reader.snapshot().authNavigation).toBeUndefined();
  pending[0]!({ ok: false, failure: detailFailure(503, { code: 'dependency_unavailable' }) });
  await refresh;
  expect(reader.snapshot().authNavigation).toBeUndefined();
  expect(reader.snapshot().detail?.account).toEqual(value.account); // Read-only recovery retains its own content.
  const older = reader.load('members', memberCursor);
  const newer = reader.load('responsibilities', operatorCursor);
  const denied = projectManagedAuthNavigation({ state: 'ready', operations: [] }, current, viewerId, {});
  pending[2]!({ ok: true, viewerId, value: current, authNavigation: denied });
  await newer;
  expect(reader.snapshot().authNavigation?.actions.delete.state).toBe('denied');
  pending[1]!(positive);
  await older;
  expect(reader.snapshot().authNavigation?.actions.delete.state).toBe('denied');
  expect(reader.snapshot().detail).toMatchObject({
    account: current.account,
    self: true,
    role: 'member',
    operator: current.operator,
    operated: false,
  });
  expect(reader.snapshot().members.page).toEqual(value.members);
  expect(reader.snapshot().responsibilities.page).toEqual(current.responsibilities);
  const rendered = markup(reader);
  expect(rendered).toContain('Current target');
  expect(rendered).toContain('Current operator');
  expect(rendered).toContain(m.managed_member());
  expect(rendered).not.toContain('Older target');
  expect(rendered).not.toContain('/organizations/delete');
  const missing = reader.load();
  const latest = detail();
  latest.account.displayName = 'Latest retained target';
  latest.role = 'member';
  pending[3]!({ ok: true, viewerId, value: latest, authNavigation: projectNavigation(latest) });
  await missing;
  expect(reader.snapshot().authNavigation?.actions.delete.state).toBe('available');
  const olderMembers = reader.load('members', memberCursor);
  const latestFailure = reader.load('responsibilities', operatorCursor);
  pending[5]!({ ok: false, failure: detailFailure(503, { code: 'dependency_unavailable' }) });
  await latestFailure;
  expect(reader.snapshot().authNavigation).toBeUndefined();
  pending[4]!(positive);
  await olderMembers;
  expect(reader.snapshot().detail?.account).toEqual(latest.account);
  expect(reader.snapshot().detail?.role).toBe('member');
  expect(reader.snapshot().authNavigation).toBeUndefined();
  const stale = reader.load();
  reader.clear(); // Viewer, CSRF and target changes replace/clear this immutable reader.
  pending[6]!(positive);
  await stale;
  expect(reader.snapshot().authNavigation).toBeUndefined();
  const switched = new ManagedAccountReader(viewerId, actorId, async () => positive);
  await switched.load();
  expect(switched.snapshot().detail).toBeUndefined();
  expect(switched.snapshot().authNavigation).toBeUndefined();
});

test('Offer first-page recovery for a failed managed detail continuation preserving exact original semantic input, native authority and bounded requests', async () => {
  for (const section of ['members', 'responsibilities'] as const) {
    const sibling = section === 'members' ? 'responsibilities' : 'members';
    const cursor = section === 'members' ? memberCursor : operatorCursor;
    const siblingCursor = section === 'members' ? operatorCursor : memberCursor;
    let body: unknown = detail();
    let status = 200;
    const requests: Request[] = [];
    const inputs: DetailRequest[] = [];
    const client = createKernelClient('https://kernel.example.test', {
      fetch: async (input, init) => {
        requests.push(new Request(input, init));
        return Response.json(body, { status });
      },
    });
    const reader = new ManagedAccountReader(
      viewerId,
      accountId,
      (input) => {
        inputs.push(input);
        return loadManagedAccountDetail(client, 'Bearer current-viewer', input);
      },
      'current-csrf',
    );
    await reader.load();
    const otherPage = detail();
    otherPage.members.items[0]!.account!.displayName = 'Sibling owner page';
    otherPage.responsibilities!.items[0]!.account!.displayName = 'Sibling responsibility page';
    body = otherPage;
    await reader.load(sibling, siblingCursor);
    const retained = reader.snapshot()[sibling];

    body = { code: 'invalid_cursor' };
    status = 400;
    await reader.load(section, cursor);
    expect(reader.snapshot()[section].page).toBeUndefined();
    expect(reader.snapshot()[sibling]).toBe(retained);
    const label = section === 'members' ? m.managed_holders_title() : m.managed_operated_title();
    const html = markup(reader);
    expect(html).toContain(`aria-label="${m.settings_retry()} · ${label}"`);
    expect(html.split(`aria-label="${m.settings_managed_start_first_page()} · ${label}"`)).toHaveLength(2);
    expect(html).toContain('min-h-11 min-w-11');
    expect(html).not.toContain(section === 'members' ? 'Current native owner' : 'Current indexer');
    await reader.load(section, reader.snapshot()[section].cursor);
    expect(inputs[3]).toEqual(inputs[2]); // Retry preserves the exact viewer, target, feed and opaque cursor.

    const current = detail();
    current.members.items[0]!.account!.displayName = 'Current recovered owner';
    current.responsibilities!.items[0]!.account!.displayName = 'Current recovered responsibility';
    body = current;
    status = 200;
    await reader.load(section);
    expect(reader.snapshot()[section]).toEqual({ page: current[section], cursor: undefined, pending: false });
    expect(reader.snapshot()[sibling]).toBe(retained);
    expect(reader.csrfToken).toBe('current-csrf');
    expect(inputs).toEqual([
      { viewerId, accountId },
      { viewerId, accountId, section: sibling, cursor: siblingCursor },
      { viewerId, accountId, section, cursor },
      { viewerId, accountId, section, cursor },
      { viewerId, accountId, section },
    ]);
    expect(requests).toHaveLength(5);
    const key = section === 'members' ? 'membersCursor' : 'operatorsCursor';
    expect(new URL(requests[2]!.url).searchParams.get(key)).toBe(cursor);
    expect(requests[3]!.url).toBe(requests[2]!.url);
    expect(new URL(requests[4]!.url).search).toBe('');
    for (const request of requests) {
      expect(request.method).toBe('GET');
      expect(new URL(request.url).pathname).toBe(`/v1/accounts/${accountId}/management`);
      expect(request.headers.get('authorization')).toBe('Bearer current-viewer');
      expect(request.headers.get('cache-control')).toBe('no-store');
      expect(request.cache).toBe('no-store');
    }
  }
});

test('a failed first-page reset stays an honest section error; native refusals or restricted responses cannot revive private rows', async () => {
  for (const section of ['members', 'responsibilities'] as const) {
    for (const status of [400, 401, 403, 404, 200]) {
      let result = ready();
      const inputs: DetailRequest[] = [];
      const reader = new ManagedAccountReader(viewerId, accountId, async (input) => {
        inputs.push(input);
        return result;
      });
      await reader.load();
      const sibling = section === 'members' ? 'responsibilities' : 'members';
      const retained = reader.snapshot()[sibling];
      result = { ok: false, failure: detailFailure(400, { code: 'invalid_cursor' }) };
      await reader.load(section, section === 'members' ? memberCursor : operatorCursor);
      const restricted = detail();
      restricted.role = 'member';
      restricted.members = { state: 'denied', items: [], next: null };
      restricted.responsibilities = null;
      result = status === 200 ? ready(restricted) : { ok: false, failure: detailFailure(status) };
      await reader.load(section);
      expect(inputs).toHaveLength(3);
      expect(inputs[2]).toEqual({ viewerId, accountId, section });
      const html = markup(reader);
      expect(html).not.toContain(section === 'members' ? 'Current native owner' : 'Current indexer');
      expect(html).not.toContain(m.settings_managed_start_first_page());
      expect(html).not.toContain(m.managed_no_holders());
      expect(html).not.toContain(m.managed_no_responsibilities());
      if (status === 400) {
        expect(reader.snapshot()[section]).toEqual({
          page: undefined,
          cursor: undefined,
          pending: false,
          failure: detailFailure(400),
        });
        expect(reader.snapshot()[sibling]).toBe(retained);
        expect(html).toContain(m.settings_managed_unavailable());
      } else if (status === 200) {
        expect(reader.snapshot().members.page?.state).toBe('denied');
        expect(reader.snapshot().responsibilities.page).toBeNull();
        expect(html).toContain(m.managed_holders_denied());
        expect(html).toContain(m.settings_managed_responsibilities_unavailable());
      } else {
        expect(reader.snapshot().detail).toBeUndefined();
        expect(reader.snapshot().members.page).toBeUndefined();
        expect(reader.snapshot().responsibilities.page).toBeUndefined();
        expect(reader.snapshot().failure?.status).toBe(status);
      }
    }
  }
});

test('transient continuation failures retain their page while Retry-After disables both actions; a pending reset admits no duplicate or global read', async () => {
  const clock = spyOn(Date, 'now');
  try {
    for (const section of ['members', 'responsibilities'] satisfies DetailSection[]) {
      let result = ready();
      let resolve: ((value: DetailResult) => void) | undefined;
      let defer = false;
      const inputs: DetailRequest[] = [];
      const reader = new ManagedAccountReader(viewerId, accountId, (input) => {
        inputs.push(input);
        return defer
          ? new Promise((done) => {
              resolve = done;
            })
          : Promise.resolve(result);
      });
      await reader.load();
      const sibling = section === 'members' ? 'responsibilities' : 'members';
      defer = true;
      const admitted = reader.load(sibling);
      defer = false;
      const captured = reader.load.bind(reader, section, section === 'members' ? memberCursor : operatorCursor);
      result = { ok: false, failure: detailFailure(429, {}, { 'retry-after': '3' }) };
      await reader.load(section, section === 'members' ? memberCursor : operatorCursor);
      const deadline = reader.snapshot().retryAt!;
      clock.mockReturnValue(deadline - 1000);
      resolve!(ready());
      await admitted;
      expect(reader.snapshot().retryAt).toBe(deadline);
      const saved = reader.snapshot();
      await captured();
      await reader.load();
      await reader.load(section);
      expect(reader.snapshot()).toBe(saved);
      const html = markup(reader);
      const label = section === 'members' ? m.managed_holders_title() : m.managed_operated_title();
      const actions = (html.match(/<button\b[^>]*>/g) ?? []).filter((button) =>
        [m.settings_retry(), m.settings_managed_start_first_page()].some((action) =>
          button.includes(`aria-label="${action} · ${label}"`),
        ),
      );
      expect(html).toContain(m.settings_retry_wait());
      expect(actions).toHaveLength(2);
      for (const action of actions) expect(action).toContain('disabled=""');
      expect(html).toContain('Current native owner');
      expect(html).toContain('Current indexer');
      expect(html).not.toContain(`aria-label="${m.settings_managed_first_page()} ·`);
      expect(inputs).toHaveLength(3); // Only the already admitted sibling may settle during the wait.
      clock.mockReturnValue(deadline);
      expect(inputs).toHaveLength(3); // Expiry never sends IO.
      defer = true;
      const reset = reader.load(section);
      expect(reader.snapshot()[section].pending).toBe(true);
      expect(reader.snapshot()[section === 'members' ? 'responsibilities' : 'members'].pending).toBe(false);
      await reader.load(section);
      await reader.load(section, 'another-cursor');
      await reader.load();
      expect(inputs).toHaveLength(4);
      resolve!(ready());
      await reset;
      expect(reader.snapshot()[section].cursor).toBeUndefined();
    }
  } finally {
    clock.mockRestore();
  }
});
