import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, type ReactNode } from 'react';
import type { CopyItem } from '../src/library/copies-read';
import { m } from '../src/paraglide/messages.js';

// Shells are isolated here; real sheet/dialog focus, wrapping and target geometry are covered by the journey stories.
const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/library/copies', width: 320, height: 568 });
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
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
let mobile = true;
const create = mock(async (_input: unknown): Promise<unknown> => ({ ok: false, reason: 'unavailable' }));
const update = mock(async (_input: unknown): Promise<unknown> => ({ ok: false, reason: 'unavailable' }));
const remove = mock(async (_input: unknown): Promise<unknown> => ({ ok: false, reason: 'unavailable' }));
mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('../src/library/copies-actions', () => ({
  createCopy: create,
  updateCopy: update,
  deleteCopy: remove,
  readCopyDetail() {},
  readCopySubject() {},
  undoCopy() {},
}));
mock.module('../src/threads/composer', () => ({ csrfHeaders: () => ({ 'x-csrf-token': 'current' }) }));
mock.module('../src/kernel/exposure', () => ({ Exposure: ({ children }: { children: ReactNode }) => children }));
mock.module('@rezics/ui/hooks/use-is-mobile', () => ({ useIsMobile: () => mobile }));
const Part = ({ children }: { children: ReactNode }) => <div>{children}</div>;
mock.module('@rezics/ui/shadcn/dialog', () => ({
  Dialog: ({ children }: { children: ReactNode }) => <div data-presentation="dialog">{children}</div>,
  DialogContent: Part,
  DialogHeader: Part,
  DialogTitle: Part,
}));
mock.module('@rezics/ui/bottom-sheet', () => ({
  BottomSheet: ({ children }: { children: ReactNode }) => <div data-presentation="sheet">{children}</div>,
}));
const { createRoot } = await import('react-dom/client');
const { CopyForm } = await import('../src/library/copies-page');
const host = window.document.createElement('main') as unknown as HTMLElement;
window.document.body.append(host);
let root: ReturnType<typeof createRoot>;
const saved = mock(() => {});
const created = mock(() => {});
const removed = mock(() => {});
const closed = mock(() => {});
const keyed = mock(() => {});
const copy: CopyItem = {
  id: 'historic-copy',
  revision: 7,
  idempotencyKey: 'original-key',
  kind: 'old-kind',
  kindLabel: 'Accepted paper',
  status: 'old-status',
  statusLabel: 'Accepted kept',
  meaning: 'known',
  statusEditing: { state: 'unsupported' },
  subject: null,
  location: 'Study',
  source: 'Original shop',
  note: 'Original note',
  acquiredOn: '2020-02-29',
  disposedOn: null,
};
const profile = {
  kinds: [
    { id: 'print', label: 'Print', statuses: [{ id: 'owned', label: 'Owned' }] },
    { id: 'digital', label: 'Digital', statuses: [{ id: 'kept', label: 'Kept' }] },
  ],
};
beforeEach(() => {
  for (const fn of [create, update, remove, saved, created, removed, closed, keyed]) fn.mockClear();
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
});
afterAll(async () => {
  mock.restore();
  await window.happyDOM.close();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});
const render = (editing = true, inline = false) =>
  act(async () =>
    root.render(
      <CopyForm
        {...(editing ? { copy } : { profile, sendKind: true })}
        inline={inline}
        subjectId="edition"
        addKey="create-key"
        onClose={closed}
        onCreated={created}
        onSaved={saved}
        onRemoved={removed}
        onKey={keyed}
      />,
    ),
  );
const form = () => host.querySelector('form')!;
const control = (label: string, region: ParentNode = form()) => {
  const button = [...region.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent === label);
  expect(button).toBeDefined();
  return button!;
};
const click = (label: string, region?: ParentNode) => act(async () => control(label, region).click());
const submit = () =>
  act(async () => {
    form().dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  });
