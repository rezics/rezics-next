import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import type { AccessIO, AccessState, Change } from '../src/accounts/resource-access/data';
import { snapshot, managerId } from '../src/stories/pages/accounts-resource-access/fixtures';

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/access' });
const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  ...Object.fromEntries(
    [
      'HTMLElement',
      'HTMLInputElement',
      'HTMLButtonElement',
      'HTMLFormElement',
      'Element',
      'Node',
      'NodeFilter',
      'Document',
      'ShadowRoot',
      'DocumentFragment',
      'MutationObserver',
      'ResizeObserver',
    ].map((key) => [key, window[key]]),
  ),
  getComputedStyle: window.getComputedStyle.bind(window),
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
mock.module('cloudflare:workers', () => ({ env: {} }));
const { createRoot } = await import('react-dom/client');
const { createMemoryHistory, createRootRoute, createRoute, createRouter, Link, Outlet, RouterProvider } =
  await import('@tanstack/react-router');
const { within, userEvent } = await import('storybook/test');
const { ResourceAccessPage } = await import('../src/accounts/resource-access/page');
const { AuthoringDepartureProvider } = await import('../src/threads/authoring-departure');
const { m } = await import('../src/paraglide/messages.js');
const { getLocale, setLocale } = await import('../src/paraglide/runtime.js');
const locale = getLocale();
const user = userEvent.setup({ document: window.document as unknown as Document });
let host: HTMLDivElement, root: ReturnType<typeof createRoot>;
const click = async (element: HTMLElement) => act(async () => user.click(element));
const type = async (element: HTMLElement, text: string) => act(async () => user.type(element, text));
const button = (name: string, scope: HTMLElement = document.body) =>
  within(scope).getByRole('button', { name, exact: true });
const blocked = () => {
  const event = new window.Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
};
const decision = () => within(document.body).getByRole('alertdialog');
const stay = () => click(button(m.thread_authoring_stay(), decision()));
const leave = () => click(button(m.thread_authoring_leave(), decision()));
beforeEach(() => {
  setLocale('en', { reload: false });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});
afterAll(async () => {
  setLocale(locale, { reload: false });
  await window.happyDOM.close();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});
function ioFor(page = structuredClone(snapshot)): AccessIO {
  return {
    read: mock(async () => ({ status: 'ready', page })),
    lookup: mock(async () => page.identities[1]!),
    save: mock(async () => ({ status: 'saved' })),
  };
}
async function mount(initial: AccessState, io: AccessIO, containingOwner = false) {
  const parent = createRootRoute({
    component: () =>
      containingOwner ? (
        <AuthoringDepartureProvider>
          <Outlet />
        </AuthoringDepartureProvider>
      ) : (
        <Outlet />
      ),
  });
  const access = createRoute({
    getParentRoute: () => parent,
    path: '/access',
    component: () => (
      <>
        <ResourceAccessPage initial={initial} io={io} />
        <Link to="/away">Destination</Link>
      </>
    ),
  });
  const away = createRoute({
    getParentRoute: () => parent,
    path: '/away',
    component: () => <p>Destination reached</p>,
  });
  const router = createRouter({
    routeTree: parent.addChildren([access, away]),
    history: createMemoryHistory({ initialEntries: ['/access'] }),
  });
  await act(async () => {
    await router.load();
    root.render(<RouterProvider router={router} />);
  });
  return router;
}

test('changed grant draft survives Stay; paging and deliberate Leave retire it through the shared owner', async () => {
  const page = structuredClone(snapshot);
  page.next = 'next-grants';
  const io = ioFor(page);
  await mount({ status: 'ready', page }, io, true);
  await click(button(m.access_add_grant()));
  const handle = within(host).getByLabelText(m.access_handle());
  await click(handle);
  expect(blocked()).toBe(false);
  await type(handle, 'aki');
  await act(async () => user.selectOptions(within(host).getByLabelText(m.access_grant_kind()), 'direct'));
  await act(async () => user.selectOptions(within(host).getByLabelText(m.access_action()), 'collection:update'));
  const end = within(host).getByLabelText(m.access_ends()) as HTMLInputElement;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    setter.call(end, '2027-01-01T12:00');
    end.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  const draft = [handle, within(host).getByLabelText(m.access_action()), end].map(
    (node) => (node as HTMLInputElement).value,
  );
  expect(blocked()).toBe(true);
  const link = within(host).getByRole('link', { name: 'Destination' });
  await click(link);
  expect(within(document.body).getAllByRole('alertdialog')).toHaveLength(1);
  await stay();
  expect(document.activeElement).toBe(link);
  expect(
    [handle, within(host).getByLabelText(m.access_action()), end].map((node) => (node as HTMLInputElement).value),
  ).toEqual(draft);
  await click(button(m.access_next_page()));
  await stay();
  expect(io.read).toHaveBeenCalledTimes(0);
  expect((handle as HTMLInputElement).value).toBe('aki');
  await click(button(m.access_next_page()));
  await leave();
  expect(io.read).toHaveBeenCalledWith('next-grants', expect.any(AbortSignal));
  expect(host.querySelector('#access-handle')).toBeNull();
  expect(blocked()).toBe(false);
  await click(link);
  expect(host.textContent).toContain('Destination reached');
});

