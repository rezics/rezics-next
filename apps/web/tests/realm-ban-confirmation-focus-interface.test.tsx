import { afterAll, expect, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import type { BanReadState, BanWriteResult } from '../src/community/realm-bans';
import type { RealmBanTarget } from '../src/community/realm-ban-target';

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/spaces/one' });
const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  location: window.location,
  HTMLElement: window.HTMLElement,
  HTMLButtonElement: window.HTMLButtonElement,
  HTMLFormElement: window.HTMLFormElement,
  HTMLInputElement: window.HTMLInputElement,
  HTMLTextAreaElement: window.HTMLTextAreaElement,
  Element: window.Element,
  Node: window.Node,
  Document: window.Document,
  DocumentFragment: window.DocumentFragment,
  MutationObserver: window.MutationObserver,
  ResizeObserver: window.ResizeObserver,
  getComputedStyle: window.getComputedStyle.bind(window),
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  matchMedia: window.matchMedia.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

const { createRoot } = await import('react-dom/client');
const { RealmBansControl } = await import('../src/community/realm-bans-control');
const { m } = await import('../src/paraglide/messages.js');
const host = window.document.createElement('main') as unknown as HTMLElement;
window.document.body.append(host);
let root: ReturnType<typeof createRoot> | undefined;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
function button(label: string) {
  const node = [...host.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent?.trim() === label);
  expect(node).toBeDefined();
  return node!;
}
async function click(label: string) {
  await act(async () => {
    button(label).click();
    await tick();
  });
}
async function editAccount(value: string) {
  const input = host.querySelector('input')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
}
afterAll(() => {
  if (root) act(() => root!.unmount());
  host.remove();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  window.close();
});

test('review cancellation and successful unban retain a useful keyboard position', async () => {
  const realmId = '0192f3a0-6c1e-7b2a-9d4e-000000000010';
  const accountId = '0192f3a0-6c1e-7b2a-9d4e-000000000002';
  const row = { accountId, reason: 'Reviewed reason', actor: 'moderator', at: '2026-10-31T10:00:00Z' };
  const initial: BanReadState = { state: 'ready', page: { items: [row], next: null } };
  const target = {
    lookupHandle: 'river',
    account: {
      id: '0192f3a0-6c1e-7b2a-9d4e-000000000003',
      kind: 'actor',
      state: 'active',
      handle: 'river',
      displayName: 'River',
      automated: false,
      operatorId: null,
    },
  } as RealmBanTarget;
  let writes = 0;
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <RealmBansControl
        realmId={realmId}
        ready
        initial={initial}
        read={async () => ({ state: 'ready', page: { items: [], next: null } })}
        resolve={async (handle) => ({ state: 'ready', target: { ...target, lookupHandle: handle } })}
        write={async (): Promise<BanWriteResult> => {
          writes++;
          return { ok: true, action: 'unban', accountId };
        }}
      />,
    );
    await tick();
  });

  await editAccount('@river');
  await click(m.realm_bans_target_lookup());
  await click(m.realm_bans_target_select());
  button(m.realm_bans_ban()).focus();
  await click(m.realm_bans_ban());
  expect(document.activeElement).toBe(button(m.realm_bans_ban()));
  expect(writes).toBe(0);
  button(m.realm_bans_cancel()).focus();
  await click(m.realm_bans_cancel());
  expect(document.activeElement).toBe(button(m.realm_bans_ban()));

  const unban = button(m.realm_bans_unban());
  unban.focus();
  await click(m.realm_bans_unban());
  expect(writes).toBe(0);
  button(m.realm_bans_cancel()).focus();
  await click(m.realm_bans_cancel());
  expect(document.activeElement).toBe(unban);
  unban.focus();
  await click(m.realm_bans_unban());
  button(m.realm_bans_confirm()).focus();
  await click(m.realm_bans_confirm());
  expect(writes).toBe(1);
  expect(host.querySelector('li')).toBeNull();
  expect(document.activeElement).toBe(host.querySelector('[data-slot="realm-ban-outcome"]'));
});
