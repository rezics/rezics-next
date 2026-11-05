// UNRUN: mounted presentation regressions use the existing authenticated visit and deferred read seams.
// Browser layout/focus painting and native authority acceptance remain owed after integration.
import { afterAll, expect, mock, spyOn, test } from 'bun:test';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { act, StrictMode } from 'react';
import * as start from '../.storybook/react-start';
import type { CurrentReviewVote } from '../src/threads/review-vote';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
afterAll(() => mock.restore());

const id = (n: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(n).padStart(12, '0')}`;
const owner = { state: 'signed-in' as const, subject: id(40), csrfToken: 'initial-csrf' };
const votes: CurrentReviewVote[] = [
  { questionId: '00000000-0000-7000-8000-000000000001', units: 14, revision: 8 },
  { questionId: '00000000-0000-7000-8000-000000000001', units: 16, revision: 4 },
];
const longTitle = `Übersetzungen・翻訳・ترجمات ${'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.repeat(8)}`;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function mountFields(locale: 'en' | 'de' | 'es' | 'fr' | 'ja' | 'ko' | 'zh-Hans' | 'zh-Hant' = 'en') {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/compose', width: 390, height: 900 });
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
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { sessionQuery } = await import('../src/session/query');
  const { setLocale } = await import('../src/paraglide/runtime.js');
  const { m } = await import('../src/paraglide/messages.js');
  const { ReviewFields } = await import('../src/threads/review-fields');
  const { observeThreadCreationReader, useThreadCreationLifetime, ThreadCreationLifetimeProvider } =
    await import('../src/threads/thread-creation-lifetime');
  const voteRead = await import('../src/threads/review-vote-read');
  const search = await import('../src/threads/content-subject-search');
  const storybookRequire = createRequire(createRequire(import.meta.url).resolve('storybook/test'));
  const { default: userEvent } = await import(storybookRequire.resolve('@testing-library/user-event'));
  const user = userEvent.setup({ document: window.document });
  setLocale(locale, { reload: false });

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // Same session observation/admission fixture as thread-creation-lifetime.test.tsx; no private vote cache.
  client.setQueryData(sessionQuery.queryKey, owner);
  const observation = observeThreadCreationReader(client)!;
  const admission = { observation, actualSubject: owner.subject };
  const reads: { subjectId: string; work: ReturnType<typeof deferred<CurrentReviewVote | null>> }[] = [];
  const read = spyOn(voteRead, 'readCurrentReviewVote').mockImplementation(({ data }) => {
    const work = deferred<CurrentReviewVote | null>();
    reads.push({ subjectId: data.subjectId, work });
    return work.promise;
  });
  const suggestions = spyOn(search, 'searchContentSubjects').mockResolvedValue([
    search.contentSubjectPreset(id(3), 'Next subject'),
  ]);
  const subjects: (string | null)[][] = [[], []];
  const citations: (CurrentReviewVote | undefined)[][] = [[], []];
  const subjectCallbacks = [0, 1].map((index) => (value: string | null) => subjects[index]!.push(value));
  const citationCallbacks = [0, 1].map(
    (index) => (value: CurrentReviewVote | undefined) => citations[index]!.push(value),
  );
  let disabled = false;
  let selected = true;
  function Visit({ index }: { index: number }) {
    const visit = useThreadCreationLifetime({ boardId: id(10), purpose: 'reviews', initialKey: id(20) }, admission);
    // The actual route also removes metadata when its original visit is no longer bound.
    return (
      <ThreadCreationLifetimeProvider lifetime={visit.lifetime}>
        <form aria-label={`Review ${index + 1}`}>
          <input aria-label="Review title" defaultValue="Draft title" />
          <textarea aria-label="Review body" defaultValue="Draft body" />
          {visit.bound ? (
            <ReviewFields
              {...(selected ? { initialSubjectId: id(index + 1), initialSubjectTitle: longTitle } : {})}
              searchScope={visit.scopeKey}
              disabled={disabled}
              onSubjectChange={subjectCallbacks[index]!}
              onVoteCitationChange={citationCallbacks[index]!}
            />
          ) : null}
        </form>
      </ThreadCreationLifetimeProvider>
    );
  }
  const host = window.document.createElement('main');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const render = async (options: { disabled?: boolean; selected?: boolean } = {}) => {
    disabled = options.disabled ?? disabled;
    selected = options.selected ?? selected;
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <StrictMode>
            <Visit index={0} />
            <Visit index={1} />
          </StrictMode>
        </QueryClientProvider>,
      ),
    );
  };
  const settle = async (ready: () => boolean) => {
    for (let n = 0; n < 180 && !ready(); n++)
      await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, 10));
      });
    expect(ready()).toBe(true);
  };
  const forms = () => [...host.querySelectorAll('form')];
  const checkbox = (index: number) => forms()[index]!.querySelector<HTMLElement>('[role="checkbox"]');
  const label = (index: number) => forms()[index]!.querySelector<HTMLLabelElement>('label[for]')!;
  const resolveVotes = async () => {
    await settle(() => reads.length === 2);
    await act(async () => {
      for (const request of reads) request.work.resolve(votes[request.subjectId === id(1) ? 0 : 1]!);
    });
    await settle(() => !!checkbox(0) && !!checkbox(1));
  };
  const retire = async () => {
    await act(async () => {
      client.setQueryData(sessionQuery.queryKey, { state: 'signed-out', subject: null, csrfToken: null });
      client.setQueryData(sessionQuery.queryKey, owner);
    });
  };
  const dispose = async () => {
    await act(async () => root.unmount());
    read.mockRestore();
    suggestions.mockRestore();
    client.clear();
    setLocale('en', { reload: false });
    host.remove();
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  };
  return {
    host,
    window,
    user,
    m,
    reads,
    subjects,
    citations,
    forms,
    checkbox,
    label,
    render,
    settle,
    resolveVotes,
    retire,
    dispose,
  };
}

