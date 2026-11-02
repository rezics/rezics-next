import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import * as start from '../.storybook/react-start';
import type { OverviewValue, Section } from '../src/features/pages/overview';
import type { RelationGroupRequest } from '../src/features/pages/relation-stream-query';
import type { Reader } from '../src/subject/reader';

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason?: unknown): void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

type HeldRelation = {
  request: RelationGroupRequest;
  response: Deferred<Section>;
};

let heldRelations: HeldRelation[] = [];

function relationRequest(value: unknown): value is RelationGroupRequest {
  return typeof value === 'object' && value !== null && 'subject' in value && 'node' in value && 'cursor' in value;
}

// The existing loadRelationGroup BFF call is the only gate. Its validator, key function,
// mounted component, QueryClient, session QueryCache, and per-owner continuation cache are real.
function createServerFn() {
  let validate: ((input: unknown) => unknown) | undefined;
  const chain = {
    validator(next: (input: unknown) => unknown) {
      validate = next;
      return chain;
    },
    handler<T extends (...args: never[]) => unknown>(handler: T): T {
      return ((input?: unknown) => {
        const supplied =
          typeof input === 'object' && input !== null && 'data' in input
            ? (input as { data: unknown }).data
            : undefined;
        const data = validate ? validate(supplied) : supplied;
        if (relationRequest(data)) {
          const response = deferred<Section>();
          heldRelations.push({ request: data, response });
          return response.promise;
        }
        return Promise.resolve(handler({ data } as never));
      }) as T;
    },
  };
  return chain;
}

function installWindow(window: InstanceType<typeof import('happy-dom').Window>) {
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    location: window.location,
    HTMLElement: window.HTMLElement,
    HTMLAnchorElement: window.HTMLAnchorElement,
    Element: window.Element,
    Node: window.Node,
    Document: window.Document,
    DocumentFragment: window.DocumentFragment,
    MutationObserver: window.MutationObserver,
    ResizeObserver: window.ResizeObserver,
    Event: window.Event,
    MouseEvent: window.MouseEvent,
    KeyboardEvent: window.KeyboardEvent,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  return () => {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  };
}

type ReadingSpec = {
  subject: string;
  targetSubject: string;
  accountId?: string;
  contextId: string;
  populationId: string;
  realm: string;
  readerId: string | null;
  locale: string;
  node: string;
  view: string;
  cursor: string;
  label: string;
  reader: Reader;
  readKind?: 'links' | 'relations';
};

type Reading = {
  spec: ReadingSpec;
  value: OverviewValue;
  section: Section;
  node: string;
  view: string;
  title: string;
};

function makeReading(spec: ReadingSpec, createElement: typeof import('react').createElement): Reading {
  const context = {
    id: spec.contextId,
    population: { kind: 'realm' as const, id: spec.populationId, title: 'Selected population' },
  };
  const value = {
    locale: spec.locale,
    pageTarget: { subject: spec.targetSubject },
    context,
    realm: spec.realm,
    cacheReader: spec.readerId,
    subject: spec.subject,
    subjectLabel: spec.label,
    ...(spec.accountId ? { account: { id: spec.accountId, handle: 'fixture-account' } } : {}),
    link: ({ href, children, ...props }: { href: string; children?: unknown; [key: string]: unknown }) =>
      createElement('a', { ...props, href }, children as never),
    reader: spec.reader,
    labels: { spoilerShow: 'Show spoilers', cover: { withheld: '', reveal: '', credit: '', via: '' } },
    unlabelled: 'Untitled',
    spoilerShow: 'Show spoilers',
    details: 'Details',
    cover: 'Cover credit',
    coverVia: 'via',
    licence: 'Licence',
    source: 'Source',
    sources: 'Sources',
    sections: new Map(),
    relations: {},
    relationNodes: [],
  } as unknown as OverviewValue;
  const section: Section =
    spec.readKind === 'relations'
      ? {
          ok: true,
          read: { kind: 'relations', id: spec.subject, context: spec.contextId, property: 'schema:author', limit: 12 },
          body: { relations: [relationRow(`initial-${spec.node}-${spec.label}`, spec.label)], next: spec.cursor },
        }
      : {
          ok: true,
          read: { kind: 'links', id: spec.subject, context: spec.contextId, property: 'schema:author', limit: 12 },
          body: {
            links: [
              {
                subject: '0192f3a0-6c1e-7b2a-9d4e-000000000102',
                label: spec.label,
                type: 'schema:Book',
                property: 'schema:author',
                statement: `initial-${spec.node}-${spec.label}`,
              },
            ],
            next: spec.cursor,
          },
        };
  return { spec, value, section, node: spec.node, view: spec.view, title: spec.label };
}

function relationRow(statementId: string, label: string) {
  const target = '0192f3a0-6c1e-7b2a-9d4e-000000000102';
  return {
    target,
    label,
    type: 'schema:Person',
    statement: {
      id: statementId,
      rank: 'normal',
      property: { id: 'schema:author', data_type: 'wikibase-item' },
      value: { type: 'value', content: target },
      qualifiers: [
        {
          property: { id: 'wdt:P3831', data_type: 'string' },
          value: { type: 'value', content: 'Illustrator' },
        },
      ],
      references: [],
    },
    summary: { id: target, type: 'schema:Person', label: { value: label, language: 'en' } },
    related: {},
  };
}

