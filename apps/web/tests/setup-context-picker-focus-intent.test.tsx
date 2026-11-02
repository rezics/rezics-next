import { afterAll, afterEach, expect, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import { createSetupContextPicker, type SetupContextPicker } from '../src/community/setup-context-picker';

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/realms/new' });
const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  HTMLInputElement: window.HTMLInputElement,
  HTMLButtonElement: window.HTMLButtonElement,
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
const { createRoot } = await import('react-dom/client');
const { SetupContextPickerField } = await import('../src/community/setup-context-picker-field');
const { m } = await import('../src/paraglide/messages.js');
const host = window.document.createElement('main') as unknown as HTMLElement;
const outside = window.document.createElement('button');
window.document.body.append(host, outside);
let root: ReturnType<typeof createRoot>;
const pickers: SetupContextPicker[] = [];
async function step(action: () => unknown = () => {}) {
  await act(async () => {
    action();
  });
  await act(async () => {
    await new Promise((done) => setTimeout(done, 5));
  });
}
afterEach(async () => {
  await step(() => root.unmount());
  for (const picker of pickers.splice(0)) picker.dispose();
});
afterAll(() => {
  host.remove();
  outside.remove();
  window.happyDOM.abort();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

for (const scenario of [
  'current',
  'moved',
  'focus ABA',
  'pointerdown',
  'click',
  'disabled ABA',
  'replaced',
  'picker ABA',
  'retired',
  'unmounted',
  'stale',
]) {
  test(`Context page focus intent: ${scenario}`, async () => {
    let settle!: (page: { contexts: { id: string; label: string }[]; next: null }) => void;
    let requests = 0;
    const late = new Promise<{ contexts: { id: string; label: string }[]; next: null }>((done) => {
      settle = done;
    });
    const picker = createSetupContextPicker({
      search: async ({ cursor }) => {
        requests++;
        return cursor === undefined ? { contexts: [], next: '' } : late;
      },
      resolve: async () => null,
    });
    pickers.push(picker);
    root = createRoot(host);
    const paint = (value = picker, disabled = false) =>
      step(() => root.render(<SetupContextPickerField picker={value} disabled={disabled} />));
    await paint();
    await step(() => picker.retrySearch());
    const query = host.querySelector<HTMLInputElement>('input[type="search"]')!;
    const next = [...host.querySelectorAll('button')].find((node) => node.textContent === m.setup_context_next())!;
    await step(() => {
      (scenario === 'focus ABA' ? query : next).focus();
      next.click();
    });
    if (scenario === 'moved' || scenario === 'focus ABA') await step(() => outside.focus());
    if (scenario === 'focus ABA') await step(() => query.focus());
    if (scenario === 'pointerdown' || scenario === 'click')
      await step(() => outside.dispatchEvent(new window.MouseEvent(scenario, { bubbles: true, detail: 1 })));
    if (scenario === 'disabled ABA') {
      await paint(picker, true);
      await paint();
    }
    if (scenario === 'replaced' || scenario === 'picker ABA') {
      const replacement = createSetupContextPicker({
        search: async () => ({ contexts: [], next: null }),
        resolve: async () => null,
      });
      pickers.push(replacement);
      await paint(replacement);
      if (scenario === 'picker ABA') await paint();
    }
    if (scenario === 'retired')
      await step(() => {
        picker.connect()();
        picker.connect();
      });
    if (scenario === 'unmounted') await step(() => root.render(null));
    if (scenario === 'stale')
      await step(() => {
        picker.reference('manual');
        picker.retrySearch();
      });
    const focus = window.document.activeElement;
    await step(() => settle({ contexts: [{ id: 'late', label: 'Late Context' }], next: null }));
    expect(window.document.activeElement).toBe(scenario === 'current' ? host.querySelector('[role="region"]') : focus);
    expect(requests).toBe(scenario === 'stale' ? 3 : 2);
    expect(picker.getSnapshot().selected).toBeNull();
    if (scenario === 'retired' || scenario === 'stale' || scenario === 'replaced' || scenario === 'unmounted')
      expect(host.textContent).not.toContain('Late Context');
  });
}
