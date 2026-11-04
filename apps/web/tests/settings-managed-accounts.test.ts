import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import {
  ManagedAccountsInventory,
  firstOccurrenceInCurrentPage,
  loadManagedAccounts,
  managedAccountDestination,
  managedAccountHref,
  managedAccountsException,
  managedAccountsFailure,
  type ManagedAccountsCursors,
  type ManagedAccountsPage,
  type ManagedAccountsResult,
} from '../src/settings/managed-accounts-read';
import { MediaProblem } from '../src/media/kernel';
import { preferenceRetryDeadline } from '../src/settings/preference-failure-retry';

const viewer = '019a0000-0000-7000-8000-000000000001';
const organization = '019a0000-0000-7000-8000-000000000002';
const operated = '019a0000-0000-7000-8000-000000000003';
function page(): ManagedAccountsPage {
  const account = { id: viewer, kind: 'actor' as const, handle: 'avery', displayName: 'Avery' };
  return {
    account,
    viewer: { state: 'current', account },
    organizations: {
      state: 'ready',
      items: [
        {
          account: { id: organization, kind: 'organization', handle: null, displayName: 'Reading group' },
          role: 'member',
          navigation: { state: 'admitted' },
        },
      ],
      next: 'signed organization +/=',
    },
    responsibilities: {
      items: [
        {
          reservationId: organization,
          accountId: operated,
          account: null,
          state: 'reconciling',
          navigation: { state: 'concealed' },
        },
      ],
      next: 'signed operator +/=',
    },
  };
}
const ready = (value: ManagedAccountsPage): ManagedAccountsResult => ({ ok: true, page: value });
const unavailable: ManagedAccountsResult = {
  ok: false,
  kind: 'unavailable',
  status: 503,
  code: 'dependency_unavailable',
};

test('A signed-in human can reach their own identity, independent organization membership and operator responsibility pages in settings without treating preparing or reconciling as current authority', async () => {
  const calls: object[] = [];
  const initial = page();
  initial.organizations = { state: 'preparing', items: [], next: null };
  const inventory = new ManagedAccountsInventory(viewer, async (cursors) => {
    calls.push(cursors);
    if (cursors.operatorsCursor) return ready({ ...page(), responsibilities: { items: [], next: null } });
    return ready(initial);
  });
  await inventory.load();
  expect(inventory.snapshot().account?.id).toBe(viewer);
  expect(inventory.snapshot().organizations.state).toBe('preparing');
  expect(inventory.snapshot().responsibilities.items[0]?.state).toBe('reconciling');
  expect(inventory.snapshot().responsibilities.items[0]?.account).toBeNull();
  await inventory.more('responsibilities');
  expect(calls).toEqual([{}, { operatorsCursor: 'signed operator +/=' }]);
  expect(inventory.snapshot().organizations.state).toBe('preparing');
  expect(inventory.snapshot().responsibilities.next).toBeNull();
  const href = new URL(
    managedAccountHref('/ja/settings?panel=compact&managedAccount=old#profile', operated),
    'https://rezics.test',
  );
  expect(href.pathname).toBe('/ja/settings');
  expect(href.searchParams.get('panel')).toBe('compact');
  expect(href.searchParams.get('managedAccount')).toBe(operated);
  expect(href.hash).toBe('#account');
});

test('each feed retains its opaque cursor and usable pages across transient failure and deduplicates retried delivery', async () => {
  const calls: object[] = [];
  let fail = true;
  const inventory = new ManagedAccountsInventory(viewer, async (cursors) => {
    calls.push(cursors);
    if (!cursors.organizationsCursor && !cursors.operatorsCursor) return ready(page());
    if (cursors.organizationsCursor && fail) {
      fail = false;
      return unavailable;
    }
    if (cursors.organizationsCursor)
      return ready({ ...page(), organizations: { state: 'ready', items: [], next: 'next signed organization' } });
    return ready({ ...page(), responsibilities: { ...page().responsibilities, next: null } });
  });
  await inventory.load();
  await inventory.more('organizations');
  expect(inventory.snapshot().organizations.items).toHaveLength(1);
  expect(inventory.snapshot().organizations.failure).toEqual(unavailable);
  await inventory.more('responsibilities');
  expect(inventory.snapshot().responsibilities.items).toHaveLength(1);
  expect(inventory.snapshot().organizations.next).toBe('signed organization +/=');
  await inventory.more('organizations');
  expect(inventory.snapshot().organizations.next).toBe('next signed organization');
  expect(inventory.snapshot().organizations.items).toHaveLength(0);
  expect(inventory.snapshot().organizations.origin).toBe(false);
  expect(calls).toEqual([
    {},
    { organizationsCursor: 'signed organization +/=' },
    { operatorsCursor: 'signed operator +/=' },
    { organizationsCursor: 'signed organization +/=' },
  ]);
});

