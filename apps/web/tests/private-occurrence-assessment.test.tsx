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
const journal = (sessionId: string, reflection = sessionId, revision = 3, units: number | null = null) => ({
  sessionId,
  revision,
  startDate: null,
  finishDate: { year: 2020 },
  reflection,
  assessment: { meaningRevision: 1 as const, units },
});
const read = mock(async ({ data }: { data: { sessionId: string } }): Promise<JournalReadResult> => ({
  kind: 'ready',
  viewer: owner,
  csrfToken: owner + '-csrf',
  journal: journal(data.sessionId, data.sessionId, 3, data.sessionId === 'second' ? 13 : null),
}));
let finish!: (result: JournalCommandResult) => void;
const write = mock(
  (_input: Parameters<typeof import('../src/library/private-diary/occurrence-server').correctOccurrenceJournal>[0]) =>
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
    assess: (value: string) =>
      act(async () => {
        const field = host.querySelector('input[type=number]')!;
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value);
        field.dispatchEvent(new Event('input', { bubbles: true }));
      }),
    click: (label: string) =>
      act(async () => {
        [...host.querySelectorAll('button')].find((button) => button.textContent === label)!.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      }),
    close: async () => {
      await act(async () => root.unmount());
      client.clear();
      host.remove();
    },
  };
}

test('assessment omission preserves absence; exact journal intent and independent progress revision survive lost acknowledgement', async () => {
  const h = await mount();
  try {
    await h.show();
    await h.show();
    expect(h.host.querySelector<HTMLInputElement>('input[type=number]')!.value).toBe('');
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

test('selected occurrence sets zero, explicitly clears, and keeps independent repeat values', async () => {
  const h = await mount();
  try {
    await h.show();
    await h.show();
    await h.assess('0');
    await h.edit('keep unrelated draft');
    await h.submit();
    expect(write.mock.calls[0]).toMatchObject([
      {
        data: {
          sessionId: 'exact',
          body: {
            revision: 3,
            assessment: { units: 0 },
            reflection: 'keep unrelated draft',
          },
        },
      },
    ]);
    await act(async () => finish({ kind: 'saved', journal: journal('exact', 'keep unrelated draft', 4, 0) }));
    expect(h.host.querySelector<HTMLInputElement>('input[type=number]')!.value).toBe('0');
    await h.click(m.library_occurrence_clear_assessment());
    await h.submit();
    expect(write.mock.calls[1]).toMatchObject([{ data: { body: { revision: 4, assessment: null } } }]);
    await act(async () => finish({ kind: 'saved', journal: journal('exact', 'keep unrelated draft', 5) }));
    await h.show('second');
    await h.show('second');
    expect(h.host.querySelector<HTMLInputElement>('input[type=number]')!.value).toBe('6.5');
    expect(session('second').revision).toBe(7);
  } finally {
    await h.close();
  }
});

test('stale journal review retains edited fields while adopting unrelated fresh values', async () => {
  const h = await mount();
  try {
    await h.show();
    await h.show();
    await h.assess('8.5');
    await h.submit();
    read.mockImplementationOnce(async () => ({
      kind: 'ready',
      viewer: owner,
      csrfToken: owner + '-csrf',
      journal: { ...journal('exact', 'fresh reflection', 4), finishDate: { year: 2021 } },
    }));
    await act(async () => {
      finish({ kind: 'conflict' });
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(h.host.querySelector('textarea')!.value).toBe('fresh reflection');
    expect(h.host.querySelector<HTMLInputElement>('input[type=number]')!.value).toBe('8.5');
    await h.submit();
    expect(write).toHaveBeenCalledTimes(1);
    await h.click(m.library_occurrence_review_latest());
    await h.submit();
    expect(write.mock.calls[1]).toMatchObject([{ data: { body: { revision: 4, assessment: { units: 17 } } } }]);
    expect(write.mock.calls[1]![0].data.body).toEqual({ revision: 4, assessment: { units: 17 } });
    await act(async () => finish({ kind: 'missing' }));
    expect(h.host.querySelector('input[type=number]')).toBeNull();
  } finally {
    await h.close();
  }
});

test('matching independent readback leaves an uncertain assessment bound to its original retry', async () => {
  const h = await mount();
  try {
    await h.show();
    await h.show();
    await h.assess('10');
    await h.submit();
    const original = write.mock.calls[0];
    await act(async () => finish({ kind: 'uncertain' }));
    read.mockImplementationOnce(async () => ({
      kind: 'ready',
      viewer: owner,
      csrfToken: owner + '-csrf',
      journal: journal('exact', 'exact', 4, 20),
    }));
    await h.click(m.library_occurrence_read_current());
    expect(h.host.textContent).toContain(m.library_occurrence_observed({ revision: 4, assessment: '10' }));
    await h.submit();
    expect(write).toHaveBeenCalledTimes(1);
    await h.click(m.library_rich_entry_retry());
    expect(write.mock.calls[1]).toEqual(original);
    await act(async () => finish({ kind: 'retired' }));
    expect(h.host.querySelector('input[type=number]')).toBeNull();
  } finally {
    await h.close();
  }
});
