import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement, forwardRef, useState, type ReactNode } from 'react';
import type { CopyItem } from '../src/library/copies-read';
import { m } from '../src/paraglide/messages.js';

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/library/copies', width: 390, height: 844 });
const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  HTMLInputElement: window.HTMLInputElement,
  Element: window.Element,
  Node: window.Node,
  MutationObserver: window.MutationObserver,
  ResizeObserver: window.ResizeObserver,
  getComputedStyle: window.getComputedStyle.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

const create = mock(async (_input: unknown): Promise<unknown> => ({ ok: false, reason: 'unavailable' }));
const update = mock(async (_input: unknown): Promise<unknown> => ({ ok: false, reason: 'unavailable' }));
const deletion = mock(async (_input: unknown): Promise<unknown> => ({ ok: false, reason: 'unavailable' }));
const detail = mock(async (_id: string): Promise<any> => ({ ok: false, reason: 'unavailable' }));
mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('../src/library/copies-actions', () => ({
  createCopy: create,
  updateCopy: update,
  deleteCopy: deletion,
  readCopyDetail() {},
  readCopySubject() {},
  undoCopy() {},
}));
mock.module('../src/threads/composer', () => ({ csrfHeaders: () => ({ 'x-csrf-token': 'current' }) }));
mock.module('../src/kernel/exposure', () => ({ Exposure: ({ children }: { children: ReactNode }) => children }));
mock.module('@rezics/ui/hooks/use-is-mobile', () => ({ useIsMobile: () => false }));
const Part = ({ children }: { children: ReactNode }) => <div>{children}</div>;
const DialogContent = forwardRef<HTMLDivElement, { children: ReactNode }>(({ children }, ref) => (
  <div ref={ref} role="alertdialog">
    {children}
  </div>
));
const DialogButton = forwardRef<HTMLButtonElement, { children: ReactNode; onClick?: () => void }>(
  ({ children, onClick }, ref) => (
    <button ref={ref} type="button" onClick={onClick}>
      {children}
    </button>
  ),
);
mock.module('@rezics/ui/shadcn/alert-dialog', () => ({
  AlertDialog: ({ children, open }: { children: ReactNode; open: boolean }) => (open ? <div>{children}</div> : null),
  AlertDialogAction: DialogButton,
  AlertDialogCancel: DialogButton,
  AlertDialogContent: DialogContent,
  AlertDialogDescription: Part,
  AlertDialogFooter: Part,
  AlertDialogHeader: Part,
  AlertDialogTitle: Part,
}));

const { CopyForm } = await import('../src/library/copies-page');
const { createRoot } = await import('react-dom/client');
const { createMemoryHistory, createRootRoute, createRoute, createRouter, Link, Outlet, RouterProvider } =
  await import('@tanstack/react-router');
const host = window.document.createElement('main') as unknown as HTMLElement;
window.document.body.append(host);
let root: ReturnType<typeof createRoot>;
let router: ReturnType<typeof createRouter>;
const created = mock(() => {});
const saved = mock(() => {});
const closed = mock(() => {});
const paragraphs = `${'📚'.repeat(995)}\n\nend`;
const copy: CopyItem = {
  id: 'copy-1',
  revision: 7,
  idempotencyKey: 'original-key',
  kind: 'print',
  kindLabel: 'Print',
  status: 'owned',
  statusLabel: 'Owned',
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
const originating = {
  isCurrent: () => true,
  headers: () => ({ 'x-csrf-token': 'current' }),
  readDetail: detail,
  readSubject: async () => ({ state: 'unavailable' as const }),
};

function mount(mode: 'create' | 'edit' | 'picker') {
  function CopiesRoute() {
    const [open, setOpen] = useState(true);
    return (
      <>
        {open && (
          <CopyForm
            {...(mode === 'edit' ? { copy } : { profile: mode === 'picker' ? undefined : profile, sendKind: true })}
            inline
            subjectId={mode === 'picker' ? null : 'edition'}
            addKey="create-key"
            originating={originating}
            onClose={() => {
              closed();
              setOpen(false);
            }}
            onCreated={created}
            onSaved={saved}
            onRemoved={() => {}}
            onKey={() => {}}
          />
        )}
        <Link to="/next">Next page</Link>
      </>
    );
  }
  const rootRoute = createRootRoute({ component: Outlet });
  const copiesRoute = createRoute({ getParentRoute: () => rootRoute, path: '/copies', component: CopiesRoute });
  const nextRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/next',
    component: () => <h1>Next page</h1>,
  });
  router = createRouter({
    routeTree: rootRoute.addChildren([copiesRoute, nextRoute]),
    history: createMemoryHistory({ initialEntries: ['/copies'] }),
  });
  root = createRoot(host);
  return act(async () => {
    await router.load();
    root.render(createElement(RouterProvider, { router }));
  });
}

