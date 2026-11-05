import { expect, spyOn, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import type { Intent, Outcome, Page } from '../src/accounts/lifecycle-controls/data';

test('independent lifecycle reviews retire confirmations and reconcile the exact uncertain command', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/platform/accounts/selected' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    Document: window.Document,
    DocumentFragment: window.DocumentFragment,
    MutationObserver: window.MutationObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, value });
  const { createRoot } = await import('react-dom/client');
  const { AccountLifecyclePage } = await import('../src/accounts/lifecycle-controls/page');
  const { m } = await import('../src/paraglide/messages.js');
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  const ready = (suffix: string): Page => ({
    status: 'ready',
    account: {
      id: `01a1a000-0000-7000-8000-00000000010${suffix}`,
      kind: 'actor',
      displayName: `Reader ${suffix}`,
      handle: `reader${suffix}`,
    },
    offered: ['suspend'],
    currentState: 'unavailable',
  });
  const commands: Intent[] = [];
  let reads = 0;
  let complete!: (outcome: Outcome) => void;
  const io = {
    read: async (): Promise<Page> => {
      if (++reads === 1) throw Error('read failed');
      return ready('2');
    },
    change: (intent: Intent) => {
      commands.push(intent);
      return new Promise<Outcome>((resolve) => {
        complete = resolve;
      });
    },
  };
  const paint = (suffix = '2', show = true) =>
    act(async () =>
      root.render(
        <>
          <AccountLifecyclePage initial={ready('1')} io={io} />
          {show && <AccountLifecyclePage initial={ready(suffix)} io={io} />}
        </>,
      ),
    );
  const panel = (index: number) => host.querySelectorAll('article')[index]!;
  const button = (index: number, name: string) =>
    [...panel(index).querySelectorAll('button')].find((node) => node.textContent === name)!;
  const click = (index: number, name: string) => act(async () => button(index, name).click());
  const retained = (node: HTMLElement) =>
    Reflect.get(
      node,
      Object.keys(node).find((key) => key.startsWith('__reactProps$'))!,
    ).onClick;
  try {
    await paint();
    for (const review of host.querySelectorAll('article')) {
      for (const label of review.querySelectorAll('label'))
        expect(review.contains(document.getElementById(label.htmlFor))).toBe(true);
      const reason = review.querySelector('textarea')!;
      expect(review.contains(document.getElementById(reason.getAttribute('aria-describedby')!))).toBe(true);
    }
    await click(0, m.lifecycle_review());
    await click(1, m.lifecycle_review());
    for (const review of host.querySelectorAll('article')) {
      const section = review.querySelector('section')!;
      expect(section.contains(document.getElementById(section.getAttribute('aria-labelledby')!))).toBe(true);
    }
    const cancelled = retained(button(1, m.lifecycle_confirm()));
    await click(1, m.lifecycle_cancel());
    await click(1, m.lifecycle_review());
    await act(async () => cancelled());
    expect(commands).toHaveLength(0);
    const replaced = retained(button(1, m.lifecycle_confirm()));
    await paint('3');
    await act(async () => replaced());
    expect(commands).toHaveLength(0);
    await paint();
    await click(1, m.lifecycle_review());
    const confirm = retained(button(1, m.lifecycle_confirm()));
    let expire!: () => void;
    const schedule = globalThis.setTimeout;
    const timer = spyOn(globalThis, 'setTimeout').mockImplementation(((fn, ms, ...args) => {
      if (ms === 35_000) expire = () => fn(...args);
      return schedule(fn, ms, ...args);
    }) as typeof setTimeout);
    await act(async () => {
      confirm();
      confirm();
    });
    expect(commands).toHaveLength(1);
    expect(commands[0]!.accountId).toBe((ready('2') as Extract<Page, { status: 'ready' }>).account.id);
    timer.mockRestore();
    await act(async () => expire());
    expect(panel(1).textContent).toContain(m.lifecycle_uncertain());
    expect(button(1, m.lifecycle_read_current()).disabled).toBe(false);
    await act(async () => complete({ status: 'recorded', receiptId: 'late', current: ready('2') }));
    expect(panel(1).textContent).toContain(m.lifecycle_uncertain());
    await act(async () => confirm());
    expect(commands).toHaveLength(1);
    await click(1, m.lifecycle_read_current());
    expect(panel(1).textContent).toContain(m.lifecycle_unavailable());
    expect(button(1, m.lifecycle_retry_same()).disabled).toBe(true);
    await click(1, m.lifecycle_read_current());
    await click(1, m.lifecycle_retry_same());
    expect(commands).toHaveLength(2);
    expect(commands[1]).toBe(commands[0]);
    await act(async () => complete({ status: 'recorded', receiptId: 'receipt', current: ready('2') }));
    expect(panel(1).textContent).toContain(m.lifecycle_recorded());
    const closed = retained(button(0, m.lifecycle_confirm()));
    await act(async () => root.render(null));
    await act(async () => closed());
    expect(commands).toHaveLength(2);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
