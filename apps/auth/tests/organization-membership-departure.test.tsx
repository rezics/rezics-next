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
const previous = new Map(
  [...Object.keys(globals), 'fetch'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
);
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
const { createRoot } = await import('react-dom/client');
const { createRootRoute, createRoute, createRouter, createMemoryHistory, RouterProvider, Outlet } =
  await import('@tanstack/react-router');
const { OrganizationMembersPage } = await import('../src/routes/organizations.members');
const { overwriteGetLocale } = await import('../src/paraglide/runtime.js');
const { m } = await import('../src/paraglide/messages.js');
overwriteGetLocale(() => 'en');
const [org, member, account, reservation] = [1, 2, 3, 4].map(
  (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
) as [string, string, string, string];
const list = spyOn(membership, 'loadMembershipPage');
let root: ReturnType<typeof createRoot>, host: HTMLDivElement, router: ReturnType<typeof createRouter>;
let execute: (() => Promise<Response>) | undefined;
let requests: string[];
async function flush(action?: () => void) {
  await act(async () => {
    action?.();
  });
}
const click = (label: string) =>
  flush(() => [...host.querySelectorAll('button')].find((b) => b.textContent === label)!.click());
const navigate = (to: string) =>
  flush(() => {
    void router.navigate({ to });
  });
const unload = () => {
  const event = new dom.Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event as unknown as Event);
  return event.defaultPrevented;
};
async function mount() {
  requests = [];
  execute = undefined;
  const profile = membership.membershipProfile()!;
  globalThis.fetch = (async (input) => {
    const path = String(input);
    requests.push(path);
    if (path === '/session')
      return Response.json({ account_id: account, client_id: profile.client_id, scope: profile.scope });
    if (path.endsWith('/member'))
      return Response.json({
        organizationId: org,
        memberAccountId: member,
        membership: { role: 'member', reservationId: reservation },
      });
    if (path.endsWith('/approve'))
      return Response.json({ reference: 'approval', expiresAt: new Date(Date.now() + 60000).toISOString() });
    return execute ? execute() : Response.json({ accountId: member });
  }) as typeof fetch;
  list.mockResolvedValue({
    kind: 'ready',
    organizationId: org,
    role: 'owner',
    holders: [{ accountId: member, role: 'member', reservationId: reservation }],
    next: 'next',
  });
  const parent = createRootRoute({ component: Outlet });
  const review = createRoute({
    getParentRoute: () => parent,
    path: '/organizations/members',
    component: () => <OrganizationMembersPage organizationId={org} />,
  });
  const away = createRoute({ getParentRoute: () => parent, path: '/away', component: () => 'Away' });
  router = createRouter({
    history: createMemoryHistory({ initialEntries: ['/organizations/members'] }),
    routeTree: parent.addChildren([review, away]),
  });
  host = document.body.appendChild(document.createElement('div'));
  root = createRoot(host);
  await router.load();
  await flush(() => root.render(<RouterProvider router={router} />));
}
afterEach(async () => {
  await flush(() => root?.unmount());
  host?.remove();
  window.sessionStorage.clear();
  list.mockReset();
});
afterAll(async () => {
  list.mockRestore();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  await dom.happyDOM.close();
});

test('changed draft alone warns; Stay restores focus and values, Leave discards, clean visits leave normally', async () => {
  await mount();
  expect(unload()).toBe(false);
  const field = host.querySelector<HTMLInputElement>('#membership-account')!;
  await flush(() => {
    field.focus();
    Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, 'value')!.set!.call(field, member);
    field.dispatchEvent(new dom.Event('input', { bubbles: true }) as unknown as Event);
    const role = host.querySelector<HTMLSelectElement>('#membership-role')!;
    role.value = 'owner';
    role.dispatchEvent(new dom.Event('change', { bubbles: true }) as unknown as Event);
  });
  expect(unload()).toBe(true);
  await navigate('/away');
  await click(m.auth_members_stay());
  expect(document.activeElement).toBe(field);
  expect(field.value).toBe(member);
  expect(host.querySelector<HTMLSelectElement>('#membership-role')!.value).toBe('owner');
  await navigate('/away');
  await click(m.auth_members_leave());
  expect(host.textContent).toBe('Away');
  await navigate('/organizations/members');
  expect(host.querySelector<HTMLInputElement>('#membership-account')!.value).toBe('');
  await navigate('/away');
  expect(host.textContent).toBe('Away');
});

test('paging Stay retains exact reservation and confirmation; Leave discards unsent review', async () => {
  await mount();
  await click(m.auth_members_change_role());
  await flush(() => host.querySelector<HTMLInputElement>('input[type=checkbox]')!.click());
  const saved = membership.readMembershipCommand();
  await click(m.auth_inventory_next());
  await click(m.auth_members_stay());
  expect(host.querySelector<HTMLInputElement>('input[type=checkbox]')!.checked).toBe(true);
  expect(membership.readMembershipCommand()).toEqual(saved);
  expect(host.textContent).toContain(reservation);
  await click(m.auth_inventory_next());
  await click(m.auth_members_leave());
  expect(list.mock.calls.at(-1)).toEqual([org, account, 'next']);
  expect(membership.readMembershipCommand()).toBeNull();
  expect(host.querySelector('#membership-confirmation')).toBeNull();
});

test('deliberate Leave retires late execute callbacks and restores only the unresolved original command', async () => {
  await mount();
  await click(m.auth_members_change_role());
  let release!: (response: Response) => void;
  execute = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  await flush(() => host.querySelector<HTMLInputElement>('input[type=checkbox]')!.click());
  await click(m.auth_members_submit());
  const saved = membership.readMembershipCommand() as membership.MembershipCommand;
  expect(saved.unresolved).toBe(true);
  await navigate('/away');
  await click(m.auth_members_leave());
  const reads = list.mock.calls.length,
    calls = requests.length;
  await flush(() => release(Response.json({ accountId: member })));
  expect(requests).toHaveLength(calls);
  expect(list.mock.calls).toHaveLength(reads);
  expect(membership.readMembershipCommand()).toEqual(saved);
  await navigate('/organizations/members');
  expect(host.textContent).toContain(org);
  expect(host.textContent).toContain(account);
  expect(host.querySelector<HTMLInputElement>('input[type=checkbox]')!.checked).toBe(false);
  expect(membership.readMembershipCommand()).toEqual(saved);
});