test('Stay retains the exact unresolved command; Leave never cancels or replays it and ignores its late result', async () => {
  const io = ioFor();
  const commands: Change[] = [];
  let finish!: (value: { status: 'saved' }) => void;
  let signal: AbortSignal | undefined;
  io.save = mock(async (command, caller) => {
    commands.push(structuredClone(command));
    signal = caller;
    if (commands.length === 1) return { status: 'uncertain' };
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  await mount({ status: 'ready', page: snapshot }, io);
  await click(button(m.access_add_grant()));
  await type(within(host).getByLabelText(m.access_handle()), 'aki');
  await click(button(m.access_find_account()));
  await click(button(m.access_save()));
  expect(blocked()).toBe(true);
  const link = within(host).getByRole('link', { name: 'Destination' });
  await click(link);
  await stay();
  expect(commands).toHaveLength(1);
  await click(button(m.access_retry_operation()));
  expect(commands[1]).toEqual(commands[0]);
  await click(link);
  await leave();
  expect(signal?.aborted).toBe(false);
  const reads = (io.read as ReturnType<typeof mock>).mock.calls.length;
  await act(async () => finish({ status: 'saved' }));
  expect(commands).toHaveLength(2);
  expect((io.read as ReturnType<typeof mock>).mock.calls).toHaveLength(reads);
  expect(host.textContent).toContain('Destination reached');
  expect(blocked()).toBe(false);
});

test('owner transfer confirmation survives Stay, then completes and leaves normally; caller loss bypasses drafts', async () => {
  const page = structuredClone(snapshot);
  page.resource.type = 'community.realm';
  page.roles = [{ id: 'community.realm.owner', actions: ['realm:read'], delegable: true }];
  page.grants = [
    { ...page.grants[0]!, kind: 'role', role: 'community.realm.owner', subject: { kind: 'account', id: managerId } },
  ];
  const io = ioFor(page);
  io.transfer = mock(async () => ({ status: 'saved', current: { status: 'ready', page } }));
  await mount({ status: 'ready', page }, io);
  await click(button(m.access_grant_actions()));
  await click(within(document.body).getByRole('menuitem', { name: m.access_transfer_owner() }));
  await type(within(host).getByLabelText(m.access_handle()), 'aki');
  await click(button(m.access_find_account()));
  await click(button(m.access_transfer_owner(), host));
  const confirmation = decision().textContent;
  const routerLink = within(host).getByRole('link', { name: 'Destination' });
  // Programmatic navigation also works while the confirmation owns modal focus.
  await act(async () => {
    routerLink.click();
  });
  await stay();
  expect(decision().textContent).toBe(confirmation);
  expect((within(host).getByLabelText(m.access_handle()) as HTMLInputElement).value).toBe('aki');
  await click(button(m.access_transfer_owner(), decision()));
  expect(io.transfer).toHaveBeenCalledTimes(1);
  expect(blocked()).toBe(false);
  await click(routerLink);
  expect(host.textContent).toContain('Destination reached');
  await act(async () => root.render(<ResourceAccessPage initial={{ status: 'ready', page }} io={io} />));
  await click(button(m.access_add_grant()));
  await type(within(host).getByLabelText(m.access_handle()), 'private');
  await act(async () => root.render(<ResourceAccessPage initial={{ status: 'denied' }} io={ioFor(page)} />));
  expect(blocked()).toBe(false);
  expect(within(document.body).queryByRole('alertdialog')).toBeNull();
  expect(host.textContent).not.toContain('private');
});
