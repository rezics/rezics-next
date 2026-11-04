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
  viewer: { accountId, role: 'owner', leave: 'unavailable' },
  members: {
    state: 'ready',
    holders: [
      {
        accountId: memberAccountId,
        account: { id: memberAccountId, kind: 'actor', handle: 'reader', displayName: 'Rae Reader' },
        role: 'member',
        actions: { changeRole: 'allowed', remove: 'allowed' },
      },
    ],
    next: 'next-cursor',
  },
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
function saveUnknown() {
  const command = membership.newMembershipCommand(accountId, {
    kind: 'membership',
    organizationId,
    memberAccountId,
    role: 'owner',
    reservationId,
  });
  command.reference = 'native-approval';
  command.unresolved = true;
  expect(membership.saveMembershipCommand(command)).toBe(true);
  return command;
}
function beforeUnload() {
  const event = new dom.Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event as unknown as Event);
  return event.defaultPrevented;
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

test('an unavailable inventory is explicit, reloadable and never presented as empty', async () => {
  await mount();
  list.mockResolvedValueOnce({
    kind: 'ready',
    organizationId,
    viewer: { accountId, role: 'owner', leave: 'unavailable' },
    members: { state: 'unavailable' },
  });
  await click(m.auth_inventory_reload());
  expect(host.textContent).toContain(m.auth_members_inventory_unavailable());
  expect(host.textContent).not.toContain(m.auth_members_empty_page());
  expect(host.querySelector('#membership-account')).toBeNull();
  list.mockResolvedValueOnce(ready());
  await click(m.auth_inventory_reload());
  expect(list.mock.calls.at(-1)).toEqual([organizationId, accountId, undefined]);
  expect(host.textContent).toContain('Rae Reader');
});

test('refresh retires previously advised actions when the current viewer loses membership authority', async () => {
  await mount();
  expect(button(m.auth_members_change_role()).disabled).toBe(false);
  list.mockResolvedValueOnce({ kind: 'denied' });
  await click(m.auth_inventory_reload());
  expect(host.textContent).toContain(m.auth_members_denied());
  expect(host.querySelector('ul[aria-label]')).toBeNull();
  expect(host.querySelector('#membership-confirmation')).toBeNull();
});