test('two actual ReviewFields keep labels, optional citations and keyboard/disabled interaction independent', async () => {
  const page = await mountFields();
  try {
    await page.render();
    await page.resolveVotes();
    const first = page.checkbox(0)!;
    const second = page.checkbox(1)!;
    const native = page.forms().map((form) => form.querySelector<HTMLInputElement>('input[type="checkbox"]')!);
    expect(native[0]!.id).not.toBe(native[1]!.id);
    expect(first.id).not.toBe(second.id);
    for (const index of [0, 1]) {
      // Base UI associates the native label with its hidden input and names the focusable span from it.
      expect(page.label(index).htmlFor).toBe(native[index]!.id);
      expect(page.label(index).control).toBe(native[index]);
      expect(page.checkbox(index)!.getAttribute('aria-labelledby')).toBe(page.label(index).id);
    }
    expect(page.subjects).toEqual([[], []]);
    expect(page.citations).toEqual([[undefined], [undefined]]);
    expect(first.getAttribute('aria-checked')).toBe('false');
    expect(second.getAttribute('aria-checked')).toBe('false');
    await act(async () => page.user.click(page.label(0).lastElementChild!));
    expect(page.citations).toEqual([[undefined, votes[0]], [undefined]]);
    expect(second.getAttribute('aria-checked')).toBe('false');
    await act(async () => page.user.click(page.label(1).lastElementChild!));
    expect(page.citations).toEqual([
      [undefined, votes[0]],
      [undefined, votes[1]],
    ]);
    await act(async () => {
      first.focus();
      await page.user.keyboard('[Space]');
    });
    expect(first.getAttribute('aria-checked')).toBe('false');
    expect(second.getAttribute('aria-checked')).toBe('true');
    expect(page.citations[0]!.at(-1)).toBeUndefined();
    await act(async () => page.user.tab());
    expect(page.window.document.activeElement).toBe(page.forms()[1]!.querySelector('[role="combobox"]'));
    await act(async () => page.user.tab());
    expect(page.window.document.activeElement).toBe(second);
    await act(async () => page.user.keyboard('[Space]'));
    expect(page.citations[1]!.at(-1)).toBeUndefined();
    const beforeDisabled = page.citations.map((values) => [...values]);
    await page.render({ disabled: true });
    for (const form of page.forms()) {
      expect(form.querySelector<HTMLInputElement>('[role="combobox"]')!.disabled).toBe(true);
      expect(form.querySelector('[role="checkbox"]')!.getAttribute('aria-disabled')).toBe('true');
      expect(form.querySelector<HTMLInputElement>('input[type="checkbox"]')!.disabled).toBe(true);
    }
    await act(async () => {
      await page.user.click(page.label(0));
      await page.user.click(page.label(1));
      await page.user.keyboard('[Space]');
    });
    expect(page.citations).toEqual(beforeDisabled);
    await page.render({ disabled: false });
    expect(page.checkbox(0)!.id).toBe(first.id);
    expect(page.checkbox(1)!.id).toBe(second.id);
    expect(page.reads).toHaveLength(2);
    expect(page.subjects).toEqual([[], []]);
  } finally {
    await page.dispose();
  }
});

