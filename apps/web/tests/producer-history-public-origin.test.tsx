import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import * as start from '../.storybook/react-start';
import { producerRecoveryExample } from '../src/features/pages/producer-history-reading/examples';
import { producerHistoryFixture, producerStudioId } from '../src/kernel/fake/producer-history';
import { organizationHistoryVisitReturnFragment } from '../src/features/pages/subject-visit-navigation';
import { candidateContext, type Candidate } from '../src/subject/candidates';
import type { RelationConfirmation, RelationProposal } from '../src/subject/relation-candidates';

mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
const example = producerRecoveryExample();
const windows = producerHistoryFixture('windows');
let failBackward = false;
const commands: (RelationProposal | RelationConfirmation)[] = [];
let proposed = false;
let accepted = false;
let pauseSelection = false;
let finishSelection: (() => void) | undefined;
const candidate: Candidate = {
  id: '00000000-0000-4000-8000-00000000e299',
  source: null,
  retracted: null,
  retraction: null,
  release: example.fixture.studio.subject.release,
  revision: 2,
  decision: null,
  head: null,
  rank: null,
  statement: {
    ...example.fixture.studio.subject.statements['wdt:P749']![1]!,
    id: '00000000-0000-4000-8000-00000000e299',
  },
};
mock.module('../src/features/catalogue/relation-editor-actions', () => ({
  readSubjectRelationEditor: async () => ({
    ...example.relationRead,
    authority: {
      disclosure: 'available',
      actions: {
        state: 'available',
        context: candidateContext,
        operations: ['subject.propose', 'subject.accept_candidate', 'subject.adopt'],
      },
    },
    page: {
      candidates: proposed ? [{ ...candidate, decision: accepted ? 'accepted' : null, head: accepted ? 1 : null }] : [],
      adoption: { mode: 'replace', head: 1 },
      next: null,
    },
  }),
  proposeSubjectRelation: async ({ data }: { data: RelationProposal }) => {
    commands.push(data);
    candidate.statement = {
      ...candidate.statement,
      ...data.statement,
      references: data.statement.references.map((reference, index) => ({ ...reference, hash: `citation-${index}` })),
    };
    proposed = true;
    return { ok: true, candidate: candidate.id };
  },
  confirmSubjectRelation: async ({ data }: { data: RelationConfirmation }) => {
    commands.push(data);
    if (pauseSelection)
      await new Promise<void>((resolve) => {
        finishSelection = resolve;
      });
    accepted = true;
    return { ok: true, kind: data.operation === 'adopt' ? 'selected' : 'accepted', public: example.fixture.studio };
  },
}));
const producerReads: { data: Record<string, unknown> }[] = [];
mock.module('../src/features/catalogue/producer-history/actions', () => ({
  readSubjectProducerHistory: async (input: { data: Record<string, unknown> }) => {
    producerReads.push(input);
    const { stream, cursor, session } = input.data as { stream?: string; cursor?: string; session?: string };
    if (failBackward) {
      failBackward = false;
      return { ok: false, reason: 'unavailable' };
    }
    return windows.transport.read(stream, cursor, session);
  },
}));

const locale = 'en';
const globalContext = candidateContext;
const unsupportedContext = '00000000-0000-4000-8000-00000000d812';
const realm = '00000000-0000-4000-8000-00000000d813';
const selected = windows.studio.subject.statements['wdt:P749']![1]!.id;

function historyFragment(context: string) {
  return organizationHistoryVisitReturnFragment({
    holder: producerStudioId,
    context,
    locale,
    property: 'wdt:P749',
    candidate: selected,
    revision: 1,
    release: windows.studio.subject.release,
    focus: 'keyboard',
  });
}