for (const stage of ['list', 'selection', 'signin', 'session', 'reservation', 'approval', 'execute', 'readback'])
  test(`leaving during ${stage} cannot advance an old review or browser request`, async () => {
    await mount();
    const normalReply = reply;
    const pending = deferred<Response>();
    const pendingList = deferred<membership.MembershipPage>();
    if (stage === 'list') {
      list.mockImplementationOnce(() => pendingList.promise);
      await click(m.auth_inventory_reload());
    } else if (stage === 'selection') {
      reply = () => pending.promise;
      await click(m.auth_members_change_role());
      reply = normalReply;
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
        reply = normalReply;
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
        reply = normalReply;
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
    if (stage === 'list' || stage === 'selection') expect(host.textContent).toContain(other);
    else expect(host.textContent).not.toContain(other);
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

test('a lost acknowledgement stays generic after page return and native refusal', async () => {
  await mount();
  await click(m.auth_members_change_role());
  const original = membership.readMembershipCommand() as membership.MembershipCommand;
  const normal = reply;
  reply = (path) => (path.endsWith('/execute') ? Response.json({}, { status: 503 }) : normal(path));
  await confirm();
  await click(m.auth_members_submit());
  const saved = membership.readMembershipCommand() as membership.MembershipCommand;
  expect(saved.operationKey).toBe(original.operationKey);
  expect(saved.unresolved).toBe(true);
  const writes = calls.filter(({ path }) => /\/(approve|execute)$/.test(path)).length;

  await flush(() => window.dispatchEvent(new dom.Event('pagehide')));
  const pageshow = new dom.Event('pageshow');
  Object.defineProperty(pageshow, 'persisted', { value: true });
  const pagesBeforeReturn = list.mock.calls.length;
  await flush(() => window.dispatchEvent(pageshow));
  expect(list.mock.calls).toHaveLength(pagesBeforeReturn);
  list.mockResolvedValueOnce({ kind: 'denied' });
  await click(m.auth_members_recovery_retry());

  expect(host.textContent).toContain(m.auth_members_unknown());
  expect(host.textContent).not.toContain(organizationId);
  expect(host.textContent).not.toContain(memberAccountId);
  expect(host.textContent).not.toContain(reservationId);
  expect(host.querySelector('#membership-confirmation')).toBeNull();
  expect(membership.readMembershipCommand()).toEqual(saved);
  expect(calls.filter(({ path }) => /\/(approve|execute)$/.test(path))).toHaveLength(writes);
  expect(beforeUnload()).toBe(true);
  expect(document.activeElement).toBe(host.querySelector('#membership-recovery-heading'));
});

test('a replacement session cannot inspect or inherit the original pending review', async () => {
  const saved = saveUnknown();
  await mount();
  const profile = membership.membershipProfile()!;
  reply = (path) =>
    path === '/session'
      ? Response.json({ account_id: other, client_id: profile.client_id, scope: profile.scope })
      : Response.json({ accountId: memberAccountId });
  await click(m.auth_members_recovery_retry());
  expect(host.textContent).toContain(m.auth_members_unknown());
  expect(host.textContent).not.toContain(organizationId);
  expect(host.textContent).not.toContain(memberAccountId);
  expect(host.textContent).not.toContain(accountId);
  expect(list).not.toHaveBeenCalled();
  expect(membership.readMembershipCommand()).toEqual(saved);
  expect(calls.some(({ path }) => /\/(approve|execute)$/.test(path))).toBe(false);
  expect(beforeUnload()).toBe(true);
});

test('same-initiator reauthentication only restores a read-only review', async () => {
  const saved = saveUnknown();
  await mount();
  await click(m.auth_members_recovery_sign_in());
  await flush(() => {
    input('membership-email', 'owner@example.test');
    input('membership-password', 'secret-password');
  });
  await click(m.auth_members_reauthenticate());
  expect(host.textContent).toContain(m.auth_members_unknown());
  expect(host.querySelector('#membership-confirmation')).toBeNull();
  expect(list).not.toHaveBeenCalled();
  expect(calls.some(({ path }) => /\/(approve|execute)$/.test(path))).toBe(false);
  expect(membership.readMembershipCommand()).toEqual(saved);
  await click(m.auth_members_recovery_retry());
  expect(host.textContent).toContain(organizationId);
  expect(host.querySelector('#membership-confirmation')).not.toBeNull();
  expect(calls.some(({ path }) => /\/(approve|execute)$/.test(path))).toBe(false);
});

test('a read-only recovery review restores private review only for the exact initiator and reservation', async () => {
  const saved = saveUnknown();
  await mount();
  expect(host.textContent).toContain(m.auth_members_unknown());
  expect(host.textContent).not.toContain(organizationId);
  expect(host.textContent).not.toContain(memberAccountId);
  expect(host.textContent).not.toContain(accountId);
  expect(host.textContent).not.toContain(reservationId);
  expect(list).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(host.querySelector('#membership-recovery-heading'));

  const before = calls.length;
  await flush(() => {
    button(m.auth_members_recovery_retry()).click();
    button(m.auth_members_recovery_retry()).click();
  });
  expect(list.mock.calls).toHaveLength(1);
  expect(calls.slice(before).some(({ path }) => /\/(approve|execute)$/.test(path))).toBe(false);
  expect(calls.slice(before).some(({ path }) => path.endsWith('/member'))).toBe(true);
  expect(host.textContent).toContain(organizationId);
  expect(host.textContent).toContain(memberAccountId);
  expect(host.textContent).toContain(accountId);
  expect(host.textContent).toContain(reservationId);
  expect(document.activeElement).toBe(host.querySelector('#membership-confirmation'));
  expect(membership.readMembershipCommand()).toEqual(saved);

  await confirm();
  const retry = button(m.auth_members_retry_exact());
  await flush(() => {
    retry.click();
    retry.click();
  });
  const executions = calls.filter(({ path }) => path.endsWith('/execute'));
  expect(executions).toHaveLength(1);
  expect(calls.filter(({ path }) => path.endsWith('/approve'))).toHaveLength(0);
  expect(executions[0]!.body).toEqual({
    accountId,
    operationKey: saved.operationKey,
    operation: saved.operation,
    reference: saved.reference,
  });
});

test('a replacement descriptor or inaccessible storage fails closed without deleting or sending it', async () => {
  const saved = saveUnknown();
  await mount();
  const replacement = membership.newMembershipCommand(accountId, {
    ...saved.operation,
    memberAccountId: other,
  });
  replacement.reference = 'replacement-approval';
  replacement.unresolved = true;
  expect(membership.saveMembershipCommand(replacement)).toBe(true);
  await click(m.auth_members_recovery_retry());
  expect(host.textContent).toContain(m.auth_members_unknown());
  expect(host.textContent).not.toContain(memberAccountId);
  expect(host.textContent).not.toContain(other);
  expect(membership.readMembershipCommand()).toEqual(replacement);
  expect(list).not.toHaveBeenCalled();
  expect(calls.some(({ path }) => /\/(approve|execute)$/.test(path))).toBe(false);

  await flush(() => root!.unmount());
  host.remove();
  root = undefined;
  window.sessionStorage.clear();
  const descriptor = Object.getOwnPropertyDescriptor(window, 'sessionStorage');
  Object.defineProperty(window, 'sessionStorage', { configurable: true, get: () => { throw new Error('storage denied'); } });
  try {
    await mount();
    expect(host.textContent).toContain(m.auth_members_recovery_unavailable());
    expect(button(m.auth_members_recovery_retry()).disabled).toBe(true);
    expect(host.querySelector('#membership-confirmation')).toBeNull();
  } finally {
    if (descriptor) Object.defineProperty(window, 'sessionStorage', descriptor);
    else Reflect.deleteProperty(window, 'sessionStorage');
  }
});

test('recovery labels are available in all eight Auth locales', async () => {
  for (const locale of ['en', 'de', 'es', 'fr', 'ja', 'ko', 'zh-Hans', 'zh-Hant']) {
    if (root) {
      await flush(() => root!.unmount());
      host.remove();
      root = undefined;
    }
    window.sessionStorage.clear();
    saveUnknown();
    overwriteGetLocale(() => locale);
    await mount();
    expect(host.querySelector('#membership-recovery-heading')?.textContent).toBe(m.auth_members_recovery_heading());
    expect(button(m.auth_members_recovery_retry()).textContent).toBe(m.auth_members_recovery_retry());
    expect(button(m.auth_members_recovery_sign_in()).textContent).toBe(m.auth_members_recovery_sign_in());
  }
  overwriteGetLocale(() => 'en');
});