test('subject switching, an absent vote and a failed private read cannot expose an old or fabricated citation', async () => {
  const page = await mountFields();
  try {
    await page.render();
    await page.settle(() => page.reads.length === 2);
    const title = page.forms()[1]!.querySelector<HTMLInputElement>('[aria-label="Review title"]')!;
    const body = page.forms()[1]!.querySelector<HTMLTextAreaElement>('[aria-label="Review body"]')!;
    await act(async () => {
      await page.user.clear(title);
      await page.user.type(title, 'My review title');
      await page.user.clear(body);
      await page.user.type(body, 'My review body');
    });
    const input = page.forms()[0]!.querySelector<HTMLInputElement>('[role="combobox"]')!;
    await act(async () => {
      await page.user.clear(input);
      await page.user.type(input, 'Next');
    });
    await page.settle(() => page.window.document.querySelector('[role="option"]') !== null);
    await act(async () => page.user.click(page.window.document.querySelector('[role="option"]')!));
    await page.settle(() => page.reads.length === 3);
    expect(page.subjects).toEqual([[id(3)], []]);
    expect(page.reads[2]!.subjectId).toBe(id(3));
    expect(page.checkbox(0)).toBeNull();
    await act(async () => {
      page.reads.find((request) => request.subjectId === id(1))!.work.resolve(votes[0]!);
      page.reads.find((request) => request.subjectId === id(2))!.work.reject(new Error('Private read unavailable'));
      page.reads[2]!.work.resolve(null);
    });
    expect(page.host.querySelector('[role="checkbox"]')).toBeNull();
    expect(page.host.querySelector('[data-slot="field-description"]')).toBeNull();
    expect(page.citations.every((values) => values.every((value) => value === undefined))).toBe(true);
    expect(page.forms()[0]!.textContent).toContain('Next subject');
    expect(page.forms()[0]!.textContent).toContain(page.m.thread_review_vote_none());
    expect(page.forms()[1]!.textContent).toContain(page.m.thread_review_vote_read_failed());
    const retry = page.forms()[1]!.querySelector<HTMLButtonElement>('button')!;
    expect(retry.textContent).toBe(page.m.thread_review_vote_retry());
    await act(async () => {
      retry.click();
      retry.click();
    });
    await page.settle(() => page.reads.length === 4);
    expect(page.reads[3]!.subjectId).toBe(id(2));
    await act(async () => page.reads[3]!.work.resolve(votes[1]!));
    await page.settle(() => page.checkbox(1) !== null);
    expect(page.checkbox(1)!.getAttribute('aria-checked')).toBe('false');
    expect(page.citations[1]!.at(-1)).toBeUndefined();
    expect(title.value).toBe('My review title');
    expect(body.value).toBe('My review body');
    expect(input.value).toBe('Next subject');
    await page.render();
    expect(page.reads).toHaveLength(4);
  } finally {
    await page.dispose();
  }
});

