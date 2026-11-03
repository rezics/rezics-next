import { afterAll, afterEach, expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { dirname } from 'node:path';
import { act, createElement, useState } from 'react';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { QueryClient } from '@tanstack/react-query';
import { realmMembersLifetimeSource } from '../src/community/members/lifetime';
import type { MembersCaller } from '../src/community/members/page';
import type { MemberAdditionIntent, MemberPageRead, RealmMembersSource } from '../src/community/members/source';
import type { SelectedRealmMember } from '../src/community/members/selected-account';
import { loadRealmBans, writeRealmBan } from '../src/community/realm-bans';
import { RealmBansControl } from '../src/community/realm-bans-control';

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const browser = new Window({ url: 'https://site.test/en/realms/realm/members' });
const originals = new Map<string, PropertyDescriptor | undefined>();
for (const [key, value] of Object.entries({
  window: browser,
  document: browser.document,
  navigator: browser.navigator,
  HTMLElement: browser.HTMLElement,
  HTMLButtonElement: browser.HTMLButtonElement,
  Element: browser.Element,
  Node: browser.Node,
  Document: browser.Document,
  DocumentFragment: browser.DocumentFragment,
  MutationObserver: browser.MutationObserver,
  ResizeObserver: browser.ResizeObserver,
  getComputedStyle: browser.getComputedStyle.bind(browser),
  IS_REACT_ACT_ENVIRONMENT: true,
})) {
  originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
const { createRoot } = await import('react-dom/client');
const { RealmMembersPage } = await import('../src/community/members/page');
const { RealmMembersEntry } = await import('../src/community/members/entry');
const { m } = await import('../src/paraglide/messages.js');
const { setLocale } = await import('../src/paraglide/runtime.js');
setLocale('en', { reload: false });
let root: ReturnType<typeof createRoot> | undefined;
let host: HTMLElement;
const tick = async () => {
  await Promise.resolve();
  await Promise.resolve();
};
async function render(source: RealmMembersSource, realmId = 'realm', locale = 'en', caller?: MembersCaller) {
  if (!root) {
    host = document.createElement('main');
    document.body.append(host);
    root = createRoot(host);
  }
  await act(async () => {
    root!.render(createElement(RealmMembersPage, { realmId, source, locale, caller }));
    await tick();
  });
}
async function click(text: string) {
  const button = [...host.querySelectorAll('button')].find((node) => node.textContent === text)!;
  expect(button).toBeDefined();
  await act(async () => {
    button.focus();
    button.click();
    await tick();
  });
  return button;
}
function source(read?: MemberPageRead): RealmMembersSource {
  return {
    pageBound: 20,
    readPage: async () =>
      read ?? {
        kind: 'ready',
        page: {
          realm: { id: 'realm', label: 'Exact Realm' },
          authority: 'grant',
          next: null,
          rows: [
            {
              kind: 'disclosed',
              identity: { accountId: 'a', reference: 'account-a', label: 'Similar name' },
              membershipInterval: 'producer-interval-a',
              membership: 'current',
            },
          ],
        },
      },
    readSelected: async (address) => ({
      kind: 'ready',
      ...address,
      identity: { accountId: 'a', reference: 'account-a', label: 'Exact selected account' },
      membershipInterval: address.membershipInterval ?? null,
      membership: 'pending',
      advice: { add: 'unavailable', ban: 'available', unban: 'unavailable' },
    }),
  };
}
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  host?.remove();
});
afterAll(async () => {
  await browser.happyDOM.close();
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test('member discovery uses current Realm management observations and the Realm route anchor', async () => {
  type Props = Parameters<typeof RealmMembersEntry>[0];
  let update!: (next: Props) => void;
  function Entry() {
    const [props, setProps] = useState<Props>({ realmId: 'realm', appearance: false, setup: null });
    update = setProps;
    return createElement(RealmMembersEntry, props);
  }
  const route = createRootRoute({ component: Entry });
  const router = createRouter({ routeTree: route, history: createMemoryHistory({ initialEntries: ['/'] }) });
  await router.load();
  host = document.createElement('main');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(createElement(RouterProvider, { router })));
  expect(host.querySelector('a')).toBeNull();
  for (const [setup, appearance, admitted] of [
    [{ kind: 'ready', realm: { id: 'realm' }, permitted: { settings: true } }, false, true],
    [{ kind: 'ready', realm: { id: 'space' }, permitted: { settings: true } }, false, false],
    [{ kind: 'ready', realm: { id: 'realm' }, permitted: { settings: false } }, false, false],
    [{ kind: 'failure' }, true, true],
    [{ kind: 'failure' }, false, false],
  ] satisfies [Props['setup'], boolean, boolean][]) {
    await act(async () => update({ realmId: 'realm', setup, appearance }));
    const link = host.querySelector('a');
    expect(link !== null).toBe(admitted);
    if (link) expect(link.getAttribute('href')).toBe('/realms/realm/members');
  }
});

test('producer lifetime retirement conceals the mounted page and delayed selection without requests or focus recovery', async () => {
  for (const phase of ['page', 'selection', 'return'] as const) {
    const fixture = source();
    const pending = Promise.withResolvers<Awaited<ReturnType<typeof fixture.readPage>>>();
    const selected = Promise.withResolvers<Awaited<ReturnType<typeof fixture.readSelected>>>();
    let current = true;
    let notify = () => {};
    let stops = 0;
    let pages = 0;
    let selections = 0;
    await render({
      ...fixture,
      observe: () => ({
        current: () => current,
        subscribe: (listener) => {
          notify = listener;
          return () => {
            stops++;
          };
        },
      }),
      readPage: async (address) => {
        pages++;
        return phase === 'page' ? pending.promise : fixture.readPage(address);
      },
      readSelected: async (address) => {
        selections++;
        return phase === 'return' ? fixture.readSelected(address) : selected.promise;
      },
    });
    if (phase !== 'page') await click(m.realm_members_inspect());
    await act(async () => {
      if (phase === 'return') {
        const back = [...host.querySelectorAll('button')].find((node) => node.textContent === m.realm_members_back())!;
        back.focus();
        back.click();
      }
      current = false;
      notify();
      await tick();
    });
    expect(host.textContent).toContain(m.realm_members_retired());
    expect(host.textContent).not.toContain('Similar name');
    expect(stops).toBe(1);
    expect(document.activeElement).not.toBe(host.querySelector('h1'));
    const focus = document.activeElement;
    await act(async () => {
      pending.resolve(await fixture.readPage({ realmId: 'realm', cursor: null }));
      selected.resolve(
        await fixture.readSelected({ realmId: 'realm', accountId: 'a', authority: 'grant' }),
      );
      await tick();
    });
    expect(host.textContent).not.toContain('Exact selected account');
    expect(host.querySelectorAll('button')).toHaveLength(0);
    expect(document.activeElement).toBe(focus);
    expect([pages, selections]).toEqual([1, phase === 'page' ? 0 : 1]);
  }
});

test('mounted roster inspects an exact current observation, keeps pending truthful and returns keyboard focus', async () => {
  await render(source());
  expect(host.textContent).toContain('Exact Realm');
  await click(m.realm_members_inspect());
  expect(host.textContent).toContain('Exact selected account');
  expect(host.textContent).toContain('account-a');
  expect(host.textContent).not.toContain('Similar name');
  expect(host.textContent).toContain(m.realm_members_pending());
  expect(document.activeElement?.textContent).toBe(m.realm_members_inspection());
  expect(host.querySelector('a')).toBeNull();
  await click(m.realm_members_back());
  expect(document.activeElement?.textContent).toBe(m.realm_members_inspect());
});

test('selected addition reviews the entered identity, retries one immutable command and waits for explicit readback', async () => {
  const accountId = '0192f3a0-6c1e-7b2a-9d4e-000000000301';
  const addresses: unknown[] = [];
  const intents: MemberAdditionIntent[] = [];
  let pages = 0;
  let memberCurrent = false;
  let failStatusRead = false;
  const fixture = source();
  await render({
    ...fixture,
    readPage: async (address) => {
      pages++;
      return fixture.readPage(address);
    },
    readSelected: async (address) => {
      addresses.push(address);
      if (failStatusRead && addresses.length === 2) return { kind: 'failed' };
      return {
        kind: 'ready',
        realmId: address.realmId,
        authority: address.authority,
        identity: { accountId: address.accountId, reference: 'selected-account-reference', label: 'Exact inspected account' },
        membershipInterval: memberCurrent ? 'producer-new-membership-interval' : null,
        membership: memberCurrent ? 'current' : 'none',
        advice: { add: memberCurrent ? 'unavailable' : 'available', ban: 'unavailable', unban: 'unavailable' },
      };
    },
    addMember: async (intent) => {
      intents.push(intent);
      return intents.length === 1 ? { kind: 'unknown' } : { kind: 'accepted', workflowId: 'workflow' };
    },
  });
  const input = host.querySelector('input')!;
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setValue.call(input, accountId);
    input.dispatchEvent(new browser.Event('input', { bubbles: true }));
    await tick();
  });
  await click(m.realm_members_lookup_account());
  expect(addresses).toEqual([{ realmId: 'realm', accountId, authority: 'grant' }]);
  expect(host.textContent).toContain('Exact inspected account');
  await click(m.realm_members_add_member());
  expect(host.textContent).toContain('Add Exact inspected account to Exact Realm?');
  expect(host.textContent).toContain(accountId);
  expect(host.textContent).toContain('realm');
  await click(m.realm_bans_confirm());
  expect(host.textContent).toContain(m.realm_members_unknown_command());
  await click(m.realm_members_retry_command());
  expect(intents).toHaveLength(2);
  expect(intents[0]).toEqual(intents[1]);
  expect(Object.isFrozen(intents[0])).toBe(true);
  expect(host.textContent).toContain(m.realm_members_add_pending());
  expect(addresses).toHaveLength(1);
  expect(pages).toBe(1);
  failStatusRead = true;
  await click(m.realm_members_check_status());
  expect(host.textContent).toContain(m.realm_members_selected_failed());
  expect(host.textContent).toContain(m.realm_members_add_pending());
  expect(host.textContent).not.toContain('Exact inspected account');
  failStatusRead = false;
  memberCurrent = true;
  await click(m.realm_members_retry_selected());
  expect(addresses).toEqual([
    { realmId: 'realm', accountId, authority: 'grant' },
    { realmId: 'realm', accountId, authority: 'grant' },
    { realmId: 'realm', accountId, authority: 'grant' },
  ]);
  expect(host.textContent).toContain(m.realm_members_current());
  expect(pages).toBe(1);
});

