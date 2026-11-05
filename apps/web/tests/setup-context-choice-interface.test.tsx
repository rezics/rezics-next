import { afterAll, afterEach, expect, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import {
  ContextChoiceError,
  createSetupContextPicker,
  type ContextChoiceSource,
  type SetupContextPicker,
} from '../src/community/setup-context-picker';
import type { SetupChoice } from '../src/community/space-setup';

// Actual field observations, authored UNRUN. Supplied choices establish no native authority.
// Browser geometry, keyboard activation, RTL layout and native admission remain integration obligations.
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
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  matchMedia: window.matchMedia.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const { createRoot } = await import('react-dom/client');
const { SetupContextPickerField } = await import('../src/community/setup-context-picker-field');
const { m } = await import('../src/paraglide/messages.js');
const { setLocale } = await import('../src/paraglide/runtime.js');
const id = (n: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(n).padStart(12, '0')}`;
const saved = { id: id(1), label: 'Saved العربية Context — ' + 'UnbrokenSavedIdentity'.repeat(12) };
const chosen = { id: id(2), label: 'Chosen 日本語 Context — ' + 'UnbrokenChosenIdentity'.repeat(12) };
const directory = { id: chosen.id, label: 'Directory display label is not the resolved selection' };
const host = window.document.createElement('main') as unknown as HTMLElement;
window.document.body.append(host);
let root: ReturnType<typeof createRoot> | undefined;
let picker: SetupContextPicker;

function source(overrides: Partial<ContextChoiceSource> = {}): ContextChoiceSource {
  return {
    search: async () => ({ contexts: [directory], next: null }),
    resolve: async (requested) => (requested === saved.id ? saved : { ...chosen, id: requested }),
    ...overrides,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function tick(milliseconds = 0) {
  await act(async () => {
    await new Promise((done) => setTimeout(done, milliseconds));
  });
}
async function mount(boundary = source(), reference = '', disabled = false, dir: 'ltr' | 'rtl' = 'ltr') {
  setLocale('en', { reload: false });
  host.dir = dir;
  picker = createSetupContextPicker(boundary, reference);
  root = createRoot(host);
  await act(async () => {
    root!.render(<SetupContextPickerField picker={picker} disabled={disabled} />);
  });
}
function button(label: string) {
  const found = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
    (node) => node.textContent?.trim() === label,
  );
  expect(found).toBeDefined();
  return found!;
}
async function click(node: HTMLElement) {
  await act(async () => {
    node.click();
  });
  await tick();
}
async function edit(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  await tick();
}
function referenceInput() {
  return host.querySelector<HTMLInputElement>('input:not([type="search"])')!;
}
async function browse() {
  await act(async () => {
    picker.retrySearch();
  });
  await tick(10);
}
function outsideDetails(text: string) {
  const node = [...host.querySelectorAll('p')].find((value) => value.textContent === text);
  expect(node).toBeDefined();
  expect(node!.closest('details')).toBeNull();
}
afterEach(async () => {
  await act(async () => {
    root?.unmount();
    picker?.dispose();
  });
  root = undefined;
  host.replaceChildren();
});
afterAll(() => {
  host.remove();
  window.happyDOM.abort();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test('complete supplied current, selected and reference identities remain readable in the actual RTL field', async () => {
  await mount(source(), chosen.id, false, 'rtl');
  await act(async () => {
    await picker.current(saved.id, 'saved-head');
    await picker.choose(chosen.id);
  });
  expect(host.textContent).toContain(saved.label);
  expect(host.textContent).toContain(chosen.label);
  expect(host.textContent).toContain(saved.id);
  expect(host.textContent).toContain(chosen.id);
  expect(referenceInput().value).toBe(chosen.id);
  expect(referenceInput().dir).toBe('ltr');
  expect(host.querySelector('details')!.open).toBe(false);
  for (const identity of host.querySelectorAll('bdi[dir="ltr"]'))
    expect([saved.id, chosen.id]).toContain(identity.textContent!);
  for (const text of [m.setup_context_hint(), m.setup_context_changed(), m.setup_context_keep_draft()])
    outsideDetails(text);
  await click(button(m.setup_context_clear()));
  expect(picker.getSnapshot().current?.id).toBe(saved.id);
  expect(picker.getSnapshot().selected).toBeNull();
  expect(host.querySelector('details')!.open).toBe(true);
});

test('manual reference validation, loading disablement and exact resolution retain existing recovery guidance', async () => {
  const resolution = deferred<SetupChoice | null>();
  const calls: string[] = [];
  await mount(
    source({
      resolve: (requested) => {
        calls.push(requested);
        return resolution.promise;
      },
    }),
  );
  expect(host.querySelector('details')!.open).toBe(true);
  expect(button(m.space_setup_resolve()).disabled).toBe(true);
  expect(host.textContent).toContain(m.space_setup_reference_hint());
  await edit(referenceInput(), 'not-a-reference');
  expect(button(m.space_setup_resolve()).disabled).toBe(true);
  await edit(referenceInput(), chosen.id);
  expect(button(m.space_setup_resolve()).disabled).toBe(false);
  await click(button(m.space_setup_resolve()));
  expect(calls).toEqual([chosen.id]);
  expect(referenceInput().disabled).toBe(true);
  expect(button(m.space_setup_loading()).disabled).toBe(true);
  await act(async () => {
    resolution.resolve(chosen);
  });
  expect(host.textContent).toContain(chosen.label);
  expect(host.querySelector('details')!.open).toBe(false);
});

test('directory display labels do not resolve rows; choosing resolves only the exact requested ID', async () => {
  const calls: string[] = [];
  await mount(
    source({
      resolve: async (requested) => {
        calls.push(requested);
        return chosen;
      },
    }),
  );
  await browse();
  expect(calls).toEqual([]);
  const result = host.querySelector<HTMLButtonElement>('ul button')!;
  expect(result.textContent).toContain(directory.label);
  expect(result.textContent).toContain(directory.id);
  await click(result);
  expect(calls).toEqual([chosen.id]);
  expect(host.textContent).toContain(chosen.label);
  expect(host.textContent).not.toContain(directory.label);
});

test('sparse Next preserves an empty-string cursor distinctly from terminal null', async () => {
  const requests: { query: string; cursor?: string }[] = [];
  await mount(
    source({
      search: async ({ query, cursor }) => {
        requests.push({ query, ...(cursor === undefined ? {} : { cursor }) });
        return requests.length === 1 ? { contexts: [], next: '' } : { contexts: [directory], next: null };
      },
    }),
  );
  await browse();
  expect(host.textContent).toContain(m.setup_context_empty());
  await click(button(m.setup_context_next()));
  await tick(10);
  expect(requests).toEqual([{ query: '' }, { query: '', cursor: '' }]);
  expect(host.textContent).toContain(directory.label);
  expect(host.textContent).not.toContain(m.setup_context_next());
});

for (const scenario of ['denied', 'unavailable', 'denied continuation', 'unavailable continuation']) {
  const continuation = scenario.endsWith('continuation');
  const reason = scenario.startsWith('denied') ? 'denied' : 'unavailable';
  test(`${scenario} keeps explicit recovery distinct from empty`, async () => {
    const page = deferred<{ contexts: readonly SetupChoice[]; next: string | null }>();
    const requests: (string | undefined)[] = [];
    await mount(
      source({
        search: async ({ cursor }) => {
          requests.push(cursor);
          if (continuation && requests.length === 1) return { contexts: [], next: '' };
          if (requests.length === (continuation ? 2 : 1)) throw new ContextChoiceError(reason);
          return page.promise;
        },
      }),
      chosen.id,
    );
    await browse();
    if (continuation) await click(button(m.setup_context_next()));
    expect(host.querySelector('[role="alert"]')!.textContent).toBe(
      reason === 'denied' ? m.setup_context_denied() : m.setup_context_unavailable(),
    );
    expect(host.textContent).not.toContain(m.setup_context_empty());
    expect(host.textContent).not.toContain(directory.label);
    const restart = continuation && reason === 'unavailable';
    expect(host.textContent!.includes(m.setup_context_restart())).toBe(restart);
    expect(host.querySelector('details')!.open).toBe(true);
    if (restart) {
      await act(async () => {
        root!.render(<SetupContextPickerField picker={picker} disabled />);
      });
      expect(button(m.setup_context_restart()).disabled).toBe(true);
      await act(async () => {
        root!.render(<SetupContextPickerField picker={picker} disabled={false} />);
      });
    }
    await click(button(restart ? m.setup_context_restart() : m.space_setup_retry()));
    expect(requests.at(-1)).toBe(continuation && !restart ? '' : undefined);
    if (restart) expect(window.document.activeElement).toBe(host.querySelector('input[type="search"]'));
    expect(host.querySelector('[role="status"]')!.textContent).toBe(m.setup_context_searching());
    expect(host.textContent).not.toContain(m.setup_context_empty());
    expect(referenceInput().value).toBe(chosen.id);
    await act(async () => {
      page.resolve({ contexts: [], next: null });
    });
    expect(host.textContent).toContain(m.setup_context_empty());
    await click(button(m.space_setup_resolve()));
    expect(host.textContent).toContain(chosen.label);
  });
}

test('current check, use-current, clear and selected retry keep saved and chosen pointers independent', async () => {
  let deny = false;
  const calls: string[] = [];
  await mount(
    source({
      resolve: async (requested) => {
        calls.push(requested);
        return deny ? null : requested === saved.id ? saved : chosen;
      },
    }),
  );
  await act(async () => {
    await picker.current(saved.id, 'head');
    await picker.choose(chosen.id);
  });
  await click(button(m.setup_context_check_current()));
  expect(picker.getSnapshot().selected?.id).toBe(chosen.id);
  await click(button(m.setup_context_use_current()));
  expect(calls).toEqual([saved.id, chosen.id, saved.id, saved.id]);
  expect(picker.getSnapshot().selected?.id).toBe(saved.id);
  await click(button(m.setup_context_clear()));
  expect(picker.getSnapshot().current?.id).toBe(saved.id);
  deny = true;
  await edit(referenceInput(), chosen.id);
  await click(button(m.space_setup_resolve()));
  expect(picker.getSnapshot().selected?.phase).toBe('denied');
  expect(host.querySelector('details')!.open).toBe(true);
  deny = false;
  await click(button(m.space_setup_retry()));
  expect(picker.getSnapshot().selected?.phase).toBe('ready');
  expect(picker.getSnapshot().current?.id).toBe(saved.id);
});

test('mismatched exact resolutions fail closed and do not reveal their supplied labels', async () => {
  await mount(source({ resolve: async () => ({ id: id(99), label: 'WITHHELD MISMATCH LABEL' }) }), chosen.id);
  await click(button(m.space_setup_resolve()));
  expect(picker.getSnapshot().selected?.phase).toBe('unavailable');
  expect(host.textContent).not.toContain('WITHHELD MISMATCH LABEL');
  expect(host.querySelector('details')!.open).toBe(true);
  expect(host.textContent).toContain(m.setup_context_unavailable());
});

test('current head ABA and synchronous disconnect/reconnect cannot publish retired labels through the field', async () => {
  const old = deferred<SetupChoice | null>();
  let calls = 0;
  await mount(
    source({ resolve: async (requested) => (++calls === 1 ? old.promise : { id: requested, label: saved.label }) }),
  );
  const disconnect = picker.connect();
  let pending!: Promise<void>;
  await act(async () => {
    pending = picker.current(saved.id, 'head-a');
  });
  await act(async () => {
    disconnect();
    picker.connect();
    await picker.current(saved.id, 'head-b');
    await picker.current(saved.id, 'head-a');
  });
  await act(async () => {
    old.resolve({ id: saved.id, label: 'RETIRED CURRENT LABEL' });
    await pending;
  });
  expect(host.textContent).toContain(saved.label);
  expect(host.textContent).not.toContain('RETIRED CURRENT LABEL');
  const retainedUseCurrent = button(m.setup_context_use_current());
  picker.dispose();
  await click(retainedUseCurrent);
  expect(calls).toBe(3);
  expect(picker.getSnapshot().selected).toBeNull();
});

test('disabled controls retain supplied selection and reference while manual guidance remains accessible', async () => {
  const calls: string[] = [];
  await mount(
    source({
      resolve: async (requested) => {
        calls.push(requested);
        return requested === saved.id ? saved : chosen;
      },
    }),
    chosen.id,
    true,
  );
  await act(async () => {
    await picker.current(saved.id);
    await picker.choose(chosen.id);
  });
  await click(host.querySelector('summary')!);
  expect(host.querySelector('details')!.open).toBe(true);
  expect(host.textContent).toContain(m.space_setup_reference_hint());
  for (const input of host.querySelectorAll<HTMLInputElement>('input')) expect(input.disabled).toBe(true);
  for (const control of host.querySelectorAll<HTMLButtonElement>('button')) {
    expect(control.disabled).toBe(true);
    await click(control);
  }
  expect(button(m.space_setup_resolve()).disabled).toBe(true);
  expect(calls).toEqual([saved.id, chosen.id]);
  expect(picker.getSnapshot().selected?.id).toBe(chosen.id);
  expect(referenceInput().value).toBe(chosen.id);
});
