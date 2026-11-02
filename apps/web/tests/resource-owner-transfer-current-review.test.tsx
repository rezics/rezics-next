import { afterAll, afterEach, expect, spyOn, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import type { AccessIO, AccessSnapshot } from '../src/accounts/resource-access/data';
import { snapshot, managerId, readerId } from '../src/stories/pages/accounts-resource-access/fixtures';
import { m } from '../src/paraglide/messages.js';

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/access/realm' });
const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  HTMLInputElement: window.HTMLInputElement,
  Element: window.Element,
  Node: window.Node,
  DocumentFragment: window.DocumentFragment,
  MutationObserver: window.MutationObserver,
  ResizeObserver: window.ResizeObserver,
  getComputedStyle: window.getComputedStyle.bind(window),
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const { createRoot } = await import('react-dom/client');
const { OwnerTransferForm } = await import('../src/accounts/resource-access/owner-transfer.tsx');
const host = document.createElement('main');
document.body.append(host);
let root: ReturnType<typeof createRoot>;
afterEach(async () => {
  await act(async () => root.unmount());
});
afterAll(async () => {
  await window.happyDOM.close();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});
function setup() {
  root = createRoot(host);
  const page: AccessSnapshot = structuredClone(snapshot);
  page.resource.type = 'community.realm';
  page.roles = [{ ...page.roles[0]!, id: 'community.realm.owner', delegable: true }];
  page.grants = [
    { ...page.grants[0]!, kind: 'role', role: 'community.realm.owner', subject: { kind: 'account', id: managerId } },
  ];
  const calls: { resolve(value: (typeof snapshot.identities)[number] | null): void; reject(error: Error): void }[] = [];
  const confirmed: unknown[] = [];
  let cancelled = 0;
  const io: AccessIO = {
    read: async () => ({ status: 'ready', page }),
    save: async () => ({ status: 'saved' }),
    transfer: async () => ({ status: 'saved', current: { status: 'ready', page } }),
    lookup: () => new Promise((resolve, reject) => calls.push({ resolve, reject })),
  };
  const render = (current = page, transport = io) =>
    act(async () =>
      root.render(
        <OwnerTransferForm
          page={current}
          grant={current.grants[0]!}
          io={transport}
          onConfirm={(input) => confirmed.push(input)}
          onCancel={() => cancelled++}
        />,
      ),
    );
  return { page, io, calls, confirmed, render, cancelled: () => cancelled };
}
const buttons = (name: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].filter((node) => node.textContent === name);
const click = (name: string) =>
  act(async () => {
    const button = buttons(name).at(-1)!;
    expect(button).toBeDefined();
    button.click();
  });
const input = (value: string) =>
  act(async () => {
    const node = host.querySelector('input')!;
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(node, value);
    node.dispatchEvent(new window.Event('input', { bubbles: true }) as unknown as Event);
  });
const start = async () => {
  await input('aki');
  await click(m.access_find_account());
};
const recipient = snapshot.identities.find((item) => item.id === readerId)!;
const dialog = () => document.querySelector('[role="alertdialog"]');
const mutations: Record<string, (page: AccessSnapshot) => void> = {
  resource: (page) => {
    page.resource.id = readerId;
  },
  route: (page) => {
    page.resource.route++;
  },
  type: (page) => {
    page.resource.type = 'community.space';
  },
  actor: (page) => {
    page.authority.accountId = readerId;
  },
  principal: (page) => {
    page.authority.principalId = readerId;
  },
  client: (page) => {
    page.authority.clientId = 'other-client';
  },
  source: (page) => {
    page.grants[0]!.subject.id = readerId;
  },
  validity: (page) => {
    page.grants[0]!.valid = '[2026-11-01,)';
  },
  permission: (page) => {
    page.grants[0]!.manageable = false;
  },
};
for (const [name, mutate] of Object.entries(mutations))
  test(`${name} changes discard delayed lookup and an open review, including return to the original context`, async () => {
    const s = setup();
    await s.render();
    await start();
    const changed = structuredClone(s.page);
    mutate(changed);
    await s.render(changed);
    await s.render();
    await act(async () => s.calls[0]!.resolve(recipient));
    expect(buttons(m.access_transfer_owner())[0]!.disabled).toBe(true);
    await start();
    await act(async () => s.calls[1]!.resolve(recipient));
    await click(m.access_transfer_owner());
    expect(dialog()?.textContent).toContain(readerId);
    await s.render(changed);
    await s.render();
    expect(dialog()).toBeNull();
    expect(s.confirmed).toEqual([]);
    expect(buttons(m.access_transfer_owner())[0]!.disabled).toBe(true);
  });
test('failed lookup can retry; editing and cancellation discard delayed results; confirmation submits the exact reviewed command once', async () => {
  const s = setup();
  await s.render();
  await start();
  await act(async () => s.calls[0]!.reject(new Error('read failed')));
  expect(host.querySelector('[role="alert"]')).not.toBeNull();
  await click(m.access_find_account());
  await input('new-recipient');
  await click(m.access_find_account());
  await act(async () => s.calls[1]!.resolve({ ...recipient, id: 'old-recipient' }));
  expect(buttons(m.access_transfer_owner())[0]!.disabled).toBe(true);
  await act(async () => s.calls[2]!.resolve(recipient));
  await click(m.access_transfer_owner());
  const confirm = buttons(m.access_transfer_owner()).at(-1)!;
  await act(async () => {
    confirm.click();
    confirm.click();
  });
  expect(s.confirmed).toEqual([
    {
      resource: { id: s.page.resource.id, route: s.page.resource.route },
      fromAccountId: managerId,
      toAccountId: readerId,
      previousValid: s.page.grants[0]!.valid,
    },
  ]);
  await act(async () => root.unmount());
  root = createRoot(host);
  await s.render();
  await start();
  await click(m.access_cancel());
  await act(async () => s.calls[3]!.resolve(recipient));
  expect(s.cancelled()).toBe(1);
  expect(buttons(m.access_transfer_owner())[0]!.disabled).toBe(true);
});

test('stalled lookup keeps the handle and permits retry without accepting a late recipient', async () => {
  const s = setup();
  await s.render();
  const schedule = globalThis.setTimeout;
  const timer = spyOn(globalThis, 'setTimeout').mockImplementation(((fn, ms, ...args) =>
    schedule(fn, ms === 25_000 ? 10 : ms, ...args)) as typeof setTimeout);
  try {
    await start();
    await act(async () => {
      await new Promise((resolve) => schedule(resolve, 20));
    });
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    expect(host.querySelector('input')!.value).toBe('aki');
    expect(buttons(m.access_find_account())[0]!.disabled).toBe(false);
    await click(m.access_find_account());
    await act(async () => s.calls[0]!.resolve(recipient));
    expect(buttons(m.access_transfer_owner())[0]!.disabled).toBe(true);
    await act(async () => s.calls[1]!.resolve(recipient));
    expect(buttons(m.access_transfer_owner())[0]!.disabled).toBe(false);
  } finally {
    timer.mockRestore();
  }
});
