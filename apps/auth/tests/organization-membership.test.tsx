import { afterAll, afterEach, expect, spyOn, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import * as membership from '../src/organization-membership';

// Reuse the mounted Auth tests' installed DOM; only the server-function list transport is replaced.
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
  Document: dom.Document,
  DocumentFragment: dom.DocumentFragment,
  Element: dom.Element,
  Node: dom.Node,
  MutationObserver: dom.MutationObserver,
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
const [organizationId, memberAccountId, accountId, reservationId, other] = [1, 2, 3, 4, 5].map(
  (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
) as [string, string, string, string, string];
const profile = membership.membershipProfile()!;
const session = () => Response.json({ account_id: accountId, client_id: profile.client_id, scope: profile.scope });
const selected = (role = 'member') =>
  Response.json({ organizationId, memberAccountId, membership: { role, reservationId } });
const approval = () =>
  Response.json({ reference: 'native-approval', expiresAt: new Date(Date.now() + 60_000).toISOString() });
const ready = (id = organizationId): membership.MembershipPage => ({
  kind: 'ready',
  organizationId: id,
  role: 'owner',
  holders: [{ accountId: memberAccountId, role: 'member', reservationId }],
  next: 'next-cursor',
});
const list = spyOn(membership, 'loadMembershipPage');
let root: ReturnType<typeof createRoot> | undefined, host: HTMLDivElement;
let calls: { path: string; body: any }[];
let reply: (path: string) => Response | Promise<Response>;
async function flush(action?: () => void) {
  await act(async () => {
    action?.();
  });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  return {
    promise: new Promise<T>((done) => {
      resolve = done;
    }),
    resolve,
  };
}
function button(label: string) {
  return [...host.querySelectorAll('button')].find((node) => node.textContent === label)!;
}
const click = (label: string) => flush(() => button(label).click());
async function mount() {
  calls = [];
  reply = (path) =>
    path === '/session'
      ? session()
      : path.endsWith('/member')
        ? selected()
        : path.endsWith('/approve')
          ? approval()
          : Response.json({ accountId: memberAccountId });
  globalThis.fetch = (async (input, init) => {
    const path = String(input);
    calls.push({ path, body: init?.body ? JSON.parse(String(init.body)) : null });
    return reply(path);
  }) as typeof fetch;
  list.mockImplementation(async (id) => ready(id));
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await flush(() => root!.render(<OrganizationMembersPage organizationId={organizationId} />));
}
async function leave(change: boolean) {
  await flush(() => root!.render(change ? <OrganizationMembersPage organizationId={other} /> : null));
}
async function confirm() {
  await flush(() => host.querySelector<HTMLInputElement>('input[type=checkbox]')!.click());
}
function input(id: string, value: string) {
  const field = host.querySelector<HTMLInputElement>(`#${id}`)!;
  Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, 'value')!.set!.call(field, value);
  field.dispatchEvent(new dom.Event('input', { bubbles: true }) as unknown as Event);
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

test('unavailable reads retain identity and Stay preserves an edited selection', async () => {
  await mount();
  await leave(false);
  reply = () => Response.json({}, { status: 503 });
  await flush(() => root!.render(<OrganizationMembersPage organizationId={organizationId} />));
  expect(button(m.auth_inventory_reload()).disabled).toBe(false);
  reply = () => session();
  list.mockResolvedValueOnce({ kind: 'unavailable' });
  await click(m.auth_inventory_reload());
  await flush(() => input('membership-account', memberAccountId));
  await click(m.auth_inventory_reload());
  await click(m.auth_members_stay());
  expect(list.mock.calls.at(-1)).toEqual([organizationId, accountId, undefined]);
  expect(host.querySelector<HTMLInputElement>('#membership-account')!.value).toBe(memberAccountId);
  expect(calls.filter(({ path }) => path === '/session')).toHaveLength(3);
});

for (const stage of ['list', 'selection', 'signin', 'session', 'reservation', 'approval', 'execute', 'readback'])
  test(`leaving during ${stage} cannot advance an old review or browser request`, async () => {
    await mount();
    const pending = deferred<Response>();
    const pendingList = deferred<membership.MembershipPage>();
    if (stage === 'list') {
      list.mockImplementationOnce(() => pendingList.promise);
      await click(m.auth_inventory_reload());
    } else if (stage === 'selection') {
      reply = () => pending.promise;
      await click(m.auth_members_change_role());
    } else {
      await click(m.auth_members_change_role());
      const saved = membership.readMembershipCommand();
      expect(saved).not.toBeNull();
      if (stage === 'signin') {
        reply = (path) =>
          path.endsWith('/approve')
            ? Response.json({ code: 'step_up_required' }, { status: 401 })
            : path === '/session'
              ? session()
              : selected();
        await confirm();
        await click(m.auth_members_submit());
        await flush(() => {
          input('membership-email', 'owner@example.test');
          input('membership-password', 'secret-password');
        });
        reply = () => pending.promise;
        await click(m.auth_members_reauthenticate());
      } else {
        const target = {
          session: '/session',
          reservation: '/account-management/organizations/member',
          approval: '/account-operations/approve',
          execute: '/account-operations/execute',
          readback: '/account-management/organizations/member',
        }[stage];
        let points = 0;
        reply = (path) =>
          path === target && (stage !== 'readback' || ++points === 2)
            ? pending.promise
            : path === '/session'
              ? session()
              : path.endsWith('/member')
                ? selected()
                : path.endsWith('/approve')
                  ? approval()
                  : Response.json({ accountId: memberAccountId });
        await confirm();
        await click(m.auth_members_submit());
      }
    }
    await leave(stage !== 'execute');
    const count = calls.length,
      reads = list.mock.calls.length,
      stored = window.sessionStorage.getItem('rezics.organization-membership.command');
    await flush(() => {
      pending.resolve(
        stage === 'session'
          ? session()
          : stage === 'approval'
            ? approval()
            : stage === 'execute'
              ? Response.json({ accountId: memberAccountId })
              : selected(),
      );
      pendingList.resolve(ready());
    });
    expect(calls).toHaveLength(count);
    expect(list.mock.calls).toHaveLength(reads);
    expect(window.sessionStorage.getItem('rezics.organization-membership.command')).toBe(stored);
    if (stage === 'selection') expect(stored).toBeNull();
    if (stage === 'execute') expect(JSON.parse(stored!).unresolved).toBe(true);
    else expect(host.textContent).toContain(other);
    expect(host.querySelector('#membership-confirmation')).toBeNull();
  });

test('determinate refusals preserve review; reauthentication requires confirmation and uncertain execution retains exact retry', async () => {
  await mount();
  await click(m.auth_members_change_role());
  const command = membership.readMembershipCommand() as membership.MembershipCommand;
  expect(command.operation).toEqual({
    kind: 'membership',
    organizationId,
    memberAccountId,
    role: 'owner',
    reservationId,
  });
  const normal = reply;
  reply = (path) =>
    path.endsWith('/approve') ? Response.json({ code: 'step_up_required' }, { status: 401 }) : normal(path);
  await confirm();
  await click(m.auth_members_submit());
  await flush(() => {
    input('membership-email', 'owner@example.test');
    input('membership-password', 'secret-password');
  });
  reply = () => Response.json({}, { status: 401 });
  await click(m.auth_members_reauthenticate());
  expect(host.querySelector('#membership-confirmation')).not.toBeNull();
  expect(host.textContent).toContain(memberAccountId);
  await flush(() => input('membership-password', 'secret-password'));
  reply = normal;
  await click(m.auth_members_reauthenticate());
  expect(button(m.auth_members_submit()).disabled).toBe(true);
  expect(calls.some(({ path }) => path.endsWith('/execute'))).toBe(false);
  reply = (path) => (path.endsWith('/execute') ? Response.json({}, { status: 503 }) : normal(path));
  await confirm();
  await click(m.auth_members_submit());
  const unresolved = membership.readMembershipCommand() as membership.MembershipCommand;
  expect(unresolved.operationKey).toBe(command.operationKey);
  expect(unresolved.unresolved).toBe(true);
  expect(button(m.auth_inventory_cancel()).disabled).toBe(true);
  const approvals = calls.filter(({ path }) => path.endsWith('/approve')).length;
  reply = (path) => (path.endsWith('/member') ? selected('owner') : normal(path));
  await confirm();
  await click(m.auth_members_retry_exact());
  expect(calls.filter(({ path }) => path.endsWith('/approve'))).toHaveLength(approvals);
  const executions = calls.filter(({ path }) => path.endsWith('/execute'));
  expect(executions).toHaveLength(2);
  expect(executions[0]!.body).toEqual(executions[1]!.body);
  expect(executions[0]!.body).toEqual({
    accountId,
    operationKey: command.operationKey,
    operation: command.operation,
    reference: 'native-approval',
  });
  await click(m.auth_members_close());
  expect(membership.readMembershipCommand()).toBeNull();
});
