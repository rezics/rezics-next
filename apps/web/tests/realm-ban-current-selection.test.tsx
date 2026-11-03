import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { admitRealmBanCurrent, unavailableRealmBanCurrent } from '../src/community/realm-ban-current';
import { RealmBanCurrentObservationView } from '../src/community/realm-ban-current-control';
import { m } from '../src/paraglide/messages.js';

const input = Object.freeze({ realmId: 'realm', accountId: 'account', cursor: 'opaque-frontier' });
const ban = { accountId: input.accountId, actor: null, at: '2026-11-02T14:05:00Z', reason: 'Actual reason\nFull text' };

test('exact observations bind the Realm, selected account and unchanged frontier; failures never establish absence', async () => {
  for (const other of [
    { ...input, realmId: 'replacement' },
    { ...input, accountId: 'replacement' },
    { ...input, cursor: 'replacement' },
    { realmId: input.realmId, accountId: input.accountId },
  ]) {
    expect(admitRealmBanCurrent(input, { state: 'absent', input: other })).toEqual({ state: 'unavailable' });
    expect(admitRealmBanCurrent(input, { state: 'current', input: other, ban })).toEqual({ state: 'unavailable' });
  }
  expect(admitRealmBanCurrent(input, { state: 'current', input, ban: { ...ban, accountId: 'other' } })).toEqual({
    state: 'unavailable',
  });
  for (const state of ['forbidden', 'unavailable', 'signed-out', 'closed'] as const)
    expect(admitRealmBanCurrent(input, { state })).toEqual({ state });
  expect(await unavailableRealmBanCurrent(input)).toEqual({ state: 'unavailable' });
  const current = admitRealmBanCurrent(input, { state: 'current', input, ban });
  expect(current.state).toBe('current');
  if (current.state !== 'current') throw new Error('Expected current episode');
  ban.reason = 'Later replacement';
  expect(current.ban.reason).toBe('Actual reason\nFull text');
  expect(Object.isFrozen(current.ban)).toBe(true);
  expect(Object.isFrozen(current.input)).toBe(true);
  const replacement = admitRealmBanCurrent(input, {
    state: 'current',
    input,
    ban: { ...ban, at: '2026-11-03T10:00:00Z' },
  });
  expect(replacement).not.toEqual(current);
  expect(current.input.cursor).toBe('opaque-frontier');
});

test('selected current facts and operational absence do not claim a definitive command or removal completion', () => {
  const observation = { state: 'current' as const, input, ban: { ...ban, reason: 'Displayed reason' } };
  const html = renderToStaticMarkup(createElement(RealmBanCurrentObservationView, { observation }));
  expect(html).toContain('Displayed reason');
  expect(html).toContain('2026-11-02 14:05:00 UTC');
  expect(html).toContain(m.realm_bans_moderator_erased());
  expect(html).toContain(m.realm_bans_help());
  expect(html).not.toContain('realm-ban-outcome');
  const absent = admitRealmBanCurrent(input, { state: 'absent', input });
  if (absent.state !== 'absent') throw new Error('Expected admitted absence');
  const absence = renderToStaticMarkup(createElement(RealmBanCurrentObservationView, { observation: absent }));
  expect(absence).toContain(m.realm_bans_inspect_absent());
  expect(absence).not.toContain('Displayed reason');
  expect(absence).not.toContain(m.realm_bans_lifted());
});

test('inspection retry retains one frozen selection and leaves the list frontier and receipts independent', async () => {
  const { dirname } = await import('node:path');
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
    HTMLInputElement: window.HTMLInputElement,
    Element: window.Element,
    Node: window.Node,
    Document: window.Document,
    DocumentFragment: window.DocumentFragment,
    MutationObserver: window.MutationObserver,
    ResizeObserver: window.ResizeObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { RealmBansControl } = await import('../src/community/realm-bans-control');
  const host = window.document.createElement('main');
  window.document.body.append(host);
  const root = createRoot(host);
  const realmId = '01a17a3b-70ea-712a-9ff7-81fc6a9381b6';
  const accountId = '01a17a3b-70ea-712a-9ff7-81fc6a938199';
  const reads: (string | undefined)[] = [];
  const inspections: import('../src/community/realm-ban-current').RealmBanCurrentInput[] = [];
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  const click = async (label: string) =>
    act(async () => {
      const button = [...host.querySelectorAll('button')].find((node) => node.textContent?.trim() === label)!;
      expect(button).toBeDefined();
      button.click();
      await tick();
    });
  try {
    await act(async () => {
      root.render(
        createElement(RealmBansControl, {
          realmId,
          ready: true,
          read: async (cursor) => {
            reads.push(cursor);
            return { state: 'ready', page: { items: [], next: 'next-window' } };
          },
          write: async () => {
            throw new Error('Inspection must not submit a command');
          },
          inspect: async (input) => {
            inspections.push(input);
            return inspections.length === 1
              ? { state: 'unavailable' }
              : inspections.length === 2
                ? { state: 'current', input, ban: { ...ban, accountId, reason: 'Selected episode' } }
                : { state: 'absent', input };
          },
        }),
      );
      await tick();
    });
    await click(m.realm_bans_next());
    const field = host.querySelectorAll('input')[1]!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(field, accountId);
      field.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    await click(m.realm_bans_inspect_action());
    expect(host.textContent).toContain(m.realm_bans_inspect_unavailable());
    await click(m.realm_bans_inspect_retry());
    expect(host.textContent).toContain('Selected episode');
    await click(m.realm_bans_inspect_retry());
    expect(host.textContent).toContain(m.realm_bans_inspect_absent());
    expect(host.textContent).not.toContain('Selected episode');
    expect(host.querySelector('[data-slot="realm-ban-outcome"]')).toBeNull();
    expect(inspections[0]).toEqual({ realmId, accountId, cursor: 'next-window' });
    expect(inspections.every((input) => input === inspections[0] && Object.isFrozen(input))).toBe(true);
    expect(reads).toEqual([undefined, 'next-window']);
  } finally {
    await act(async () => {
      root.unmount();
      await tick();
    });
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    window.close();
  }
});
