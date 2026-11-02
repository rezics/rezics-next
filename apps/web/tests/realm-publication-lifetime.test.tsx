import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, StrictMode, useCallback, type ReactNode } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import type { Root } from 'react-dom/client';
import * as start from '../.storybook/react-start';
import type { PublicationChange, PublicationOutcome } from '../src/community/publication-controls';
import type { PublishedSubject, RealmHome } from '../src/community/space';
import type { PublicationTarget } from '../src/community/publication-subject-picker';
import type { SuggestionResult } from '../src/search/suggestions';

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/spaces/atlas-member' });
const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  location: window.location,
  HTMLElement: window.HTMLElement,
  HTMLButtonElement: window.HTMLButtonElement,
  HTMLFormElement: window.HTMLFormElement,
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const id = (n: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(n).padStart(12, '0')}`;
const realmId = id(10);
const reader = id(20);
const head = id(30);
const nextHead = id(31);
const viewer = (subject = reader, csrfToken: string | null = 'csrf-one') => ({
  state: 'signed-in' as const,
  subject,
  csrfToken,
});
const target = (): PublicationTarget => ({
  id: id(40),
  title: 'Lifetime book',
  label: 'Lifetime book',
  labels: { en: 'Lifetime book' },
  types: ['schema:Book'],
  typeName: 'Book',
  cover: null,
});
const subjects = (): PublishedSubject[] => [{ ...target(), publicationId: head }];

type Write = ReturnType<typeof deferred<PublicationOutcome>> & {
  input: Parameters<import('../src/community/publication-subject-picker').PublicationSend>[0];
  credential: string;
};
const writes: Write[] = [];
const hostWrites: (ReturnType<typeof deferred<PublicationOutcome>> & { input: Write['input'] })[] = [];
const saved: { subject: string; head: string }[] = [];
let activeCredential = 'csrf-one';
let latestControl: ReturnType<typeof import('../src/community/publication-controls-view').usePublicationControls>;
let rerenderMarker = 0;
let shelfSubjects = subjects();

function HookHarness({ showControls = false }: { showControls?: boolean } = {}) {
  const send = useCallback(
    (input: Write['input']) => {
      const call = { ...deferred<PublicationOutcome>(), input: structuredClone(input), credential: activeCredential };
      writes.push(call);
      return call.promise;
    },
    [activeCredential],
  );
  const control = usePublicationControls(
    realmId,
    send,
    (_input, chosen, savedHead) => saved.push({ subject: chosen.id, head: savedHead }),
    shelfSubjects,
    true,
    reader,
  );
  latestControl = control;
  return (
    <>
      <output data-marker={rerenderMarker}>{control.target?.title ?? 'No target'}</output>
      {showControls ? <PublicationControls control={control} refresh={async () => undefined} /> : null}
    </>
  );
}

const host = window.document.createElement('main') as unknown as HTMLElement;
window.document.body.append(host);
let root: Root | undefined;
let client: QueryClient | undefined;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('../src/community/space-actions', () => ({
  changeRealmPublication: async () => ({ kind: 'unavailable' }),
  readRealmBoards: async () => ({ kind: 'page', items: [], next: null, unavailable: 0 }),
  readRealmPublications: async () => ({ kind: 'page', items: [], next: null, unavailable: 0 }),
}));

const { createRoot } = await import('react-dom/client');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { sessionQuery } = await import('../src/session/query');
const { PublicationControls, usePublicationControls } = await import('../src/community/publication-controls-view');
const { publicationSubjectSearch } = await import('../src/community/publication-subject-picker');
const { RealmShelf } = await import('../src/community/space-page');
const { m } = await import('../src/paraglide/messages.js');

async function mountHook(session = viewer()) {
  await close();
  writes.length = 0;
  hostWrites.length = 0;
  saved.length = 0;
  activeCredential = session.csrfToken ?? '';
  shelfSubjects = subjects();
  rerenderMarker = 0;
  client?.clear();
  const nextClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client = nextClient;
  nextClient.setQueryData(sessionQuery.queryKey, session);
  root = createRoot(host);
  await paintHook();
}

function tree(node: ReactNode) {
  return (
    <StrictMode>
      <QueryClientProvider client={client!}>{node}</QueryClientProvider>
    </StrictMode>
  );
}

async function paintHook() {
  await act(async () => {
    root!.render(tree(<HookHarness />));
    await tick();
  });
}

async function close() {
  if (root) {
    await act(async () => {
      root!.unmount();
      await tick();
    });
    root = undefined;
  }
  host.textContent = '';
}

async function updateSession(session: ReturnType<typeof viewer>) {
  activeCredential = session.csrfToken ?? '';
  await act(async () => {
    client!.setQueryData(sessionQuery.queryKey, session);
    await tick();
  });
}

type StartedChange = { completion: Promise<void> };

async function startChange(action: PublicationChange['action']): Promise<StartedChange> {
  let completion!: Promise<void>;
  await act(async () => {
    completion = latestControl.change(action, target());
  });
  return { completion };
}

async function settle(index: number, outcome: PublicationOutcome) {
  await act(async () => {
    writes[index]!.resolve(outcome);
    await tick();
  });
}

afterEach(async () => {
  await close();
  client?.clear();
  client = undefined;
  writes.length = 0;
  saved.length = 0;
  hostWrites.length = 0;
  activeCredential = 'csrf-one';
  shelfSubjects = subjects();
  rerenderMarker = 0;
});

afterAll(async () => {
  mock.restore();
  host.remove();
  window.happyDOM.abort();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

describe('Complete Realm publication original caller lifetime', () => {
  test('publication departure keeps selection and exact recovery on Stay, then retires before destination reads on Leave', async () => {
    await close();
    writes.length = 0;
    saved.length = 0;
    activeCredential = 'csrf-one';
    shelfSubjects = subjects();
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(sessionQuery.queryKey, viewer());
    const nextRead = deferred<void>();
    let readStarted = false;
    const { AuthoringDepartureProvider } = await import('../src/threads/authoring-departure');
    const { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider, useRouter } =
      await import('@tanstack/react-router');
    function RealmRoute() {
      const router = useRouter();
      return (
        <AuthoringDepartureProvider>
          <HookHarness showControls />
          <button type="button" onClick={() => void router.navigate({ href: '/next' })}>Leave Realm</button>
        </AuthoringDepartureProvider>
      );
    }
    const rootRoute = createRootRoute({ component: Outlet });
    const realmRoute = createRoute({ getParentRoute: () => rootRoute, path: '/realm', component: RealmRoute });
    const nextRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/next',
      loader: async () => {
        readStarted = true;
        await nextRead.promise;
      },
      component: () => <p>Next destination</p>,
    });
    const router = createRouter({
      routeTree: rootRoute.addChildren([realmRoute, nextRoute]),
      history: createMemoryHistory({ initialEntries: ['/realm'] }),
    });
    const testRoot = (root = createRoot(host));
    await router.load();
    await act(async () => {
      testRoot.render(tree(<RouterProvider router={router} />));
      await tick();
    });
    const waitFor = async (ready: () => boolean) => {
      for (let count = 0; count < 180 && !ready(); count++) await act(async () => tick());
      expect(ready()).toBe(true);
    };
    const click = async (label: string) => {
      const button = [...window.document.querySelectorAll('button')].find((item) => item.textContent?.trim() === label);
      expect(button).toBeDefined();
      await act(async () => button!.click());
    };
    const dialog = () => window.document.querySelector('[role="alertdialog"]');
    const beforeUnload = () => {
      const event = new window.Event('beforeunload', { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    };
    const selected = target();
    expect(beforeUnload()).toBe(false);
    await act(async () => latestControl.choose(selected));
    await waitFor(() => beforeUnload());
    await click('Leave Realm');
    await waitFor(() => dialog() !== null);
    expect(dialog()?.textContent).toContain(m.thread_authoring_leave_unsaved());
    await click(m.thread_authoring_stay());
    await waitFor(() => dialog() === null);
    expect(latestControl.target).toEqual(selected);
    await act(async () => void latestControl.change('publish', selected));
    await settle(0, { kind: 'saved', head: nextHead });
    expect(beforeUnload()).toBe(false);

    await act(async () => {
      latestControl.choose(null);
      latestControl.choose(selected);
      void latestControl.change('publish', selected);
    });
    const exact = structuredClone(writes[1]!.input);
    await settle(1, { kind: 'unavailable' });
    await click(m.realm_publication_curate());
    await click(m.realm_publication_curate());
    await click(m.realm_publication_curate());
    await act(async () => {
      void latestControl.retry();
      await tick();
    });
    expect(writes[2]!.input).toEqual(exact);
    await settle(2, { kind: 'unavailable' });
    await click('Leave Realm');
    await waitFor(() => dialog() !== null);
    expect(dialog()?.textContent).toContain(m.thread_authoring_leave_pending());
    await click(m.thread_authoring_stay());
    await waitFor(() => dialog() === null);
    expect(latestControl.target).toEqual(selected);
    expect(latestControl.action).toBe('publish');
    expect(latestControl.outcome).toEqual({ kind: 'unavailable' });
    await act(async () => {
      void latestControl.retry();
      await tick();
    });
    expect(writes[3]!.input).toEqual(exact);

    await click('Leave Realm');
    await waitFor(() => dialog() !== null);
    await click(m.thread_authoring_leave());
    await waitFor(() => readStarted);
    expect(latestControl.target).toBeNull();
    const writeCount = writes.length;
    await act(async () => void latestControl.retry());
    expect(writes).toHaveLength(writeCount);
    nextRead.resolve();
    await waitFor(() => router.state.location.pathname === '/next');
  });

  test('healthy renders keep the draft and read the current authoritative shelf head', async () => {
    await mountHook();
    await act(async () => latestControl.choose(target()));
    const selected = latestControl.target;
    shelfSubjects = [{ ...target(), publicationId: nextHead }];
    rerenderMarker++;
    await paintHook();
    expect(latestControl.target).toEqual(selected);

    const { completion } = await startChange('withdraw');
    expect(writes).toHaveLength(1);
    expect(writes[0]!.input.expectedHead).toBe(nextHead);
    await settle(0, { kind: 'saved', head: id(32) });
    await completion;
    expect(saved).toEqual([{ subject: target().id, head: id(32) }]);
    expect(latestControl.outcome).toEqual({ kind: 'saved', head: id(32) });
  });

  test('a session-cache transition fences queued callbacks and old credentials before transport', async () => {
    await mountHook();
    const queued = latestControl;
    await act(async () => {
      client!.setQueryData(sessionQuery.queryKey, viewer(reader, 'csrf-away'));
      client!.setQueryData(sessionQuery.queryKey, viewer());
      queued.choose(target());
      void queued.change('publish', target());
    });
    expect(writes).toHaveLength(0);
    expect(latestControl.target).toBeNull();

    await act(async () => latestControl.choose(target()));
    const { completion } = await startChange('publish');
    expect(writes).toHaveLength(1);
    expect(writes[0]!.credential).toBe('csrf-one');
    await settle(0, { kind: 'saved', head: nextHead });
    await completion;
    expect(saved).toEqual([{ subject: target().id, head: nextHead }]);
  });

  test('late saved, denied and conflict replies cannot update a same-account replacement lifetime', async () => {
    for (const outcome of [
      { kind: 'saved', head: nextHead },
      { kind: 'denied' },
      { kind: 'conflict', currentHead: nextHead },
    ] as const) {
      await mountHook();
      await act(async () => latestControl.choose(target()));
      const current = await startChange('publish');
      expect(writes).toHaveLength(1);
      let currentCredential = 'csrf-two';
      if (outcome.kind === 'denied') {
        currentCredential = 'csrf-one';
        await act(async () => {
          // Same-value writes still create a new session-cache revision.
          client!.setQueryData(sessionQuery.queryKey, viewer());
          await tick();
        });
      } else if (outcome.kind === 'conflict') {
        await act(async () => {
          client!.setQueryData(sessionQuery.queryKey, { state: 'signed-out', subject: reader, csrfToken: null });
          client!.setQueryData(sessionQuery.queryKey, viewer(reader, currentCredential));
          await tick();
        });
        activeCredential = currentCredential;
      } else {
        await updateSession(viewer(reader, currentCredential));
      }
      await settle(0, outcome);
      await current.completion;
      expect(saved).toHaveLength(0);
      expect(latestControl.target).toBeNull();
      expect(latestControl.outcome).toBeNull();
      expect(writes).toHaveLength(1);

      await act(async () => latestControl.choose(target()));
      const { completion } = await startChange('publish');
      expect(writes).toHaveLength(2);
      expect(writes[1]!.credential).toBe(currentCredential);
      await settle(1, { kind: 'saved', head: nextHead });
      await completion;
      expect(saved).toEqual([{ subject: target().id, head: nextHead }]);
    }
  });

  test('uncertain retry preserves the exact request and conflict review creates a fresh key at the current head', async () => {
    await mountHook();
    await act(async () => latestControl.choose(target()));
    const { completion } = await startChange('withdraw');
    expect(writes).toHaveLength(1);
    await settle(0, { kind: 'unavailable' });
    await completion;
    const exact = structuredClone(writes[0]!.input);
    expect(latestControl.outcome).toEqual({ kind: 'unavailable' });

    let retry: Promise<void> | undefined;
    await act(async () => {
      retry = latestControl.retry();
    });
    expect(writes[1]!.input).toEqual(exact);
    await settle(1, { kind: 'conflict', currentHead: nextHead });
    await retry;
    let review: Promise<void> | undefined;
    await act(async () => {
      review = latestControl.review();
    });
    expect(writes[2]!.input).toMatchObject({
      realmId,
      subjectId: target().id,
      action: 'withdraw',
      expectedHead: nextHead,
    });
    expect(writes[2]!.input.idempotencyKey).not.toBe(exact.idempotencyKey);
    await settle(2, { kind: 'saved', head: id(32) });
    await review;
    expect(writes).toHaveLength(3);
  });

  test('returning to the same account does not restore private outcomes, heads or uncertain intents', async () => {
    await mountHook();
    const privateTarget = { ...target(), id: id(41) };
    await act(async () => latestControl.choose(privateTarget));
    const current = await startChange('publish');
    await settle(0, { kind: 'unavailable' });
    await current.completion;
    expect(latestControl.outcome).toEqual({ kind: 'unavailable' });
    const retired = latestControl;

    await act(async () => {
      client!.setQueryData(sessionQuery.queryKey, viewer(id(21), 'csrf-other'));
      client!.setQueryData(sessionQuery.queryKey, viewer());
      await tick();
    });
    expect(latestControl.target).toBeNull();
    expect(latestControl.outcome).toBeNull();
    await act(async () => {
      void retired.retry();
      void retired.review();
      void retired.change('withdraw', privateTarget);
    });
    expect(writes).toHaveLength(1);

    await act(async () => latestControl.choose(privateTarget));
    let staleHeadAction: Promise<void> | undefined;
    await act(async () => {
      staleHeadAction = latestControl.change('withdraw', privateTarget);
    });
    expect(writes).toHaveLength(1);
    let current: Promise<void> | undefined;
    await act(async () => {
      current = latestControl.change('publish', privateTarget);
    });
    expect(writes).toHaveLength(2);
    expect(writes[1]!.input.expectedHead).toBeUndefined();
    expect(writes[1]!.input.idempotencyKey).not.toBe(writes[0]!.input.idempotencyKey);
    await settle(1, { kind: 'saved', head: nextHead });
    await staleHeadAction;
    await current;
    expect(saved).toEqual([{ subject: privateTarget.id, head: nextHead }]);
  });

  test('unmount and remount under the same account cannot revive its retained controls or result', async () => {
    await mountHook();
    await act(async () => latestControl.choose(target()));
    const retained = latestControl;
    const retiredOperation = await startChange('publish');
    expect(writes).toHaveLength(1);
    await close();
    await act(async () => {
      retained.choose(target());
      void retained.change('publish', target());
      void retained.retry();
      void retained.review();
    });
    root = createRoot(host);
    await paintHook();
    expect(latestControl.target).toBeNull();
    expect(writes).toHaveLength(1);
    await settle(0, { kind: 'saved', head: nextHead });
    await retiredOperation.completion;
    expect(saved).toHaveLength(0);
    expect(latestControl.outcome).toBeNull();

    await act(async () => latestControl.choose(target()));
    const { completion } = await startChange('publish');
    expect(writes).toHaveLength(2);
    await settle(1, { kind: 'saved', head: nextHead });
    await completion;
    expect(saved).toHaveLength(1);
  });

  const hostSubject = { ...target(), publicationId: head };
  const realm: RealmHome = {
    id: realmId,
    title: 'Atlas',
    visibility: 'public',
    viewer: null,
    boards: [],
    published: [hostSubject],
    boardNext: null,
    publicationNext: null,
  };
  const hostSearch = publicationSubjectSearch(
    'en',
    async () =>
      ({
        subjects: [{ id: hostSubject.id, type: 'schema:Book', labels: { en: hostSubject.title }, summary: null }],
        types: { 'schema:Book': { en: 'Book' } },
        as_of: '2026-10-31T00:00:00Z',
      }) satisfies SuggestionResult,
  );
  const hostTransport = {
    boards: async () => ({ kind: 'page' as const, items: [], next: null, unavailable: 0 }),
    publications: async () => ({ kind: 'page' as const, items: [], next: null, unavailable: 0 }),
    change: (input: Write['input']) => {
      const call = { ...deferred<PublicationOutcome>(), input: structuredClone(input) };
      hostWrites.push(call);
      return call.promise;
    },
  };
  function RealmShelfHost() {
    return <RealmShelf realm={realm} transport={hostTransport} search={hostSearch} />;
  }

  async function paintShelf() {
    await act(async () => {
      root!.render(tree(<RealmShelfHost />));
      await tick();
    });
  }

  async function settleHost(index: number, outcome: PublicationOutcome) {
    await act(async () => {
      hostWrites[index]!.resolve(outcome);
      await tick();
    });
  }

  function shelfButton(name: string) {
    const button = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
      (node) => node.getAttribute('aria-label') === name || node.textContent?.trim() === name,
    );
    expect(button).toBeDefined();
    return button!;
  }

  async function shelfWithdraw() {
    const trigger = shelfButton(m.realm_publication_actions({ title: target().title }));
    await act(async () => {
      trigger.focus();
      trigger.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await tick();
    });
    const item = [...window.document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (node) => node.textContent?.trim() === m.realm_publication_withdraw(),
    );
    expect(item).toBeDefined();
    await act(async () => {
      item!.click();
      await tick();
    });
  }

  async function shelfPublish() {
    await act(async () => {
      shelfButton(m.realm_publication_curate()).click();
      await tick();
    });
    const input = [...host.querySelectorAll<HTMLInputElement>('input')].find(
      (node) => node.getAttribute('aria-label') === m.realm_publication_choose(),
    );
    expect(input).toBeDefined();
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, hostSubject.title);
      input!.dispatchEvent(new window.Event('input', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    const option = [...window.document.querySelectorAll<HTMLElement>('[role="option"]')].find((node) =>
      node.textContent?.includes(hostSubject.title),
    );
    expect(option).toBeDefined();
    await act(async () => {
      option!.click();
      await tick();
    });
    await act(async () => {
      shelfButton(m.realm_publication_publish()).click();
      await tick();
    });
  }

  test('a successful republish replaces the existing Realm slot with its authoritative head once', async () => {
    await mountHook();
    hostWrites.length = 0;
    await paintShelf();
    await shelfPublish();
    expect(hostWrites).toHaveLength(1);
    expect(hostWrites[0]!.input).toMatchObject({
      realmId,
      subjectId: hostSubject.id,
      action: 'publish',
      expectedHead: head,
    });
    await settleHost(0, { kind: 'saved', head: nextHead });
    const subjectCards = [...host.querySelectorAll<HTMLAnchorElement>('a')].filter((node) =>
      node.textContent?.includes(hostSubject.title),
    );
    expect(subjectCards).toHaveLength(1);

    await shelfWithdraw();
    expect(hostWrites).toHaveLength(2);
    expect(hostWrites[1]!.input.expectedHead).toBe(nextHead);
    await settleHost(1, { kind: 'saved', head: id(32) });
    expect(host.querySelectorAll('a').length).toBe(0);
  });

  test('RealmShelf saved callback reconciles one current slot and ignores a late retired response', async () => {
    await mountHook();
    hostWrites.length = 0;
    await paintShelf();
    await shelfWithdraw();
    expect(hostWrites).toHaveLength(1);
    await updateSession(viewer(reader, 'csrf-two'));
    await settleHost(0, { kind: 'saved', head: nextHead });
    expect(host.textContent).toContain(target().title);
    expect(host.textContent).not.toContain(m.realm_publication_removed());
    expect(hostWrites).toHaveLength(1);

    await shelfWithdraw();
    expect(hostWrites).toHaveLength(2);
    await settleHost(1, { kind: 'saved', head: nextHead });
    expect(host.textContent).not.toContain(target().title);
    expect(host.textContent).toContain(m.realm_publication_removed());
  });
});