function continuation(
  request: RelationGroupRequest,
  label: string,
  next: string | null,
  kind: 'links' | 'relations' = 'links',
): Section {
  if (kind === 'relations')
    return {
      ok: true,
      read: {
        kind,
        id: request.subject,
        context: request.context,
        property: 'schema:author',
        limit: 12,
      },
      body: { relations: [relationRow(`statement-${label}`, label)], next },
    };
  return {
    ok: true,
    read: {
      kind: 'links',
      id: request.subject,
      context: request.context,
      property: 'schema:author',
      limit: 12,
    },
    body: {
      links: [
        {
          subject: '0192f3a0-6c1e-7b2a-9d4e-000000000102',
          label,
          type: 'schema:Book',
          property: 'schema:author',
          statement: `statement-${label}`,
        },
      ],
      next,
    },
  };
}

function cacheKeyFor(client: import('@tanstack/react-query').QueryClient, request: RelationGroupRequest) {
  return client
    .getQueryCache()
    .getAll()
    .find(
      (query) =>
        query.queryKey[0] === 'subject-relation-group' &&
        query.queryKey[1] === request.subject &&
        query.queryKey[5] === request.node &&
        query.queryKey[6] === request.cursor,
    )?.queryKey;
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

// Authored UNRUN: one mounted campaign for actual reader-cache health, transition, request ownership and recovery.
test('private unmount cannot bless borrowed relation rows after unobserved session recovery', async () => {
  heldRelations = [];
  mock.module('@tanstack/react-start', () => ({ ...start, createServerFn }));
  mock.module('@tanstack/react-start/server', () => ({ ...start, createServerFn }));

  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://rezics.test/en/subjects/relations' });
  const restoreGlobals = installWindow(window);

  try {
    const [
      { createRoot },
      { QueryClient, QueryClientProvider },
      { createElement: h, useState: reactUseState, StrictMode: ReactStrictMode },
      { createMemoryHistory, createRootRoute, createRouter, RouterProvider },
      { userEvent },
      { defaultReader },
      { RelationStream },
      { sessionQuery },
      { relationGroupKey },
      { setLocale },
    ] = await Promise.all([
      import('react-dom/client'),
      import('@tanstack/react-query'),
      import('react'),
      import('@tanstack/react-router'),
      import('storybook/test'),
      import('../src/subject/reader'),
      import('../src/features/pages/relation-stream'),
      import('../src/session/query'),
      import('../src/features/pages/relation-stream-query'),
      import('../src/paraglide/runtime.js'),
    ]);
    setLocale('en', { reload: false });

    const ids = {
      subjectA: '0192f3a0-6c1e-7b2a-9d4e-000000000101',
      subjectB: '0192f3a0-6c1e-7b2a-9d4e-000000000102',
      targetB: '0192f3a0-6c1e-7b2a-9d4e-000000000103',
      account: '0192f3a0-6c1e-7b2a-9d4e-000000000104',
      contextA: '0192f3a0-6c1e-7b2a-9d4e-000000000201',
      contextB: '0192f3a0-6c1e-7b2a-9d4e-000000000202',
      populationA: '0192f3a0-6c1e-7b2a-9d4e-000000000301',
      populationB: '0192f3a0-6c1e-7b2a-9d4e-000000000302',
      realmA: '0192f3a0-6c1e-7b2a-9d4e-000000000401',
      realmB: '0192f3a0-6c1e-7b2a-9d4e-000000000402',
    };
    const sessionA = { state: 'signed-in', subject: 'reader-A', csrfToken: null } as const;
    const sessionB = { state: 'signed-in', subject: 'reader-B', csrfToken: null } as const;
    const clientB = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
    const clients = [clientB];
    clientB.setQueryData(sessionQuery.queryKey, sessionA);

    const baseSpec: ReadingSpec = {
      subject: ids.subjectA,
      targetSubject: ids.subjectA,
      contextId: ids.contextA,
      populationId: ids.populationA,
      realm: ids.realmA,
      readerId: 'reader-A',
      locale: 'en',
      node: 'side-stories',
      view: 'relations',
      cursor: 'fixture-side-stories-next',
      label: 'First A',
      reader: defaultReader,
    };
    const secondSpec: ReadingSpec = {
      ...baseSpec,
      node: 'adaptations',
      view: 'works',
      cursor: 'fixture-adaptations-next',
      label: 'First adaptations',
      readKind: 'relations',
    };
    const publicSpec: ReadingSpec = {
      ...baseSpec,
      view: 'editions',
      readerId: null,
      node: 'public-links',
      cursor: 'fixture-public-next',
      label: 'Public first row',
    };
    const first = makeReading(baseSpec, h);
    const second = makeReading(secondSpec, h);
    const sharedBase = makeReading({ ...baseSpec, node: 'shared-links', label: 'Shared stream' }, h);
    const shared: Reading = {
      ...sharedBase,
      section:
        first.section.ok && sharedBase.section.ok
          ? { ...sharedBase.section, body: first.section.body }
          : sharedBase.section,
    };
    const publicReading = makeReading(publicSpec, h);
    let replacePrimary: (reading: Reading) => void = () => {};
    let replaceSecondary: (reading: Reading) => void = () => {};
    let replaceClient: (client: InstanceType<typeof QueryClient>) => void = () => {};
    let setPrimaryMounted: (mounted: boolean) => void = () => {};
    let setSecondaryMounted: (mounted: boolean) => void = () => {};
    let setSharedMounted: (mounted: boolean) => void = () => {};
    let currentPrimary = first;
    let currentSecondary = second;
    let invalidations = 0;

    function Screen() {
      const [primary, setPrimary] = reactUseState(first);
      const [secondary, setSecondary] = reactUseState(second);
      const [primaryMounted, updatePrimaryMounted] = reactUseState(true);
      const [secondaryMounted, updateSecondaryMounted] = reactUseState(true);
      const [sharedMounted, updateSharedMounted] = reactUseState(true);
      replacePrimary = setPrimary;
      replaceSecondary = setSecondary;
      setPrimaryMounted = updatePrimaryMounted;
      setSecondaryMounted = updateSecondaryMounted;
      setSharedMounted = updateSharedMounted;
      currentPrimary = primary;
      currentSecondary = secondary;
      return h(
        'main',
        null,
        primaryMounted ? h(RelationStream, primary) : null,
        secondaryMounted ? h(RelationStream, secondary) : null,
        h(RelationStream, publicReading),
        sharedMounted ? h(RelationStream, shared) : null,
        h('button', { id: 'outside-reading' }, 'Outside reading'),
      );
    }

    function Harness() {
      const [client, setClient] = reactUseState(clientB);
      replaceClient = setClient;
      return h(QueryClientProvider, { client }, h(RouterProvider, { router }));
    }

    const route = createRootRoute({ component: Screen });
    const history = createMemoryHistory({ initialEntries: ['/en/subjects/relations'] });
    const router = createRouter({ routeTree: route, history });
    const originalInvalidate = router.invalidate.bind(router);
    Object.defineProperty(router, 'invalidate', {
      configurable: true,
      value: (...args: Parameters<typeof router.invalidate>) => {
        invalidations += 1;
        return originalInvalidate(...args);
      },
    });
    await router.load();

    const host = window.document.createElement('div');
    window.document.body.append(host);
    const root = createRoot(host as unknown as HTMLElement);
    let rootMounted = true;
    const stream = (node: string) =>
      host.querySelector<HTMLElement>(`[data-slot="relation-stream"][data-node="${node}"]`)!;
    const trigger = (node: string) => stream(node).querySelector<HTMLAnchorElement>('[data-slot="continue-group"]')!;
    const status = (node: string) => stream(node).querySelector<HTMLElement>('[aria-live="polite"]')!;
    const outside = () => host.querySelector<HTMLButtonElement>('#outside-reading')!;
    const startMore = async (node: string) => {
      const action = trigger(node);
      action.focus();
      await act(async () => {
        await userEvent.keyboard('{Enter}');
      });
      await settle();
      return action;
    };
    const replaceWith = async (reading: Reading) => {
      await act(async () => replacePrimary(reading));
      await settle();
    };
    const replaceWithMounted = async (reading: Reading) => {
      await act(async () => {
        replacePrimary(reading);
        setPrimaryMounted(true);
      });
      await settle();
    };
    const mountPrimary = async (mounted: boolean) => {
      await act(async () => setPrimaryMounted(mounted));
      await settle();
    };
    const mountSecondary = async (mounted: boolean) => {
      await act(async () => setSecondaryMounted(mounted));
      await settle();
    };
    const mountShared = async (mounted: boolean) => {
      await act(async () => setSharedMounted(mounted));
      await settle();
    };
    const assertPendingKey = (client: InstanceType<typeof QueryClient>, held: HeldRelation) => {
      const key = cacheKeyFor(client, held.request);
      expect(key).toBeDefined();
      expect(key).toEqual(relationGroupKey(held.request, key?.at(-1) as string));
      return key!;
    };
    const expectRetired = (node: string) => {
      expect(stream(node).textContent).not.toContain('Retired continuation row');
      expect(stream(node).querySelector('[data-slot="continue-group"]')).toBeNull();
      expect(status(node).textContent).toBe('');
      expect(stream(node).getAttribute('aria-busy')).not.toBe('true');
    };

    try {
      await act(async () => root.render(h(ReactStrictMode, null, h(Harness))));
      expect(stream('side-stories').textContent).toContain('First A');
      expect(stream('adaptations').textContent).toContain('First adaptations');
      expect(stream('adaptations').textContent).toContain('Illustrator');
      expect(stream('public-links').textContent).toContain('Public first row');
      expect(shared.section).not.toBe(first.section);
      expect(first.section.ok).toBe(true);
      expect(shared.section.ok).toBe(true);
      if (first.section.ok && shared.section.ok) expect(shared.section.body).toBe(first.section.body);
      clientB.setQueryData(['subject-relation-group', 'another-owner'], { sentinel: true });

      // Distinct live nodes can share the exact prepared body. Releasing one owner closes new borrowing
      // without taking rows, its pending query, completion, or focus from the other live owner.
      const originalAction = await startMore('side-stories');
      const originalRequest = heldRelations.at(-1)!;
      const originalKey = assertPendingKey(clientB, originalRequest);
      const sharedAction = await startMore('shared-links');
      const sharedRequest = heldRelations.at(-1)!;
      const sharedKey = assertPendingKey(clientB, sharedRequest);
      expect(originalKey).not.toEqual(sharedKey);
      await mountPrimary(false);
      expect(clientB.getQueryCache().find({ queryKey: originalKey, exact: true })).toBeUndefined();
      expect(clientB.getQueryCache().find({ queryKey: sharedKey, exact: true })).toBeDefined();

      const borrowedBase = makeReading({ ...baseSpec, label: 'Borrowed after actual unmount' }, h);
      const borrowedAfterUnmount: Reading = {
        ...borrowedBase,
        section:
          first.section.ok && borrowedBase.section.ok
            ? { ...borrowedBase.section, body: first.section.body }
            : borrowedBase.section,
      };
      await replaceWithMounted(borrowedAfterUnmount);
      expectRetired('side-stories');
      expect(stream('side-stories').textContent).not.toContain('First A');
      expect(stream('side-stories').querySelector('[role="alert"]')).not.toBeNull();
      expect(stream('side-stories').querySelector('[href*="node=side-stories"]')).not.toBeNull();
      expect(stream('shared-links').textContent).toContain('First A');
      expect(clientB.getQueryCache().find({ queryKey: sharedKey, exact: true })).toBeDefined();
      expect(window.document.activeElement).toBe(sharedAction);
      sharedRequest.response.resolve(continuation(sharedRequest.request, 'Shared stream continuation', 'shared-next'));
      await settle();
      expect(stream('shared-links').textContent).toContain('Shared stream continuation');
      expect(status('shared-links').textContent).toContain(': 1. You can load more.');
      expect(trigger('shared-links').getAttribute('href')).toContain('cursor=shared-next');
      expect(window.document.activeElement).toBe(sharedAction);
      expect(clientB.getQueryCache().find({ queryKey: sharedKey, exact: true })).toBeUndefined();
      expect(invalidations).toBe(0);

      const afterBorrowedRecovery = makeReading({ ...baseSpec, label: 'Fresh after borrowed remount' }, h);
      await replaceWithMounted(afterBorrowedRecovery);
      const freshAction = await startMore('side-stories');
      const freshRequest = heldRelations.at(-1)!;
      const freshKey = assertPendingKey(clientB, freshRequest);
      expect(freshKey).not.toEqual(originalKey);
      expect(clientB.getQueryCache().find({ queryKey: freshKey, exact: true })).toBeDefined();
      originalRequest.response.resolve(continuation(originalRequest.request, 'Retired continuation row', null));
      await settle();
      expect(stream('side-stories').textContent).toContain('Fresh after borrowed remount');
      expect(stream('side-stories').textContent).not.toContain('Retired continuation row');
      expect(status('side-stories').textContent).toContain('Loading more');
      expect(clientB.getQueryCache().find({ queryKey: originalKey, exact: true })).toBeUndefined();
      expect(clientB.getQueryCache().find({ queryKey: freshKey, exact: true })).toBeDefined();
      expect(window.document.activeElement).toBe(freshAction);
      freshRequest.response.resolve(
        continuation(freshRequest.request, 'Fresh continuation after old cleanup', 'fresh-next'),
      );
      await settle();
      expect(stream('side-stories').textContent).toContain('Fresh continuation after old cleanup');
      expect(clientB.getQueryCache().find({ queryKey: freshKey, exact: true })).toBeUndefined();
      expect(window.document.activeElement).toBe(freshAction);
      expect(invalidations).toBe(0);
      void originalAction;

      // With every private owner unmounted, A/B/A and retained-data error/equal recovery cannot
      // make an old reading current again. Rebuilt containers still borrow the retired row objects.
      await mountPrimary(false);
      await mountSecondary(false);
      await mountShared(false);
      await act(async () => {
        clientB.setQueryData(sessionQuery.queryKey, sessionB);
        clientB.setQueryData(sessionQuery.queryKey, sessionA);
      });
      await settle();
      const borrowedRowsBase = makeReading({ ...baseSpec, label: 'Copied containers after unobserved ABA' }, h);
      const initialLinks = first.section.ok ? first.section.body.links : undefined;
      const borrowedRowsSection: Section =
        first.section.ok && borrowedRowsBase.section.ok && Array.isArray(initialLinks)
          ? { ...borrowedRowsBase.section, body: { ...first.section.body, links: [...initialLinks] } }
          : borrowedRowsBase.section;
      await replaceWithMounted({ ...borrowedRowsBase, section: borrowedRowsSection });
      expectRetired('side-stories');
      expect(stream('side-stories').textContent).not.toContain('First A');
      expect(stream('side-stories').querySelector('[role="alert"]')).not.toBeNull();
      expect(stream('side-stories').querySelector('[href*="node=side-stories"]')).not.toBeNull();

      const afterUnobservedAba = makeReading({ ...baseSpec, label: 'Fresh A after unobserved ABA' }, h);
      await replaceWithMounted(afterUnobservedAba);
      expect(stream('side-stories').textContent).toContain('Fresh A after unobserved ABA');
      const afterUnobservedAbaSecondary = makeReading(
        { ...secondSpec, label: 'Fresh adaptations after unobserved ABA' },
        h,
      );
      await act(async () => {
        replaceSecondary(afterUnobservedAbaSecondary);
        setSecondaryMounted(true);
      });
      await settle();

      const unobservedErrorAction = await startMore('side-stories');
      const unobservedErrorRequest = heldRelations.at(-1)!;
      const unobservedErrorKey = assertPendingKey(clientB, unobservedErrorRequest);
      outside().focus();
      await mountPrimary(false);
      await mountSecondary(false);
      expect(clientB.getQueryCache().find({ queryKey: unobservedErrorKey, exact: true })).toBeUndefined();
      const unobservedSessionError = clientB.fetchQuery({
        queryKey: sessionQuery.queryKey,
        staleTime: 0,
        retry: false,
        queryFn: async () => {
          throw new Error('Session query failed while its private relation owner was unmounted');
        },
      });
      await act(async () => {
        await unobservedSessionError.catch(() => undefined);
      });
      expect(clientB.getQueryState(sessionQuery.queryKey)?.status).toBe('error');
      expect(clientB.getQueryData(sessionQuery.queryKey)).toEqual(sessionA);
      clientB.setQueryData(sessionQuery.queryKey, sessionA);
      await settle();

      const copiedAfterError = makeReading({ ...baseSpec, label: 'Copied rows after retained error' }, h);
      const afterAbaLinks = afterUnobservedAba.section.ok ? afterUnobservedAba.section.body.links : undefined;
      const copiedAfterErrorSection: Section =
        afterUnobservedAba.section.ok && copiedAfterError.section.ok && Array.isArray(afterAbaLinks)
          ? {
              ...copiedAfterError.section,
              body: {
                ...afterUnobservedAba.section.body,
                links: [...afterAbaLinks],
              },
            }
          : copiedAfterError.section;
      await replaceWithMounted({ ...copiedAfterError, section: copiedAfterErrorSection });
      expectRetired('side-stories');
      expect(stream('side-stories').textContent).not.toContain('Fresh A after unobserved ABA');
      expect(stream('side-stories').querySelector('[role="alert"]')).not.toBeNull();
      unobservedErrorRequest.response.reject(new Error('Late rejection after borrowed remount'));
      await settle();
      expectRetired('side-stories');
      expect(clientB.getQueryCache().find({ queryKey: unobservedErrorKey, exact: true })).toBeUndefined();
      expect(window.document.activeElement).toBe(outside());
      expect(invalidations).toBe(0);
      void unobservedErrorAction;

      const afterUnobservedError = makeReading({ ...baseSpec, label: 'Fresh A after retained error' }, h);
      await replaceWithMounted(afterUnobservedError);
      const recoveredAction = await startMore('side-stories');
      const recoveredRequest = heldRelations.at(-1)!;
      const recoveredKey = assertPendingKey(clientB, recoveredRequest);
      recoveredRequest.response.resolve(
        continuation(recoveredRequest.request, 'Recovered continuation', 'recovered-next'),
      );
      await settle();
      expect(stream('side-stories').textContent).toContain('Fresh A after retained error');
      expect(stream('side-stories').textContent).toContain('Recovered continuation');
      expect(status('side-stories').textContent).toContain(': 1. You can load more.');
      expect(trigger('side-stories').getAttribute('href')).toContain('cursor=recovered-next');
      expect(clientB.getQueryCache().find({ queryKey: recoveredKey, exact: true })).toBeUndefined();
      expect(window.document.activeElement).toBe(recoveredAction);
      expect(invalidations).toBe(0);
      const recoveredSecondary = makeReading({ ...secondSpec, label: 'Fresh adaptations after error' }, h);
      await act(async () => {
        replaceSecondary(recoveredSecondary);
        setSecondaryMounted(true);
      });
      await settle();
      heldRelations = [];

      // A normal session refetch keeps the successful cached reader and must not retire the stream.
      const healthySessionQuery = clientB.getQueryCache().find({ queryKey: sessionQuery.queryKey, exact: true });
      const expectRecoveredReading = () => {
        const rows = stream('side-stories').querySelector('[data-layout="cover-grid"]');
        expect(rows?.textContent).not.toContain('Fresh A after retained error');
        expect(rows?.textContent).toContain('Recovered continuation');
        expect(status('side-stories').textContent).toContain(': 1. You can load more.');
        expect(trigger('side-stories')).toBe(recoveredAction);
        expect(trigger('side-stories').getAttribute('href')).toContain('cursor=recovered-next');
        expect(stream('side-stories').getAttribute('aria-busy')).toBe('false');
        expect(stream('side-stories').querySelector('[role="alert"]')).toBeNull();
        expect(clientB.getQueryCache().find({ queryKey: sessionQuery.queryKey, exact: true })).toBe(
          healthySessionQuery,
        );
        expect(clientB.getQueryCache().find({ queryKey: recoveredKey, exact: true })).toBeUndefined();
        expect(heldRelations).toHaveLength(0);
        expect(window.document.activeElement).toBe(recoveredAction);
        expect(invalidations).toBe(0);
      };
      const sameSession = deferred<typeof sessionA>();
      const sameSessionFetch = clientB.fetchQuery({
        queryKey: sessionQuery.queryKey,
        staleTime: 0,
        retry: false,
        queryFn: () => sameSession.promise,
      });
      await settle();
      expect(clientB.getQueryState(sessionQuery.queryKey)?.fetchStatus).toBe('fetching');
      expectRecoveredReading();
      sameSession.resolve(sessionA);
      await sameSessionFetch;
      await settle();
      expect(clientB.getQueryState(sessionQuery.queryKey)?.fetchStatus).toBe('idle');
      expectRecoveredReading();

      // Error with retained data retires synchronously. The old anchor is invoked before React commits.
      const errorAction = await startMore('side-stories');
      expect(heldRelations).toHaveLength(1);
      const errorRequest = heldRelations[0]!;
      expect(errorRequest.request.cursor).toBe('recovered-next');
      const errorKey = assertPendingKey(clientB, errorRequest);
      outside().focus();
      const sessionError = clientB.fetchQuery({
        queryKey: sessionQuery.queryKey,
        staleTime: 0,
        retry: false,
        queryFn: async () => {
          throw new Error('Session query failed while retaining its previous reader');
        },
      });
      const requestsBeforeErrorCallback = heldRelations.length;
      await act(async () => {
        await sessionError.catch(() => undefined);
        errorAction.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
      });
      expect(heldRelations).toHaveLength(requestsBeforeErrorCallback);
      expect(clientB.getQueryState(sessionQuery.queryKey)?.status).toBe('error');
      expect(clientB.getQueryData(sessionQuery.queryKey)).toEqual(sessionA);
      await settle();
      expectRetired('side-stories');
      expect(stream('side-stories').querySelector('[data-layout="cover-grid"]')).toBeNull();
      expect(stream('side-stories').textContent).not.toContain('Recovered continuation');
      expect(stream('side-stories').querySelector('[role="alert"]')).not.toBeNull();
      expect(stream('side-stories').querySelector('[href*="node=side-stories"]')).not.toBeNull();
      expect(clientB.getQueryCache().find({ queryKey: errorKey, exact: true })).toBeUndefined();
      expect(clientB.getQueryData(['subject-relation-group', 'another-owner'])).toEqual({ sentinel: true });
      expect(stream('public-links').textContent).toContain('Public first row');
      const publicAction = await startMore('public-links');
      const publicRequest = heldRelations.at(-1)!;
      expect(publicRequest.request).toMatchObject({ reader: null, node: 'public-links', cursor: publicSpec.cursor });
      publicRequest.response.resolve(
        continuation(publicRequest.request, 'Public continuation while session unavailable', 'public-next'),
      );
      await settle();
      expect(stream('public-links').textContent).toContain('Public continuation while session unavailable');
      expect(window.document.activeElement).toBe(publicAction);
      errorRequest.response.resolve(continuation(errorRequest.request, 'Retired continuation row', null));
      await settle();
      expectRetired('side-stories');
      expect(window.document.activeElement).toBe(publicAction);
      expect(invalidations).toBe(0);

      // Equal recovery alone cannot bless the retired section; a new section object starts a new visit.
      clientB.setQueryData(sessionQuery.queryKey, sessionA);
      await settle();
      expectRetired('side-stories');
      expect(stream('side-stories').querySelector('[data-layout="cover-grid"]')).toBeNull();
      expect(stream('side-stories').textContent).not.toContain('Recovered continuation');
      expect(stream('side-stories').textContent).not.toContain('First A');
      const borrowed = makeReading({ ...baseSpec, label: 'Borrowed wrapper' }, h);
      const borrowedSection: Section = afterUnobservedError.section.ok
        ? { ...afterUnobservedError.section, body: afterUnobservedError.section.body }
        : afterUnobservedError.section;
      await replaceWith({ ...borrowed, section: borrowedSection });
      expectRetired('side-stories');
      expect(stream('side-stories').textContent).not.toContain('Fresh A after retained error');
      expect(stream('side-stories').textContent).not.toContain('Recovered continuation');
      expect(stream('side-stories').textContent).not.toContain('First A');
      expect(stream('side-stories').querySelector('[role="alert"]')).not.toBeNull();
      const afterError = makeReading({ ...baseSpec, label: 'Fresh A after error' }, h);
      await replaceWith(afterError);
      expect(stream('side-stories').textContent).toContain('Fresh A after error');

      // One cache batch observes A -> B -> A even though React only sees the final equal value.
      const beforeAba = heldRelations.length;
      const abaAction = await startMore('side-stories');
      expect(heldRelations).toHaveLength(beforeAba + 1);
      const abaRequest = heldRelations.at(-1)!;
      const abaKey = assertPendingKey(clientB, abaRequest);
      outside().focus();
      const requestsBeforeAbaCallback = heldRelations.length;
      await act(async () => {
        clientB.setQueryData(sessionQuery.queryKey, sessionB);
        clientB.setQueryData(sessionQuery.queryKey, sessionA);
        abaAction.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
      });
      expect(heldRelations).toHaveLength(requestsBeforeAbaCallback);
      await settle();
      expectRetired('side-stories');
      expect(window.document.activeElement).toBe(outside());
      expect(clientB.getQueryCache().find({ queryKey: abaKey, exact: true })).toBeUndefined();
      abaRequest.response.resolve({ ok: false, status: 409 });
      await settle();
      expectRetired('side-stories');
      expect(invalidations).toBe(0);
      const afterAba = makeReading({ ...baseSpec, label: 'Fresh A after ABA' }, h);
      await replaceWith(afterAba);
      expect(stream('side-stories').textContent).toContain('Fresh A after ABA');

      // Sign-out, unknown admission, and removal followed by equal recreation are separate retirements.
      const signOutAction = await startMore('side-stories');
      const signOutRequest = heldRelations.at(-1)!;
      const signOutKey = assertPendingKey(clientB, signOutRequest);
      outside().focus();
      const requestsBeforeSignOutCallback = heldRelations.length;
      await act(async () => {
        clientB.setQueryData(sessionQuery.queryKey, { state: 'signed-out', subject: null });
        signOutAction.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
      });
      expect(heldRelations).toHaveLength(requestsBeforeSignOutCallback);
      await settle();
      expectRetired('side-stories');
      expect(window.document.activeElement).toBe(outside());
      signOutRequest.response.resolve(continuation(signOutRequest.request, 'Retired continuation row', 'old-next'));
      await settle();
      expect(clientB.getQueryCache().find({ queryKey: signOutKey, exact: true })).toBeUndefined();
      expect(invalidations).toBe(0);
      clientB.setQueryData(sessionQuery.queryKey, sessionA);
      const afterSignOut = makeReading({ ...baseSpec, label: 'Fresh A after sign-out' }, h);
      await replaceWith(afterSignOut);
      expect(stream('side-stories').textContent).toContain('Fresh A after sign-out');

      const unknownAction = await startMore('side-stories');
      const unknownRequest = heldRelations.at(-1)!;
      outside().focus();
      const requestsBeforeUnknownCallback = heldRelations.length;
      await act(async () => {
        clientB.setQueryData(sessionQuery.queryKey, { state: 'unknown', csrfToken: null });
        unknownAction.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
      });
      expect(heldRelations).toHaveLength(requestsBeforeUnknownCallback);
      await settle();
      expectRetired('side-stories');
      expect(window.document.activeElement).toBe(outside());
      unknownRequest.response.reject(new Error('Late rejected continuation'));
      await settle();
      expect(invalidations).toBe(0);
      clientB.setQueryData(sessionQuery.queryKey, sessionA);
      const afterUnknown = makeReading({ ...baseSpec, label: 'Fresh A after unknown' }, h);
      await replaceWith(afterUnknown);
      expect(stream('side-stories').textContent).toContain('Fresh A after unknown');

      const removalAction = await startMore('side-stories');
      const removalRequest = heldRelations.at(-1)!;
      const oldSessionQuery = clientB.getQueryCache().find({ queryKey: sessionQuery.queryKey, exact: true });
      outside().focus();
      const requestsBeforeRemovalCallback = heldRelations.length;
      await act(async () => {
        clientB.removeQueries({ queryKey: sessionQuery.queryKey, exact: true });
        clientB.setQueryData(sessionQuery.queryKey, sessionA);
        removalAction.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
      });
      expect(heldRelations).toHaveLength(requestsBeforeRemovalCallback);
      const recreatedSessionQuery = clientB.getQueryCache().find({ queryKey: sessionQuery.queryKey, exact: true });
      expect(recreatedSessionQuery).toBeDefined();
      expect(recreatedSessionQuery).not.toBe(oldSessionQuery);
      await settle();
      expectRetired('side-stories');
      expect(window.document.activeElement).toBe(outside());
      removalRequest.response.resolve(continuation(removalRequest.request, 'Retired continuation row', null));
      await settle();
      expect(invalidations).toBe(0);
      const afterRecreation = makeReading({ ...baseSpec, label: 'Fresh A after recreation' }, h);
      await replaceWith(afterRecreation);
      expect(stream('side-stories').textContent).toContain('Fresh A after recreation');

      // Provider replacement retires the old client owner and will not reuse its Section object.
      const providerAction = await startMore('side-stories');
      const providerRequest = heldRelations.at(-1)!;
      const providerKey = assertPendingKey(clientB, providerRequest);
      const sameSectionAfterProvider = currentPrimary;
      const clientC = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
      clients.push(clientC);
      clientC.setQueryData(sessionQuery.queryKey, sessionA);
      outside().focus();
      const requestsBeforeProviderCallback = heldRelations.length;
      await act(async () => {
        replaceClient(clientC);
        providerAction.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
      });
      expect(heldRelations).toHaveLength(requestsBeforeProviderCallback);
      await settle();
      expect(window.document.activeElement).toBe(outside());
      expect(stream('side-stories').textContent).not.toContain('Fresh A after recreation');
      expect(clientB.getQueryCache().find({ queryKey: providerKey, exact: true })).toBeUndefined();
      providerRequest.response.resolve(continuation(providerRequest.request, 'Retired continuation row', null));
      await settle();
      expectRetired('side-stories');
      expect(invalidations).toBe(0);
      expect(sameSectionAfterProvider.section).toBe(currentPrimary.section);
      const afterProvider = makeReading({ ...baseSpec, label: 'Fresh A after provider replacement' }, h);
      await replaceWith(afterProvider);
      expect(stream('side-stories').textContent).toContain('Fresh A after provider replacement');
      const afterProviderSecondary = makeReading(
        { ...secondSpec, label: 'Fresh adaptations after provider replacement' },
        h,
      );
      await act(async () => replaceSecondary(afterProviderSecondary));
      await settle();
      expect(stream('adaptations').textContent).toContain('Fresh adaptations after provider replacement');

      // Two mounted node owners have distinct keys. Replacing one leaves the other pending owner intact.
      await startMore('side-stories');
      const primaryRequest = heldRelations.at(-1)!;
      const primaryKey = assertPendingKey(clientC, primaryRequest);
      await startMore('adaptations');
      const secondaryRequest = heldRelations.at(-1)!;
      const secondaryKey = assertPendingKey(clientC, secondaryRequest);
      expect(primaryKey).not.toEqual(secondaryKey);
      const transitionedPrimary = makeReading({ ...baseSpec, subject: ids.subjectB, label: 'Fresh subject B' }, h);
      await replaceWith(transitionedPrimary);
      expect(clientC.getQueryCache().find({ queryKey: primaryKey, exact: true })).toBeUndefined();
      expect(clientC.getQueryCache().find({ queryKey: secondaryKey, exact: true })).toBeDefined();
      outside().focus();
      primaryRequest.response.resolve(continuation(primaryRequest.request, 'Retired continuation row', null));
      secondaryRequest.response.resolve(
        continuation(secondaryRequest.request, 'Independent adaptation row', 'adaptations-next', 'relations'),
      );
      await settle();
      expect(stream('side-stories').textContent).toContain('Fresh subject B');
      expect(stream('side-stories').textContent).not.toContain('Retired continuation row');
      expect(stream('adaptations').textContent).toContain('Independent adaptation row');
      expect(window.document.activeElement).toBe(outside());
      expect(clientC.getQueryCache().find({ queryKey: primaryKey, exact: true })).toBeUndefined();
      expect(clientC.getQueryCache().find({ queryKey: secondaryKey, exact: true })).toBeUndefined();
      expect(invalidations).toBe(0);

      // Each page and representation operand independently retires the prior mounted owner.
      const sourceChanges: Array<[string, Partial<ReadingSpec>]> = [
        ['subject', { subject: ids.subjectA }],
        ['page target', { targetSubject: ids.targetB }],
        ['account', { accountId: ids.account }],
        ['Context', { contextId: ids.contextB }],
        ['population', { populationId: ids.populationB }],
        ['Realm', { realm: ids.realmB }],
        ['locale', { locale: 'zh-Hans' }],
        ['reader preferences', { reader: { ...defaultReader, spoilerLevel: 0 } }],
        ['node', { node: 'qualified-role', readKind: 'relations' }],
        ['view', { view: 'works' }],
        ['new Section', {}],
      ];
      for (const [name, change] of sourceChanges) {
        const old = currentPrimary;
        const action = await startMore(old.node);
        const held = heldRelations.at(-1)!;
        const key = assertPendingKey(clientC, held);
        outside().focus();
        const requestsBeforeTransitionCallback = heldRelations.length;
        const next = makeReading({ ...old.spec, ...change, label: `Fresh after ${name}` }, h);
        await act(async () => {
          replacePrimary(next);
          action.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
        });
        expect(heldRelations).toHaveLength(requestsBeforeTransitionCallback);
        await settle();
        expect(clientC.getQueryCache().find({ queryKey: key, exact: true })).toBeUndefined();
        held.response.resolve(continuation(held.request, 'Retired continuation row', null));
        await settle();
        expect(stream(next.node).textContent).toContain(`Fresh after ${name}`);
        expect(stream(next.node).textContent).not.toContain('Retired continuation row');
        expect(status(next.node).textContent).toBe('');
        expect(window.document.activeElement).toBe(outside());
        expect(invalidations).toBe(0);
      }

      // Route identity is independent too; the old route's pending result cannot own the new route.
      const routeAction = await startMore(currentPrimary.node);
      const routeRequest = heldRelations.at(-1)!;
      const routeKey = assertPendingKey(clientC, routeRequest);
      outside().focus();
      const requestsBeforeRouteCallback = heldRelations.length;
      await act(async () => {
        history.push('/en/subjects/other-route');
        await router.load();
        routeAction.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
      });
      expect(heldRelations).toHaveLength(requestsBeforeRouteCallback);
      await settle();
      expectRetired(currentPrimary.node);
      expect(clientC.getQueryCache().find({ queryKey: routeKey, exact: true })).toBeUndefined();
      routeRequest.response.reject(new Error('Late route request rejection'));
      await settle();
      expect(window.document.activeElement).toBe(outside());
      expect(invalidations).toBe(0);
      const afterRoute = makeReading({ ...currentPrimary.spec, label: 'Fresh after route' }, h);
      await replaceWith(afterRoute);
      expect(stream(afterRoute.node).textContent).toContain('Fresh after route');
      void routeAction;

      // Healthy keyboard continuations report the accepted empty or populated window and preserve focus behavior.
      const emptyAction = await startMore(afterRoute.node);
      const emptyRequest = heldRelations.at(-1)!;
      const emptyKey = assertPendingKey(clientC, emptyRequest);
      expect(emptyRequest.request).toMatchObject({ node: afterRoute.node, cursor: afterRoute.spec.cursor });
      emptyRequest.response.resolve({
        ok: true,
        read: {
          kind: 'links',
          id: emptyRequest.request.subject,
          context: emptyRequest.request.context,
          property: 'schema:author',
          limit: 12,
        },
        body: { links: [], next: 'empty-but-continuable' },
      });
      await settle();
      expect(clientC.getQueryCache().find({ queryKey: emptyKey, exact: true })).toBeUndefined();
      expect(status(afterRoute.node).textContent).toContain(': 0. You can load more.');
      expect(trigger(afterRoute.node).getAttribute('href')).toContain('cursor=empty-but-continuable');
      expect(window.document.activeElement).toBe(emptyAction);

      const duplicateAction = await startMore(afterRoute.node);
      const duplicateRequest = heldRelations.at(-1)!;
      expect(duplicateRequest.request).toMatchObject({ node: afterRoute.node, cursor: 'empty-but-continuable' });
      duplicateRequest.response.resolve({
        ok: true,
        read: {
          kind: 'links',
          id: duplicateRequest.request.subject,
          context: duplicateRequest.request.context,
          property: 'schema:author',
          limit: 12,
        },
        body: {
          links: [
            {
              subject: ids.subjectB,
              label: afterRoute.spec.label,
              type: 'schema:Book',
              property: 'schema:author',
              statement: `initial-${afterRoute.node}-${afterRoute.spec.label}`,
            },
          ],
          next: null,
        },
      });
      await settle();
      expect(status(afterRoute.node).textContent).toContain(': 1. End of this list.');
      expect(stream(afterRoute.node).querySelector('[data-slot="continue-group"]')).toBeNull();
      expect(stream(afterRoute.node).querySelector('[data-slot="relation-stream-end"]')).not.toBeNull();
      expect(window.document.activeElement).toBe(
        stream(afterRoute.node).querySelector('[data-slot="relation-stream-end"]'),
      );
      expect(invalidations).toBe(0);
      void duplicateAction;

      // Unmount cancels and removes the last owner key; a late response cannot repopulate it.
      const unmountAction = await startMore(currentSecondary.node);
      const unmountRequest = heldRelations.at(-1)!;
      const unmountKey = assertPendingKey(clientC, unmountRequest);
      await act(async () => root.unmount());
      rootMounted = false;
      expect(clientC.getQueryCache().find({ queryKey: unmountKey, exact: true })).toBeUndefined();
      unmountRequest.response.resolve(continuation(unmountRequest.request, 'Late unmounted row', null));
      await settle();
      expect(clientC.getQueryCache().find({ queryKey: unmountKey, exact: true })).toBeUndefined();
      expect(invalidations).toBe(0);
      void unmountAction;
    } finally {
      if (rootMounted) await act(async () => root.unmount());
      for (const client of clients) client.clear();
      host.remove();
    }
  } finally {
    mock.restore();
    restoreGlobals();
    await window.happyDOM.close();
  }
});
