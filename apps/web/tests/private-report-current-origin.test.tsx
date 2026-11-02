import { afterAll, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import * as start from '../.storybook/react-start';
import definitions from '../src/kernel/recorded/definitions-release.json';
import type { CurrentLabelShelfData, LabelShelfInput } from '../src/library/label-shelf-read';
import type { FollowCountsPage } from '../src/library/private-follow-counts';

// UNRUN: composed source regressions. Native, browser and original acceptance proof remain deferred.
const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/library' });
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
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const originalFetch = globalThis.fetch;
const id = (n: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(n).padStart(12, '0')}`;
const labelId = id(10);
const undo = { labelId, subjectId: id(11), assignmentId: id(12), revision: 19 };
const undoKey = id(13);
const allGroups = ['personal_library', 'reading_progress', 'library_label.assignment_list', 'library_label.unassign'];
let actor = 'A';
let csrf = 'a'.repeat(22);
let address = '/en/library';
let empty = false;
let countBody: unknown = { followingCount: 0 };
let countStatus = 200;
const request = (subject = actor, href = address) =>
  new Request(`https://site.test${href}`, {
    headers: { cookie: `__Host-rezics_session=${subject.repeat(43)}` },
  });
const env = {
  KERNEL_ORIGIN: 'https://kernel.test',
  AUTH_ISSUER: 'https://auth.test',
  API_RESOURCE: 'https://kernel.test',
  WEBSITE_SCOPES: 'openid',
  WEBSITE_CLIENT_ID: 'private-report-test',
  WEBSITE_CLIENT_KEY: '{}',
  SESSIONS: {
    idFromName: (value: string) => value,
    get: (value: string) => {
      const subject = value[0]!;
      const credential = async () => ({ status: 'active', subject, accessToken: `token-${subject}`, csrfToken: csrf });
      return { credential, credentialIfFresh: credential };
    },
  },
};
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => ({ getRequest: request, setResponseHeader: () => {} }));
mock.module('cloudflare:workers', () => ({ env }));
const native: Request[] = [];
globalThis.fetch = (async (input, init) => {
  const req = new Request(input, init);
  const url = new URL(req.url);
  if (url.pathname === '/v1/definitions/active') return Response.json({ digest: definitions.digest });
  if (url.pathname.startsWith('/v1/definitions/releases/')) return Response.json(definitions);
  native.push(req);
  if (url.pathname === '/v1/platform/exposure') return Response.json({ admitted: allGroups });
  if (url.pathname === '/v1/libraryLabelAssignments') {
    const subject = req.headers.get('authorization')!.slice(-1);
    return Response.json({
      label: { id: url.searchParams.get('labelId'), name: `${subject} private shelf`, revision: 3 },
      assignments: empty
        ? []
        : [{ id: id(14), labelId, subjectId: id(15), revision: 7, subject: null, libraryEntry: null }],
      next: empty ? null : `next-${subject}`,
    });
  }
  if (url.pathname === '/v1/followCounts/outgoing')
    return Response.json(countBody, { status: countStatus, headers: { 'retry-after': '7' } });
  if (url.pathname.startsWith('/v1/followCounts/')) {
    const [, , , targetType, targetId] = url.pathname.split('/');
    return Response.json({ targetType, targetId, followerCount: 0 });
  }
  throw new Error(`Unexpected native request ${req.url}`);
}) as typeof fetch;

const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { createRootRoute, createRoute, createRouter, createMemoryHistory, Outlet, RouterProvider, useLocation } =
  await import('@tanstack/react-router');
const { createRoot } = await import('react-dom/client');
const { renderToStaticMarkup } = await import('react-dom/server');
const { CurrentLabelShelf } = await import('../src/library/label-shelf-current');
const { loadCurrentLabelShelfPage } = await import('../src/library/label-shelf-read');
const { PrivateFollowCountsPage } = await import('../src/library/private-follow-counts-page');
const { loadPrivateFollowCounts, followCountsSearch } = await import('../src/library/private-follow-counts');
const { sessionQuery, exposureQuery } = await import('../src/session/query');
const { viewerExposureLifetime, viewerExposureQuery } = await import('../src/kernel/viewer-exposure');
const { kernelClient } = await import('../src/kernel/client');
const { getLocale, setLocale } = await import('../src/paraglide/runtime');
const previousLocale = getLocale();
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
async function until(predicate: () => boolean) {
  for (let i = 0; i < 100 && !predicate(); i++)
    await act(async () => {
      await tick();
    });
  expect(predicate()).toBe(true);
}
function handler(node: Element, name: string): (event: Event) => void {
  const key = Object.keys(node).find((key) => key.startsWith('__reactProps$'))!;
  const props = (node as unknown as Record<string, Record<string, (event: Event) => void>>)[key]!;
  expect(typeof props[name]).toBe('function');
  return props[name]!;
}
const event = () => new window.Event('submit', { cancelable: true }) as unknown as Event;
const session = (subject = actor, token: string | null = csrf) => ({ state: 'signed-in', subject, csrfToken: token });
const labelSearch = {
  label: labelId,
  layout: 'table',
  cursor: 'first',
  undoLabelId: labelId,
  undoSubjectId: undo.subjectId,
  undoAssignmentId: undo.assignmentId,
  undoRevision: '19',
  undoKey,
  labelResult: 'label-restore-stale',
};
const countSearch = { targetType: 'collection', targetId: id(20) };
type Call = {
  prepared: Promise<CurrentLabelShelfData | FollowCountsPage>;
  resolve: (page: CurrentLabelShelfData | FollowCountsPage) => void;
  reject: (error: Error) => void;
  data: unknown;
};

