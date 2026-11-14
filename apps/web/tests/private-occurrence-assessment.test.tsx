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
  'HTMLAnchorElement',
  'Element',
  'Node',
  'Document',
  'Event',
  'MouseEvent',
  'MutationObserver',
  'ResizeObserver',
  'getComputedStyle',
  'matchMedia',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'IS_REACT_ACT_ENVIRONMENT',
];
const previous = names.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
for (const key of names)
  Object.defineProperty(globalThis, key, {
    configurable: true,
    writable: true,
    value:
      key === 'window'
        ? window
        : key === 'IS_REACT_ACT_ENVIRONMENT'
          ? true
          : ['getComputedStyle', 'matchMedia', 'requestAnimationFrame', 'cancelAnimationFrame'].includes(key)
            ? Reflect.get(window, key).bind(window)
            : Reflect.get(window, key),
  });
afterAll(async () => {
  mock.restore();
  names.forEach((key, i) =>
    previous[i] ? Object.defineProperty(globalThis, key, previous[i]!) : Reflect.deleteProperty(globalThis, key),
  );
  await window.happyDOM.close();
});
let owner = 'owner';
let credential = 'csrf';
let allowed = true;
mock.module('../src/session/query', () => ({
  useSession: () => ({ state: 'signed-in', subject: owner, csrfToken: owner + '-' + credential }),
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
  csrfToken: owner + '-' + credential,
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
  credential = 'csrf';
  allowed = true;
  write.mockClear();
  setLocale('en', { reload: false });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const base = createRootRoute();
  const route = createRoute({ getParentRoute: () => base, path: '/library/progress/$id' });
  const history = createRoute({ getParentRoute: () => base, path: '/library/history' });
  const router = createRouter({
    routeTree: base.addChildren([route, history]),
    history: createMemoryHistory({ initialEntries: ['/library/progress/exact'] }),
  });
  await router.load();
  const click = (label: string) =>
    act(async () => {
      [...document.querySelectorAll('button')].find((button) => button.textContent === label)!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  const show = async (id = 'exact', openEditor = true, lifetime?: object) => {
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <RouterContextProvider router={router}>
            <PrivateOccurrenceControls session={session(id)} isCurrent={() => true} lifetime={lifetime} />
          </RouterContextProvider>
        </QueryClientProvider>,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    if (
      openEditor &&
      [...host.querySelectorAll('button')].some((button) => button.textContent === m.library_journal_edit_entry())
    )
      await click(m.library_journal_edit_entry());
  };
  const review = () =>
    act(async () => {
      host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
  const submit = async () => {
    await review();
    const save = [...host.querySelectorAll('button')].find(
      (button) => button.textContent === m.library_occurrence_save(),
    );
    if (save && !save.disabled) await click(m.library_occurrence_save());
  };
  const edit = async (value: string) =>
    act(async () => {
      const field = host.querySelector('textarea')!;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, value);
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
  return {
    host,
    router,
    depart: () =>
      act(async () => {
        void router.navigate({ href: '/library/history' });
        await new Promise((resolve) => setTimeout(resolve, 0));
      }),
    unload: () => {
      const event = new window.Event('beforeunload', { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    },
    show,
    submit,
    review,
    click,
    edit,
    assess: (value: string) =>
      act(async () => {
        const field = host.querySelector('input[inputmode="decimal"]')!;
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value);
        field.dispatchEvent(new Event('input', { bubbles: true }));
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
    expect(h.host.querySelector<HTMLInputElement>('input[inputmode="decimal"]')!.value).toBe('');
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
    expect(h.host.querySelector('textarea')!.disabled).toBe(false);
    await h.edit('later local edit');
    await act(async () => finish({ kind: 'acknowledged', revision: 4 }));
    expect(h.host.textContent).toContain(m.library_occurrence_acknowledged());
    await h.depart();
    expect(document.querySelector('[role="alertdialog"]')!.textContent).toContain(
      m.library_journal_draft_navigation_acknowledged(),
    );
    await h.click(m.library_progress_draft_navigation_stay());
    const retry = [...h.host.querySelectorAll('button')].find(
      (button) => button.textContent === m.library_rich_entry_retry(),
    )!;
    await act(async () => retry.click());
    expect(write.mock.calls[1]).toEqual(original);
    await act(async () => finish({ kind: 'saved', journal: journal('exact', 'private edit', 4) }));
    expect(session('exact').revision).toBe(7);
    expect(h.host.querySelector('[aria-label="' + m.library_journal_current_value() + '"]')!.textContent).toContain(
      'private edit',
    );
    expect(h.host.querySelector('textarea')!.value).toBe('later local edit');
    expect(h.unload()).toBe(true);
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
    await h.depart();
    expect(document.querySelector('[role="alertdialog"]')!.textContent).toContain(
      m.library_journal_draft_navigation_pending(),
    );
    await h.show('second');
    await h.show('second');
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(h.router.state.location.pathname).toBe('/library/progress/exact');
    expect(h.host.querySelector('textarea')!.value).toBe('second');
    await act(async () => oldFinish({ kind: 'saved', journal: journal('exact', 'late old private value', 4) }));
    expect(h.host.textContent).not.toContain('late old private value');
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
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
    expect(h.host.querySelector<HTMLInputElement>('input[inputmode="decimal"]')!.value).toBe('0');
    await h.click(m.library_occurrence_clear_assessment());
    await h.submit();
    expect(write.mock.calls[1]).toMatchObject([{ data: { body: { revision: 4, assessment: null } } }]);
    await act(async () => finish({ kind: 'saved', journal: journal('exact', 'keep unrelated draft', 5) }));
    expect(h.unload()).toBe(false);
    await h.show('second');
    await h.show('second');
    expect(h.host.querySelector<HTMLInputElement>('input[inputmode="decimal"]')!.value).toBe('6.5');
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
    await h.click(m.library_occurrence_read_current());
    expect(h.host.querySelector('textarea')!.value).toBe('fresh reflection');
    expect(h.host.querySelector<HTMLInputElement>('input[inputmode="decimal"]')!.value).toBe('8.5');
    await h.submit();
    expect(write).toHaveBeenCalledTimes(1);
    await h.click(m.library_occurrence_review_latest());
    await h.submit();
    expect(write.mock.calls[1]).toMatchObject([{ data: { body: { revision: 4, assessment: { units: 17 } } } }]);
    expect(write.mock.calls[1]![0].data.body).toEqual({ revision: 4, assessment: { units: 17 } });
    await h.depart();
    await act(async () => finish({ kind: 'missing' }));
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(h.host.querySelector('input[inputmode="decimal"]')).toBeNull();
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
    expect(h.host.querySelector('input[inputmode="decimal"]')).toBeNull();
  } finally {
    await h.close();
  }
});

test('journal opens as private reading and explicit cancel discards only the unsent draft', async () => {
  const h = await mount();
  try {
    await h.show('exact', false);
    await h.show('exact', false);
    expect(h.host.querySelector('textarea')).toBeNull();
    expect(h.host.textContent).toContain('exact');
    await h.click(m.library_journal_edit_entry());
    expect(document.activeElement).toBe(h.host.querySelector('textarea'));
    await h.edit('私人感想\nA long second paragraph. <em>literal</em>');
    await h.review();
    expect(write).toHaveBeenCalledTimes(0);
    expect(h.host.textContent).toContain(m.library_journal_original_value());
    expect(h.host.querySelector('em')).toBeNull();
    await h.click(m.library_journal_correct_draft());
    expect(h.host.querySelector('textarea')!.value).toBe('私人感想\nA long second paragraph. <em>literal</em>');
    await h.review();
    await h.click(m.library_progress_cancel());
    expect(h.host.querySelector('form')).toBeNull();
    expect(h.host.textContent).not.toContain('A long second paragraph.');
    expect(document.activeElement?.textContent).toBe(m.library_journal_edit_entry());
    await h.click(m.library_journal_edit_entry());
    expect(h.host.querySelector('textarea')!.value).toBe('exact');
    expect(h.unload()).toBe(false);
    expect(write).toHaveBeenCalledTimes(0);
  } finally {
    await h.close();
  }
});

test('a fresh read cannot replace the original comparison or exact retry after an uncertain save', async () => {
  const h = await mount();
  try {
    await h.show();
    await h.show();
    await h.edit('提案した感想\nProposed private note');
    await h.submit();
    const original = write.mock.calls[0];
    await act(async () => finish({ kind: 'uncertain' }));
    read.mockImplementationOnce(async () => ({
      kind: 'ready',
      viewer: owner,
      csrfToken: owner + '-csrf',
      journal: journal('exact', 'CURRENT OTHER DEVICE VALUE', 4),
    }));
    await h.click(m.library_occurrence_read_current());
    const comparison = h.host.querySelector('[aria-label="' + m.library_journal_review() + '"]')!;
    expect(comparison.textContent).toContain(m.library_journal_review_basis({ revision: 3 }));
    expect(comparison.textContent).toContain('Proposed private note');
    expect(comparison.textContent).not.toContain('CURRENT OTHER DEVICE VALUE');
    expect(h.host.querySelector('[aria-label="' + m.library_journal_current_value() + '"]')!.textContent).toContain(
      'CURRENT OTHER DEVICE VALUE',
    );
    expect(
      [...h.host.querySelectorAll('button')].some((button) => button.textContent === m.library_progress_cancel()),
    ).toBe(false);
    await h.depart();
    expect(document.querySelector('[role="alertdialog"]')!.textContent).toContain(
      m.library_journal_draft_navigation_uncertain(),
    );
    await h.click(m.library_progress_draft_navigation_stay());
    await h.click(m.library_rich_entry_retry());
    expect(write.mock.calls[1]).toEqual(original);
    await act(async () => finish({ kind: 'saved', journal: journal('exact', 'Proposed private note', 4) }));
    expect(session('exact').revision).toBe(7);
    expect(h.unload()).toBe(false);
    await h.depart();
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(h.router.state.location.pathname).toBe('/library/history');
  } finally {
    await h.close();
  }
});

test('credential and reader-source replacements close the old decision and discard only unsent fields', async () => {
  const h = await mount();
  try {
    let lifetime = {};
    await h.show('exact', true, lifetime);
    await h.show('exact', true, lifetime);
    for (const change of ['credential', 'source', 'account'] as const) {
      await h.edit('private draft from ' + change);
      await h.depart();
      expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
      if (change === 'credential') credential = 'renewed-csrf';
      else if (change === 'source') lifetime = {};
      else owner = 'another-account';
      await h.show('exact', true, lifetime);
      await h.show('exact', true, lifetime);
      expect(document.querySelector('[role="alertdialog"]')).toBeNull();
      expect(h.host.querySelector('textarea')!.value).toBe('exact');
      expect(h.unload()).toBe(false);
      expect(write).toHaveBeenCalledTimes(0);
    }
  } finally {
    await h.close();
  }
});