test('denial clears all private pages and invalidates in-flight siblings; disposal and wrong-viewer completions never revive them', async () => {
  let finish: (result: ManagedAccountsResult) => void = () => {};
  const inventory = new ManagedAccountsInventory(viewer, async (cursors) => {
    if (cursors.operatorsCursor)
      return new Promise((resolve) => {
        finish = resolve;
      });
    if (cursors.organizationsCursor) return { ok: false, kind: 'denied', status: 403, code: 'forbidden' };
    return ready(page());
  });
  await inventory.load();
  const pending = inventory.more('responsibilities');
  await inventory.more('organizations');
  finish(ready(page()));
  await pending;
  expect(inventory.snapshot().account).toBeNull();
  expect(inventory.snapshot().responsibilities.items).toEqual([]);
  expect(inventory.snapshot().failure?.code).toBe('forbidden');
  const stale = new ManagedAccountsInventory(
    viewer,
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const loading = stale.load();
  stale.dispose();
  finish(ready(page()));
  await loading;
  expect(stale.snapshot().account).toBeNull();
  const changed = new ManagedAccountsInventory(viewer, async () =>
    ready({ ...page(), account: { ...page().account, id: operated } }),
  );
  await changed.load();
  expect(changed.snapshot().account).toBeNull();
});

test('native reads validate the exact bounded schema, preserve literal failures and make only one no-store viewer request', async () => {
  const requests: Request[] = [];
  let body: unknown = page();
  let status = 200;
  const client = createKernelClient('https://kernel.test', {
    fetch: (async (input, init) => {
      requests.push(new Request(input, init));
      expect(init?.cache).toBe('no-store');
      return Response.json(body, { status });
    }) as typeof fetch,
  });
  const cursors = { organizationsCursor: 'org +/=', operatorsCursor: 'op +/=' };
  expect((await loadManagedAccounts(client, 'Bearer viewer', viewer, cursors)).ok).toBe(true);
  expect(requests).toHaveLength(1);
  expect(requests[0]!.headers.get('authorization')).toBe('Bearer viewer');
  expect(requests[0]!.headers.get('cache-control')).toBe('no-store');
  expect(new URL(requests[0]!.url).pathname).toBe('/v1/me/managedAccounts');
  expect(Object.fromEntries(new URL(requests[0]!.url).searchParams)).toEqual(cursors);
  body = { ...page(), organizations: { state: 'ready', items: [], next: 'filtered continuation' } };
  const filtered = await loadManagedAccounts(client, 'Bearer viewer', viewer, {});
  expect(filtered.ok && filtered.page.organizations.next).toBe('filtered continuation');
  body = {
    ...page(),
    responsibilities: { items: [{ ...page().responsibilities.items[0], state: 'complete' }], next: null },
  };
  expect((await loadManagedAccounts(client, 'Bearer viewer', viewer, {})).ok).toBe(false);
  status = 403;
  body = {
    status: 403,
    code: 'account_suspended',
    title: 'Forbidden',
    type: 'https://rezics.com/problems/account_suspended',
  };
  expect(await loadManagedAccounts(client, 'Bearer viewer', viewer, {})).toEqual({
    ok: false,
    kind: 'denied',
    status: 403,
    code: 'account_suspended',
  });
});

test('Respect native retry delays in managed account inventory with current native response and viewer isolation contracts', async () => {
  const requests: Request[] = [];
  for (const [status, retryAfter, retryable] of [
    [429, '12', true],
    [503, 'Sat, 31 Oct 2026 12:00:00 GMT', false],
  ] as const) {
    const body = { status, code: 'overloaded', retryable, request_id: `native-${status}` };
    const client = createKernelClient('https://kernel.test', {
      fetch: (async (input, init) => {
        requests.push(new Request(input, init));
        expect(init?.cache).toBe('no-store');
        return Response.json(body, { status, headers: { 'Retry-After': retryAfter } });
      }) as typeof fetch,
    });
    const failure = {
      ok: false,
      kind: 'unavailable',
      status,
      code: body.code,
      retryAfter,
      retryable,
      requestId: body.request_id,
    };
    expect(await loadManagedAccounts(client, 'Bearer viewer', viewer, {})).toEqual(failure);
    expect(
      managedAccountsException(
        new MediaProblem({ ...body, title: 'Unavailable', type: 'about:blank' }, { 'Retry-After': retryAfter }),
      ),
    ).toEqual(failure);
  }
  expect(requests).toHaveLength(2);
  for (const request of requests) {
    expect(request.method).toBe('GET');
    expect(request.headers.get('authorization')).toBe('Bearer viewer');
    expect(request.headers.get('cache-control')).toBe('no-store');
    expect(new URL(request.url).pathname).toBe('/v1/me/managedAccounts');
    expect(new URL(request.url).search).toBe('');
  }
  expect(managedAccountsFailure(403, { code: 'forbidden', retryable: false })).toEqual({
    ok: false,
    kind: 'denied',
    status: 403,
    code: 'forbidden',
    retryable: false,
  });
  expect(managedAccountsFailure(503, { retryable: 'true', request_id: 42 })).toEqual({
    ok: false,
    kind: 'unavailable',
    status: 503,
    code: null,
  });
});

test('inventory retry metadata uses the shared seconds and HTTP-date deadlines without inventing a delay', () => {
  const now = Date.parse('Sat, 31 Oct 2026 12:00:00 GMT');
  for (const [header, deadline] of [
    ['12', now + 12_000],
    ['Sat, 31 Oct 2026 12:00:20 GMT', now + 20_000],
    [undefined, 0],
    ['', 0],
    ['0', 0],
    ['-1', 0],
    ['1.5', 0],
    ['later', 0],
    ['Sat, 31 Oct 2026 11:59:59 GMT', 0],
  ] as const) {
    const failure = managedAccountsFailure(
      503,
      undefined,
      header === undefined ? undefined : { 'Retry-After': header },
    );
    expect(preferenceRetryDeadline(failure.retryAfter, now)).toBe(deadline);
  }
});

test('independent delayed feed failures keep exact cursors, retained rows and reconciliation while explicit recovery advances only its feed', async () => {
  const calls: ManagedAccountsCursors[] = [];
  const failed = new Set<string>();
  const organizationFailure = managedAccountsFailure(
    429,
    { code: 'rate_limited', retryable: true },
    { 'Retry-After': '2' },
  );
  const responsibilityFailure = managedAccountsFailure(
    503,
    { code: 'overloaded', request_id: 'operator-page' },
    { 'Retry-After': 'Sat, 31 Oct 2026 12:00:20 GMT' },
  );
  const inventory = new ManagedAccountsInventory(viewer, async (cursors) => {
    calls.push(cursors);
    const feed = cursors.organizationsCursor ? 'organizations' : cursors.operatorsCursor ? 'responsibilities' : null;
    if (!feed) return ready(page());
    if (!failed.has(feed)) {
      failed.add(feed);
      return feed === 'organizations' ? organizationFailure : responsibilityFailure;
    }
    return ready({ ...page(), [feed]: { ...page()[feed], items: [], next: null } });
  });
  await inventory.load();
  await Promise.all([inventory.more('organizations'), inventory.more('responsibilities')]);
  const bothFailed = inventory.snapshot();
  expect(bothFailed.organizations.failure).toBe(organizationFailure);
  expect(bothFailed.responsibilities.failure).toBe(responsibilityFailure);
  expect(bothFailed.organizations.items).toEqual(page().organizations.items);
  expect(bothFailed.responsibilities.items).toEqual(page().responsibilities.items);
  await inventory.more('organizations');
  expect(inventory.snapshot().organizations.next).toBeNull();
  expect(inventory.snapshot().organizations.items).toEqual([]);
  expect(inventory.snapshot().responsibilities).toBe(bothFailed.responsibilities);
  await inventory.more('responsibilities');
  expect(inventory.snapshot().organizations.next).toBeNull();
  expect(inventory.snapshot().responsibilities.next).toBeNull();
  expect(inventory.snapshot().responsibilities.items).toEqual([]);
  expect(calls).toEqual([
    {},
    { organizationsCursor: 'signed organization +/=' },
    { operatorsCursor: 'signed operator +/=' },
    { organizationsCursor: 'signed organization +/=' },
    { operatorsCursor: 'signed operator +/=' },
  ]);
});

test('busy initial and selected-feed actions make one request while disposal still permits a fresh lifecycle load', async () => {
  const calls: ManagedAccountsCursors[] = [];
  let finish: (result: ManagedAccountsResult) => void = () => {};
  const inventory = new ManagedAccountsInventory(viewer, (cursors) => {
    calls.push(cursors);
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  const loading = inventory.load();
  await inventory.load();
  expect(calls).toEqual([{}]);
  finish(ready(page()));
  await loading;
  const paging = inventory.more('organizations');
  await inventory.more('organizations');
  expect(calls).toHaveLength(2);
  finish(unavailable);
  await paging;
  expect(inventory.snapshot().organizations.next).toBe('signed organization +/=');
  const abandoned = inventory.load();
  const finishAbandoned = finish;
  inventory.dispose();
  finishAbandoned({ ok: false, kind: 'denied', status: 403, code: 'forbidden' });
  await abandoned;
  expect(inventory.snapshot().account).toBeNull();
  const revived = new ManagedAccountsInventory(viewer, (cursors) => {
    calls.push(cursors);
    return Promise.resolve(ready(page()));
  });
  await revived.load();
  expect(revived.snapshot().account?.id).toBe(viewer);
  expect(calls).toHaveLength(4);
});

test('Recover a managed inventory feed from a rejected cursor preserving exact original semantic input, native authority and bounded requests', async () => {
  for (const feed of ['organizations', 'responsibilities'] as const) {
    for (const status of [400, 409]) {
      const requests: Request[] = [];
      const initial = page();
      initial.organizations.items.push({
        ...initial.organizations.items[0]!,
        account: { ...initial.organizations.items[0]!.account, id: operated },
      });
      initial.responsibilities.items.push({ ...initial.responsibilities.items[0]!, reservationId: viewer });
      initial[feed].next = ' opaque +/= &?% cursor ';
      const replacement = page();
      replacement.organizations = { state: 'ready', items: [], next: null };
      replacement.responsibilities = { items: [], next: null };
      if (feed === 'organizations')
        replacement.organizations.items = [{ ...page().organizations.items[0]!, role: 'owner' }];
      else replacement.responsibilities.items = [{ ...page().responsibilities.items[0]!, state: 'current' }];
      const client = createKernelClient('https://kernel.test', {
        fetch: (async (input, init) => {
          requests.push(new Request(input, init));
          expect(init?.cache).toBe('no-store');
          return requests.length === 1
            ? Response.json(initial)
            : requests.length < 4
              ? Response.json({ code: status === 400 ? 'invalid_cursor' : 'stale_cursor' }, { status })
              : Response.json(replacement);
        }) as typeof fetch,
      });
      const inventory = new ManagedAccountsInventory(viewer, (cursors) =>
        loadManagedAccounts(client, 'Bearer viewer', viewer, cursors),
      );
      await inventory.firstPage(feed);
      await inventory.load();
      await inventory.firstPage(feed);
      expect(requests).toHaveLength(1);
      const before = inventory.snapshot();
      await inventory.more(feed);
      expect(inventory.snapshot()[feed].failure?.status).toBe(status);
      expect(inventory.snapshot()[feed].items).toBe(before[feed].items);
      expect(requests).toHaveLength(2);
      await inventory.more(feed);
      expect(requests).toHaveLength(3);
      await inventory.firstPage(feed);
      const after = inventory.snapshot();
      expect(after[feed].items).toEqual(replacement[feed].items);
      expect(after[feed].next).toBeNull();
      expect(after[feed].failure).toBeNull();
      expect(after[feed].restartable).toBe(false);
      const sibling = feed === 'organizations' ? 'responsibilities' : 'organizations';
      expect(after[sibling]).toBe(before[sibling]);
      expect(after.account).toBe(before.account);
      await inventory.firstPage(feed);
      await inventory.more(feed);
      expect(requests).toHaveLength(4);
      const cursorKey = feed === 'organizations' ? 'organizationsCursor' : 'operatorsCursor';
      expect(requests.map((request) => Object.fromEntries(new URL(request.url).searchParams))).toEqual([
        {},
        { [cursorKey]: initial[feed].next },
        { [cursorKey]: initial[feed].next },
        {},
      ]);
      for (const request of requests) {
        expect(request.method).toBe('GET');
        expect(new URL(request.url).pathname).toBe('/v1/me/managedAccounts');
        expect(request.headers.get('authorization')).toBe('Bearer viewer');
        expect(request.headers.get('cache-control')).toBe('no-store');
      }
    }
  }
});

test('first-page replacement coalesces busy actions and preserves an in-flight sibling in either completion order', async () => {
  for (const feed of ['organizations', 'responsibilities'] as const) {
    for (const restartFirst of [true, false]) {
      const sibling = feed === 'organizations' ? 'responsibilities' : 'organizations';
      const calls: ManagedAccountsCursors[] = [];
      const pending: ((result: ManagedAccountsResult) => void)[] = [];
      const inventory = new ManagedAccountsInventory(viewer, async (cursors) => {
        calls.push(cursors);
        if (calls.length === 1) return ready(page());
        if (calls.length === 2) return managedAccountsFailure(400, { code: 'invalid_cursor' });
        return new Promise((resolve) => pending.push(resolve));
      });
      await inventory.load();
      await inventory.more(feed);
      const siblingRead = inventory.more(sibling);
      const before = inventory.snapshot();
      const restart = inventory.firstPage(feed);
      await inventory.firstPage(feed);
      await inventory.more(feed);
      expect(inventory.snapshot()[feed].busy).toBe(true);
      expect(inventory.snapshot()[feed].failure).toBe(before[feed].failure);
      expect(inventory.snapshot()[feed].items).toBe(before[feed].items);
      expect(inventory.snapshot()[sibling]).toBe(before[sibling]);
      const fresh = page();
      fresh[feed].items = [];
      fresh[feed].next = 'fresh first-page continuation';
      const siblingPage = page();
      siblingPage[sibling].next = 'sibling continuation';
      if (restartFirst) {
        pending[1]!(ready(fresh));
        await restart;
        expect(inventory.snapshot()[sibling]).toBe(before[sibling]);
        expect(inventory.snapshot()[sibling].busy).toBe(true);
        pending[0]!(ready(siblingPage));
      } else {
        pending[0]!(ready(siblingPage));
        await siblingRead;
        const completed = inventory.snapshot()[sibling];
        pending[1]!(ready(fresh));
        await restart;
        expect(inventory.snapshot()[sibling]).toBe(completed);
      }
      await siblingRead;
      expect(inventory.snapshot()[feed].items).toEqual([]);
      expect(inventory.snapshot()[feed].next).toBe('fresh first-page continuation');
      expect(inventory.snapshot()[sibling].items).toEqual(page()[sibling].items);
      expect(inventory.snapshot()[sibling].next).toBe('sibling continuation');
      expect(calls).toEqual([
        {},
        feed === 'organizations'
          ? { organizationsCursor: page()[feed].next! }
          : { operatorsCursor: page()[feed].next! },
        sibling === 'organizations'
          ? { organizationsCursor: page()[sibling].next! }
          : { operatorsCursor: page()[sibling].next! },
        {},
      ]);
    }
  }
});

test('a failed first-page read retains stale pages and explicit recovery until a genuine ready or preparing first page arrives', async () => {
  for (const feed of ['organizations', 'responsibilities'] as const) {
    const calls: ManagedAccountsCursors[] = [];
    const failure = managedAccountsFailure(503, { code: 'overloaded' }, { 'Retry-After': '2' });
    const fresh = page();
    fresh.organizations = { state: 'preparing', items: [], next: null };
    fresh.responsibilities = { items: [], next: null };
    const inventory = new ManagedAccountsInventory(viewer, async (cursors) => {
      calls.push(cursors);
      if (calls.length === 1) return ready(page());
      if (calls.length === 3) return failure;
      if (calls.length === 5) return ready(fresh);
      return managedAccountsFailure(409, { code: 'stale_cursor' });
    });
    await inventory.load();
    const original = inventory.snapshot();
    await inventory.more(feed);
    await inventory.firstPage(feed);
    expect(inventory.snapshot()[feed].failure).toBe(failure);
    expect(inventory.snapshot()[feed].items).toBe(original[feed].items);
    expect(inventory.snapshot()[feed].next).toBe(original[feed].next);
    expect(inventory.snapshot()[feed].restartable).toBe(true);
    expect(inventory.snapshot()[feed].busy).toBe(false);
    await inventory.more(feed);
    expect(calls[3]).toEqual({});
    await inventory.firstPage(feed);
    expect(calls[2]).toEqual({});
    expect(calls[4]).toEqual({});
    expect(inventory.snapshot()[feed].items).toEqual([]);
    expect(inventory.snapshot()[feed].failure).toBeNull();
    expect(inventory.snapshot()[feed].restartable).toBe(false);
    expect(inventory.snapshot().organizations.state).toBe(feed === 'organizations' ? 'preparing' : 'ready');
    await inventory.firstPage(feed);
    expect(calls).toHaveLength(5);
  }
});

test('denied or wrong-viewer first-page results clear both feeds and invalidate siblings, while stale resets cannot revive data', async () => {
  for (const outcome of ['denied', 'wrong-viewer', 'wrong-kind', 'disposed', 'reloaded'] as const) {
    const pending: ((result: ManagedAccountsResult) => void)[] = [];
    let calls = 0;
    const inventory = new ManagedAccountsInventory(viewer, async () => {
      calls++;
      if (calls === 1 || calls === 5) return ready(page());
      if (calls === 2) return managedAccountsFailure(400, { code: 'invalid_cursor' });
      return new Promise((resolve) => pending.push(resolve));
    });
    await inventory.load();
    await inventory.more('organizations');
    const sibling = inventory.more('responsibilities');
    const restart = inventory.firstPage('organizations');
    if (outcome === 'disposed') inventory.dispose();
    if (outcome === 'reloaded') await inventory.load();
    const beforeCompletion = inventory.snapshot();
    const wrongViewer = page();
    wrongViewer.account = { ...wrongViewer.account, id: operated };
    const wrongKind = page();
    wrongKind.account = { ...wrongKind.account, kind: 'organization' };
    pending[1]!(
      outcome === 'denied'
        ? managedAccountsFailure(403, { code: 'forbidden' })
        : ready(outcome === 'wrong-viewer' ? wrongViewer : outcome === 'wrong-kind' ? wrongKind : page()),
    );
    await restart;
    pending[0]!(ready(page()));
    await sibling;
    if (outcome === 'disposed' || outcome === 'reloaded') {
      expect(inventory.snapshot()).toBe(beforeCompletion);
    } else {
      expect(inventory.snapshot().account).toBeNull();
      expect(inventory.snapshot().organizations.items).toEqual([]);
      expect(inventory.snapshot().responsibilities.items).toEqual([]);
      expect(inventory.snapshot().failure?.kind).toBe('denied');
    }
    expect(calls).toBe(outcome === 'reloaded' ? 5 : 4);
  }
});

test('initial, preparing and exhausted feeds do not offer cursor recovery or issue first-page requests', async () => {
  for (const state of ['initial-failure', 'preparing', 'no-more'] as const) {
    const calls: ManagedAccountsCursors[] = [];
    const initial = page();
    initial.organizations = { state: state === 'preparing' ? 'preparing' : 'ready', items: [], next: null };
    initial.responsibilities.next = null;
    const inventory = new ManagedAccountsInventory(viewer, async (cursors) => {
      calls.push(cursors);
      return state === 'initial-failure' || calls.length > 1
        ? managedAccountsFailure(400, { code: 'invalid_cursor' })
        : ready(initial);
    });
    await inventory.load();
    await inventory.more('organizations');
    await inventory.firstPage('organizations');
    await inventory.firstPage('responsibilities');
    expect(inventory.snapshot().organizations.restartable).toBe(false);
    expect(inventory.snapshot().responsibilities.restartable).toBe(false);
    expect(calls).toEqual(state === 'preparing' ? [{}, {}] : [{}]);
  }
});

test('first-occurrence-in-current-page is the duplicate policy and earlier pages are not retained to collapse it', () => {
  const first = page().organizations.items[0]!;
  const duplicate = { ...first, role: 'owner' as const };
  const later = {
    ...first,
    account: { ...first.account, id: operated },
    navigation: { state: 'admitted' as const },
  };
  expect(firstOccurrenceInCurrentPage([first, duplicate, later], (item) => item.account.id)).toEqual([first, later]);
  expect(managedAccountDestination('/en/settings', { state: 'admitted' }, first.account)).toBe(
    managedAccountHref('/en/settings', organization),
  );
  expect(managedAccountDestination('/en/settings', { state: 'unavailable' }, first.account)).toBeUndefined();
  expect(managedAccountDestination('/en/settings', { state: 'concealed' }, first.account)).toBeUndefined();
  expect(managedAccountDestination('/en/settings', { state: 'admitted' }, null)).toBeUndefined();
});

test('a native page of duplicate identities keeps the first occurrence only, without a hidden earlier-page cache', async () => {
  const first = page().organizations.items[0]!;
  const inventory = new ManagedAccountsInventory(viewer, async () =>
    ready({
      ...page(),
      organizations: {
        state: 'ready',
        items: [first, { ...first, role: 'owner' }, { ...first, account: { ...first.account, id: operated } }],
        next: 'page-2',
      },
    }),
  );
  await inventory.load();
  expect(inventory.snapshot().organizations.items.map((item) => item.account.id)).toEqual([organization, operated]);
  expect(inventory.snapshot().organizations.items).toHaveLength(2);
});

test('several sequential pages retain at most 20 rows per feed and 40 directory rows in total', async () => {
  const calls: ManagedAccountsCursors[] = [];
  const inventory = new ManagedAccountsInventory(viewer, async (cursors) => {
    calls.push(cursors);
    const index = cursors.organizationsCursor ? Number(cursors.organizationsCursor) : 0;
    const organizations = Array.from({ length: 20 }, (_, item) => ({
      account: {
        id: `019a0000-0000-7000-8000-${String(index * 20 + item + 2).padStart(12, '0')}`,
        kind: 'organization' as const,
        handle: null,
        displayName: `Organization ${index}:${item}`,
      },
      role: 'member' as const,
      navigation: { state: 'admitted' as const },
    }));
    return ready({
      ...page(),
      organizations: { state: 'ready', items: organizations, next: String(index + 1) },
      responsibilities: {
        items: Array.from({ length: 20 }, (_, item) => ({
          reservationId: `019b0000-0000-7000-8000-${String(item + 1).padStart(12, '0')}`,
          accountId: operated,
          account: null,
          state: 'reconciling' as const,
          navigation: { state: 'concealed' as const },
        })),
        next: null,
      },
    });
  });
  await inventory.load();
  for (let step = 0; step < 5; step++) await inventory.more('organizations');
  const snapshot = inventory.snapshot();
  expect(snapshot.organizations.items).toHaveLength(20);
  expect(snapshot.responsibilities.items).toHaveLength(20);
  expect(snapshot.organizations.items.length + snapshot.responsibilities.items.length).toBe(40);
  expect(snapshot.organizations.origin).toBe(false);
  expect(calls).toHaveLength(6);
  await inventory.firstPage('organizations');
  expect(inventory.snapshot().organizations.origin).toBe(true);
  expect(inventory.snapshot().responsibilities.items).toHaveLength(20);
  expect(calls.at(-1)).toEqual({});
});

test('missing additive navigation is unavailable, concealed targets have no destination, and a current hold can be admitted', async () => {
  const requests: Request[] = [];
  const body: Record<string, unknown> = {
    account: { id: viewer, kind: 'actor', handle: 'avery', displayName: 'Avery' },
    organizations: {
      state: 'ready',
      items: [{ account: { id: organization, kind: 'organization', handle: null, displayName: 'Group' }, role: 'owner' }],
      next: null,
    },
    responsibilities: {
      items: [
        { reservationId: organization, accountId: operated, account: null, state: 'reconciling' },
        {
          reservationId: viewer,
          accountId: operated,
          account: { id: operated, kind: 'actor', handle: 'bot', displayName: 'Bot' },
          state: 'current',
          navigation: { state: 'admitted' },
        },
        {
          reservationId: organization.slice(0, -1) + '8',
          accountId: organization,
          account: { id: organization, kind: 'organization', handle: null, displayName: 'Held' },
          state: 'reconciling',
          navigation: { state: 'unavailable' },
        },
      ],
      next: null,
    },
  };
  const client = createKernelClient('https://kernel.test', {
    fetch: (async (input, init) => {
      requests.push(new Request(input, init));
      return Response.json(body);
    }) as typeof fetch,
  });
  const loaded = await loadManagedAccounts(client, 'Bearer viewer', viewer, {});
  expect(loaded.ok).toBe(true);
  if (!loaded.ok) return;
  expect(loaded.page.viewer.account.id).toBe(viewer);
  expect(loaded.page.organizations.items[0]?.navigation.state).toBe('unavailable');
  expect(loaded.page.responsibilities.items[0]?.navigation.state).toBe('concealed');
  expect(loaded.page.responsibilities.items[1]?.navigation.state).toBe('admitted');
  expect(loaded.page.responsibilities.items[2]?.navigation.state).toBe('unavailable');
  expect(managedAccountDestination('/en/settings', loaded.page.organizations.items[0]?.navigation, loaded.page.organizations.items[0]?.account ?? null)).toBeUndefined();
  expect(
    managedAccountDestination(
      '/en/settings',
      loaded.page.responsibilities.items[1]?.navigation,
      loaded.page.responsibilities.items[1]?.account ?? null,
    ),
  ).toBe(managedAccountHref('/en/settings', operated));
  body.viewer = { state: 'current', account: { id: operated, kind: 'actor', handle: null, displayName: null } };
  expect((await loadManagedAccounts(client, 'Bearer viewer', viewer, {})).ok).toBe(false);
});

test('return-to-first after several next pages does not walk cursors and preserves the sibling page', async () => {
  const calls: ManagedAccountsCursors[] = [];
  const inventory = new ManagedAccountsInventory(viewer, async (cursors) => {
    calls.push(cursors);
    if (cursors.organizationsCursor)
      return ready({
        ...page(),
        organizations: { state: 'ready', items: [], next: `${cursors.organizationsCursor}-next` },
      });
    return ready(page());
  });
  await inventory.load();
  const responsibilities = inventory.snapshot().responsibilities;
  await inventory.more('organizations');
  await inventory.more('organizations');
  expect(inventory.snapshot().organizations.origin).toBe(false);
  expect(inventory.snapshot().responsibilities).toBe(responsibilities);
  await inventory.firstPage('organizations');
  expect(inventory.snapshot().organizations.origin).toBe(true);
  expect(inventory.snapshot().organizations.items).toHaveLength(1);
  expect(inventory.snapshot().responsibilities).toBe(responsibilities);
  expect(calls.filter((call) => Object.keys(call).length === 0)).toHaveLength(2);
});