async function mount(kind: 'shelf' | 'counts') {
  actor = 'A';
  csrf = 'a'.repeat(22);
  empty = false;
  countBody = { followingCount: 0 };
  countStatus = 200;
  setLocale('en', { reload: false });
  const path = kind === 'shelf' ? '/library' : '/library/follow-counts';
  const search = kind === 'shelf' ? labelSearch : countSearch;
  address = `/en${path}?${new URLSearchParams(search)}`;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(sessionQuery.queryKey, session());
  // This legacy grant must never admit either private owner.
  client.setQueryData(exposureQuery.queryKey, allGroups);
  const calls: Call[] = [];
  const queue = (prepared: Call['prepared'], data: unknown) =>
    new Promise<CurrentLabelShelfData | FollowCountsPage>((resolve, reject) =>
      calls.push({ prepared, data, resolve, reject }),
    );
  let initial: CurrentLabelShelfData = {
    state: 'unavailable',
    provenance: {
      subject: null,
      locale: 'en',
      source: { labelId, cursor: 'first', undo, undoKey, labelResult: 'label-restore-stale' },
    },
  };
  function Page() {
    const current = useLocation({ select: (location) => location.search });
    address = `/en${path}?${new URLSearchParams(current as Record<string, string>)}`;
    return kind === 'shelf' ? (
      <CurrentLabelShelf
        initial={initial}
        locale={getLocale()}
        display={{ layout: 'table', size: 'm' }}
        read={({ data }) => {
          const input: LabelShelfInput = {
            labelId: data.labelId,
            limit: 100,
            ...(data.cursor ? { cursor: data.cursor } : {}),
            ...(data.undoSubjectId
              ? {
                  undo: {
                    subjectId: data.undoSubjectId,
                    labelId: data.undoLabelId!,
                    assignmentId: data.undoAssignmentId!,
                    revision: data.undoRevision!,
                  },
                }
              : {}),
            ...(data.undoKey ? { undoKey: data.undoKey } : {}),
            ...(data.labelResult ? { labelResult: data.labelResult } : {}),
          };
          return queue(
            loadCurrentLabelShelfPage(kernelClient(), request(), env as never, input),
            data,
          ) as Promise<CurrentLabelShelfData>;
        }}
      />
    ) : (
      <PrivateFollowCountsPage
        context={followCountsSearch(current)}
        read={({ data }) =>
          queue(
            loadPrivateFollowCounts(kernelClient(), request(), env as never, data),
            data,
          ) as Promise<FollowCountsPage>
        }
      />
    );
  }
  const base = createRootRoute({ component: Outlet });
  const route = createRoute({ getParentRoute: () => base, path, component: Page, validateSearch: (value) => value });
  const router = createRouter({
    routeTree: base.addChildren([route]),
    history: createMemoryHistory({ initialEntries: [`${path}?${new URLSearchParams(search)}`] }),
  });
  await router.load();
  const host = window.document.createElement('div') as unknown as HTMLElement;
  window.document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    ),
  );
  const fields = () =>
    [...host.querySelectorAll('form')].map((form) =>
      Object.fromEntries([...form.querySelectorAll('input')].map((input) => [input.name, input.value])),
    );
  const scalars = () =>
    [...host.querySelectorAll('[data-follow-count]')].map((node) => node.getAttribute('data-follow-count'));
  const visible = (subject: string) =>
    kind === 'shelf' ? host.textContent!.includes(`${subject} private shelf`) : scalars().length === 2;
  const retained = () =>
    kind === 'shelf'
      ? [...host.querySelectorAll('form')].map((form) => handler(form, 'onSubmit'))
      : [handler(host.querySelector('button')!, 'onClick')];
  const refuse = (callbacks: ReturnType<typeof retained>) => {
    const before = calls.length;
    for (const callback of callbacks) {
      const submitted = event();
      callback(submitted);
      if (kind === 'shelf') expect(submitted.defaultPrevented).toBe(true);
    }
    expect(calls.length).toBe(before);
  };
  const release = async (
    index: number,
    alter?: (page: CurrentLabelShelfData | FollowCountsPage) => CurrentLabelShelfData | FollowCountsPage,
  ) => {
    const page = await calls[index]!.prepared;
    await act(async () => {
      calls[index]!.resolve(alter ? alter(page) : page);
      await tick();
    });
  };
  const scopedKey = () => {
    const snapshot = viewerExposureLifetime(client).getSnapshot();
    if (snapshot.state !== 'signed-in') throw new Error('No enrolled observation');
    return viewerExposureQuery(snapshot.observation).queryKey;
  };
  const refresh = async () => {
    await act(async () => {
      void client.invalidateQueries({
        queryKey: kind === 'shelf' ? ['library', 'label-shelf'] : ['library-private-follow-counts'],
      });
      await tick();
    });
  };
  return {
    client,
    server: (payload: CurrentLabelShelfData) => {
      const previous = initial;
      initial = payload;
      try {
        return renderToStaticMarkup(
          <QueryClientProvider client={client}>
            <RouterProvider router={router} />
          </QueryClientProvider>,
        );
      } finally {
        initial = previous;
      }
    },
    calls,
    host,
    fields,
    scalars,
    visible,
    retained,
    refuse,
    release,
    scopedKey,
    refresh,
    router,
    close: async () => {
      await act(async () => root.unmount());
      client.clear();
      host.remove();
    },
  };
}

