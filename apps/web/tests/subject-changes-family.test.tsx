import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { act, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type {
  ChangeDetail,
  ChangesState,
  ChangesRead,
  ChangesTransport,
  DetailRead,
} from '../src/features/catalogue/subject-changes';
import * as start from '../.storybook/react-start';
import type { BrowserSession } from '../src/session/browser-state';

const unavailable = { state: 'unavailable', subject: null, csrfToken: null } as const;
let sessionRead: () => Promise<BrowserSession> = async () => unavailable;
let historyRead: (input: unknown) => Promise<ChangesRead> = async () => ({ kind: 'unavailable' });
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('../src/session/state', () => ({ readSessionState: () => sessionRead() }));
mock.module('../src/features/catalogue/subject-changes-actions', () => ({
  loadSubjectChanges: (input: unknown) => historyRead(input),
  loadSubjectChange: async () => ({ kind: 'unavailable' }),
}));

// Authored UNRUN: actual mounted presentation and generated-client seams. Happy DOM
// proves neither geometry nor native authorization; original native/lifetime tests remain owed.
test('the complete Subject history family keeps independent headings, bounded supplied evidence and deliberate current-reader controls', async () => {
  const require = createRequire(import.meta.url);
  const { Window } = await import(createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom'));
  const window = new Window({ url: 'https://site.test/en', width: 390, height: 844 });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    MutationObserver: window.MutationObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import('react-dom/client');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { SubjectChanges, SubjectChangesPage, ChangeExplanation } =
    await import('../src/features/catalogue/subject-changes-page');
  const { CandidateReaderBoundary } = await import('../src/subject/candidate-lifetime');
  const { catalogueChangesFixture, changesCursor, changesLastCursor } =
    await import('../src/kernel/fake/catalogue-changes');
  const { languageName } = await import('../src/subject/language');
  const { candidateContext } = await import('../src/subject/candidates');
  const { m } = await import('../src/paraglide/messages.js');
  const { setLocale } = await import('../src/paraglide/runtime.js');
  setLocale('en', { reload: false });
  const { default: userEvent } = await import(
    createRequire(require.resolve('storybook/test')).resolve('@testing-library/user-event')
  );
  const user = userEvent.setup({ document: window.document });
  const host = document.createElement('main');
  document.body.append(host);
  const outside = document.createElement('button');
  outside.textContent = 'Independent focus';
  document.body.append(outside);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  client.setQueryData(['session'], { state: 'signed-out', subject: null, csrfToken: null });
  const render = async (node: ReactNode) => {
    await act(async () => root.render(<QueryClientProvider client={client}>{node}</QueryClientProvider>));
  };
  const settle = async () => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };
  const until = async (ready: () => boolean) => {
    for (let attempt = 0; attempt < 60 && !ready(); attempt++) await settle();
    expect(ready()).toBe(true);
  };
  const button = (scope: Element, text: string) => {
    const found = [...scope.querySelectorAll<HTMLButtonElement>('button')].find((node) =>
      node.textContent?.includes(text),
    );
    expect(found).toBeDefined();
    return found!;
  };
  const click = async (scope: Element, text: string) => {
    const target = button(scope, text);
    expect(target.disabled).toBe(false);
    await act(async () => user.click(target));
    await settle();
  };
  const queued = (target: object) => {
    const key = Object.keys(target).find((name) => name.startsWith('__reactProps$'))!;
    const callback = Reflect.get(target, key).onClick as () => void;
    return () => callback();
  };
  const histories = () => [...host.querySelectorAll<HTMLElement>('[data-slot="subject-changes"]')];
  const revisions = (scope: Element) => scope.querySelector(`section[aria-label="${m.changes_revisions()}"]`)!;
  const explanation = (scope: Element) => scope.querySelector<HTMLElement>('section[aria-labelledby]')!;
  const associations = () => {
    const ids = histories().map((page) => {
      const region = explanation(page);
      const id = region.getAttribute('aria-labelledby')!;
      const heading = document.getElementById(id)!;
      expect(region.tagName).toBe('SECTION');
      expect(region.contains(heading)).toBe(true);
      expect(page.contains(heading)).toBe(true);
      expect(heading.tagName).toBe('H2');
      expect(heading.getAttribute('data-content-item-slot')).toBe('title');
      return id;
    });
    expect(new Set(ids).size).toBe(ids.length);
    return ids;
  };
  const authoredControls = (page: Element, currentText = m.changes_current()) => {
    // Classes are an authored sizing/focus witness only, never a measured 44px result.
    const targets = [...page.querySelectorAll<HTMLElement>('button, a')].filter(
      (node) =>
        (node.tagName === 'BUTTON' && !node.closest('[data-slot="subject-frame"]')) || node.textContent === currentText,
    );
    for (const node of targets) {
      for (const token of [
        'min-h-11',
        'min-w-11',
        'max-w-full',
        'whitespace-normal',
        '[overflow-wrap:anywhere]',
        'relative',
        'z-10',
      ])
        expect(node.classList.contains(token)).toBe(true);
      expect(node.className).toContain('focus-visible:');
      expect(node.className).not.toContain('min-h-8');
      expect(node.closest('a a, button button, a button, button a')).toBeNull();
    }
    expect(
      revisions(page)?.querySelector('[role="button"], [data-slot="list-row-link"], [hidden], .sr-only'),
    ).toBeNull();
    expect(explanation(page)?.querySelector('[hidden], .sr-only')).toBeNull();
  };
  const terms: ChangeDetail['summary'] = {
    kind: 'terms',
    fields: [
      { field: 'labels', languages: ['en', 'fr', 'de', 'ja', 'ko', 'zh-Hans', 'zh-Hant', 'es'] },
      { field: 'descriptions', languages: ['ja', 'de', 'fr'] },
      { field: 'aliases', languages: ['es', 'en', 'ko'] },
    ],
  };
  const first = catalogueChangesFixture('ready', 'en', undefined, (revision) =>
    Response.json({
      subject: first.id,
      revision: { revision, kind: 'terms', release: first.read.subject.release },
      change: terms,
    }),
  );
  const second = catalogueChangesFixture('ready', 'en', undefined, (revision) =>
    Response.json({
      subject: second.id,
      revision: { revision, kind: 'propose', release: second.read.subject.release },
      change: {
        kind: 'candidate',
        candidate: '00000000-0000-8000-0000-000000000005',
        property: 'schema:isbn',
        context: candidateContext,
        reading: { decision: { head: 8, verdict: 'accept', revision: 6 }, selected: true, rank: 'preferred' },
      },
    }),
  );
  const longTitle = `旅人の物語 — Édition originale — رحلة طويلة ${'星'.repeat(220)}`;
  first.read.subject.labels.en = longTitle;
  const calls: Array<{ operation: string; operand?: string | number | undefined; session?: string | undefined }> = [];
  let listFailure = false;
  let detailFailure = false;
  let pending: { promise: Promise<DetailRead> } | undefined;
  let transport: ChangesTransport = {
    list: async (cursor, session) => {
      calls.push({ operation: 'list', operand: cursor, session });
      if (listFailure) return { kind: 'unavailable' };
      return first.transport.list(cursor, session);
    },
    detail: async (revision, session) => {
      calls.push({ operation: 'detail', operand: revision, session });
      if (pending) return pending.promise;
      if (detailFailure) return { kind: 'unavailable' };
      return first.transport.detail(revision, session);
    },
  };
  let observed = { state: 'signed-in' as const, subject: first.id, csrfToken: 'original-csrf' };
  const showReaders = () =>
    render(
      <>
        <CandidateReaderBoundary observed={observed} address="history-family">
          <SubjectChanges locale="en" transport={transport} currentHref={`/en/subjects/${first.id}`} />
        </CandidateReaderBoundary>
        <SubjectChanges locale="en" transport={second.transport} />
      </>,
    );
  try {
    outside.focus();
    await showReaders();
    await until(() => histories().length === 2 && histories().every((page) => !!page.querySelector('ol button')));
    const [a, b] = histories() as [HTMLElement, HTMLElement];
    expect(document.activeElement).toBe(outside);
    const ids = associations();
    expect(a.textContent).toContain(longTitle);
    expect(revisions(a).querySelectorAll('li')).toHaveLength(2);
    expect(revisions(b).querySelectorAll('li')).toHaveLength(2);
    expect(revisions(a).querySelector('h2')?.textContent).toBe(m.changes_revisions());
    expect(explanation(a).textContent).toContain(m.changes_choose());
    expect(calls).toEqual([{ operation: 'list', operand: undefined, session: undefined }]);
    expect(first.calls).toHaveLength(2);
    for (const page of [a, b]) authoredControls(page);
    const currentHref = a.querySelector<HTMLAnchorElement>('nav a')!.getAttribute('href');
    const selectFive = m.changes_revision({ revision: '5' });
    await act(async () => {
      a.querySelector<HTMLAnchorElement>('nav a')!.focus();
      await user.tab();
    });
    expect(document.activeElement).toBe(button(a, selectFive));
    await act(async () => user.keyboard('{Enter}'));
    await settle();
    expect(calls.at(-1)).toEqual({ operation: 'detail', operand: 5, session: 'changes-session' });
    expect(document.activeElement).toBe(explanation(a).querySelector('h2'));
    outside.focus();
    await showReaders();
    expect(document.activeElement).toBe(outside);
    expect(button(a, selectFive).getAttribute('aria-pressed')).toBe('true');
    expect(button(b, selectFive).getAttribute('aria-pressed')).toBe('false');
    expect(explanation(b).textContent).toContain(m.changes_choose());
    expect(associations()).toEqual(ids);
    const fields = a.querySelector(`dl[aria-label="${m.changes_fields()}"]`)!;
    expect(fields.querySelectorAll('dt')).toHaveLength(3);
    if (terms.kind !== 'terms') throw new Error('Expected terms');
    for (const [index, term] of [...fields.querySelectorAll('dt')].entries()) {
      expect(term.nextElementSibling?.tagName).toBe('DD');
      expect(term.nextElementSibling?.textContent).toBe(
        terms.fields[index]!.languages.map((tag) => languageName(tag, 'en')).join(' · '),
      );
      expect(term.parentElement?.querySelectorAll('dd')).toHaveLength(1);
    }
    const native = first.calls.find((call) => call.path.endsWith('/revisions/5'))!;
    expect(native).toMatchObject({
      authorization: 'Bearer story',
      session: 'changes-session',
      cache: 'no-store',
      redirect: 'manual',
    });
    expect(
      first.calls
        .filter((call) => call.path === `/v1/subjects/${first.id}`)
        .every((call) => call.authorization === null),
    ).toBe(true);
    expect(a.querySelector('nav a')?.getAttribute('href')).toBe(currentHref);
    expect(a.textContent).toContain(m.changes_current_notice());
    await click(b, selectFive);
    const current = b.querySelector(`section[aria-label="${m.changes_current()}"]`)!;
    expect(current.querySelector('h3')?.textContent).toBe(m.changes_current());
    for (const text of [m.context_accepted(), m.context_selected(), m.candidate_rank_preferred()])
      expect(current.textContent).toContain(text);
    expect(b.textContent).not.toContain(m.changes_current_notice());

    // A failed continuation replays exactly its original opaque cursor and continuity.
    listFailure = true;
    await click(a, m.changes_more());
    expect(document.activeElement).toBe(button(a, m.changes_retry()));
    const retry = queued(button(a, m.changes_retry()));
    expect(calls.at(-1)).toEqual({ operation: 'list', operand: changesCursor, session: 'changes-session' });
    authoredControls(a);
    expect(revisions(a).querySelectorAll('li')).toHaveLength(2);
    listFailure = false;
    await click(a, m.changes_retry());
    expect(calls.at(-1)).toEqual({ operation: 'list', operand: changesCursor, session: 'changes-session' });
    expect(document.activeElement?.textContent).toBe(
      m.subject_relation_completed_more({ label: m.changes_revisions(), count: '0' }),
    );
    expect(revisions(a).querySelectorAll('li')).toHaveLength(2);
    expect(a.textContent).not.toContain(m.changes_empty());
    const afterRetry = calls.length;
    retry();
    await settle();
    expect(calls).toHaveLength(afterRetry);
    const oldMore = queued(button(a, m.changes_more()));
    await click(a, m.changes_more());
    expect(calls.at(-1)).toEqual({ operation: 'list', operand: changesLastCursor, session: 'changes-session' });
    expect(revisions(a).querySelectorAll('li')).toHaveLength(3);
    expect(document.activeElement).toBe(
      button(a, m.changes_revision({ revision: '2' }))
        .closest('li')
        ?.querySelector('p'),
    );
    expect([...revisions(a).querySelectorAll('button')].some((node) => node.textContent === m.changes_more())).toBe(
      false,
    );
    const endCalls = calls.length;
    oldMore();
    await settle();
    expect(calls).toHaveLength(endCalls);
    detailFailure = true;
    await click(a, m.changes_revision({ revision: '2' }));
    expect(document.activeElement).toBe(button(a, m.changes_retry_detail()));
    const oldDetailRetry = queued(button(a, m.changes_retry_detail()));
    expect(a.textContent).toContain(m.changes_unavailable());
    expect(a.querySelector('dl')).toBeNull();
    authoredControls(a);
    detailFailure = false;
    await click(a, m.changes_retry_detail());
    expect(calls.at(-1)).toEqual({ operation: 'detail', operand: 2, session: 'changes-session' });
    expect(document.activeElement).toBe(explanation(a).querySelector('h2'));
    const afterDetailRetry = calls.length;
    oldDetailRetry();
    await settle();
    expect(calls).toHaveLength(afterDetailRetry);

    // Retired callbacks and late private results cannot revive the old page or move focus.
    const retiredSelect = queued(button(a, selectFive));
    let resolve!: (value: DetailRead) => void;
    pending = {
      promise: new Promise((yes) => {
        resolve = yes;
      }),
    };
    await click(a, selectFive);
    expect(a.getAttribute('aria-busy')).toBe('true');
    expect(a.textContent).toContain(m.changes_detail_loading());
    expect([...a.querySelectorAll<HTMLButtonElement>('section button')].every((node) => node.disabled)).toBe(true);
    const beforeRefresh = calls.length;
    transport = { ...transport };
    await showReaders();
    expect(calls).toHaveLength(beforeRefresh);
    expect(a.getAttribute('aria-busy')).toBe('true');
    observed = { ...observed, csrfToken: 'replacement-csrf' };
    await showReaders();
    await until(() => !!histories()[0]?.querySelector('ol button'));
    expect(calls.at(-1)).toEqual({ operation: 'list', operand: undefined, session: undefined });
    outside.focus();
    const snapshot = host.innerHTML;
    const count = calls.length;
    const cache = client
      .getQueryCache()
      .getAll()
      .map((query) => [query.queryKey, query.state.data]);
    resolve({
      kind: 'ready',
      session: 'retired-session',
      detail: { id: first.id, revision: 5, summary: { kind: 'limited' } },
    });
    pending = undefined;
    await settle();
    retiredSelect();
    oldMore();
    retry();
    oldDetailRetry();
    await settle();
    expect(calls).toHaveLength(count);
    expect(host.innerHTML).toBe(snapshot);
    expect(document.activeElement).toBe(outside);
    expect(
      client
        .getQueryCache()
        .getAll()
        .map((query) => [query.queryKey, query.state.data]),
    ).toEqual(cache);

    expect(first.calls.filter((call) => call.path.endsWith('/revisions')).map((call) => call.cursor)).toEqual([
      null,
      changesCursor,
      changesLastCursor,
      null,
    ]);
    expect(first.calls).toHaveLength(12);
    expect(second.calls).toHaveLength(4);

    // Empty final batches retain the accumulated list and allow a subsequent explanation.
    const initial = await second.transport.list();
    if (initial.kind !== 'ready') throw new Error('Expected list');
    let edgeReads = 0;
    let edgeFailure: 'detail' | 'subject' | undefined;
    const edgeTransport: ChangesTransport = {
      list: async () =>
        edgeReads++ === 0
          ? initial
          : edgeReads === 2
            ? { kind: 'unavailable' }
            : {
                kind: 'ready',
                page: { ...initial.page, revisions: [], next: null },
              },
      detail: async (revision) =>
        edgeFailure === 'subject'
          ? { kind: 'missing', scope: 'subject' }
          : edgeFailure === 'detail'
            ? { kind: 'unavailable' }
            : {
                kind: 'ready',
                detail: { id: initial.page.id, revision, summary: { kind: 'limited' } },
              },
    };
    outside.focus();
    await render(<SubjectChanges key="empty-final" locale="en" transport={edgeTransport} />);
    expect(document.activeElement).toBe(outside);
    await click(host, m.changes_more());
    expect(document.activeElement).toBe(button(host, m.changes_retry()));
    await click(host, selectFive);
    expect(document.activeElement).toBe(explanation(histories()[0]!).querySelector('h2'));
    edgeFailure = 'detail';
    await click(host, selectFive);
    expect(document.activeElement).toBe(button(host, m.changes_retry_detail()));
    await click(host, m.changes_retry());
    expect(document.activeElement?.textContent).toBe(
      m.subject_relation_completed_end({ label: m.changes_revisions(), count: '0' }),
    );
    expect(host.querySelectorAll('ol li')).toHaveLength(initial.page.revisions.length);
    edgeFailure = undefined;
    await click(host, m.changes_retry_detail());
    expect(document.activeElement).toBe(explanation(histories()[0]!).querySelector('h2'));
    expect(host.textContent).toContain(m.changes_limited());
    edgeFailure = 'subject';
    await click(host, selectFive);
    expect(document.activeElement?.textContent).toBe(m.changes_missing());
    expect(host.querySelector('section[aria-labelledby]')).toBeNull();
    expect(host.textContent).not.toContain(m.changes_limited());

    // Supplied full-family states keep all existing notices, semantics and callbacks.
    const list = await first.transport.list();
    if (list.kind !== 'ready') throw new Error('Expected list');
    const suppliedReads = first.calls.length + second.calls.length;
    const longProperty = `A supplied property — ${'Full multilingual evidence 星 رحلة '.repeat(15)}`;
    const detail: ChangeDetail = {
      id: first.id,
      revision: 2147483647,
      metadata: { revision: 2147483647, kind: 'terms', release: 'PRIVATE OLD TEXT' },
      propertyLabel: { text: longProperty, lang: 'en' },
      summary: terms,
    };
    const state: ChangesState = {
      page: { ...list.page, revisions: [{ revision: detail.revision, kind: 'terms' }] },
      selected: detail.revision,
      detail: { kind: 'ready', detail },
    };
    const selected: number[] = [];
    let more = 0;
    let retried = 0;
    let detailRetried = 0;
    const show = async (value: ChangesState, locale = 'en', rtl = false) => {
      await render(
        <div dir={rtl ? 'rtl' : 'ltr'}>
          <SubjectChangesPage
            state={value}
            locale={locale}
            currentHref={list.page.href}
            onSelect={(revision) => selected.push(revision)}
            onMore={() => more++}
            onRetry={() => retried++}
            onDetailRetry={() => detailRetried++}
          />
        </div>,
      );
      const region = explanation(histories()[0]!);
      if (region) {
        for (const withheld of [
          first.id,
          '00000000-0000-8000-0000-000000000005',
          candidateContext,
          'Bearer story',
          'changes-session',
          'retired-session',
          first.read.subject.release,
          'PRIVATE OLD TEXT',
          'PRIVATE ACTOR',
        ])
          expect(region.innerHTML).not.toContain(withheld);
      }
    };
    for (const locale of ['en', 'de', 'es', 'fr', 'ja', 'ko', 'zh-Hans', 'zh-Hant']) {
      const o = { locale: locale as never };
      await show(state, locale, true);
      const page = histories()[0]!;
      expect(page.textContent).toContain(longTitle);
      expect(page.textContent).toContain(longProperty);
      expect(page.textContent).toContain(m.changes_revision({ revision: '2147483647' }, o));
      expect(page.querySelector('dl')?.getAttribute('aria-label')).toBe(m.changes_fields({}, o));
      expect(page.querySelector('dl')?.querySelectorAll('dt')).toHaveLength(3);
      authoredControls(page, m.changes_current({}, o));
      // Preserve the original exact dt/dd HTML and inclusion oracle.
      const html = renderToStaticMarkup(<ChangeExplanation detail={detail} locale={locale} />);
      expect(renderToStaticMarkup(<SubjectChangesPage state={state} locale={locale} />)).toContain(html);
      expect(html).toContain('</dt><dd>');
    }
    await show(state);
    const stableId = associations()[0];
    await click(histories()[0]!, m.changes_revision({ revision: '2147483647' }));
    await click(histories()[0]!, m.changes_more());
    expect(selected).toEqual([2147483647]);
    expect(more).toBe(1);
    for (const [kind, text] of [
      ['denied', m.changes_denied()],
      ['missing', m.changes_missing()],
      ['invalid', m.changes_invalid()],
      ['conflict', m.changes_conflict()],
      ['unavailable', m.changes_unavailable()],
    ] as const) {
      await show({ failure: { kind } });
      expect(host.querySelector('[role="alert"]')?.textContent).toBe(text);
      expect(host.querySelector('ol')).toBeNull();
      expect(host.querySelector('a')?.getAttribute('href')).toBe(list.page.href);
      if (kind !== 'missing') await click(host, m.changes_retry());
      else expect(host.querySelector('button')).toBeNull();
      await show({ ...state, detail: { kind } });
      expect(associations()[0]).toBe(stableId);
      expect(host.querySelector('[role="alert"]')?.textContent).toBe(text);
      expect(host.querySelector('dl')).toBeNull();
      await click(host, m.changes_retry_detail());
      authoredControls(histories()[0]!);
    }
    expect(retried).toBe(4);
    expect(detailRetried).toBe(5);
    for (const next of [null, changesCursor]) {
      await show({ page: { ...list.page, revisions: [], next } });
      expect(host.textContent).toContain(next === null ? m.changes_empty() : m.changes_empty_page());
      expect(host.querySelectorAll('li')).toHaveLength(0);
      expect(host.querySelector('section[aria-labelledby]')).toBeNull();
      expect(revisions(histories()[0]!).querySelector('button') === null).toBe(next === null);
    }
    for (const loading of ['list', 'more', 'detail'] as const) {
      await show(loading === 'list' ? { loading } : { ...state, detail: undefined, loading });
      expect(histories()[0]!.getAttribute('aria-busy')).toBe('true');
      expect(host.querySelector('[role="status"]')?.textContent).toBe(
        loading === 'detail' ? m.changes_detail_loading() : m.changes_loading(),
      );
      expect([...host.querySelectorAll<HTMLButtonElement>('section button')].every((node) => node.disabled)).toBe(true);
    }
    await show({ ...state, selected: undefined, detail: undefined });
    expect(host.textContent).toContain(m.changes_choose());
    await show({ ...state, detail: { kind: 'ready', detail: { ...detail, summary: { kind: 'limited' } } } });
    expect(host.textContent).toContain(m.changes_limited());
    expect(host.textContent).toContain(m.changes_current_notice());
    expect(host.querySelector(`section[aria-label="${m.changes_current()}"]`)).toBeNull();
    for (const decision of ['accept', 'reject', 'abstain'] as const) {
      await show({
        ...state,
        detail: {
          kind: 'ready',
          detail: {
            ...detail,
            summary: {
              kind: 'decision',
              candidate: '00000000-0000-8000-0000-000000000005',
              property: 'schema:isbn',
              context: candidateContext,
              decision,
              reading: {
                decision: { head: 8, verdict: decision, revision: 6 },
                selected: decision === 'accept',
                rank: decision === 'accept' ? 'preferred' : 'deprecated',
              },
            },
          },
        },
      });
      expect(host.querySelector('h3')?.textContent).toBe(m.changes_current());
      expect(host.textContent).toContain(
        decision === 'accept'
          ? m.context_accepted()
          : decision === 'reject'
            ? m.candidate_rejected_state()
            : m.changes_abstained_detail(),
      );
      expect(host.textContent).toContain(decision === 'accept' ? m.context_selected() : m.value_not_selected());
      expect(host.textContent).not.toContain(m.changes_current_notice());
    }
    await show({
      ...state,
      detail: {
        kind: 'ready',
        detail: {
          ...detail,
          summary: {
            kind: 'candidate',
            candidate: '00000000-0000-8000-0000-000000000005',
            property: 'schema:isbn',
            reading: { decision: null, selected: false, rank: null },
          },
        },
      },
    });
    expect(host.textContent).toContain(m.candidate_unresolved());
    expect(host.textContent).toContain(m.value_not_selected());
    expect(host.textContent).not.toContain(m.changes_current_notice());
    for (const mode of ['inherit', 'replace', 'suppress'] as const) {
      await show({
        ...state,
        detail: {
          kind: 'ready',
          detail: {
            ...detail,
            summary: {
              kind: 'adoption',
              property: 'schema:isbn',
              context: candidateContext,
              mode,
              selection: [{ candidate: '00000000-0000-8000-0000-000000000005', rank: 'preferred' }],
            },
          },
        },
      });
      expect(host.textContent).toContain(m.changes_adopted_detail());
      expect(host.textContent).toContain(
        mode === 'inherit' ? m.context_inherit() : mode === 'replace' ? m.context_replace() : m.context_suppress(),
      );
      expect(host.textContent).toContain(m.candidate_rank_preferred());
      expect(host.querySelector('h3')?.textContent).toBe(m.changes_recorded());
    }

    // Cost: rendering touches only supplied retained rows/text, with constant per-row
    // frame overhead and zero IO. 64 rows represent accumulated pages (native limit 20),
    // never a claim that a 64-row native response or backend growth check was executed.
    const readCount = first.calls.length + second.calls.length;
    expect(readCount).toBe(suppliedReads);
    for (const size of [1, 8, 64]) {
      let visited = 0;
      const rows = Array.from({ length: size }, (_, index) => ({ revision: index + 1, kind: 'terms' }));
      const supplied = new Proxy(rows, {
        get(target, property, receiver) {
          if (typeof property === 'string' && /^\d+$/.test(property)) visited++;
          return Reflect.get(target, property, receiver);
        },
      });
      await show({ page: { ...list.page, revisions: supplied }, selected: undefined });
      expect(revisions(histories()[0]!).querySelectorAll('li')).toHaveLength(size);
      expect(revisions(histories()[0]!).querySelectorAll('[data-overlay]')).toHaveLength(size);
      expect(visited).toBe(size);
      expect(first.calls.length + second.calls.length).toBe(readCount);
    }
    for (const privateText of [
      first.id,
      'Bearer story',
      'changes-session',
      'retired-session',
      first.read.subject.release,
      'PRIVATE ACTOR',
      'PRIVATE OLD TEXT',
    ]) {
      // The public current href may contain its Subject id; explanation markup must not.
      expect(explanation(histories()[0]!).innerHTML).not.toContain(privateText);
    }
    await render(null);
    const afterUnmount = calls.length;
    retiredSelect();
    oldMore();
    retry();
    oldDetailRetry();
    await settle();
    expect(calls).toHaveLength(afterUnmount);

    // Recovery uses the installed query, preserving the address and retiring private work.
    const { SubjectChangesSession } = await import('../src/features/catalogue/subject-changes-session');
    const reload = mock(() => {});
    Object.defineProperty(window.location, 'reload', { value: reload });
    const address = { id: first.id, locale: 'en', currentHref: `/en/subjects/${first.id}` };
    const requests: unknown[] = [];
    historyRead = async (input) => {
      requests.push(input);
      return first.transport.list();
    };
    client.setQueryData(['session'], unavailable);
    await render(<SubjectChangesSession {...address} />);
    expect(host.textContent).toContain(m.changes_unavailable());
    await click(host, m.changes_retry());
    await until(() => host.textContent!.includes(m.changes_unavailable()));
    sessionRead = async () => {
      throw new Error('session temporarily failed');
    };
    await click(host, m.changes_retry());
    await until(() => host.textContent!.includes(m.changes_unavailable()));
    expect(button(host, m.changes_retry()).disabled).toBe(false);
    expect(requests).toHaveLength(0);
    const recovery = Promise.withResolvers<BrowserSession>();
    sessionRead = () => recovery.promise;
    await click(host, m.changes_retry());
    expect(host.textContent).toContain(m.changes_loading());
    await act(async () => recovery.resolve({ state: 'signed-in', subject: first.id, csrfToken: 'fresh-csrf' }));
    await until(() => !!host.querySelector('ol button'));
    expect(requests).toEqual([
      {
        data: { id: first.id, locale: 'en', expectedReader: first.id, cursor: undefined, session: undefined },
        headers: { 'X-CSRF-Token': 'fresh-csrf' },
      },
    ]);
    expect(host.querySelector('nav a')?.getAttribute('href')).toBe(address.currentHref);
    let pendingList = Promise.withResolvers<ChangesRead>();
    historyRead = async (input) => {
      requests.push(input);
      return pendingList.promise;
    };
    await click(host, m.changes_more());
    const heldList = pendingList;
    await act(async () => client.removeQueries({ queryKey: ['session'] }));
    expect(host.querySelector('ol')).toBeNull();
    pendingList = Promise.withResolvers<ChangesRead>();
    await act(async () => client.setQueryData(['session'], { state: 'signed-out', subject: null, csrfToken: null }));
    expect(host.querySelector('ol')).toBeNull();
    expect(requests.at(-1)).toMatchObject({ data: { expectedReader: null, session: undefined }, headers: {} });
    await act(async () => heldList.resolve(await first.transport.list(changesCursor)));
    expect(host.querySelector('ol')).toBeNull();
    expect(host.querySelector('article')?.getAttribute('aria-busy')).toBe('true');
    await act(async () => pendingList.resolve(await first.transport.list()));
    await until(() => !!host.querySelector('ol button'));
    expect(reload).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    client.clear();
    await window.happyDOM.abort();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}, 30_000);
