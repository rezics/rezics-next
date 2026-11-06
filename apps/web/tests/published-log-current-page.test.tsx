import { afterAll, describe, expect, mock, spyOn, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, Children, Fragment, isValidElement, StrictMode, type ReactNode } from 'react';
import type { PublishedLog, PublishedLogWriteResult } from '../src/library/logs-read';
import { m } from '../src/paraglide/messages.js';

// UNRUN: mounted deferred-result regressions for integration; no native/transport outcome claim.
// Reuse the DOM already installed with Puck rather than introducing a test dependency.
const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/logs/original' });
const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  HTMLButtonElement: window.HTMLButtonElement,
  Element: window.Element,
  Node: window.Node,
  DocumentFragment: window.DocumentFragment,
  MutationObserver: window.MutationObserver,
  ResizeObserver: window.ResizeObserver,
  getComputedStyle: window.getComputedStyle.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
afterAll(async () => {
  mock.restore();
  await window.happyDOM.close();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

function deferred() {
  let resolve!: (value: PublishedLogWriteResult) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<PublishedLogWriteResult>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
type Input = { data: { id: string; revision?: number; idempotencyKey: string; deletionId?: string }; headers: unknown };
type Call = ReturnType<typeof deferred> & Input;
const removes: Call[] = [];
const restores: Call[] = [];
function transport(calls: Call[], input: Input) {
  const call = { ...deferred(), ...input };
  calls.push(call);
  return call.promise;
}
mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('../src/library/logs-server', () => ({
  publishProgressLog: async () => ({ ok: false, reason: 'closed' }),
  removePublishedLog: (input: Input) => transport(removes, input),
  restorePublishedLog: (input: Input) => transport(restores, input),
}));
mock.module('../src/threads/composer', () => ({ csrfHeaders: () => ({ 'x-csrf-token': 'csrf' }) }));
// Grant exposure, observing real callbacks so retired controls can also be exercised before dispatch.
let deleteAction: (() => void) | undefined;
function observeDelete(children: ReactNode) {
  Children.forEach(children, (child) => {
    if (!isValidElement<{ children?: ReactNode; onClick?: () => void }>(child)) return;
    if (child.type === 'button' && child.props.children === m.library_logs_confirm_delete())
      deleteAction = child.props.onClick;
    observeDelete(child.props.children);
  });
}
mock.module('../src/kernel/exposure', () => ({
  Exposure: ({ children }: { children: ReactNode }) => {
    observeDelete(children);
    return <Fragment>{children}</Fragment>;
  },
  useOperation: () => true,
}));
const { UndoNotice } = await import('../src/library/copies-undo');
let undoProps: Parameters<typeof UndoNotice>[0] | undefined;
mock.module('../src/library/copies-undo', () => ({
  UndoNotice: (props: Parameters<typeof UndoNotice>[0]) => {
    undoProps = props;
    return <UndoNotice {...props} />;
  },
}));
const { createRoot } = await import('react-dom/client');
const { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } =
  await import('@tanstack/react-router');
const { PublishedLogPageView } = await import('../src/library/log-page');
const { setLocale } = await import('../src/paraglide/runtime.js');
setLocale('en', { reload: false });
type Page = Parameters<typeof PublishedLogPageView>[0];
function page(id = 'original', revision = 7): Page {
  const log: PublishedLog = {
    id,
    account: { handle: 'reader', displayName: 'Reader' },
    subject: { id: `subject-${id}`, label: `Subject ${id}`, type: 'book', types: ['book'], cover: null },
    sessionState: 'completed',
    startedAt: '2026-01-01T00:00:00Z',
    completedAt: '2026-01-02T00:00:00Z',
    publishedAt: '2026-01-03T00:00:00Z',
    note: `Snapshot ${id}`,
  };
  return { log, isOwner: true, revision };
}
const receipt = (id = 'original', revision = 8): PublishedLogWriteResult => ({
  ok: true,
  id,
  undo: { deletionId: crypto.randomUUID(), revision },
});
const settle = (action: () => void) =>
  act(async () => {
    action();
  });
async function complete(call: Call, outcome: 'success' | 'refusal' | 'rejection', result = receipt()) {
  await settle(() => {
    if (outcome === 'rejection') call.reject(new Error('uncertain transport outcome'));
    else call.resolve(outcome === 'refusal' ? { ok: false, reason: 'closed' } : result);
  });
}
async function mount(initial = page()) {
  removes.length = restores.length = 0;
  deleteAction = undefined;
  undoProps = undefined;
  const host = window.document.createElement('main') as unknown as HTMLElement;
  window.document.body.append(host);
  const root = createRoot(host);
  const router = createRouter({
    routeTree: createRootRoute(),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  const show = (p: Page | null) =>
    act(async () => {
      root.render(
        <StrictMode>
          <RouterContextProvider router={router}>{p ? <PublishedLogPageView {...p} /> : null}</RouterContextProvider>
        </StrictMode>,
      );
    });
  const button = (name: string) => {
    const found = [...host.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent === name);
    expect(found).toBeDefined();
    return found!;
  };
  const click = (name: string) => settle(() => button(name).click());
  const confirm = () =>
    settle(() => {
      deleteAction!();
      deleteAction!();
    });
  const remove = async () => {
    await click(m.library_logs_delete());
    await confirm();
    return removes.at(-1)!;
  };
  const undo = () =>
    settle(() => {
      const b = button(m.editor_undo());
      b.click();
      b.click();
    });
  const intact = (p: Page) => {
    expect(host.textContent).toContain(p.log.note!);
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.querySelector('[role="status"]')).toBeNull();
    expect(button(m.library_logs_confirm_delete()).disabled).toBe(true);
    expect(button(m.library_logs_cancel()).disabled).toBe(true);
  };
  await show(initial);
  return {
    host,
    show,
    button,
    click,
    confirm,
    remove,
    undo,
    intact,
    close: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

describe('Old published-log deletion and Undo completions cannot alter a replacement publication page', () => {
  for (const phase of ['remove', 'restore'] as const)
    for (const boundary of ['different publication', 'same publication new revision'] as const)
      for (const outcome of ['success', 'refusal', 'rejection'] as const)
        test(`${phase} ${outcome} is isolated after ${boundary}`, async () => {
          const h = await mount();
          try {
            let old = await h.remove();
            if (phase === 'restore') {
              await complete(old, 'success');
              await h.undo();
              expect(restores).toHaveLength(1);
              old = restores[0]!;
            }
            const replacement = page(boundary === 'different publication' ? 'replacement' : 'original', 23);
            await h.show(replacement);
            expect(h.host.textContent).toContain(replacement.log.note!);
            expect(h.host.querySelector('[role="alert"]')).toBeNull();
            expect(h.host.querySelector('[role="status"]')).toBeNull();
            expect(h.button(m.library_logs_delete()).disabled).toBe(false);
            const current = await h.remove(); // New page is usable while the old promise is pending.
            expect(current.data).toEqual({
              id: replacement.log.id,
              revision: 23,
              idempotencyKey: current.data.idempotencyKey,
            });
            expect(current.data.idempotencyKey).not.toBe(removes[0]!.data.idempotencyKey);
            await complete(old, outcome, phase === 'restore' ? { ok: true, id: 'original', revision: 99 } : receipt());
            h.intact(replacement);
            await h.confirm(); // Exercise the callback even while its DOM button is disabled.
            expect(removes).toHaveLength(2);
            await complete(current, 'refusal');
            await h.confirm();
            expect(removes[2]!.data).toEqual(current.data); // Old success/finally cannot rotate the new key.
            await complete(removes[2]!, 'success', receipt(replacement.log.id, 24));
            await h.undo();
            const currentRestore = restores.at(-1)!;
            await complete(currentRestore, 'success', { ok: true, id: replacement.log.id, revision: 25 });
            await h.remove();
            expect(removes.at(-1)!.data.revision).toBe(25);
            expect(removes.at(-1)!.data.idempotencyKey).not.toBe(current.data.idempotencyKey);
            await complete(removes.at(-1)!, 'refusal');
          } finally {
            await h.close();
          }
        });
});

test('old completions cannot replace a new deletion episode or unlock its pending Undo', async () => {
  for (const phase of ['remove', 'restore'] as const)
    for (const outcome of ['success', 'refusal', 'rejection'] as const) {
      const h = await mount();
      try {
        let old = await h.remove();
        if (phase === 'restore') {
          await complete(old, 'success');
          await h.undo();
          old = restores[0]!;
        }
        await h.show(page('replacement', 23));
        const currentReceipt = receipt('replacement', 24);
        await complete(await h.remove(), 'success', currentReceipt);
        const currentUndo = undoProps!;
        await h.undo();
        const current = restores.at(-1)!;
        const count = restores.length;
        await complete(old, outcome, { ok: true, id: 'original', revision: 99 });
        expect(h.host.querySelector('[role="status"]')?.textContent).toBe(m.library_logs_deleted());
        expect(h.host.querySelector('[role="alert"]')).toBeNull();
        expect(h.button(m.editor_undo()).disabled).toBe(true);
        expect(undoProps!.deadline).toBe(currentUndo.deadline);
        expect(await currentUndo.restore(crypto.randomUUID())).toBe(false);
        expect(restores).toHaveLength(count);
        await complete(current, 'rejection');
        await h.undo();
        expect(restores.at(-1)!.data).toEqual(current.data);
        expect(current.data).toEqual({
          id: 'replacement',
          ...(currentReceipt.ok ? currentReceipt.undo : {}),
          idempotencyKey: current.data.idempotencyKey,
        });
        await complete(restores.at(-1)!, 'success', { ok: true, id: 'replacement', revision: 25 });
        expect(h.host.textContent).toContain('Snapshot replacement');
        expect(await currentUndo.restore(crypto.randomUUID())).toBe(false);
      } finally {
        await h.close();
      }
    }
});

test('replacement and ownership removal clear confirmation, errors, tombstones, Undo and pending state', async () => {
  for (const state of ['confirmation', 'error', 'deleted']) {
    const original = page();
    const h = await mount(original);
    try {
      if (state === 'confirmation') await h.click(m.library_logs_delete());
      else await complete(await h.remove(), state === 'error' ? 'refusal' : 'success');
      const oldDelete = deleteAction!;
      const oldRestore = undoProps?.restore;
      await h.show({ ...original, isOwner: false });
      expect(h.host.textContent).toContain(original.log.note!);
      expect(h.host.querySelector('button')).toBeNull();
      expect(h.host.querySelector('[role="alert"]')).toBeNull();
      expect(h.host.querySelector('[role="status"]')).toBeNull();
      const count = removes.length;
      await settle(oldDelete);
      if (oldRestore) expect(await oldRestore(crypto.randomUUID())).toBe(false);
      expect(removes).toHaveLength(count);
      expect(restores).toHaveLength(0);
      await h.show(original);
      const current = await h.remove();
      expect(current.data.revision).toBe(7);
      await complete(current, 'refusal');
      await h.show(page('replacement', 23));
      expect(h.host.querySelector('[role="alert"]')).toBeNull();
      expect(h.button(m.library_logs_delete())).toBeDefined();
    } finally {
      await h.close();
    }
  }
});

test('unmount and ownership removal retire pending remove/restore and their retained callbacks', async () => {
  for (const phase of ['remove', 'restore'] as const)
    for (const boundary of ['unmount', 'ownership'] as const)
      for (const outcome of ['success', 'refusal', 'rejection'] as const) {
        const original = page();
        const h = await mount(original);
        try {
          let old = await h.remove();
          const oldDelete = deleteAction!;
          if (phase === 'restore') {
            await complete(old, 'success');
            await h.undo();
            old = restores[0]!;
          }
          const oldRestore = undoProps?.restore;
          await h.show(boundary === 'unmount' ? null : { ...original, isOwner: false });
          await settle(oldDelete);
          if (oldRestore) expect(await oldRestore(crypto.randomUUID())).toBe(false);
          expect(removes).toHaveLength(1);
          expect(restores).toHaveLength(phase === 'restore' ? 1 : 0);
          await h.show(original);
          const current = await h.remove();
          await complete(old, outcome, { ok: true, id: 'original', revision: 99 });
          h.intact(original);
          await h.confirm();
          expect(removes).toHaveLength(2);
          await complete(current, 'refusal');
        } finally {
          await h.close();
        }
      }
});

test('same-page uncertain retries keep exact payloads, evidence and deadline; only success rotates the key', async () => {
  let now = 1_800_000_000_000;
  const clock = spyOn(Date, 'now').mockImplementation(() => now);
  const original = page();
  const h = await mount(original);
  try {
    await h.click(m.library_logs_delete());
    await h.show({ ...original, log: { ...original.log } });
    expect(h.button(m.library_logs_confirm_delete())).toBeDefined(); // Clones do not erase the confirmation draft.
    await h.confirm();
    expect(removes).toHaveLength(1); // Two synchronous invocations dispatched once.
    const oldDelete = deleteAction!;
    const intent = removes[0]!.data;
    expect(intent).toEqual({ id: original.log.id, revision: 7, idempotencyKey: intent.idempotencyKey });
    expect(removes[0]!.headers).toEqual({ 'x-csrf-token': 'csrf' });
    await complete(removes[0]!, 'rejection');
    await h.show({ ...original, log: { ...original.log } });
    expect(h.host.querySelector('[role="alert"]')?.textContent).toBe(m.library_logs_write_failed());
    now += 1_000;
    await h.confirm();
    expect(removes[1]!.data).toEqual(intent);
    await complete(removes[1]!, 'refusal');
    expect(h.host.querySelector('[role="alert"]')?.textContent).toBe(m.platform_closed_message());
    await h.confirm();
    expect(removes[2]!.data).toEqual(intent);
    const deleted = receipt();
    await complete(removes[2]!, 'success', deleted);
    await settle(oldDelete);
    expect(removes).toHaveLength(3); // A retired confirmation cannot dispatch against the tombstone.
    expect(undoProps!.deadline).toBe(now - 1_000 + 30_000);
    await h.undo();
    expect(restores).toHaveLength(1);
    const restoreIntent = restores[0]!.data;
    expect(restoreIntent).toEqual({
      id: original.log.id,
      ...(deleted.ok ? deleted.undo : {}),
      idempotencyKey: restoreIntent.idempotencyKey,
    });
    expect(restores[0]!.headers).toEqual({ 'x-csrf-token': 'csrf' });
    await complete(restores[0]!, 'rejection');
    await h.show({ ...original, log: { ...original.log } });
    expect(h.host.querySelector('[role="alert"]')?.textContent).toBe(m.library_logs_write_failed());
    await h.undo();
    expect(restores[1]!.data).toEqual(restoreIntent);
    await complete(restores[1]!, 'refusal');
    await h.undo();
    expect(restores[2]!.data).toEqual(restoreIntent);
    await complete(restores[2]!, 'success', { ok: true, id: original.log.id, revision: 11 });
    await h.show({ ...original, log: { ...original.log } }); // Must not reinstate loader revision 7.
    expect(h.host.textContent).toContain(original.log.note!);
    expect([...h.host.querySelectorAll('time')].map((node) => node.dateTime)).toEqual([
      original.log.startedAt,
      original.log.completedAt!,
      original.log.publishedAt,
    ]);
    expect(h.host.querySelector('a')?.textContent).toContain('Subject original');
    expect(h.host.textContent).toContain('@reader');
    await settle(oldDelete);
    expect(removes).toHaveLength(3); // Restoring also retires the old revision-bound confirmation.
    const next = await h.remove();
    expect(next.data.revision).toBe(11);
    expect(next.data.idempotencyKey).not.toBe(intent.idempotencyKey);
    await complete(next, 'success', receipt(original.log.id, 12));
    const deadline = undoProps!.deadline;
    now = deadline;
    expect(await undoProps!.restore(crypto.randomUUID())).toBe(false);
    await h.undo();
    expect(restores).toHaveLength(3); // Exactly 30 seconds is expired; native 720-hour policy is never sent/renewed.
  } finally {
    await h.close();
    clock.mockRestore();
  }
});

test('owner retract, confirm and Undo keep 44px keyboard-visible targets', async () => {
  const h = await mount();
  try {
    const tokens = ['min-h-11', 'min-w-11', 'max-w-full', 'whitespace-normal', 'focus-visible:outline-2'];
    const remove = h.button(m.library_logs_delete());
    for (const name of tokens) expect(remove.className).toContain(name);
    await h.click(m.library_logs_delete());
    for (const name of tokens) {
      expect(h.button(m.library_logs_confirm_delete()).className).toContain(name);
      expect(h.button(m.library_logs_cancel()).className).toContain(name);
    }
    await h.confirm();
    await complete(removes.at(-1)!, 'success');
    const undo = h.button(m.editor_undo());
    for (const name of tokens) expect(undo.className).toContain(name);
  } finally {
    await h.close();
  }
});

test('public snapshots remain readable without owner revision or dispatch controls', async () => {
  for (const props of [
    { ...page(), isOwner: false },
    { ...page(), revision: undefined },
  ]) {
    const h = await mount(props);
    try {
      expect(h.host.textContent).toContain(props.log.note!);
      expect(h.host.querySelector('button')).toBeNull();
      expect(h.host.innerHTML).not.toContain('idempotencyKey');
      expect(h.host.innerHTML).not.toContain('csrf');
      expect(removes).toHaveLength(0);
      expect(restores).toHaveLength(0);
    } finally {
      await h.close();
    }
  }
});