afterAll(async () => {
  globalThis.fetch = originalFetch;
  setLocale(previousLocale, { reload: false });
  await window.happyDOM.close();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  mock.restore();
});

test('Complete named-label shelf and private follow reports preserves current authority and exact uncertain operations across observed replacement and ABA', async () => {
  for (const kind of ['shelf', 'counts'] as const) {
    const page = await mount(kind);
    try {
      await until(() => page.calls.length === 1);
      await page.release(0);
      await until(() => page.visible('A'));
      const retained = page.retained();
      const obsolete = page.client
        .getQueryCache()
        .findAll({ queryKey: kind === 'shelf' ? ['library', 'label-shelf'] : ['library-private-follow-counts'] })
        .find((query) => query.getObserversCount() > 0)!;
      // All changes and retained callbacks occur in one synchronous task, before React can commit.
      await act(async () => {
        page.client.setQueryData(sessionQuery.queryKey, session('B'));
        page.client.setQueryData(sessionQuery.queryKey, session('A'));
        page.refuse(retained);
        // Even an imperative retained query dispatch must precheck its originating observation.
        void obsolete.fetch().catch(() => {});
        expect(page.calls).toHaveLength(1);
      });
      await until(() => page.calls.length === 2);
      expect(page.visible('A')).toBe(false);
      await page.release(1);
      await until(() => page.visible('A'));
      await page.refresh();
      await until(() => page.calls.length === 3);
      const old = page.retained();
      actor = 'B';
      await act(async () => {
        page.client.setQueryData(sessionQuery.queryKey, session());
        page.refuse(old);
      });
      await until(() => page.calls.length === 4);
      await page.release(3);
      await until(() => page.visible('B'));
      const bFields = page.fields();
      await page.refresh();
      await until(() => page.calls.length === 5);
      // Late A success/failure must neither overwrite B nor unlock B's pending reload.
      if (kind === 'shelf') await page.release(2);
      else
        await act(async () => {
          page.calls[2]!.reject(new Error('late A failed'));
          await tick();
        });
      if (kind === 'shelf') expect(page.fields()).toEqual(bFields);
      else {
        expect(page.scalars()).toEqual([]);
        expect(page.host.querySelector('button')!.disabled).toBe(true);
      }
      await page.release(4);
      await until(() => page.visible('B'));
      const lastFields = page.fields();
      const beforeError = page.retained();
      await act(async () => {
        page.client
          .getQueryCache()
          .find({ queryKey: sessionQuery.queryKey, exact: true })!
          .setState({ status: 'error', error: new Error('session unavailable') });
        page.refuse(beforeError);
      });
      expect(page.visible('B')).toBe(false);
      await act(async () => page.client.setQueryData(sessionQuery.queryKey, session()));
      await until(() => page.visible('B'));
      expect(page.calls).toHaveLength(5); // Authority recovery cannot replace an uncertain native intent.
      if (kind === 'shelf') expect(page.fields()).toEqual(lastFields);
      const signedOut = page.retained();
      await act(async () => {
        page.client.setQueryData(sessionQuery.queryKey, { state: 'signed-out', subject: null, csrfToken: null });
        page.refuse(signedOut);
      });
      expect(page.visible('B')).toBe(false);
    } finally {
      await page.close();
    }
  }
});