test('Organization origin completes three producer windows, exact Retry and correction, then returns with private retirement', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: `https://site.test/${locale}/subjects/${producerStudioId}/paper-lantern-studio` });
  window.scrollTo = () => undefined;
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    HTMLButtonElement: window.HTMLButtonElement,
    HTMLInputElement: window.HTMLInputElement,
    Element: window.Element,
    Node: window.Node,
    Document: window.Document,
    DocumentFragment: window.DocumentFragment,
    MutationObserver: window.MutationObserver,
    ResizeObserver: window.ResizeObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    scrollTo: window.scrollTo,
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const saved = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

  const { act, createElement: h } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { createMemoryHistory, createRootRouteWithContext, createRoute, createRouter, Outlet, RouterProvider } =
    await import('@tanstack/react-router');
  const { OrganizationReader } = await import('../src/features/catalogue/organization-reader/view');
  const { ProducerHistoryEntry } = await import('../src/features/catalogue/producer-history/entry');
  const { Route: ProducerRoute } = await import('../src/routes/subjects/$id_.$slug.producer');
  const { setLocale } = await import('../src/paraglide/runtime.js');
  const { browserObservation } = await import('../src/session/observation');
  const { producerHistoryEntryVisit, producerHistoryVisitReturn } =
    await import('../src/features/catalogue/producer-history/visit');
  const messages = await import('../src/paraglide/messages.js');
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  queryClient.setQueryData(['session'], { state: 'signed-in', subject: 'origin-reader', csrfToken: 'csrf-origin' });
  const stopObservation = browserObservation(queryClient).subscribeCache(() => {});

  const rootRoute = createRootRouteWithContext<{ queryClient: typeof queryClient }>()({ component: Outlet });
  const localeRoute = createRoute({ getParentRoute: () => rootRoute, path: '/$locale', component: Outlet });
  const OriginRoute = createRoute({
    getParentRoute: () => localeRoute,
    path: `/subjects/$id/$slug`,
    validateSearch: (search: Record<string, unknown>) => {
      if (typeof search.context !== 'string') throw new Error('Expected the public reading Context');
      return { context: search.context };
    },
    component: PublicOrigin,
  });
  function PublicOrigin() {
    const { context } = OriginRoute.useSearch();
    const currentHref = `/${locale}/subjects/${producerStudioId}/paper-lantern-studio?context=${context}${historyFragment(context)}`;
    return h(
      'div',
      {},
      context === globalContext &&
        h(OrganizationReader, {
          read: { public: windows.studio, release: windows.release },
          locale,
          currentHref,
        }),
      h(ProducerHistoryEntry, {
        id: producerStudioId,
        label: 'Paper Lantern Studio',
        locale,
        context,
        currentHref,
      }),
    );
  }

  ProducerRoute.update({
    id: '/subjects/$id/$slug/producer',
    path: '/subjects/$id/$slug/producer',
    getParentRoute: () => localeRoute,
    head: () => ({}),
  } as never);
  const history = createMemoryHistory({
    initialEntries: [`/${locale}/subjects/${producerStudioId}/paper-lantern-studio?context=${globalContext}`],
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([localeRoute.addChildren([OriginRoute, ProducerRoute])]),
    context: { queryClient },
    history,
    defaultPendingMs: 0,
    defaultPendingMinMs: 0,
  });
  const host = window.document.createElement('main');
  window.document.body.append(host);
  const root = createRoot(host);
  const previousLocale = (await import('../src/paraglide/runtime.js')).getLocale();
  setLocale(locale, { reload: false });
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  const link = (name: string) =>
    [...host.querySelectorAll<HTMLAnchorElement>('a')].find((item) => item.textContent === name)!;
  const navigate = async (href: string) =>
    act(async () => {
      window.history.replaceState(null, '', href);
      await router.navigate({ href });
      await tick();
    });

  try {
    await act(async () => {
      await router.load();
      root.render(h(QueryClientProvider, { client: queryClient }, h(RouterProvider, { router })));
      await tick();
    });

    const publicEntry = link(messages.m.producer_history_title());
    expect(publicEntry).toBeDefined();
    const admittedHref = new URL(publicEntry.getAttribute('href')!, 'https://site.test');
    expect(admittedHref.searchParams.get('context')).toBe(globalContext);
    const admittedReturn = admittedHref.searchParams.get('via')!;
    expect(admittedReturn).toBe(
      `/${locale}/subjects/${producerStudioId}/paper-lantern-studio?context=${globalContext}${historyFragment(globalContext)}`,
    );

    await navigate(`${admittedHref.pathname}${admittedHref.search}`);
    await act(async () => tick());
    expect(router.state.location.pathname).toBe(admittedHref.pathname);
    expect(host.textContent).toContain(messages.m.producer_history_intro());
    expect(producerReads.length).toBe(1);
    expect(producerReads[0]!.data.id).toBe(producerStudioId);
    expect(producerReads[0]!.data.context).toBeUndefined();
    const pageReturn = link(messages.m.producer_history_back());
    expect(pageReturn.getAttribute('href')).toBe(admittedReturn);

    const button = (name: string, region: ParentNode = host) =>
      [...region.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent === name)!;
    const click = async (name: string, region: ParentNode = host) => act(async () => button(name, region).click());
    const m = messages.m;
    await click(m.producer_history_more());
    await click(m.producer_history_more());
    expect(host.textContent).toContain(m.producer_history_empty());
    expect(host.querySelectorAll('li[data-slot="list-row"]')).toHaveLength(0);
    failBackward = true;
    await click(m.producer_history_previous());
    const failedTarget = producerReads.at(-1)!.data;
    expect(host.textContent).toContain(m.producer_history_unavailable());
    button(m.producer_history_retry()).focus();
    await click(m.producer_history_retry());
    expect(producerReads.at(-1)!.data).toEqual(failedTarget);
    expect(failedTarget).toMatchObject({ cursor: 'window-2', session: 'window-session-1' });
    expect(window.document.activeElement?.tagName).toBe('H2');
    await click(m.producer_history_first());
    expect(producerReads.at(-1)!.data.cursor).toBeUndefined();
    expect(producerReads.at(-1)!.data.session).toBeUndefined();
    await click(m.producer_history_more());
    await click(m.producer_history_previous());
    const origin = producerReads.at(-1)!.data;
    const occurrences = host.querySelectorAll('li[data-slot="list-row"]');
    expect(occurrences).toHaveLength(2);
    expect(occurrences[0]!.querySelector('h2,h3')!.textContent).toBe(
      occurrences[1]!.querySelector('h2,h3')!.textContent,
    );
    await click(m.producer_history_inspect(), occurrences[1]!);
    await click(m.producer_history_correct(), occurrences[1]!);
    await click(m.relation_open());
    await act(async () => {
      const input = host.querySelector<HTMLInputElement>('input[type="url"]')!;
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(
        input,
        'https://example.org/corrected-history',
      );
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    await click(m.relation_add_citation());
    for (const action of [m.relation_propose(), m.candidate_accept(), m.candidate_adopt()]) {
      await click(action);
      const group = host.querySelector(`[aria-label="${m.candidate_confirm_title({ action })}"]`)!;
      button(action, group).focus();
      await click(action, group);
    }
    expect(commands[0]).toMatchObject({
      id: producerStudioId,
      slot: { property: 'wdt:P749', target: example.fixture.similar.subject.id },
    });
    expect(commands).toHaveLength(3);
    expect((commands[0] as RelationProposal).statement.references).toHaveLength(2);
    expect((commands[0] as RelationProposal).statement.references[1]!.parts[0]!.value).toEqual({
      type: 'value',
      content: 'https://example.org/corrected-history',
    });
    expect(windows.calls.filter((call) => call.path.endsWith('/relations'))).toHaveLength(producerReads.length - 1);
    expect(producerReads.at(-1)!.data).toEqual(origin);
    expect(host.querySelector('li[aria-current="true"] h2,li[aria-current="true"] h3')).toBe(
      window.document.activeElement,
    );
    expect(host.textContent).toContain(m.producer_history_correction_retired());
    await click(m.producer_history_retired_close());
    expect(
      [...host.querySelectorAll('button')].some((item) => item.textContent === m.producer_history_previous()),
    ).toBe(false);
    await click(m.producer_history_correct(), host.querySelectorAll('li[data-slot="list-row"]')[1]!);
    await click(m.relation_open());
    await click(m.candidate_review());
    await click(m.candidate_adopt());
    const decision = host.querySelector(
      `[aria-label="${m.candidate_confirm_title({ action: m.candidate_adopt() })}"]`,
    )!;
    button(m.candidate_adopt(), decision).focus();
    pauseSelection = true;
    await click(m.candidate_adopt(), decision);
    const toolbar = window.document.createElement('button');
    window.document.body.append(toolbar);
    toolbar.focus();
    await act(async () => finishSelection!());
    expect(window.document.activeElement).toBe(toolbar);
    toolbar.remove();
    pauseSelection = false;
    await click(m.producer_history_retired_close());
    await navigate(link(m.producer_history_back()).getAttribute('href')!);
    expect(router.state.location.hash).toBe(historyFragment(globalContext).slice(1));
    expect(host.querySelector('[role="region"]')?.textContent).toContain(selected);
    expect(window.document.activeElement).toBe(host.querySelector('[role="region"]'));
    const journeyReads = producerReads.length - 1;

    await navigate(`/${locale}/subjects/${producerStudioId}/paper-lantern-studio?context=${unsupportedContext}`);
    const unsupportedEntry = link(messages.m.producer_history_title());
    const unsupportedHref = new URL(unsupportedEntry.getAttribute('href')!, 'https://site.test');
    expect(unsupportedHref.searchParams.get('context')).toBe(unsupportedContext);
    const unsupportedReturn = unsupportedHref.searchParams.get('via')!;
    await navigate(`${unsupportedHref.pathname}${unsupportedHref.search}`);
    expect(host.textContent).toContain(messages.m.producer_history_context_unavailable());
    expect(producerReads.length).toBe(1 + journeyReads);
    const refusalReturn = link(messages.m.producer_history_back());
    expect(refusalReturn.getAttribute('href')).toBe(unsupportedReturn);
    const globalVisit = link(messages.m.producer_history_global_visit());
    const globalHref = new URL(globalVisit.getAttribute('href')!, 'https://site.test');
    expect(globalHref.searchParams.has('context')).toBe(false);
    expect(globalHref.searchParams.has('realm')).toBe(false);
    expect(globalHref.searchParams.get('via')).toBe(unsupportedReturn);

    await navigate(`${globalHref.pathname}${globalHref.search}`);
    await act(async () => tick());
    expect(router.state.location.search.context).toBeUndefined();
    expect(producerReads.length).toBe(2 + journeyReads);
    expect(producerReads[1 + journeyReads]!.data.context).toBeUndefined();
    expect(host.textContent).toContain(messages.m.producer_history_title());

    await navigate(`/${locale}/subjects/${producerStudioId}/paper-lantern-studio/producer`);
    await act(async () => tick());
    expect(router.state.location.search).toEqual({});
    expect(producerReads.length).toBe(3 + journeyReads);

    const realmReturn = `/${locale}/subjects/${producerStudioId}/paper-lantern-studio?context=${globalContext}&realm=${realm}#connections`;
    await navigate(
      `/${locale}/subjects/${producerStudioId}/paper-lantern-studio/producer?context=${globalContext}&realm=${realm}&via=${encodeURIComponent(realmReturn)}`,
    );
    expect(host.textContent).toContain(messages.m.producer_history_context_unavailable());
    expect(producerReads.length).toBe(3 + journeyReads);
    const realmGlobal = new URL(
      link(messages.m.producer_history_global_visit()).getAttribute('href')!,
      'https://site.test',
    );
    expect(realmGlobal.searchParams.has('context')).toBe(false);
    expect(realmGlobal.searchParams.has('realm')).toBe(false);
    expect(realmGlobal.searchParams.get('via')).toBe(realmReturn);
    await navigate(`${realmGlobal.pathname}${realmGlobal.search}`);
    await act(async () => tick());
    expect(producerReads.length).toBe(4 + journeyReads);

    await click(m.producer_history_more());
    expect(button(m.producer_history_previous())).toBeDefined();
    for (const [key, value] of [
      [['session'], { state: 'signed-in', subject: 'origin-reader', csrfToken: 'csrf-origin' }],
      [['exposure', 'viewer'], []],
      [['exposure', 'viewer'], []],
      [['session'], { state: 'signed-in', subject: 'other-reader', csrfToken: 'csrf-other' }],
      [['session'], { state: 'signed-in', subject: 'origin-reader', csrfToken: 'csrf-origin' }],
    ] as const) {
      await act(async () => {
        queryClient.setQueryData(key, value);
        await tick();
      });
      expect(
        [...host.querySelectorAll('button')].some((item) => item.textContent === m.producer_history_previous()),
      ).toBe(false);
      await click(m.producer_history_more());
    }

    const oversized = producerHistoryEntryVisit({
      href: `/${locale}/subjects/${producerStudioId}/paper-lantern-studio/producer?context=${unsupportedContext}`,
      currentHref: `/${locale}/subjects/${producerStudioId}/${'history-'.repeat(250)}?context=${unsupportedContext}${historyFragment(unsupportedContext)}`,
      fallbackHref: `/${locale}/subjects/${producerStudioId}/organization`,
      id: producerStudioId,
      locale,
      context: unsupportedContext,
    });
    expect(oversized?.restarted).toBe(true);
    expect(oversized?.returnHref).toContain('#connections');
    expect(oversized?.returnHref).not.toContain('#organization-history');

    expect(
      producerHistoryVisitReturn(unsupportedReturn, {
        id: '00000000-0000-4000-8000-00000000d899',
        locale,
        context: unsupportedContext,
      }),
    ).toBeUndefined();
    expect(
      producerHistoryVisitReturn(unsupportedReturn, {
        id: producerStudioId,
        locale: 'ja',
        context: unsupportedContext,
      }),
    ).toBeUndefined();
    expect(
      producerHistoryVisitReturn(unsupportedReturn, {
        id: producerStudioId,
        locale,
        context: globalContext,
      }),
    ).toBeUndefined();
    expect(
      producerHistoryVisitReturn(
        `/${locale}/subjects/${producerStudioId}/paper-lantern-studio?context=${unsupportedContext}&realm=${realm}#connections`,
        { id: producerStudioId, locale, context: unsupportedContext, realm: '00000000-0000-4000-8000-00000000d899' },
      ),
    ).toBeUndefined();
    expect(
      producerHistoryVisitReturn(
        `/${locale}/subjects/${producerStudioId}/paper-lantern-studio?context=${unsupportedContext}&context=${unsupportedContext}#connections`,
        { id: producerStudioId, locale, context: unsupportedContext },
      ),
    ).toBeUndefined();
    const overBudget = `${unsupportedReturn}${'x'.repeat(2049)}`;
    expect(
      producerHistoryVisitReturn(overBudget, { id: producerStudioId, locale, context: unsupportedContext }),
    ).toBeUndefined();
    const validate = (ProducerRoute.options as { validateSearch?: (search: Record<string, unknown>) => unknown })
      .validateSearch!;
    expect(() => validate({ context: globalContext, extra: 'closed' })).toThrow();
    expect(() => validate({ context: globalContext, via: ['first', 'second'] })).toThrow();
    expect(() => validate({ via: 'x'.repeat(2049) })).toThrow();
  } finally {
    await act(async () => root.unmount());
    stopObservation();
    queryClient.clear();
    await window.happyDOM.abort();
    setLocale(previousLocale, { reload: false });
    for (const [key, value] of saved)
      value ? Object.defineProperty(globalThis, key, value) : Reflect.deleteProperty(globalThis, key);
    producerReads.length = 0;
  }
});
