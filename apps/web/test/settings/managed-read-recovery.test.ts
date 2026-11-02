import { expect, spyOn, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { withManagedReadDeadline } from '../../src/settings/managed-read-deadline';
import {
  ManagedAccountsInventory,
  loadManagedAccounts,
  type ManagedAccountsResult,
} from '../../src/settings/managed-accounts-read';
import { ManagedAccountReader, loadManagedAccountDetail } from '../../src/settings/managed-account-detail-read';
import { ManagedAccountActionsRead, loadManagedAccountActions } from '../../src/settings/managed-account-actions-read';
import { readAccountRenameContextResult } from '../../src/settings/account-rename-data';
import { AccountRenameRegion } from '../../src/settings/account-safety';

const viewerId = '019a0000-0000-7000-8000-000000000001';
const target = { viewerId, accountId: viewerId };
const page = {
  account: { id: viewerId, kind: 'actor' as const, handle: null, displayName: null },
  organizations: { state: 'ready' as const, items: [], next: 'opaque/+=' },
  responsibilities: { items: [], next: null },
};
const never = <T>(): Promise<T> => new Promise(() => {});

async function fastDeadlines(run: () => Promise<void>) {
  const schedule = globalThis.setTimeout;
  const timer = spyOn(globalThis, 'setTimeout').mockImplementation(((callback, delay, ...args) =>
    schedule(callback, delay === 10_000 ? 0 : delay, ...args)) as typeof setTimeout);
  try {
    await run();
  } finally {
    timer.mockRestore();
  }
}

test('every embedded native read releases stalled headers and bodies as recoverable failures', async () => {
  await fastDeadlines(async () => {
    for (const phase of ['headers', 'body']) {
      const signals: AbortSignal[] = [];
      const client = createKernelClient('https://kernel.test', {
        fetch: (async (input, init) => {
          signals.push(new Request(input, init).signal);
          return phase === 'headers'
            ? never<Response>()
            : new Response(new ReadableStream(), {
                headers: { 'content-type': 'application/json' },
              });
        }) as typeof fetch,
      });
      const inventory = await loadManagedAccounts(client, 'Bearer current', viewerId, {});
      expect(inventory).toMatchObject({ ok: false, kind: 'unavailable', status: null });
      const detail = await loadManagedAccountDetail(client, 'Bearer current', target);
      expect(detail).toMatchObject({ ok: false, failure: { status: null, transient: true } });
      expect(await loadManagedAccountActions(client, 'Bearer current', target)).toMatchObject({ state: 'unavailable' });
      const rename = await readAccountRenameContextResult(client, 'Bearer current', viewerId);
      expect(rename.context).toBeNull();
      expect(rename.failures).toHaveLength(2);
      expect(signals).toHaveLength(5);
      expect(signals.every((signal) => signal.aborted)).toBe(true);
    }
  });
});

test('caller cancellation settles non-cooperative reads, prevents pre-cancelled dispatch and cleans resources', async () => {
  const caller = new AbortController();
  const remove = spyOn(caller.signal, 'removeEventListener');
  const clear = spyOn(globalThis, 'clearTimeout');
  let dispatched = 0;
  let child!: AbortSignal;
  try {
    const pending = withManagedReadDeadline((signal) => {
      dispatched++;
      child = signal;
      return never();
    }, caller.signal);
    caller.abort(new Error('retired session'));
    await expect(pending).rejects.toThrow('retired session');
    expect(child.aborted).toBe(true);
    await expect(
      withManagedReadDeadline(() => {
        dispatched++;
        return never();
      }, caller.signal),
    ).rejects.toThrow('retired session');
    expect(dispatched).toBe(1);
    expect(await withManagedReadDeadline(async () => 'ready')).toBe('ready');
    expect(clear).toHaveBeenCalledTimes(3);
    expect(remove).toHaveBeenCalledTimes(2);
  } finally {
    remove.mockRestore();
    clear.mockRestore();
  }
});

test('inventory timeout preserves its cursor, independent actions recover, and late pages cannot overwrite recovery', async () => {
  await fastDeadlines(async () => {
    let late!: (result: ManagedAccountsResult) => void;
    const cursors: object[] = [];
    const inventory = new ManagedAccountsInventory(viewerId, (cursor) => {
      cursors.push(cursor);
      return cursors.length === 2
        ? new Promise((resolve) => {
            late = resolve;
          })
        : Promise.resolve({ ok: true, page });
    });
    const actions = new ManagedAccountActionsRead(target, () => never());
    await inventory.load();
    await Promise.all([inventory.more('organizations'), actions.load()]);
    expect(inventory.snapshot().organizations).toMatchObject({
      busy: false,
      next: 'opaque/+=',
      restartable: false,
      failure: { kind: 'unavailable' },
    });
    expect(actions.snapshot()).toMatchObject({ pending: false, result: { state: 'unavailable' } });
    await inventory.more('organizations');
    late({ ok: true, page: { ...page, organizations: { ...page.organizations, next: 'obsolete' } } });
    await Promise.resolve();
    expect(cursors).toEqual([{}, { organizationsCursor: 'opaque/+=' }, { organizationsCursor: 'opaque/+=' }]);
    expect(inventory.snapshot().organizations.next).toBe('opaque/+=');
    inventory.dispose();
    actions.dispose();
  });
});

test('detail and rename entry unlock deliberate recovery and retired readers discard late completion', async () => {
  await fastDeadlines(async () => {
    let detailCalls = 0;
    const detail = new ManagedAccountReader(viewerId, viewerId, () => {
      detailCalls++;
      return never();
    });
    await detail.load();
    expect(detail.snapshot()).toMatchObject({ pending: false, failure: { transient: true } });
    await detail.load();
    expect(detailCalls).toBe(2);
    let calls = 0;
    const rename = new AccountRenameRegion(async () => {
      calls++;
      return calls === 1 ? never() : { context: { accountId: viewerId, handle: 'current', available: true } };
    }, viewerId);
    const unmount = rename.mount();
    await rename.reload();
    expect(rename.snapshot()).toMatchObject({ loading: false, context: null, failures: [{ status: null }] });
    await rename.reload();
    expect(rename.snapshot().context?.handle).toBe('current');
    expect(calls).toBe(2);
    detail.clear();
    rename.dispose();
    unmount();
    expect(rename.snapshot()).toMatchObject({ loading: false, context: null });
  });
});