test('independent scoped admission, payload replacement, healthy rotation and navigation preserve exact native forms while retiring their callbacks', async () => {
  const page = await mount('shelf');
  try {
    await until(() => page.calls.length === 1);
    await page.release(0);
    await until(() => page.visible('A'));
    const actualServer = (await page.calls[0]!.prepared) as CurrentLabelShelfData;
    expect(page.server(actualServer)).toContain('A private shelf');
    for (const provenance of [
      { ...actualServer.provenance, subject: null },
      { ...actualServer.provenance, locale: 'ja' },
      { ...actualServer.provenance, source: { ...actualServer.provenance.source, labelId: id(99) } },
    ])
      expect(page.server({ ...actualServer, provenance })).not.toContain('A private shelf');
    expect(page.calls).toHaveLength(1);
    const fields = page.fields();
    expect(fields).toHaveLength(2);
    expect(fields.find((form) => form.intent === 'restore')).toEqual({
      intent: 'restore',
      subjectId: undo.subjectId,
      labelId,
      assignmentId: undo.assignmentId,
      idempotencyKey: undoKey,
      revision: '19',
      csrf_token: csrf,
    });
    expect(fields.find((form) => form.intent === 'unassign')).toMatchObject({
      subjectId: id(15),
      labelId,
      assignmentId: id(14),
      revision: '7',
      csrf_token: csrf,
    });
    const original = page.retained();
    await act(async () => {
      const key = page.scopedKey();
      page.client.setQueryData(key, {
        subject: 'A',
        admitted: allGroups.filter((group) => group !== 'library_label.unassign'),
      });
      page.client.setQueryData(key, { subject: 'A', admitted: allGroups });
      page.refuse(original);
    });
    expect(page.fields()).toEqual(fields);
    expect(page.calls).toHaveLength(1);
    const readAdmission = page.retained();
    const oldNext = handler(page.host.querySelector('a[href*="cursor=next-"]')!, 'onClick');
    await act(async () => {
      const key = page.scopedKey();
      page.client
        .getQueryCache()
        .find({ queryKey: key, exact: true })!
        .setState({ status: 'error', error: new Error('exposure unavailable') });
      page.client.setQueryData(key, { subject: 'A', admitted: allGroups });
      page.refuse(readAdmission);
      const click = event();
      oldNext(click);
      expect(click.defaultPrevented).toBe(true);
    });
    expect(page.fields()).toEqual(fields);
    expect(page.calls).toHaveLength(1);
    const preRotation = page.retained();
    csrf = 'z'.repeat(22);
    await act(async () => {
      page.client.setQueryData(sessionQuery.queryKey, session());
      page.refuse(preRotation);
    });
    await until(() => page.fields().length === 2);
    expect(page.fields()).toEqual(fields);
    expect(page.calls).toHaveLength(1);
    const beforeMissingCredential = page.retained();
    await act(async () => {
      page.client.setQueryData(sessionQuery.queryKey, session('A', null));
      page.refuse(beforeMissingCredential);
    });
    expect(page.fields()).toEqual([]);
    await act(async () => page.client.setQueryData(sessionQuery.queryKey, session()));
    await until(() => page.fields().length === 2);
    expect(page.fields()).toEqual(fields);
    expect(page.calls).toHaveLength(1);
    const equivalent = page.retained();
    await act(async () => page.client.setQueryData(page.scopedKey(), { subject: 'A', admitted: [...allGroups] }));
    for (const callback of equivalent) {
      const submit = event();
      callback(submit);
      expect(submit.defaultPrevented).toBe(false);
    }
    const query = page.client
      .getQueryCache()
      .findAll({ queryKey: ['library', 'label-shelf'] })
      .find((query) => query.getObserversCount() > 0)!;
    const actual = query.state.data;
    const payloadCallbacks = page.retained();
    await act(async () => {
      page.client.setQueryData(query.queryKey, {
        ...(actual as CurrentLabelShelfData),
        provenance: { ...(actual as CurrentLabelShelfData).provenance, subject: 'B' },
      });
      page.client.setQueryData(query.queryKey, actual);
      page.refuse(payloadCallbacks);
    });
    expect(page.fields()).toEqual(fields);
    const next = handler(page.host.querySelector('a[href*="cursor=next-"]')!, 'onClick');
    await act(async () => {
      await page.router.navigate({ to: '/library', search: { ...labelSearch, cursor: 'second' } });
    });
    const click = event();
    next(click);
    expect(click.defaultPrevented).toBe(true);
    await until(() => page.calls.length === 2);
    expect(page.visible('A')).toBe(false);
    await act(async () => {
      await page.router.navigate({ to: '/library', search: labelSearch });
    });
    await until(() => page.calls.length === 3);
    await page.release(2);
    await until(() => page.visible('A'));
    const returned = page.fields();
    await page.release(1);
    expect(page.fields()).toEqual(returned);
    expect(returned.find((form) => form.intent === 'unassign')!.idempotencyKey).not.toBe(
      fields.find((form) => form.intent === 'unassign')!.idempotencyKey,
    );
  } finally {
    await page.close();
  }
});