test('selected ban and unban review the exact identity and use the existing native command/readback owner', async () => {
  const realmId = '0192f3a0-6c1e-7b2a-9d4e-000000000201';
  const accountId = '0192f3a0-6c1e-7b2a-9d4e-000000000301';
  const authorization = 'Bearer current-manager';
  const request = () =>
    new Request('https://site.example.test/action', { method: 'POST', headers: { authorization } });
  let banned = false;
  let reads = 0;
  const calls: { method: string; path: string; idempotencyKey: string | null; body: unknown }[] = [];
  let writeFinished = Promise.withResolvers<void>();
  let refreshFinished = Promise.withResolvers<void>();
  const client = createKernelClient('https://kernel.example.test', {
    fetch: async (input, init) => {
      const next = new Request(input, init);
      const path = new URL(next.url).pathname;
      if (next.method === 'GET') {
        reads++;
        const response = Response.json({
          items: banned ? [{ accountId, reason: 'Selected moderation reason', actor: null, at: '2026-11-01T00:00:00Z' }] : [],
          next: null,
        });
        if (reads > 1) refreshFinished.resolve();
        calls.push({ method: next.method, path, idempotencyKey: next.headers.get('idempotency-key'), body: null });
        return response;
      }
      const body = next.method === 'PUT' ? await next.json() : null;
      calls.push({ method: next.method, path, idempotencyKey: next.headers.get('idempotency-key'), body });
      if (next.method === 'PUT') {
        banned = true;
        writeFinished.resolve();
        return Response.json({
          ban: {
            realmId,
            accountId,
            reason: 'Selected moderation reason',
            actor: null,
            at: '2026-11-01T00:00:00Z',
            workflowId: null,
          },
        });
      }
      banned = false;
      writeFinished.resolve();
      return new Response(null, { status: 204 });
    },
  });
  const read = () => loadRealmBans(client, request(), {}, { realmId });
  const initial = await read();
  const selectedMember: SelectedRealmMember = {
    realmId,
    realmLabel: 'Exact selected Realm',
    accountId,
    reference: 'exact-account-reference',
    label: 'Exact selected account',
    membershipInterval: 'opaque-selected-interval',
    authority: 'exact-authority',
    advice: { ban: 'available', unban: 'available' },
    current: () => true,
    subscribe: () => () => {},
  };
  host = document.createElement('main');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      createElement(RealmBansControl, {
        realmId,
        initial,
        ready: true,
        read,
        write: (input) => writeRealmBan(client, request(), {}, input),
        selectedMember,
      }),
    );
    await tick();
  });
  const clickEnabled = async (label: string) => {
    const button = [...host.querySelectorAll('button')].find((node) => node.textContent === label && !node.disabled)!;
    expect(button).toBeDefined();
    await act(async () => {
      button.focus();
      button.click();
      await tick();
    });
  };
  const textarea = host.querySelector('textarea')!;
  const setReason = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  await act(async () => {
    setReason.call(textarea, 'Selected moderation reason');
    textarea.dispatchEvent(new browser.Event('input', { bubbles: true }));
    await tick();
  });
  await clickEnabled(m.realm_bans_ban());
  expect(host.textContent).toContain('Exact selected Realm');
  expect(host.textContent).toContain('exact-account-reference');
  expect(host.textContent).toContain(realmId);
  expect(host.textContent).toContain('Selected moderation reason');
  writeFinished = Promise.withResolvers<void>();
  refreshFinished = Promise.withResolvers<void>();
  await act(async () => {
    const confirm = [...host.querySelectorAll('button')].find((node) => node.textContent === m.realm_bans_confirm_ban());
    expect(confirm).toBeDefined();
    confirm!.click();
    await writeFinished.promise;
    await refreshFinished.promise;
    await tick();
  });
  const banCall = calls.find((call) => call.method === 'PUT')!;
  expect(banCall).toMatchObject({
    path: `/v1/realms/${realmId}/bans/${accountId}`,
    body: { reason: 'Selected moderation reason' },
  });
  expect(banCall.idempotencyKey).toMatch(/^"[0-9a-f-]+"$/i);

  await clickEnabled(m.realm_bans_unban());
  expect(host.textContent).toContain('Membership will not be restored');
  writeFinished = Promise.withResolvers<void>();
  refreshFinished = Promise.withResolvers<void>();
  await act(async () => {
    const confirm = [...host.querySelectorAll('button')].find((node) => node.textContent === m.realm_bans_confirm());
    expect(confirm).toBeDefined();
    confirm!.click();
    await writeFinished.promise;
    await refreshFinished.promise;
    await tick();
  });
  const unbanCall = calls.find((call) => call.method === 'DELETE')!;
  expect(unbanCall.path).toBe(`/v1/realms/${realmId}/bans/${accountId}`);
  expect(unbanCall.idempotencyKey).toMatch(/^"[0-9a-f-]+"$/i);
  expect(reads).toBe(3);
});