const field = (label: string) => {
  const node = [...form().querySelectorAll('label')].find((node) => node.textContent === label)!;
  return window.document.getElementById(node.htmlFor)! as unknown as HTMLInputElement;
};
async function change(label: string, value: string) {
  const input = field(label);
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    input.dispatchEvent(new window.Event('change', { bubbles: true }));
  });
}
for (const presentation of ['inline', 'sheet', 'dialog'] as const) {
  test(`${presentation}: disclosure retains exact fields, dates and historical meaning through an uncertain save`, async () => {
    mobile = presentation === 'sheet';
    await render(true, presentation === 'inline');
    expect(host.querySelector('[data-presentation]')?.getAttribute('data-presentation') ?? 'inline').toBe(presentation);
    const more = control(m.library_copy_more());
    const panel = window.document.getElementById(more.getAttribute('aria-controls')!)!;
    expect(panel.hidden).toBe(true);
    await click(m.library_copy_more());
    expect(more.getAttribute('aria-expanded')).toBe('true');
    expect(field(m.library_copy_acquired()).type).toBe('date');
    expect(field(m.library_copy_acquired()).value).toBe('2020-02-29');
    await change(m.library_copy_note(), '  Exact note 📚  ');
    await change(m.library_copy_disposed(), '2024-02-29');
    await click(m.library_copy_less());
    await click(m.library_copy_more());
    expect(field(m.library_copy_note()).value).toBe('  Exact note 📚  ');
    await submit();
    expect(form().textContent).toContain('Accepted paper');
    expect(form().textContent).toContain('Accepted kept');
    const input = update.mock.calls[0]![0];
    expect(input).toEqual({
      data: {
        id: copy.id,
        revision: 7,
        idempotencyKey: 'original-key',
        location: 'Study',
        source: 'Original shop',
        note: '  Exact note 📚  ',
        acquiredOn: '2020-02-29',
        disposedOn: '2024-02-29',
      },
      headers: { 'x-csrf-token': 'current' },
    });
    await change(m.library_copy_note(), 'A different draft');
    await submit();
    expect(update.mock.calls[1]![0]).toEqual(input);
    expect(saved).not.toHaveBeenCalled();
  });
  test(`${presentation}: named deletion confirmation focuses Cancel, Escape returns to Delete and never submits`, async () => {
    mobile = presentation === 'sheet';
    await render(true, presentation === 'inline');
    const del = control(m.library_copy_delete());
    await click(m.library_copy_delete());
    const confirmation = form().querySelector<HTMLElement>('[role="alertdialog"]')!;
    expect(window.document.getElementById(confirmation.getAttribute('aria-labelledby')!)?.textContent).toBe(
      m.library_copy_delete_question(),
    );
    expect(window.document.activeElement).toBe(control(m.library_copy_cancel(), confirmation));
    await submit();
    expect(update).not.toHaveBeenCalled();
    await act(async () =>
      confirmation.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
    );
    expect(form().querySelector('[role="alertdialog"]')).toBeNull();
    expect(window.document.activeElement).toBe(del);
    expect(closed).not.toHaveBeenCalled();
    await click(m.library_copy_delete());
    await click(m.library_copy_cancel(), form().querySelector('[role="alertdialog"]')!);
    expect(window.document.activeElement).toBe(del);
    expect(remove).not.toHaveBeenCalled();
  });
}
test('create sends the selected kind and dates once; closing retires its late success', async () => {
  let resolve!: (value: unknown) => void;
  create.mockImplementationOnce(
    () =>
      new Promise((yes) => {
        resolve = yes;
      }),
  );
  await render(false, true);
  const kind = form().querySelector('select[name="kind"]')!;
  await act(async () => {
    kind.value = 'digital';
    kind.dispatchEvent(new window.Event('change', { bubbles: true }));
  });
  await click(m.library_copy_more());
  await change(m.library_copy_acquired(), '2024-02-29');
  await submit();
  await submit();
  expect(create).toHaveBeenCalledTimes(1);
  expect(create.mock.calls[0]![0]).toEqual({
    data: {
      subjectId: 'edition',
      idempotencyKey: 'create-key',
      kind: 'digital',
      status: 'kept',
      acquiredOn: '2024-02-29',
      disposedOn: null,
      location: null,
      source: null,
      note: null,
    },
    headers: { 'x-csrf-token': 'current' },
  });
  expect(form().getAttribute('aria-busy')).toBe('true');
  await click(m.library_copy_cancel());
  await act(async () => resolve({ ok: true, copy }));
  expect(closed).toHaveBeenCalledTimes(1);
  expect(created).not.toHaveBeenCalled();
  expect(keyed).not.toHaveBeenCalled();
});
test('uncertain deletion retries the original revision and key and closing retires its result', async () => {
  await render(true, true);
  await click(m.library_copy_delete());
  await click(m.library_copy_delete_confirm());
  const first = remove.mock.calls[0]![0];
  expect(first).toEqual({
    data: { id: copy.id, revision: 7, idempotencyKey: 'original-key' },
    headers: { 'x-csrf-token': 'current' },
  });
  let resolve!: (value: unknown) => void;
  remove.mockImplementationOnce(
    () =>
      new Promise((yes) => {
        resolve = yes;
      }),
  );
  await click(m.library_copy_delete());
  await click(m.library_copy_delete_confirm());
  expect(remove.mock.calls[1]![0]).toEqual(first);
  await click(m.library_copy_cancel(), form().lastElementChild!);
  await act(async () => resolve({ ok: true, undo: { deletionId: 'undo', revision: 8 } }));
  expect(removed).not.toHaveBeenCalled();
  expect(closed).toHaveBeenCalledTimes(1);
});
