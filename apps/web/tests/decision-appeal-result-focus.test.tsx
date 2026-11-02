import { afterAll, afterEach, expect, test } from 'bun:test';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { DecisionPage } from '../src/moderation/decision-read';
import type { DecisionAppealAction } from '../src/moderation/decision-page';

const { dirname } = await import('node:path');
const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const browser = new Window({ url: 'https://site.test/en/moderation/decisions/one' });
const globals = {
  window: browser, document: browser.document, navigator: browser.navigator, HTMLElement: browser.HTMLElement,
  HTMLButtonElement: browser.HTMLButtonElement, HTMLTextAreaElement: browser.HTMLTextAreaElement,
  HTMLFormElement: browser.HTMLFormElement, Element: browser.Element, Node: browser.Node,
  MutationObserver: browser.MutationObserver, IS_REACT_ACT_ENVIRONMENT: true,
};
const saved = Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const { DecisionPageView } = await import('../src/moderation/decision-page');
const { m } = await import('../src/paraglide/messages.js');
const page = {
  viewerId: 'author',
  decision: {
    id: 'decision-one', targetKind: 'post', targetId: 'target-one', action: 'takedown', statement: 'Original decision.',
    decidedAt: '2026-10-01T09:30:00.000Z', appealDeadline: '2027-04-02T09:30:00.000Z', appeal: null,
  },
  target: { id: 'target-one', authorId: 'author', threadId: 'thread-one', text: 'Current target', href: '/thread-one' },
} satisfies DecisionPage;
const pending = (source: DecisionPage): DecisionPage => ({
  ...source,
  decision: {
    ...source.decision,
    appeal: { id: `appeal-${source.decision.id}`, outcome: null, statement: 'Exact appeal', resolvedAt: null },
  },
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => (resolve = yes));
  return { promise, resolve };
}

let host: HTMLElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;
async function mount(source: DecisionPage, onAppeal: DecisionAppealAction, isCurrent = () => true) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(createElement(DecisionPageView, {
    page: source, onAppeal, onRefresh: async () => source, isCurrent, now: Date.parse('2026-11-01'),
  })));
}
async function unmount() { if (root) await act(async () => root!.unmount()); host?.remove(); root = null; host = null; }
function button(label: string) {
  return [...host!.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent?.trim() === label)!;
}
function summary() {
  return [...host!.querySelectorAll<HTMLElement>('[tabindex="-1"]')].find((item) =>
    item.textContent?.includes(m.decision_appeal_pending()),
  )!;
}
async function activate(control: HTMLButtonElement) {
  control.focus();
  await act(async () => {
    control.dispatchEvent(new browser.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    control.click();
    await Promise.resolve();
  });
}
async function enterStatement() {
  const field = host!.querySelector<HTMLTextAreaElement>('textarea')!;
  const setValue = Object.getOwnPropertyDescriptor(browser.HTMLTextAreaElement.prototype, 'value')!.set!;
  await act(async () => {
    setValue.call(field, 'Same immutable appeal');
    field.dispatchEvent(new browser.Event('input', { bubbles: true }));
  });
}
afterEach(unmount);
afterAll(async () => { await browser.happyDOM.close(); for (const [key, descriptor] of saved) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); });

test('a stale completion stays on the caller; an exact keyboard retry focuses its pending summary', async () => {
  const stale = deferred<Awaited<ReturnType<DecisionAppealAction>>>();
  let current = true;
  await mount(page, () => stale.promise, () => current);
  await enterStatement();
  await activate(button(m.decision_appeal_submit()));
  current = false;
  await act(async () => {
    stale.resolve({ state: 'pending', decision: pending(page).decision });
    await stale.promise;
  });
  expect(host!.querySelector('form')).not.toBeNull(); expect(host!.querySelector('[tabindex="-1"]')).toBeNull();
  await unmount();

  const commands: Parameters<DecisionAppealAction>[0][] = [];
  await mount(page, async (command) => {
    commands.push(command);
    if (commands.length === 1) throw new Error('uncertain');
    return { state: 'pending', decision: pending(page).decision };
  });
  await enterStatement();
  const submit = button(m.decision_appeal_submit());
  await activate(submit);
  expect(document.activeElement).toBe(submit); expect(host!.textContent).toContain(m.decision_appeal_uncertain());
  await activate(button(m.decision_retry_same()));
  expect(commands[1]).toEqual(commands[0]); expect(document.activeElement).toBe(summary());
});
