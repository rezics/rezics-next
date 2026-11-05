import { afterAll, afterEach, expect, spyOn, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import * as membership from '../src/organization-membership';

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', `${import.meta.dir}/../../web`)))
);
const dom = new Window({ url: 'https://auth.test/organizations/members' });
const globals = {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  HTMLElement: dom.HTMLElement,
  HTMLInputElement: dom.HTMLInputElement,
  IS_REACT_ACT_ENVIRONMENT: true,
};
const original = new Map(
  [...Object.keys(globals), 'fetch'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
);
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
const { createRoot } = await import('react-dom/client');
const { OrganizationMembersPage } = await import('../src/routes/organizations.members');
const { overwriteGetLocale } = await import('../src/paraglide/runtime.js');
const { m } = await import('../src/paraglide/messages.js');
overwriteGetLocale(() => 'en');
const [org, account, member, other, reservation] = [1, 2, 3, 4, 5].map(
  (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
) as [string, string, string, string, string];
const profile = membership.membershipProfile()!;
const page = (cursor?: string, organizationId = org): membership.MembershipPage => ({
  kind: 'ready',
  organizationId,
  viewer: { accountId: account, role: 'owner', leave: 'unavailable' },
  members: {
    state: 'ready',
    next: `${cursor ?? 'first'}/+opaque=`,
    holders: [
      {
        accountId: member,
        account: null,
        role: 'member',
        actions: { changeRole: 'allowed', remove: 'allowed' },
      },
    ],
  },
});
const list = spyOn(membership, 'loadMembershipPage');
let root: ReturnType<typeof createRoot>, host: HTMLDivElement, requests: string[];
const flush = async (action?: () => void) => {
  await act(async () => {
    action?.();
  });
};
const button = (label: string) => [...host.querySelectorAll('button')].find((b) => b.textContent === label)!;
const click = (label: string) => flush(() => button(label).click());
const targets = () => list.mock.calls.map((call) => call[2]);
function deferred() {
  let resolve!: (value: membership.MembershipPage) => void;
  return {
    promise: new Promise<membership.MembershipPage>((done) => {
      resolve = done;
    }),
    resolve: (value: membership.MembershipPage) => resolve(value),
  };
}
async function mount() {
  requests = [];
  globalThis.fetch = (async (input) => {
    const path = String(input);
    requests.push(path);
    return path === '/session'
      ? Response.json({ account_id: account, client_id: profile.client_id, scope: profile.scope })
      : Response.json({
          organizationId: org,
          memberAccountId: member,
          membership: { role: 'member', reservationId: reservation },
        });
  }) as typeof fetch;
  list.mockImplementation(async (id, _account, cursor) => page(cursor, id));
  host = document.body.appendChild(document.createElement('div'));
  root = createRoot(host);
  await flush(() => root.render(<OrganizationMembersPage organizationId={org} />));
}
afterEach(async () => {
  await flush(() => root?.unmount());
  host?.remove();
  window.sessionStorage.clear();
  list.mockReset();
});
afterAll(async () => {
  list.mockRestore();
  for (const [key, descriptor] of original) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  await dom.happyDOM.close();
});

test('mounted first/next/previous/reload/first preserves exact targets and one prepared source call per activation', async () => {
  await mount();
  expect(button(m.auth_members_previous_page()).disabled).toBe(true);
  await click(m.auth_inventory_next());
  await click(m.auth_inventory_reload());
  await click(m.auth_inventory_next());
  await click(m.auth_members_previous_page());
  expect(document.activeElement?.id).toBe('organization-members-heading');
  await click(m.auth_members_first_page());
  expect(targets()).toEqual([
    undefined,
    'first/+opaque=',
    'first/+opaque=',
    'first/+opaque=/+opaque=',
    'first/+opaque=',
    undefined,
  ]);
  expect(list.mock.calls.every(([id, viewer]) => id === org && viewer === account)).toBe(true);
  expect(requests).toEqual(Array(6).fill('/session'));
  expect(button(m.auth_members_previous_page()).disabled).toBe(true);
});

test('failed Previous retries exactly and commits one pop; failed First preserves the accepted back stack', async () => {
  await mount();
  await click(m.auth_inventory_next());
  await click(m.auth_inventory_next());
  list.mockResolvedValueOnce({ kind: 'conflict' });
  await click(m.auth_members_previous_page());
  expect(host.textContent).toContain(m.auth_members_conflict());
  await click(m.auth_members_recovery_retry());
  expect(targets().slice(-2)).toEqual(['first/+opaque=', 'first/+opaque=']);
  list.mockResolvedValueOnce({ kind: 'unavailable' });
  await click(m.auth_members_first_page());
  expect(host.textContent).not.toContain(m.auth_members_empty_page());
  // Retry must still mean First, and the failed request must not pop its predecessor.
  list.mockResolvedValueOnce({ kind: 'unavailable' });
  await click(m.auth_members_recovery_retry());
  expect(targets().slice(-2)).toEqual([undefined, undefined]);
  await click(m.auth_members_recovery_retry());
  expect(button(m.auth_members_previous_page()).disabled).toBe(true);
  await click(m.auth_inventory_next());
  await click(m.auth_members_previous_page());
  expect(targets().at(-1)).toBeUndefined();
});

test('a failed First can be retried while accepted history remains intact until success', async () => {
  await mount();
  await click(m.auth_inventory_next());
  list.mockResolvedValueOnce({ kind: 'preparing' });
  await click(m.auth_members_first_page());
  expect(button(m.auth_members_first_page()).disabled).toBe(false);
  await click(m.auth_members_recovery_retry());
  expect(targets()).toEqual([undefined, 'first/+opaque=', undefined, undefined]);
});

test('same-turn activation issues one read; empty pages with next remain navigable and pending Previous is named', async () => {
  await mount();
  const next = button(m.auth_inventory_next());
  list.mockResolvedValueOnce({
    kind: 'ready',
    organizationId: org,
    viewer: { accountId: account, role: 'owner', leave: 'unavailable' },
    members: { state: 'ready', holders: [], next: 'empty/+next=' },
  });
  await flush(() => {
    next.click();
    next.click();
  });
  expect(targets()).toEqual([undefined, 'first/+opaque=']);
  expect(host.textContent).toContain(m.auth_members_empty_page());
  expect(button(m.auth_inventory_next()).disabled).toBe(false);
  const pending = deferred();
  list.mockImplementationOnce(() => pending.promise);
  await click(m.auth_members_previous_page());
  expect(host.textContent).toContain(m.auth_members_navigation_pending({ action: m.auth_members_previous_page() }));
  await flush(() => pending.resolve(page()));
  expect(targets()).toEqual([undefined, 'first/+opaque=', undefined]);
});

test('finite history stops at the oldest retained target and offers deliberate First', async () => {
  await mount();
  for (let n = 0; n < 34; n++) await click(m.auth_inventory_next());
  for (let n = 0; n < 32; n++) await click(m.auth_members_previous_page());
  expect(targets().at(-1)).toBe('first/+opaque=/+opaque=');
  expect(button(m.auth_members_previous_page()).disabled).toBe(true);
  expect(host.textContent).toContain(m.auth_members_previous_boundary());
  const count = list.mock.calls.length;
  await click(m.auth_members_previous_page());
  expect(list.mock.calls).toHaveLength(count);
  await click(m.auth_members_first_page());
  expect(targets().at(-1)).toBeUndefined();
  expect(host.textContent).not.toContain(m.auth_members_previous_boundary());
});

test('backward rows select through the native point read; Stay makes zero reads and preserves exact confirmation', async () => {
  await mount();
  await click(m.auth_inventory_next());
  await click(m.auth_members_previous_page());
  const details = host.querySelector('details')!;
  await flush(() => {
    details.open = true;
  });
  const beforeDisclosure = requests.length;
  await flush(() => {
    details.open = false;
  });
  expect(requests).toHaveLength(beforeDisclosure);
  await click(m.auth_members_change_role());
  expect(requests.at(-1)).toBe('/account-management/organizations/member');
  const selected = membership.readMembershipCommand();
  expect(selected && selected !== 'invalid' && selected.operation.memberAccountId).toBe(member);
  await flush(() => host.querySelector<HTMLInputElement>('input[type=checkbox]')!.click());
  const reads = list.mock.calls.length,
    calls = requests.length;
  await click(m.auth_inventory_next());
  await click(m.auth_members_stay());
  expect(list.mock.calls).toHaveLength(reads);
  expect(requests).toHaveLength(calls);
  expect(membership.readMembershipCommand()).toEqual(selected);
  expect(host.querySelector<HTMLInputElement>('input[type=checkbox]')!.checked).toBe(true);
  await click(m.auth_inventory_next());
  await click(m.auth_members_leave());
  expect(membership.readMembershipCommand()).toBeNull();
  await click(m.auth_members_previous_page());
  await click(m.auth_members_remove());
  expect(host.querySelector<HTMLInputElement>('input[type=checkbox]')!.checked).toBe(false);
});

test('replacement and synchronous retirement remove private rows, disclosure, cursor controls and late callbacks', async () => {
  await mount();
  await click(m.auth_inventory_next());
  const detached = button(m.auth_inventory_next());
  const pending = deferred();
  list.mockImplementationOnce(() => pending.promise);
  await click(m.auth_members_previous_page());
  await flush(() => root.render(<OrganizationMembersPage organizationId={other} />));
  const count = list.mock.calls.length;
  await flush(() => pending.resolve(page()));
  expect(list.mock.calls).toHaveLength(count);
  expect(host.textContent).not.toContain(org);
  await flush(() => {
    host.querySelector('details')!.open = true;
    window.dispatchEvent(new dom.Event('pagehide'));
    expect(host.textContent).not.toContain(member);
    expect(host.textContent).not.toContain(other);
    expect(host.querySelector('details')).toBeNull();
    expect(host.querySelector('nav')).toBeNull();
    detached.click();
  });
  expect(list.mock.calls).toHaveLength(count);
  await click(m.auth_members_recovery_retry());
  expect(list.mock.calls.at(-1)).toEqual([other, account, undefined]);
  expect(button(m.auth_members_previous_page()).disabled).toBe(true);
});

test('private retirement between activation and its clean departure promise prevents a new read', async () => {
  await mount();
  const count = list.mock.calls.length;
  await flush(() => {
    button(m.auth_inventory_next()).click();
    window.dispatchEvent(new dom.Event('pagehide'));
  });
  expect(list.mock.calls).toHaveLength(count);
  expect(host.textContent).not.toContain(member);
});