test('denial and sparse empty are distinct and a failed selected lookup has no retained person label', async () => {
  await render(source({ kind: 'denied' }));
  expect(host.textContent).toContain(m.realm_members_denied());
  expect(host.textContent).not.toContain(m.realm_members_empty());
  await render(
    source({
      kind: 'ready',
      page: { realm: { id: 'realm', label: 'Realm' }, authority: 'grant', rows: [], next: 'opaque' },
    }),
  );
  expect(host.textContent).toContain(m.realm_members_sparse());
  expect([...host.querySelectorAll('button')].some((node) => node.textContent === m.realm_members_more())).toBe(true);
  const failed = { ...source(), readSelected: async () => ({ kind: 'failed' as const }) };
  await render(failed);
  await click(m.realm_members_inspect());
  expect(host.textContent).toContain(m.realm_members_selected_failed());
  expect(host.textContent).not.toContain('Similar name');
  expect(host.textContent).not.toContain('account-a');
});

test('Realm, locale and source replacement remove selected identity before delayed completion', async () => {
  for (const replacement of ['realm', 'locale', 'source']) {
    const deferred = Promise.withResolvers<Awaited<ReturnType<RealmMembersSource['readSelected']>>>();
    const original = { ...source(), readSelected: () => deferred.promise };
    await render(original);
    await click(m.realm_members_inspect());
    const next = source({ kind: 'unavailable' });
    await render(
      replacement === 'source' ? next : original,
      replacement === 'realm' ? 'other' : 'realm',
      replacement === 'locale' ? 'fr' : 'en',
    );
    await act(async () => {
      deferred.resolve({
        kind: 'ready',
        realmId: 'realm',
        authority: 'grant',
        membershipInterval: 'producer-interval-a',
        identity: { accountId: 'a', reference: 'account-a', label: 'Delayed retired account' },
        membership: 'current',
        advice: { add: 'unavailable', ban: 'available', unban: 'unavailable' },
      });
      await tick();
    });
    expect(host.textContent).not.toContain('Delayed retired account');
    expect(host.textContent).not.toContain(m.realm_members_inspection());
  }
});

