import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import {
  ManagedAccountsInventory,
  loadManagedAccounts,
  managedAccountHref,
  type ManagedAccountsPage,
  type ManagedAccountsResult,
} from '../src/settings/managed-accounts-read';

const viewer = '019a0000-0000-7000-8000-000000000001';
const organization = '019a0000-0000-7000-8000-000000000002';
const operated = '019a0000-0000-7000-8000-000000000003';
function page(): ManagedAccountsPage {
  return {
    account: { id: viewer, kind: 'actor', handle: 'avery', displayName: 'Avery' },
    organizations: {
      state: 'ready',
      items: [
        {
          account: { id: organization, kind: 'organization', handle: null, displayName: 'Reading group' },
          role: 'member',
        },
      ],
      next: 'signed organization +/=',
    },
    responsibilities: {
      items: [{ reservationId: organization, accountId: operated, account: null, state: 'reconciling' }],
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

// These focused oracles are retained for integration; this attempt runs only the workspace typecheck.
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
  expect(inventory.snapshot().organizations.items).toHaveLength(1);
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
