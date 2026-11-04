import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import type { LibraryProfile } from '@rezics/definitions';
import type { NativeProgressPresentation, NativeProgressSession } from '../src/library/progress-reads';
import type { Release } from '../src/subject/definitions';
import type { ProgressSessionJournal } from '@rezics/progress';
import type { JournalCommandResult } from '../src/library/private-diary/occurrence-server';

test('Record and correct exact progress and a selected-field journal with retained retry after reader retirement', async () => {
  // Use the installed editor's DOM dependency; no browser, server or native authority is simulated here.
  const editorRequire = createRequire(import.meta.resolve('@puckeditor/core'));
  const { Window } = await import(editorRequire.resolve('happy-dom'));
  const window = new Window({ url: 'https://web.test/en/library/progress' });
  const previous = new Map<string, PropertyDescriptor | undefined>();
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement,
    HTMLTextAreaElement: window.HTMLTextAreaElement,
    Document: window.Document,
    Element: window.Element,
    Node: window.Node,
    DocumentFragment: window.DocumentFragment,
    MutationObserver: window.MutationObserver,
    ResizeObserver: window.ResizeObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    scrollTo: window.scrollTo.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [key, value] of Object.entries(globals)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  window.document.documentElement.lang = 'en';
  window.innerWidth = 1280;

  const id = '0192f3a0-6c1e-7b2a-9d4e-000000000801';
  const profile: LibraryProfile = {
    id: 'measured-journey',
    importSources: [],
    progress: {
      allowed: [
        {
          mode: 'scalar_amount',
          units: [
            {
              id: 'segment-x',
              labels: { en: 'segment' },
              countForms: { en: { one: 'segment', other: 'segments' } },
              minimum: '0',
              maximum: '98.5',
              precision: 2,
              totalPolicy: 'optional',
              identity: { kind: 'none' },
              structure: { kind: 'none' },
            },
          ],
        },
      ],
    },
  };
  const release: Release = {
    types: { Journey: { library: { profileId: profile.id } } },
    properties: {},
    libraryProfiles: { [profile.id]: profile },
  };
  let request = new Request(window.location.href);
  const csrf: string[] = [];
  const writes: { body: unknown; authorization: string | null; key: string | null }[] = [];
  let session: NativeProgressSession;

  const { createKernelClient } = await import('@rezics/client');
  const client = createKernelClient('https://kernel.test', {
    fetch: (async (input, init) => {
      const req = new Request(input, init);
      const url = new URL(req.url);
      if (req.method === 'POST' && url.pathname === `/v1/progressSessions/${id}:record`) {
        const body = (await req.json()) as { revision: number; amount: string };
        writes.push({ body, authorization: req.headers.get('authorization'), key: req.headers.get('idempotency-key') });
        // Supplied transport response, matching the producer's replacement operation.
        session = { ...session, amount: body.amount, revision: session.revision + 1 };
        return Response.json({ progressSession: session });
      }
      if (req.method === 'GET' && url.pathname === `/v1/progressSessions/${id}`) {
        expect(url.searchParams.get('presentation')).toBe('FULL');
        return Response.json({ progressSession: session });
      }
      if (req.method === 'GET' && url.pathname === `/v1/progressSessions/${id}/changes`)
        return Response.json({ changes: [], next: null });
      if (req.method === 'GET' && url.pathname === `/v1/progressSessions/${id}/completedUnits`)
        return Response.json({ completedUnits: [], next: null });
      throw new Error(`Unexpected recording request: ${req.method} ${url.pathname}`);
    }) as typeof fetch,
  });

  // Adapt Start's request boundary only. The page, server validators, reads, record command,
  // query/session/exposure, CSRF helper, router and responsive primitives are the default composition.
  const start = await import('../.storybook/react-start');
  mock.module('@tanstack/react-start', () => ({
    ...start,
    createServerFn: () => {
      let validate = (value: unknown) => value;
      const builder = {
        validator(next: typeof validate) {
          validate = next;
          return builder;
        },
        handler(handler: (input: { data: unknown }) => unknown) {
          return (input?: { data?: unknown; headers?: HeadersInit }) => {
            request = new Request(window.location.href, { headers: input?.headers });
            if (input?.headers) csrf.push(request.headers.get('x-csrf-token') ?? '');
            return handler({ data: validate(input?.data) });
          };
        },
      };
      return builder;
    },
  }));
  mock.module('@tanstack/react-start/server', () => ({ getRequest: () => request, setResponseHeader: () => {} }));
  mock.module('cloudflare:workers', () => ({ env: {} }));
  mock.module('../src/session/request', () => ({
    prepareSession: async () => {},
    viewerCredential: () => 'Bearer recording-owner',
    sessionSubject: () => 'owner',
    requestCsrfToken: () => 'recording-csrf',
  }));
  const kernel = await import('../src/kernel/client');
  mock.module('../src/kernel/client', () => ({ ...kernel, kernelClient: () => client, requestLocale: () => 'en' }));
  const definitions = await import('../src/subject/definitions');
  mock.module('../src/subject/definitions', () => ({
    ...definitions,
    readRelease: async () => release,
    nameSubjectTypes: async () => {},
  }));

  const { progressSessionProfile } = await import('../src/library/progress-profile');
  const supplied = progressSessionProfile(release, 'Journey', 'scalar_amount', 'segment-x', 'en');
  const presentation: NativeProgressPresentation = {
    meaning: 'known',
    structure: 'unverified',
    unitLabel: supplied.unitLabel,
    unitLabelLanguage: supplied.unitLabelLanguage,
    unitCountForms: supplied.unitCountForms,
    recording: { state: 'supported', inputRules: supplied.inputRules! },
  };
  session = {
    id,
    subjectId: id,
    versionSubjectId: null,
    mode: 'scalar_amount',
    unit: 'segment-x',
    amount: '2.5',
    total: null,
    locator: null,
    position: null,
    completedUnitCount: 0,
    state: 'active',
    revision: 1,
    startedAt: '2026-10-29T00:00:00.000Z',
    completedAt: null,
    subject: { id, type: 'Journey', types: ['Journey'], label: 'A journey through the mountains', cover: null },
    versionSubject: null,
    presentation,
  };

  let journal: ProgressSessionJournal = {
    sessionId: id,
    revision: 0,
    startDate: { year: 2024 },
    finishDate: null,
    reflection: 'Original private reflection',
    assessment: { meaningRevision: 1, units: 0 },
  };
  type JournalCommand = {
    sessionId: string;
    viewer: string;
    csrfToken: string;
    key: string;
    body: {
      revision: number;
      finishDate?: { year: number; month?: number; day?: number } | null;
      reflection?: string | null;
    };
  };
  const journalWrites: JournalCommand[] = [];
  let resolveJournal: ((result: JournalCommandResult) => void) | undefined;
  let refuse = false;
  mock.module('../src/library/private-diary/occurrence-server', () => ({
    readOccurrenceJournal: async () => ({ kind: 'ready', viewer: 'owner', csrfToken: 'recording-csrf', journal }),
    correctOccurrenceJournal: async ({ data }: { data: JournalCommand }): Promise<JournalCommandResult> => {
      journalWrites.push(data);
      if (refuse) return { kind: 'conflict' };
      if (journalWrites.length === 1)
        return new Promise((resolve) => {
          resolveJournal = resolve;
        });
      return { kind: 'saved', journal };
    },
    changeOccurrenceLifecycle: async () => ({ kind: 'uncertain' }),
  }));
  const { createElement: h, act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { createMemoryHistory, createRootRoute, createRouter, RouterProvider } = await import('@tanstack/react-router');
  const { ProgressSessionPage } = await import('../src/library/progress-session');
  const { readProgressSession } = await import('../src/library/progress-server');
  const { m } = await import('../src/paraglide/messages.js');
  const { setLocale } = await import('../src/paraglide/runtime.js');
  setLocale('en', { reload: false });
  const page = await readProgressSession({ data: { id } });
  const queries = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  queries.setQueryData(['session'], { state: 'signed-in', csrfToken: 'recording-csrf', subject: 'owner' });
  const { viewerExposureLifetime, viewerExposureQuery } = await import('../src/kernel/viewer-exposure');
  const observation = viewerExposureLifetime(queries);
  const stopObservation = observation.subscribe(() => {});
  const admit = () => {
    const current = observation.getSnapshot();
    if (current.state !== 'signed-in') throw new Error('Expected prepared recording viewer');
    queries.setQueryData(viewerExposureQuery(current.observation).queryKey, {
      subject: 'owner',
      admitted: ['reading_progress'],
    });
  };
  admit();
  queries.setQueryData(['exposure', 'anonymous'], []);
  const originating = {
    viewer: 'owner',
    address: { id },
    lifetime: {},
    isCurrent: () => true,
    refresh: () => readProgressSession({ data: { id } }),
  };
  const route = createRootRoute({ component: () => h(ProgressSessionPage, { page, originating }) });
  const router = createRouter({
    routeTree: route,
    history: createMemoryHistory({ initialEntries: ['/en/library/progress'] }),
  });
  await router.load();
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(h(QueryClientProvider, { client: queries }, h(RouterProvider, { router }))));
    const button = (text: string) => {
      const match = [...window.document.querySelectorAll('button')].find(
        (element: HTMLButtonElement) => element.textContent === text,
      );
      expect(match, text).toBeDefined();
      return match!;
    };
    const open = async () => {
      await act(async () => button(m.library_progress_update()).click());
      const dialog = window.document.querySelector('[role="dialog"]');
      expect(dialog).not.toBeNull();
      return dialog!;
    };
    const enter = async (dialog: HTMLElement, value: string) => {
      const input = dialog.querySelector('input[inputmode="decimal"]')!;
      await act(async () => {
        input.focus();
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, value);
        input.dispatchEvent(new window.InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
      });
      return input;
    };
    const dialog = await open();
    expect(dialog.textContent).toContain('A journey through the mountains');
    expect(dialog.textContent).toContain('Unit: segment');
    expect(dialog.textContent).toContain('Current recorded total: 2.5 segments');
    expect(dialog.textContent).toContain(m.library_progress_replace_total());
    expect(dialog.querySelector('input[inputmode="decimal"]')?.getAttribute('min')).toBe('0');
    expect(dialog.querySelector('input[inputmode="decimal"]')?.getAttribute('max')).toBe('98.5');
    expect(dialog.querySelector('input[inputmode="decimal"]')?.getAttribute('step')).toBe('0.01');
    expect(dialog.textContent).not.toContain('Session total:');
    expect(dialog.textContent).not.toContain(' / ');
    expect(host.querySelector('details')?.open).toBe(false);
    await enter(dialog, '');
    expect(dialog.textContent).toContain(m.library_progress_total_preview_empty());
    await enter(dialog, '3.75');
    expect(dialog.textContent).toContain('Recorded total after saving: 3.75 segments');
    expect(dialog.textContent).not.toContain('6.25');
    await act(async () =>
      dialog.querySelector('form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })),
    );
    await act(async () => button(m.library_progress_confirm_correction()).click());
    expect(writes).toEqual([
      {
        body: { revision: 1, amount: '3.75' },
        authorization: 'Bearer recording-owner',
        key: JSON.stringify(page.idempotencyKey),
      },
    ]);
    expect(csrf).toContain('recording-csrf');
    expect(csrf.every((token) => token === 'recording-csrf')).toBe(true);
    expect(session.amount).toBe('3.75');
    expect(session.total).toBeNull();
    expect(host.textContent).toContain('3.75 segments');
    const again = await open();
    expect(again.textContent).toContain('Current recorded total: 3.75 segments');
    await enter(again, '0');
    expect(again.textContent).toContain('Recorded total after saving: 0 segments');
    await act(async () =>
      again.querySelector('form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })),
    );
    await act(async () => button(m.library_progress_confirm_correction()).click());
    expect(writes[1]?.body).toEqual({ revision: 2, amount: '0' });
    expect(writes[1]?.key).not.toBe(JSON.stringify(page.idempotencyKey));
    expect(session.amount).toBe('0');
    expect(session.total).toBeNull();
    expect(host.textContent).toContain('0 segments');
    const journalSection = () =>
      [...host.querySelectorAll('section')].find(
        (section) => section.querySelector('h2')?.textContent === m.library_occurrence_heading(),
      )!;
    const field = (label: string) => {
      const element = [...journalSection().querySelectorAll('label')].find((element) => element.textContent === label)!;
      return window.document.getElementById(element.htmlFor)! as HTMLInputElement;
    };
    const setField = async (label: string, value: string) => {
      const input = field(label);
      await act(async () => {
        input.focus();
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, value);
        input.dispatchEvent(new window.InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
      });
    };
    expect(field(m.library_occurrence_start_date()).value).toBe('2024');
    await setField(m.library_occurrence_finish_date(), '2024-02-30');
    expect(journalSection().textContent).toContain(m.library_occurrence_date_invalid());
    expect(button(m.library_journal_review()).disabled).toBe(true);
    await setField(m.library_occurrence_finish_date(), '2024-02');
    await act(async () => button(m.library_journal_review()).click());
    expect(journalSection().textContent).toContain(m.library_journal_precision_month());
    expect(journalSection().textContent).toContain(m.library_journal_untouched());
    await act(async () => {
      button(m.library_occurrence_save()).click();
      button(m.library_occurrence_save()).click();
    });
    expect(journalWrites).toHaveLength(1);
    const captured = structuredClone(journalWrites[0]!);
    expect(captured.body).toEqual({ revision: 0, finishDate: { year: 2024, month: 2 } });
    await act(async () => queries.setQueryData(['session'], { state: 'signed-out' }));
    expect(host.textContent).not.toContain('Original private reflection');
    journal = { ...journal, revision: 1, finishDate: { year: 2024, month: 2 } };
    await act(async () => {
      resolveJournal!({ kind: 'saved', journal });
    });
    expect(host.textContent).not.toContain('Original private reflection');
    await act(async () => {
      queries.setQueryData(['session'], { state: 'signed-in', csrfToken: 'recording-csrf', subject: 'owner' });
      admit();
    });
    await act(async () => button(m.library_occurrence_read_current()).click());
    expect(journalWrites).toHaveLength(1);
    expect(journalSection().textContent).toContain(m.library_journal_retry_identity());
    await act(async () => button(m.library_rich_entry_retry()).click());
    expect(journalWrites).toHaveLength(2);
    expect(journalWrites[1]).toEqual(captured);
    expect(journalSection().textContent).toContain(m.library_journal_saved());
    // A definitive stale refusal retains selected fields until an explicit read and re-review.
    refuse = true;
    await setField(m.library_occurrence_start_date(), '2025');
    await act(async () => button(m.library_journal_review()).click());
    await act(async () => button(m.library_occurrence_save()).click());
    expect(journalSection().textContent).toContain(m.library_journal_draft_retained());
    expect(field(m.library_occurrence_start_date()).value).toBe('2025');
    await setField(m.library_occurrence_start_date(), '2026');
    expect(journalSection().textContent).toContain(m.library_journal_draft_retained());
    journal = { ...journal, revision: 2, reflection: 'Changed elsewhere' };
    await act(async () => button(m.library_occurrence_read_current()).click());
    await act(async () => button(m.library_occurrence_review_latest()).click());
    refuse = false;
    await act(async () => button(m.library_journal_review()).click());
    await act(async () => button(m.library_occurrence_save()).click());
    expect(journalWrites[3]?.body).toEqual({ revision: 2, startDate: { year: 2026 } });
    expect(journalWrites[3]?.key).not.toBe(journalWrites[2]?.key);
  } finally {
    await act(async () => root.unmount());
    stopObservation();
    queries.clear();
    window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    mock.restore();
  }
});