test('browser session and incarnation-keyed exposure changes retire mounted selection before deferred completion', async () => {
  const session = { state: 'signed-in' as const, subject: 'viewer', csrfToken: 'credential' };
  const exposureKey = ['exposure', 'viewer', session.subject, 7];
  const fail = async (client: QueryClient, queryKey: unknown[]) => {
    await client
      .fetchQuery({
        queryKey,
        queryFn: async () => {
          throw new Error('read failed');
        },
        retry: false,
      })
      .catch(() => undefined);
  };
  const changes: ((client: QueryClient) => unknown)[] = [
    (client) => {
      client.setQueryData(['session'], { ...session, subject: 'other' });
      client.setQueryData(['session'], session);
    },
    (client) => {
      client.setQueryData(['session'], { ...session, csrfToken: 'other' });
      client.setQueryData(['session'], session);
    },
    (client) => {
      client.setQueryData(['session'], { state: 'signed-out' });
      client.setQueryData(['session'], session);
    },
    (client) => client.setQueryData(['session'], { ...session }),
    (client) => fail(client, ['session']),
    (client) => client.setQueryData(exposureKey, { subject: session.subject, admitted: [] }),
    (client) => client.removeQueries({ queryKey: exposureKey, exact: true }),
    (client) => client.invalidateQueries({ queryKey: exposureKey, exact: true }),
    (client) => fail(client, exposureKey),
  ];
  for (const change of changes) {
    const client = new QueryClient();
    client.setQueryData(['session'], session);
    client.setQueryData(exposureKey, { subject: session.subject, admitted: ['realm.members'] });
    const lifetime = realmMembersLifetimeSource(client, session.subject);
    const caller = lifetime.capture(session, () => true);
    const delayed = Promise.withResolvers<Awaited<ReturnType<RealmMembersSource['readSelected']>>>();
    let pages = 0,
      selections = 0;
    const fixture = source();
    await render(
      {
        ...fixture,
        readPage: (address) => {
          pages++;
          return fixture.readPage(address);
        },
        readSelected: () => {
          selections++;
          return delayed.promise;
        },
      },
      'realm',
      'en',
      caller,
    );
    await click(m.realm_members_inspect());
    await act(async () => {
      await change(client);
      await tick();
    });
    expect(host.textContent).toContain(m.realm_members_retired());
    expect(host.textContent).not.toContain('Similar name');
    await act(async () => {
      delayed.resolve({
        kind: 'ready',
        realmId: 'realm',
        authority: 'grant',
        membershipInterval: 'producer-interval-a',
        membership: 'current',
        identity: { accountId: 'a', reference: 'account-a', label: 'Retired private identity' },
        advice: { add: 'unavailable', ban: 'available', unban: 'unavailable' },
      });
      await tick();
    });
    expect(host.textContent).not.toContain('Retired private identity');
    expect(caller.current()).toBe(false);
    expect([pages, selections]).toEqual([1, 1]);
    expect(
      client
        .getQueryCache()
        .getAll()
        .every(({ queryKey }) => queryKey[0] !== 'realm-members'),
    ).toBe(true);
    // Unmount before releasing this browser cache; later cache work belongs to another visit.
    await act(async () => root!.unmount());
    root = undefined;
    host.remove();
    client.clear();
  }
});

test('unrelated public queries leave the exact member visit and return focus current', async () => {
  const client = new QueryClient();
  const session = { state: 'signed-in' as const, subject: 'viewer', csrfToken: 'credential' };
  client.setQueryData(['session'], session);
  const caller = realmMembersLifetimeSource(client, session.subject).capture(session, () => true);
  await render(source(), 'realm', 'en', caller);
  await click(m.realm_members_inspect());
  await act(async () => {
    client.setQueryData(['public-subject', 'id'], {});
    client.setQueryData(['exposure', 'viewer', 'retired-viewer', 6], { subject: 'retired-viewer', admitted: [] });
    await tick();
  });
  expect(host.textContent).toContain('Exact selected account');
  await click(m.realm_members_back());
  expect(document.activeElement?.textContent).toBe(m.realm_members_inspect());
});