afterEach(async () => {
  await act(async () => root?.unmount());
  router?.dispose();
  host.replaceChildren();
});
afterAll(async () => {
  mock.restore();
  await window.happyDOM.close();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});
beforeEach(() => {
  for (const fn of [create, update, deletion, detail, created, saved, closed]) fn.mockClear();
});

const form = () => host.querySelector('form')!;
const button = (label: string, region: ParentNode = host) => {
  const match = [...region.querySelectorAll('button')].find((item) => item.textContent?.trim() === label);
  expect(match).toBeDefined();
  return match!;
};
const click = (label: string, region?: ParentNode) => act(async () => button(label, region).click());
const field = (label: string) => {
  const node = [...form().querySelectorAll('label')].find((item) => item.textContent === label)!;
  return window.document.getElementById(node.htmlFor)! as HTMLInputElement;
};
const select = (label: string) => field(label) as unknown as HTMLSelectElement;
async function changeInput(label: string, value: string) {
  const input = field(label);
  await act(async () => {
    Object.getOwnPropertyDescriptor(input.constructor.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    input.dispatchEvent(new window.Event('change', { bubbles: true }));
  });
}
async function choose(label: string, value: string) {
  const control = select(label);
  await act(async () => {
    Object.getOwnPropertyDescriptor(control.constructor.prototype, 'value')!.set!.call(control, value);
    control.dispatchEvent(new window.Event('change', { bubbles: true }));
  });
}
const nextLink = () => host.querySelector<HTMLAnchorElement>('a[href="/next"]')!;
const beforeUnloadIsBlocked = () => {
  const event = new window.Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
};

test('create drafts compare exact fields and kind, and offer Stay or Discard on close and navigation', async () => {
  await mount('create');
  expect(beforeUnloadIsBlocked()).toBe(false);
  await click(m.library_copy_more());
  expect(field(m.library_copy_note()).tagName).toBe('TEXTAREA');
  await changeInput(m.library_copy_note(), '\n');
  expect(beforeUnloadIsBlocked()).toBe(true);
  await changeInput(m.library_copy_note(), '');
  expect(beforeUnloadIsBlocked()).toBe(false);
  await choose(m.library_copy_kind(), 'digital');
  await changeInput(m.library_copy_note(), paragraphs);
  expect(select(m.library_copy_status()).value).toBe('kept');
  expect(beforeUnloadIsBlocked()).toBe(true);
  await click(m.library_copy_cancel());
  expect(host.querySelector('[role="alertdialog"]')?.textContent).toContain(m.library_copy_draft_navigation_title());
  await click(m.library_copy_draft_navigation_stay());
  expect(field(m.library_copy_note()).value).toBe(paragraphs);
  expect(select(m.library_copy_kind()).value).toBe('digital');
  expect(select(m.library_copy_status()).value).toBe('kept');
  create.mockResolvedValueOnce({ ok: false, reason: 'unsupported' });
  await act(async () => form().dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
  expect((create.mock.calls[0]![0] as { data: { note: string } }).data.note).toBe(paragraphs);
  expect(field(m.library_copy_note()).value).toBe(paragraphs);
  await act(async () => nextLink().click());
  expect(host.querySelector('[role="alertdialog"]')).not.toBeNull();
  await click(m.library_copy_draft_navigation_discard());
  expect(host.querySelector('h1')?.textContent).toBe('Next page');
  expect(create).toHaveBeenCalledTimes(1);
  expect(update).not.toHaveBeenCalled();
});

test('searching for an edition alone does not warn or require a discard decision', async () => {
  await mount('picker');
  const search = host.querySelector<HTMLInputElement>(`input[aria-label="${m.library_copy_edition()}"]`)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(search, 'search only');
    search.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  expect(beforeUnloadIsBlocked()).toBe(false);
  await click(m.library_copy_cancel());
  expect(host.querySelector('[role="alertdialog"]')).toBeNull();
  expect(closed).toHaveBeenCalledTimes(1);
});

test('pending and uncertain updates keep their exact intent until resolution', async () => {
  await mount('edit');
  let finishFirst!: (result: unknown) => void;
  let finishRetry!: (result: unknown) => void;
  const first = new Promise<unknown>((resolve) => {
    finishFirst = resolve;
  });
  const retry = new Promise<unknown>((resolve) => {
    finishRetry = resolve;
  });
  update.mockImplementationOnce(() => first).mockImplementationOnce(() => retry);
  await click(m.library_copy_more());
  await changeInput(m.library_copy_note(), paragraphs);
  await act(async () => form().dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
  expect(beforeUnloadIsBlocked()).toBe(true);
  await click(m.library_copy_cancel());
  expect(host.querySelector('[role="alertdialog"]')?.textContent).toContain(m.library_copy_draft_navigation_pending());
  expect(host.querySelector(`[role="alertdialog"] button`)?.textContent).toBe(m.library_copy_draft_navigation_stay());
  await click(m.library_copy_draft_navigation_stay());
  await act(async () => {
    finishFirst({ ok: false, reason: 'unavailable' });
    await first;
  });
  expect(field(m.library_copy_note()).value).toBe(paragraphs);
  expect(beforeUnloadIsBlocked()).toBe(true);
  await act(async () => nextLink().click());
  expect(host.querySelector('[role="alertdialog"]')?.textContent).toContain(m.library_copy_draft_navigation_pending());
  await click(m.library_copy_draft_navigation_stay());
  await act(async () => form().dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
  expect(update).toHaveBeenCalledTimes(2);
  expect((update.mock.calls[0]![0] as { data: { note: string } }).data.note).toBe(paragraphs);
  expect(update.mock.calls[1]![0]).toEqual(update.mock.calls[0]![0]);
  expect(new Headers((update.mock.calls[1]![0] as { headers: HeadersInit }).headers).get('x-csrf-token')).toBe(
    'current',
  );
  await act(async () => {
    finishRetry({ ok: true, copy: { ...copy, revision: 8, note: paragraphs } });
    await retry;
  });
  expect(saved).toHaveBeenCalledTimes(1);
  expect(host.querySelector('form')).toBeNull();
  expect(beforeUnloadIsBlocked()).toBe(false);
});

for (const operation of ['update', 'delete'] as const) {
  test(`${operation} conflict reviews without writing, protects the draft once and requires a separate new command`, async () => {
    await mount('edit');
    const send = operation === 'update' ? update : deletion;
    const command = async () => {
      if (operation === 'delete') {
        await click(m.library_copy_delete());
        await click(m.library_copy_delete_confirm());
      } else await click(m.library_copy_save());
    };
    await click(m.library_copy_more());
    await changeInput(m.library_copy_note(), 'My draft');
    send.mockResolvedValueOnce({ ok: false, reason: 'conflict' });
    await command();
    const refused = send.mock.calls[0]![0];
    await click(m.library_copy_save());
    expect(send).toHaveBeenCalledTimes(1);
    const current = { ...copy, revision: 10, note: 'Current note', status: 'historic', statusLabel: 'Stored status' };
    detail.mockResolvedValueOnce({ ok: true, copy: current });
    await click(m.library_copy_conflict_review_open());
    expect(detail).toHaveBeenCalledWith(copy.id);
    expect(send).toHaveBeenCalledTimes(1);
    expect(field(m.library_copy_note()).value).toBe('My draft');
    expect(host.textContent).toContain('Current note');
    expect(host.textContent).toContain('Stored status');
    await click(m.library_copy_conflict_review_accept());
    expect(host.querySelectorAll('[role="alertdialog"]')).toHaveLength(1);
    await click(m.library_copy_draft_navigation_stay());
    expect(field(m.library_copy_note()).value).toBe('My draft');
    await click(m.library_copy_conflict_review_accept());
    await click(m.library_copy_draft_navigation_discard());
    expect(closed).not.toHaveBeenCalled();
    expect(field(m.library_copy_note()).value).toBe('Current note');
    expect(beforeUnloadIsBlocked()).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
    await command();
    const next = send.mock.calls[1]![0] as { data: { revision: number; idempotencyKey: string } };
    expect(next.data.revision).toBe(10);
    expect(next.data.idempotencyKey).not.toBe((refused as typeof next).data.idempotencyKey);
    expect(saved).not.toHaveBeenCalled();
  });
}

test('conflict review retries failed reads and conceals deletion/denial without offering acceptance', async () => {
  await mount('edit');
  update.mockResolvedValueOnce({ ok: false, reason: 'conflict' });
  await click(m.library_copy_save());
  for (const result of [
    { ok: false, reason: 'unavailable' },
    { ok: true, copy: { ...copy, id: 'other-copy' } },
    { ok: false, reason: 'forbidden' },
  ]) {
    detail.mockResolvedValueOnce(result);
    await click(m.library_copy_conflict_review_open());
    expect(host.textContent).toContain(result.reason === 'forbidden'
      ? m.library_copy_detail_forbidden() : m.library_copy_detail_unavailable());
    expect([...host.querySelectorAll('button')].some(b => b.textContent === m.library_copy_conflict_review_accept())).toBe(false);
    expect(form().dataset.idempotencyKey).toBe(copy.idempotencyKey);
  }
  expect(update).toHaveBeenCalledTimes(1);
});

test('an uncertain update cannot enter conflict review and retries its original command after draft edits', async () => {
  await mount('edit');
  await click(m.library_copy_save());
  expect([...host.querySelectorAll('button')].some(b => b.textContent === m.library_copy_conflict_review_open())).toBe(false);
  await click(m.library_copy_more());
  await changeInput(m.library_copy_note(), 'Changed after lost response');
  await click(m.library_copy_save());
  expect(update.mock.calls[1]![0]).toEqual(update.mock.calls[0]![0]);
  expect(detail).not.toHaveBeenCalled();
});

test('read-only conflict review works without command headers and ignores a response after editor closure', async () => {
  await mount('edit');
  update.mockResolvedValueOnce({ ok: false, reason: 'conflict' });
  await click(m.library_copy_save());
  let finish!: (result: unknown) => void;
  detail.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const headers = originating.headers;
  originating.headers = () => null as unknown as ReturnType<typeof headers>;
  try {
    await click(m.library_copy_conflict_review_open());
    expect(detail).toHaveBeenCalledTimes(1);
    await click(m.library_copy_cancel());
    await act(async () => finish({ ok: true, copy: { ...copy, note: 'Late current data' } }));
    expect(host.querySelector('form')).toBeNull();
    expect(host.textContent).not.toContain('Late current data');
    expect(saved).not.toHaveBeenCalled();
  } finally { originating.headers = headers; }
});
