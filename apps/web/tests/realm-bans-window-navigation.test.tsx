import { expect, test } from 'bun:test';
import { act } from 'react';
import { createKernelClient } from '@rezics/client';
import { loadRealmBans, type BanReadState } from '../src/community/realm-bans';
import { banReadHarness } from './realm-bans-read-harness';

const { host, ready, props, paint, button, activate, m, window } = await banReadHarness();
const realm = '0192f3a0-6c1e-7b2a-9d4e-000000000100';
const row = (reason: string) => ({ accountId: realm, actor: null, reason, at: '2026-11-02T14:05:00Z' });

test('native windows retain eight addresses, one twenty-row body and exact Realm/frontier pairing', async () => {
  const addresses = Array.from({ length: 11 }, (_, n) => (n ? `opaque-${n}:`.padEnd(4096, 'x') : undefined));
  const requests: (string | undefined)[] = [];
  const native = createKernelClient('https://kernel.test', {
    fetch: async (url, init) => {
      const request = new Request(url, init);
      const parsed = new URL(request.url);
      expect(parsed.pathname).toBe(`/v1/realms/${realm}/bans`);
      expect(parsed.searchParams.get('limit')).toBe('20');
      expect(request.headers.get('authorization')).toBe('Bearer original-reader');
      const cursor = parsed.searchParams.get('cursor') ?? undefined;
      requests.push(cursor);
      const index = addresses.indexOf(cursor);
      return Response.json({
        items: Array.from({ length: 20 }, (_, n) => ({
          ...row(`window ${index}`),
          accountId: `${realm.slice(0, -3)}${String(n).padStart(3, '0')}`,
        })),
        next: addresses[index + 1] ?? null,
      });
    },
  });
  const read = (cursor?: string) =>
    loadRealmBans(
      native,
      new Request('https://site.test/action', {
        headers: { authorization: 'Bearer original-reader' },
      }),
      {},
      { realmId: realm, ...(cursor ? { cursor } : {}) },
    );
  await paint(props(realm, undefined, read));
  for (let n = 1; n <= 10; n++) {
    await activate(m.realm_bans_next());
    expect(requests.at(-1)).toBe(addresses[n]);
    expect(host.querySelectorAll('li')).toHaveLength(20);
  }
  await activate(m.realm_bans_refresh());
  expect(requests.at(-1)).toBe(addresses[10]);
  for (let n = 9; n >= 2; n--) {
    await activate(m.realm_bans_previous());
    expect(requests.at(-1)).toBe(addresses[n]);
    expect(host.querySelectorAll('li')).toHaveLength(20);
    expect(host.textContent).toContain(`window ${n}`);
    expect(host.textContent).not.toContain(`window ${n + 1}`);
  }
  expect(button(m.realm_bans_previous()).disabled).toBe(true);
  expect(host.textContent).toContain(m.realm_bans_history_discarded());
  expect(requests).toHaveLength(20);
  await activate(m.realm_bans_restart());
  expect(requests.at(-1)).toBeUndefined();
  expect(button(m.realm_bans_previous()).disabled).toBe(true);
  expect(host.textContent).not.toContain(m.realm_bans_history_discarded());
});

test('failed directions retry exactly, sparse pages continue, expiration restarts and denial clears history', async () => {
  const cursors: (string | undefined)[] = [];
  let next: BanReadState = ready('sparse-two');
  const read = async (cursor?: string) => (cursors.push(cursor), next);
  await paint(props(realm, ready('sparse-one'), read));
  await activate(m.realm_bans_next());
  next = { state: 'unavailable' };
  await activate(m.realm_bans_previous());
  await activate(m.realm_bans_read_retry());
  expect(cursors).toEqual(['sparse-one', undefined, undefined]);
  next = ready('sparse-one');
  await activate(m.realm_bans_read_retry());
  expect(button(m.realm_bans_previous()).disabled).toBe(true);
  next = { state: 'unavailable' };
  await activate(m.realm_bans_next());
  next = ready('sparse-two');
  await activate(m.realm_bans_read_retry());
  expect(cursors.slice(-2)).toEqual(['sparse-one', 'sparse-one']);
  await activate(m.realm_bans_refresh());
  expect(cursors.at(-1)).toBe('sparse-one');
  next = { state: 'invalid-cursor' };
  await activate(m.realm_bans_next());
  expect(button(m.realm_bans_read_retry())).toBeUndefined();
  next = ready('fresh');
  await activate(m.realm_bans_restart());
  expect(cursors.at(-1)).toBeUndefined();
  expect(button(m.realm_bans_previous()).disabled).toBe(true);
  await activate(m.realm_bans_next());
  next = { state: 'forbidden' };
  await activate(m.realm_bans_refresh());
  next = ready(null);
  await activate(m.realm_bans_restart());
  expect(button(m.realm_bans_previous()).disabled).toBe(true);
});

test('exact inspection and Stay preserve review; Leave retires it before rereading the same address', async () => {
  let reads = 0,
    writes = 0;
  const initial: BanReadState = { state: 'ready', page: { items: [row('original episode')], next: 'next' } };
  const inspections: unknown[] = [];
  await paint({
    ...props(realm, initial, async () => (++reads, initial)),
    inspect: async (input) => (inspections.push(input), { state: 'current', input, ban: row('exact episode') }),
    write: async () => (++writes, { ok: false, reason: 'unavailable' }),
  });
  await activate(m.realm_bans_next());
  const account = host.querySelectorAll('input')[1]!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(account, realm);
    account.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  await activate(m.realm_bans_inspect_action());
  expect(inspections).toEqual([{ realmId: realm, accountId: realm, cursor: 'next' }]);
  await activate(m.realm_bans_unban());
  const original = button(m.realm_bans_confirm());
  await activate(m.realm_bans_refresh());
  expect(reads).toBe(1);
  await activate(m.thread_authoring_stay());
  expect(button(m.realm_bans_confirm())).toBe(original);
  await activate(m.realm_bans_refresh());
  await activate(m.thread_authoring_leave());
  expect(reads).toBe(2);
  expect(button(m.realm_bans_confirm())).toBeUndefined();
  await act(async () => original.click());
  expect(writes).toBe(0);
  const reason = host.querySelector('textarea')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(reason, ' ');
    reason.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  await activate(m.realm_bans_next());
  await activate(m.thread_authoring_stay());
  expect(reason.value).toBe(' ');
  expect(reads).toBe(2);
  await activate(m.realm_bans_next());
  await activate(m.thread_authoring_leave());
  expect(reads).toBe(3);
});