test('actual prepared read provenance, empty success and strict report values survive retries without extra native reads', async () => {
  const page = await mount('counts');
  try {
    await until(() => page.calls.length === 1);
    await page.calls[0]!.prepared;
    const firstNative = native.filter((req) => new URL(req.url).pathname.startsWith('/v1/followCounts/')).length;
    await page.release(0, (value) => ({ ...(value as FollowCountsPage), viewer: { subject: 'B', csrfToken: csrf } }));
    expect(page.scalars()).toEqual([]);
    for (const alter of [
      (value: FollowCountsPage) => ({ ...value, locale: 'ja' }),
      (value: FollowCountsPage) => ({ ...value, context: { ...countSearch, targetId: id(99) } }),
    ]) {
      const index = page.calls.length;
      await page.refresh();
      await until(() => page.calls.length > index);
      await page.release(index, (value) => alter(value as FollowCountsPage));
      expect(page.scalars()).toEqual([]);
    }
    const index = page.calls.length;
    await page.refresh();
    await until(() => page.calls.length > index);
    await page.release(index);
    expect(page.scalars()).toEqual(['0', '0']);
    expect(native.filter((req) => new URL(req.url).pathname.startsWith('/v1/followCounts/')).length - firstNative).toBe(
      6,
    );
    for (const body of [
      { followingCount: Number.MAX_SAFE_INTEGER + 1 },
      { followingCount: -1 },
      { followingCount: '0' },
    ]) {
      countBody = body;
      const index = page.calls.length;
      await page.refresh();
      await until(() => page.calls.length > index);
      await page.release(index);
      expect(page.scalars()).toEqual(['0']);
    }
    countBody = { code: 'not_found' };
    countStatus = 404;
    const failed = page.calls.length;
    await page.refresh();
    await until(() => page.calls.length > failed);
    await page.release(failed);
    expect(page.host.textContent).toContain('7');
    expect(page.scalars()).toEqual(['0']);
    const retained = page.retained();
    await act(async () => {
      page.client.setQueryData(page.scopedKey(), { subject: 'B', admitted: allGroups });
      page.refuse(retained);
    });
    expect(page.scalars()).toEqual([]);
    const total = page.calls.length;
    csrf = '';
    await act(async () => page.client.setQueryData(sessionQuery.queryKey, session('A', null)));
    await until(() => page.calls.length === total + 1);
    await page.release(total);
    expect(page.scalars()).toEqual(['0']);
    await page.refresh();
    await until(() => page.calls.length === total + 2);
    await page.release(total + 1);
    expect(page.scalars()).toEqual(['0']);
  } finally {
    await page.close();
  }
  const shelf = await mount('shelf');
  try {
    await until(() => shelf.calls.length === 1);
    await shelf.release(0);
    await until(() => shelf.visible('A'));
    empty = true;
    await shelf.refresh();
    await until(() => shelf.calls.length === 2);
    await shelf.release(1);
    expect(shelf.visible('A')).toBe(true);
    expect(shelf.fields().filter((form) => form.intent === 'unassign')).toEqual([]);
    await act(async () => {
      await shelf.router.navigate({
        to: '/library',
        search: { ...labelSearch, undoRevision: '9007199254740992', undoSubjectId: '../invalid' },
      });
    });
    await until(() => shelf.calls.length === 3);
    expect(shelf.calls[2]!.data).not.toHaveProperty('undoRevision');
    expect(shelf.calls[2]!.data).not.toHaveProperty('undoSubjectId');
    await shelf.release(2);
    expect(shelf.fields()).toEqual([]);
  } finally {
    await shelf.close();
  }
});
