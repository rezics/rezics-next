import { afterAll, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import type { ProgressSessionView } from '../src/library/progress-reads';
import type { JournalReadResult, JournalCommandResult } from '../src/library/private-diary/occurrence-server';
const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/library/progress/exact', width: 390 });
const names = [
  'window',
  'document',
  'navigator',
  'HTMLElement',
  'HTMLInputElement',
  'HTMLTextAreaElement',
  'Element',
  'Node',
  'Document',
  'Event',
  'MouseEvent',
  'MutationObserver',
  'IS_REACT_ACT_ENVIRONMENT',
];
const previous = names.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
for (const key of names)
  Object.defineProperty(globalThis, key, {
    configurable: true,
    writable: true,
    value: key === 'window' ? window : key === 'IS_REACT_ACT_ENVIRONMENT' ? true : Reflect.get(window, key),
  });
afterAll(async () => {
  mock.restore();
  names.forEach((key, i) =>
    previous[i] ? Object.defineProperty(globalThis, key, previous[i]!) : Reflect.deleteProperty(globalThis, key),
  );
  await window.happyDOM.close();
});
let owner = 'owner';
let allowed = true;
mock.module('../src/session/query', () => ({
  useSession: () => ({ state: 'signed-in', subject: owner, csrfToken: owner + '-csrf' }),
}));
mock.module('../src/kernel/exposure', () => ({ useOperation: () => allowed }));
const journal = (sessionId: string, reflection = sessionId, revision = 3) => ({
  sessionId,
  revision,
  startDate: null,
  finishDate: { year: 2020 },
  reflection,
});
const read = mock(async ({ data }: { data: { sessionId: string } }): Promise<JournalReadResult> => ({
  kind: 'ready',
  viewer: owner,
  csrfToken: owner + '-csrf',
  journal: journal(data.sessionId),
}));
let finish!: (result: JournalCommandResult) => void;
const write = mock(
  (_input: unknown) =>
    new Promise<JournalCommandResult>((resolve) => {
      finish = resolve;
    }),
);
mock.module('../src/library/private-diary/occurrence-server', () => ({
  readOccurrenceJournal: read,
  correctOccurrenceJournal: write,
  changeOccurrenceLifecycle: mock(),
}));
const { createRoot } = await import('react-dom/client');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterContextProvider } =
  await import('@tanstack/react-router');
const { PrivateOccurrenceControls } = await import('../src/library/private-diary/occurrence-detail');
const { m } = await import('../src/paraglide/messages.js');
const { setLocale } = await import('../src/paraglide/runtime.js');
function session(id: string): ProgressSessionView {
  return {
    id,
    subjectId: 'same-subject',
    versionSubjectId: null,
    mode: 'scalar_amount',
    unit: 'page',
    total: null,
    amount: '0',
    locator: null,
    position: null,
    completedUnitCount: 0,
    state: 'completed',
    revision: 7,
    startedAt: '2020-01-01T00:00:00Z',
    completedAt: '2020-02-01T00:00:00Z',
    subject: null,
    versionSubject: null,
    changes: [],
    changesNext: null,
    units: [],
    unitsNext: null,
  };
}
async function mount() {
  owner = 'owner';
  allowed = true;
  write.mockClear();
  setLocale('en', { reload: false });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const base = createRootRoute();
  const route = createRoute({ getParentRoute: () => base, path: '/library/progress/$id' });
  const router = createRouter({
    routeTree: base.addChildren([route]),
    history: createMemoryHistory({ initialEntries: ['/library/progress/exact'] }),
  });
  await router.load();
  const show = (id = 'exact') =>
    act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <RouterContextProvider router={router}>
            <PrivateOccurrenceControls session={session(id)} isCurrent={() => true} />
          </RouterContextProvider>
        </QueryClientProvider>,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  const submit = () =>
    act(async () =>
      host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
    );
  const edit = async (value: string) =>
    act(async () => {
      const field = host.querySelector('textarea')!;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, value);
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
  return {
    host,
    show,
    submit,
    edit,
    close: async () => {
      await act(async () => root.unmount());
      client.clear();
      host.remove();
    },
  };
}

test('missing assessment stays unavailable; exact journal intent and independent progress revision survive lost acknowledgement', async () => {
  const h = await mount();
  try {
    await h.show();
    await h.show();
    expect(h.host.textContent).toContain(m.library_occurrence_assessment_unavailable());
    expect(h.host.querySelector('input[type=number]')).toBeNull();
    await h.edit('private edit');
    await h.submit();
    expect(write).toHaveBeenCalledTimes(1);
    const original = write.mock.calls[0];
    expect(original).toEqual([
      {
        data: {
          sessionId: 'exact',
          viewer: 'owner',
          csrfToken: 'owner-csrf',
          key: expect.any(String),
          body: { revision: 3, reflection: 'private edit' },
        },
      },
    ]);
    await act(async () => finish({ kind: 'acknowledged', revision: 4 }));
    expect(h.host.textContent).toContain(m.library_occurrence_acknowledged());
    const retry = [...h.host.querySelectorAll('button')].find(
      (button) => button.textContent === m.library_rich_entry_retry(),
    )!;
    await act(async () => retry.click());
    expect(write.mock.calls[1]).toEqual(original);
    await act(async () => finish({ kind: 'saved', journal: journal('exact', 'private edit', 4) }));
    expect(session('exact').revision).toBe(7);
    expect(h.host.querySelector('textarea')!.value).toBe('private edit');
  } finally {
    await h.close();
  }
});

test('same-Subject occurrence, credential and exposure replacements discard private values and delayed effects', async () => {
  const h = await mount();
  try {
    await h.show();
    await h.show();
    await h.edit('old draft');
    await h.submit();
    const oldFinish = finish;
    await h.show('second');
    await h.show('second');
    expect(h.host.querySelector('textarea')!.value).toBe('second');
    await act(async () => oldFinish({ kind: 'saved', journal: journal('exact', 'late old private value', 4) }));
    expect(h.host.textContent).not.toContain('late old private value');
    expect(h.host.querySelector('textarea')!.value).toBe('second');
    owner = 'replacement';
    await h.show('second');
    await h.show('second');
    expect(h.host.querySelector('textarea')!.value).toBe('second');
    allowed = false;
    await h.show('second');
    expect(h.host.querySelector('textarea')).toBeNull();
    expect(h.host.textContent).toContain(m.library_occurrence_unavailable());
  } finally {
    await h.close();
  }
});