test('empty or disabled fields schedule no read; retirement withholds pending and already visible vote controls', async () => {
  for (const options of [{ selected: false }, { disabled: true }]) {
    const empty = await mountFields();
    try {
      await empty.render(options);
      expect(empty.reads).toHaveLength(0);
      expect(empty.host.querySelector('[role="checkbox"]')).toBeNull();
    } finally {
      await empty.dispose();
    }
  }
  for (const pending of [true, false]) {
    const page = await mountFields();
    try {
      await page.render();
      await page.settle(() => page.reads.length === 2);
      if (!pending) {
        await page.resolveVotes();
        await act(async () => page.user.click(page.label(0).lastElementChild!));
        expect(page.citations[0]!.at(-1)).toEqual(votes[0]);
      }
      const callbacks = page.citations.map((values) => [...values]);
      await page.retire();
      await act(async () => {
        for (const request of page.reads) request.work.resolve(votes[0]!);
      });
      expect(page.host.querySelector('[role="checkbox"]')).toBeNull();
      expect(page.host.querySelector('[role="combobox"]')).toBeNull();
      expect(page.host.textContent).not.toContain(longTitle);
      expect(page.citations).toEqual(callbacks);
      expect(page.reads).toHaveLength(2);
    } finally {
      await page.dispose();
    }
  }
});

test.each(['en', 'de', 'es', 'fr', 'ja', 'ko', 'zh-Hans', 'zh-Hant'] as const)(
  '%s keeps human hierarchy, unique help and long text at phone/desktop and RTL boundaries',
  async (locale) => {
    const page = await mountFields(locale);
    try {
      await page.render();
      await page.resolveVotes();
      for (const width of [390, 1280]) {
        page.host.style.width = `${width}px`;
        for (const direction of ['ltr', 'rtl']) {
          page.host.dir = direction;
          await page.render();
          const ids = [...page.host.querySelectorAll('[id]')].map((element) => element.id);
          expect(new Set(ids).size).toBe(ids.length);
          for (const [index, form] of page.forms().entries()) {
            const section = form.querySelector('section')!;
            const heading = page.window.document.getElementById(section.getAttribute('aria-labelledby')!)!;
            expect(heading.tagName).toBe('H2');
            expect(heading.textContent).toBe(page.m.thread_review_details_heading());
            expect(form.querySelectorAll('label')).toHaveLength(1);
            expect(form.querySelector('[role="combobox"]')!.getAttribute('aria-label')).toBe(
              page.m.thread_review_subject(),
            );
            const selected = form.querySelector<HTMLElement>('[data-slot="review-selected-subject"]')!;
            expect(selected.textContent).toBe(page.m.thread_review_details_selected_subject({ title: longTitle }));
            expect(selected.classList.contains('[overflow-wrap:anywhere]')).toBe(true);
            const control = page.checkbox(index)!;
            const help = page.window.document.getElementById(control.getAttribute('aria-describedby')!)!;
            expect(form.contains(help)).toBe(true);
            expect(help.textContent).toBe(page.m.thread_review_details_citation_help());
            expect(page.label(index).textContent).toBe(
              page.m.thread_review_cite_vote({
                score: new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(votes[index]!.units / 2),
              }),
            );
            for (const token of [
              'min-h-11',
              'w-full',
              'text-start',
              'has-[:focus-visible]:outline-2',
              'has-[:focus-visible]:outline-ring',
            ])
              expect(page.label(index).classList.contains(token)).toBe(true);
            expect(page.label(index).lastElementChild!.classList.contains('[overflow-wrap:anywhere]')).toBe(true);
            expect(help.classList.contains('[overflow-wrap:anywhere]')).toBe(true);
          }
        }
      }
      expect(page.reads).toHaveLength(2);
    } finally {
      await page.dispose();
    }
  },
);
