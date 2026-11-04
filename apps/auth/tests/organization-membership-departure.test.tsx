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
  scrollTo: dom.scrollTo.bind(dom),
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
    viewer: { accountId: account, role: 'owner', leave: 'unavailable' },
    members: {
      state: 'ready',
      holders: [
        {
          accountId: member,
          account: { id: member, kind: 'actor', handle: 'member', displayName: 'Current Member' },
          role: 'member',
          actions: { changeRole: 'allowed', remove: 'allowed' },
        },
      ],
      next: 'next',
    },
  });
  const parent = createRootRoute({ component: Outlet });
  const review = createRoute({
    getParentRoute: () => parent,
    path: '/organizations/members',
    component: () => <OrganizationMembersPage organizationId={org} />,
  });
  const security = createRoute({ getParentRoute: () => parent, path: '/security', component: () => 'Security' });
  const away = createRoute({ getParentRoute: () => parent, path: '/away', component: () => 'Away' });
  router = createRouter({
    history: createMemoryHistory({ initialEntries: ['/organizations/members'] }),
    routeTree: parent.addChildren([review, security, away]),
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

test('an unsent selected-member command warns; Stay preserves it and Leave discards it', async () => {
  await mount();
  expect(unload()).toBe(false);
  await click(m.auth_members_change_role());
  expect(unload()).toBe(true);
  await navigate('/away');
  await click(m.auth_members_stay());
  expect(document.activeElement).toBe(host.querySelector('#membership-confirmation'));
  const saved = membership.readMembershipCommand();
  expect(saved && saved !== 'invalid' ? saved.operation.role : null).toBe('owner');
  await navigate('/away');
  await click(m.auth_members_leave());
  expect(host.textContent).toBe('Away');
  await navigate('/organizations/members');
  expect(membership.readMembershipCommand()).toBeNull();
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
  expect(host.textContent).toContain(m.auth_members_unknown());
  expect(host.textContent).not.toContain(org);
  expect(host.textContent).not.toContain(account);
  expect(host.textContent).not.toContain(member);
  expect(host.querySelector('#membership-confirmation')).toBeNull();
  expect(membership.readMembershipCommand()).toEqual(saved);
  await click(m.auth_members_recovery_retry());
  expect(host.textContent).toContain(org);
  expect(host.textContent).toContain(account);
  expect(host.textContent).toContain(member);
  expect(host.querySelector<HTMLInputElement>('input[type=checkbox]')!.checked).toBe(false);
  expect(membership.readMembershipCommand()).toEqual(saved);
});

test('authority loss leaves an open unknown-outcome departure choice honest and protected', async () => {
  await mount();
  execute = async () => Response.json({}, { status: 503 });
  await click(m.auth_members_change_role());
  await flush(() => host.querySelector<HTMLInputElement>('input[type=checkbox]')!.click());
  await click(m.auth_members_submit());
  const saved = membership.readMembershipCommand() as membership.MembershipCommand;
  expect(saved.unresolved).toBe(true);
  await click(m.auth_inventory_reload());
  expect(host.textContent).toContain(m.auth_members_departure());

  await flush(() => window.dispatchEvent(new dom.Event('pagehide')));
  const restored = new dom.Event('pageshow');
  Object.defineProperty(restored, 'persisted', { value: true });
  await flush(() => window.dispatchEvent(restored));
  list.mockResolvedValueOnce({ kind: 'denied' });
  await click(m.auth_members_recovery_retry());
  expect(host.textContent).toContain(m.auth_members_departure());
  expect(host.textContent).toContain(m.auth_members_unknown());
  expect(host.textContent).not.toContain(org);
  expect(host.textContent).not.toContain(member);
  expect(membership.readMembershipCommand()).toEqual(saved);
  expect(unload()).toBe(true);

  await click(m.auth_members_stay());
  expect(document.activeElement).toBe(host.querySelector('#membership-recovery-heading'));
  await navigate('/away');
  await click(m.auth_members_leave());
  expect(host.textContent).toBe('Away');
  expect(membership.readMembershipCommand()).toEqual(saved);
  await navigate('/organizations/members');
  expect(host.textContent).toContain(m.auth_members_unknown());
  expect(host.textContent).not.toContain(org);
  expect(host.textContent).not.toContain(account);
  expect(membership.readMembershipCommand()).toEqual(saved);
});

test('paging Leave rereads current advice before restoring an unresolved review', async () => {
  await mount();
  execute = async () => Response.json({}, { status: 503 });
  await click(m.auth_members_change_role());
  await flush(() => host.querySelector<HTMLInputElement>('input[type=checkbox]')!.click());
  await click(m.auth_members_submit());
  const saved = membership.readMembershipCommand() as membership.MembershipCommand;

  await click(m.auth_inventory_next());
  await click(m.auth_members_stay());
  expect(membership.readMembershipCommand()).toEqual(saved);
  await click(m.auth_inventory_next());
  await click(m.auth_members_leave());

  expect(list.mock.calls.at(-1)).toEqual([org, account, 'next']);
  expect(host.textContent).toContain(m.auth_members_unknown());
  expect(host.textContent).toContain(member);
  expect(host.querySelector<HTMLInputElement>('input[type=checkbox]')!.checked).toBe(false);
  expect(membership.readMembershipCommand()).toEqual(saved);
  expect(requests.filter((path) => path.endsWith('/execute'))).toHaveLength(1);
});

function transition(type: 'pagehide' | 'pageshow') {
  const event = new dom.Event(type);
  if (type === 'pageshow') Object.defineProperty(event, 'persisted', { value: true });
  window.dispatchEvent(event);
}
const writes = () => requests.filter((path) => /\/(approve|execute)$/.test(path));

test('pagehide removes private DOM in the event turn and a stale selection cannot repopulate it', async () => {
  await mount();
  let release!: (response: Response) => void;
  const normal = globalThis.fetch;
  globalThis.fetch = (async (input, init) =>
    String(input).endsWith('/member')
      ? new Promise<Response>((resolve) => {
          release = resolve;
        })
      : normal(input, init)) as typeof fetch;
  await click(m.auth_members_change_role());
  await flush(() => {
    transition('pagehide');
    // Assert inside the event turn, before act can flush scheduled updates.
    expect(host.textContent).not.toContain('Current Member');
    expect(host.textContent).not.toContain(org);
    expect(host.textContent).not.toContain(member);
    expect(host.querySelector('#membership-confirmation')).toBeNull();
  });
  const reads = list.mock.calls.length;
  await flush(() =>
    release(
      Response.json({
        organizationId: org,
        memberAccountId: member,
        membership: { role: 'member', reservationId: reservation },
      }),
    ),
  );
  expect(list.mock.calls).toHaveLength(reads);
  expect(membership.readMembershipCommand()).toBeNull();
  expect(host.textContent).toContain(m.auth_members_return_unsent());
  expect(document.activeElement?.id).toBe('membership-history-heading');
  expect(writes()).toHaveLength(0);
});

test('native acknowledgement survives failed observation and restoration; history dismissal changes no continuation', async () => {
  await mount();
  await click(m.auth_members_change_role());
  const normal = globalThis.fetch;
  let executed = false;
  globalThis.fetch = (async (input, init) => {
    const path = String(input);
    if (path.endsWith('/execute')) executed = true;
    else if (executed && path.endsWith('/member')) {
      executed = false;
      return Response.json({}, { status: 503 });
    }
    return normal(input, init);
  }) as typeof fetch;
  await flush(() => host.querySelector<HTMLInputElement>('input[type=checkbox]')!.click());
  await click(m.auth_members_submit());
  expect(host.textContent).toContain(m.auth_members_acknowledged());
  expect(host.textContent).not.toContain(m.auth_members_unknown());
  expect(host.textContent).not.toContain(member);
  const sent = writes().length;
  list.mockResolvedValueOnce({ kind: 'unavailable' });
  await flush(() => transition('pageshow'));
  expect(host.textContent).toContain(m.auth_members_acknowledged());
  expect(host.textContent).toContain(m.auth_members_unavailable());
  const saved = membership.readMembershipCommand();
  await click(m.auth_members_return_dismiss());
  expect(membership.readMembershipCommand()).toEqual(saved);
  expect(document.activeElement?.id).toBe('membership-current-heading');
  await click(m.auth_members_recovery_retry());
  expect(host.textContent).toContain('Current Member');
  expect(writes()).toHaveLength(sent);
});

test('unknown history survives exact later acknowledgement and matching state without changing submitted identity', async () => {
  await mount();
  await click(m.auth_members_change_role());
  execute = async () => Response.json({}, { status: 503 });
  await flush(() => host.querySelector<HTMLInputElement>('input[type=checkbox]')!.click());
  await click(m.auth_members_submit());
  const saved = membership.readMembershipCommand();
  expect(saved && saved !== 'invalid' && saved.unresolved).toBe(true);
  execute = async () => Response.json({ accountId: member });
  const normal = globalThis.fetch;
  globalThis.fetch = (async (input, init) =>
    String(input).endsWith('/member')
      ? Response.json({
          organizationId: org,
          memberAccountId: member,
          membership: { role: 'owner', reservationId: reservation },
        })
      : normal(input, init)) as typeof fetch;
  await flush(() => host.querySelector<HTMLInputElement>('input[type=checkbox]')!.click());
  await click(m.auth_members_retry_exact());
  expect(host.textContent).toContain(m.auth_members_acknowledged());
  expect(host.textContent).toContain(m.auth_members_unknown());
  expect(membership.readMembershipCommand()).toEqual(saved);
  await click(m.auth_members_return_dismiss());
  expect(membership.readMembershipCommand()).toEqual(saved);
  expect(writes().filter((p) => p.endsWith('/approve'))).toHaveLength(1);
});

test('restoration creates a new read generation; released old page never replaces current advice', async () => {
  await mount();
  let release!: (page: membership.MembershipPage) => void;
  list.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  await click(m.auth_inventory_reload());
  await flush(() => transition('pagehide'));
  expect(document.activeElement?.id).toBe('membership-current-heading');
  list.mockResolvedValueOnce({ kind: 'denied' });
  await flush(() => transition('pageshow'));
  const reads = list.mock.calls.length;
  await flush(() =>
    release({
      kind: 'ready',
      organizationId: org,
      viewer: { accountId: account, role: 'owner', leave: 'unavailable' },
      members: { state: 'ready', holders: [], next: null },
    }),
  );
  expect(list.mock.calls).toHaveLength(reads);
  expect(host.textContent).toContain(m.auth_members_denied());
  expect(host.textContent).not.toContain(org);
  await click(m.auth_members_recovery_retry());
  expect(host.textContent).toContain('Current Member');
  expect(writes()).toHaveLength(0);
});

test('lost continuation closes exact recovery while generic history and presentation dismissal remain honest', async () => {
  await mount();
  await click(m.auth_members_change_role());
  execute = async () => Response.json({}, { status: 503 });
  await flush(() => host.querySelector<HTMLInputElement>('input[type=checkbox]')!.click());
  await click(m.auth_members_submit());
  await flush(() => transition('pagehide'));
  window.sessionStorage.clear();
  const reads = list.mock.calls.length,
    sent = writes().length;
  await click(m.auth_members_recovery_retry());
  expect(host.textContent).toContain(m.auth_members_unknown());
  expect(host.textContent).not.toContain(member);
  expect(list.mock.calls).toHaveLength(reads);
  expect(writes()).toHaveLength(sent);
  await click(m.auth_members_return_dismiss());
  expect(unload()).toBe(true);
  expect(membership.readMembershipCommand()).toBeNull();
  expect(
    [...host.querySelectorAll('button')].find((b) => b.textContent === m.auth_members_recovery_retry())?.disabled,
  ).toBe(true);
});

test('pagehide synchronously clears prepared authentication inputs and stale sign-in cannot restore authority', async () => {
  await mount();
  await click(m.auth_members_change_role());
  const normal = globalThis.fetch;
  globalThis.fetch = (async (input, init) =>
    String(input).endsWith('/approve')
      ? Response.json({ code: 'step_up_required' }, { status: 401 })
      : normal(input, init)) as typeof fetch;
  await flush(() => host.querySelector<HTMLInputElement>('input[type=checkbox]')!.click());
  await click(m.auth_members_submit());
  await flush(() => {
    for (const [id, value] of [
      ['membership-email', 'private@example.test'],
      ['membership-password', 'private-password'],
    ]) {
      const field = host.querySelector<HTMLInputElement>(`#${id}`)!;
      Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, 'value')!.set!.call(field, value);
      field.dispatchEvent(new dom.Event('input', { bubbles: true }));
    }
  });
  let release!: (response: Response) => void;
  globalThis.fetch = (async () =>
    new Promise<Response>((resolve) => {
      release = resolve;
    })) as typeof fetch;
  await click(m.auth_members_reauthenticate());
  const reads = list.mock.calls.length;
  await flush(() => {
    transition('pagehide');
    expect(host.querySelector('#membership-email')).toBeNull();
    expect(host.querySelector('#membership-password')).toBeNull();
    expect(host.textContent).not.toContain(reservation);
    expect(host.textContent).not.toContain(account);
  });
  await flush(() => release(Response.json({ account_id: account })));
  expect(list.mock.calls).toHaveLength(reads);
  expect(host.querySelector('#membership-confirmation')).toBeNull();
});
