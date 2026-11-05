import { afterAll, expect, mock, spyOn, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, StrictMode, type ComponentType } from 'react';
import * as start from '../.storybook/react-start';
import type {
  CreatorStatementCurrentRead,
  CreatorStatementsAddress,
  CreatorStatementsCurrentRead,
  CreatorStatementsData,
  CreatorStatementData,
} from '../src/checkout/creator-statements';
import {
  creatorLineFixture,
  creatorStatementFixture,
  paidCreatorStatementFixture,
} from '../src/kernel/fake/creator-statements';
import type { SessionEnv } from '../src/session/client';

// UNRUN: focused source assertions for controller integration. Constructed native HTTP inputs
// and mounted actual routes do not establish native authorization, browser or visual acceptance.
const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/creator/statements' });
const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
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
const A = creatorStatementFixture.creatorAccountId;
const B = '019a2100-0000-7000-8000-000000000021';
const cookie = `__Host-rezics_session=${'a'.repeat(43)}`;
const request = () => new Request('https://site.test/en/creator/statements', { headers: { cookie } });
let currentRequest = request();
let subject = A;
let token = 'credential-A';
let preparation: 'active' | 'absent' | 'unavailable' = 'active';
let preparations = 0;
const env = {
  KERNEL_ORIGIN: 'https://kernel.test',
  AUTH_ISSUER: 'https://auth.test',
  API_RESOURCE: 'https://kernel.test',
  WEBSITE_SCOPES: 'openid payout_statement:list payout_statement:read',
  WEBSITE_CLIENT_ID: 'web',
  WEBSITE_CLIENT_KEY: '{}',
  SESSIONS: {
    idFromName: (value: string) => value,
    get: () => ({
      credential: async () => {
        preparations++;
        return { status: preparation, subject, accessToken: token, csrfToken: 'private-csrf' };
      },
    }),
  },
};
const headers = new Headers();
mock.module('cloudflare:workers', () => ({ env }));
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => ({
  ...start,
  getRequest: () => currentRequest,
  setResponseHeader: (name: string, value: string) => headers.set(name, value),
}));
const { viewerExposureLifetime, viewerExposureQuery } = await import('../src/kernel/viewer-exposure');
const reads = await import('../src/checkout/creator-statements');
const { m } = await import('../src/paraglide/messages.js');
const { setLocale } = await import('../src/paraglide/runtime.js');
setLocale('en', { reload: false });
afterAll(async () => {
  mock.restore();
  await window.happyDOM.close();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});
type CurrentRead = CreatorStatementsCurrentRead<CreatorStatementsData | CreatorStatementData>;
function list(viewer = A, cursor: string | null = null, locale = 'en'): CreatorStatementsCurrentRead {
  return {
    sessionSubject: viewer,
    requested: { kind: 'list', locale, cursor },
    page: {
      kind: 'ready',
      payoutStatements: [
        {
          ...creatorStatementFixture,
          id: viewer === A ? creatorStatementFixture.id : '019a2100-0000-7000-8000-000000000022',
          creatorAccountId: viewer,
        },
      ],
      next: `next-${viewer}+/=`,
    },
  };
}
function detail(
  viewer = A,
  id = paidCreatorStatementFixture.id,
  cursor: string | null = null,
  from: string | null = null,
  locale = 'en',
): CreatorStatementCurrentRead {
  const statement = {
    ...paidCreatorStatementFixture,
    id,
    creatorAccountId: viewer,
    paidReference: `Private payment ${viewer}`,
  };
  return {
    sessionSubject: viewer,
    requested: { kind: 'detail', locale, id, cursor, from },
    page: {
      kind: 'ready',
      statement,
      lines: {
        kind: 'ready',
        lines: [
          {
            ...creatorLineFixture,
            statementId: id,
            creatorAccountId: viewer,
            period: statement.period,
            balanceTransactionId: `txn-${viewer}`,
          },
        ],
        next: `lines-${viewer}+/=`,
      },
    },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

test('actual current readers prepare once, bind empty pages and exact point/line addresses, and refuse uncertified or foreign reads', async () => {
  const calls: Request[] = [];
  let rows = [creatorStatementFixture];
  let point = detail().page;
  let denyLines = false;
  let unavailableLines = false;
  let rotateOnPoint = true;
  const native = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const call = new Request(input, init);
    calls.push(call);
    const path = new URL(call.url).pathname;
    if (path.endsWith('/lines')) {
      if (denyLines) return Response.json({ code: 'forbidden' }, { status: 403 });
      if (unavailableLines) return Response.json({ code: 'unavailable' }, { status: 503 });
      return Response.json(point.kind === 'ready' && point.lines.kind === 'ready' ? point.lines : {});
    }
    if (path.endsWith(paidCreatorStatementFixture.id)) {
      if (rotateOnPoint) {
        subject = B;
        token = 'credential-B';
        rotateOnPoint = false;
      }
      return Response.json(point.kind === 'ready' ? { statement: point.statement } : {});
    }
    return Response.json({ payoutStatements: rows, next: null });
  });
  try {
    const before = preparations;
    const emptyAddress = { kind: 'list', locale: 'fr', cursor: 'signed/list+/=' } as const;
    rows = [];
    const empty = await reads.readCreatorStatementsCurrent({ data: { locale: 'fr', cursor: emptyAddress.cursor } });
    expect(empty).toEqual({
      sessionSubject: A,
      requested: emptyAddress,
      page: { kind: 'ready', payoutStatements: [], next: null },
    });
    expect(preparations - before).toBe(1);
    expect(calls).toHaveLength(1);
    expect(reads.acceptsStatementsCurrent(empty, B, emptyAddress)).toBe(false);
    expect(reads.acceptsStatementsCurrent(empty, A, { ...emptyAddress, cursor: null })).toBe(false);
    expect(calls[0]!.headers.get('authorization')).toBe('Bearer credential-A');
    expect(calls[0]!.headers.get('accept-language')).toStartWith('fr');
    expect(Object.fromEntries(new URL(calls[0]!.url).searchParams)).toEqual({
      limit: '20',
      cursor: emptyAddress.cursor,
    });
    const input = {
      locale: 'en',
      id: paidCreatorStatementFixture.id,
      cursor: 'signed/lines+/=',
      from: 'signed/back+/=',
    };
    const value = await reads.readCreatorStatementCurrent({ data: input });
    expect(value).toEqual({ sessionSubject: A, requested: { kind: 'detail', ...input }, page: point });
    expect(preparations - before).toBe(2);
    subject = A;
    token = 'credential-A';
    expect(calls).toHaveLength(3);
    expect(reads.acceptsStatementsCurrent(value, A, { ...value.requested, locale: 'fr' })).toBe(false);
    expect(
      reads.acceptsStatementsCurrent(value, A, {
        ...value.requested,
        kind: 'detail',
        id: creatorStatementFixture.id,
        from: null,
      }),
    ).toBe(false);
    expect(calls.slice(1).every((call) => call.headers.get('authorization') === 'Bearer credential-A')).toBe(true);
    expect(Object.fromEntries(new URL(calls[2]!.url).searchParams)).toEqual({ limit: '20', cursor: input.cursor });
    expect(calls.every((call) => call.cache === 'no-store' && call.redirect === 'manual')).toBe(true);
    expect(headers.get('cache-control')).toBe('private, no-store');
    expect(headers.get('x-robots-tag')).toBe('noindex, nofollow');
    expect(JSON.stringify(value)).not.toMatch(/credential-A|private-csrf/);

    rows = [{ ...creatorStatementFixture, creatorAccountId: B }];
    expect((await reads.readCreatorStatementsCurrent({ data: { locale: 'en' } })).page).toEqual({
      kind: 'unavailable',
    });
    point = detail(B).page;
    const count = calls.length;
    expect((await reads.readCreatorStatementCurrent({ data: input })).page).toEqual({ kind: 'unavailable' });
    expect(calls.length - count).toBe(1); // A foreign point never starts lines.
    point = detail().page;
    if (point.kind === 'ready' && point.lines.kind === 'ready')
      point.lines.lines[0]!.statementId = creatorStatementFixture.id;
    expect((await reads.readCreatorStatementCurrent({ data: input })).page).toEqual({ kind: 'unavailable' });
    point = detail().page;
    denyLines = true;
    expect((await reads.readCreatorStatementCurrent({ data: input })).page).toEqual({ kind: 'denied' });
    denyLines = false;
    unavailableLines = true;
    expect((await reads.readCreatorStatementCurrent({ data: input })).page).toMatchObject({
      kind: 'ready',
      lines: { kind: 'unavailable' },
    });
    unavailableLines = false;

    const { prepareSession, viewerCredential } = await import('../src/session/request');
    await prepareSession(currentRequest, env as unknown as Partial<SessionEnv>);
    expect(viewerCredential(currentRequest)).toBe('Bearer credential-A');
    const noReads = calls.length;
    preparation = 'absent';
    expect((await reads.readCreatorStatementsCurrent({ data: { locale: 'en' } })).page).toEqual({ kind: 'denied' });
    expect((await reads.readCreatorStatementCurrent({ data: input })).sessionSubject).toBeNull();
    preparation = 'unavailable';
    expect((await reads.readCreatorStatementCurrent({ data: input })).page).toEqual({ kind: 'unavailable' });
    preparation = 'active';
    subject = '';
    expect((await reads.readCreatorStatementsCurrent({ data: { locale: 'en' } })).page).toEqual({ kind: 'denied' });
    subject = A;
    token = '';
    expect((await reads.readCreatorStatementCurrent({ data: input })).page).toEqual({ kind: 'denied' });
    token = 'credential-A';
    currentRequest.headers.delete('cookie'); // Retained Request maps must not count as fresh preparation.
    expect((await reads.readCreatorStatementsCurrent({ data: { locale: 'en' } })).sessionSubject).toBeNull();
    currentRequest.headers.set('authorization', 'Bearer unrelated');
    expect((await reads.readCreatorStatementCurrent({ data: input })).page).toEqual({ kind: 'denied' });
    expect(calls).toHaveLength(noReads);
  } finally {
    native.mockRestore();
    currentRequest = request();
    subject = A;
    token = 'credential-A';
    preparation = 'active';
  }
});

test('mounted actual routes keep only current viewer/address data across hydration, replacement and admission/address ABA', async () => {
  const { createRoot, hydrateRoot } = await import('react-dom/client');
  const { flushSync } = await import('react-dom');
  const { renderToString } = await import('react-dom/server');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { createRouter, createRootRoute, createMemoryHistory, RouterContextProvider } =
    await import('@tanstack/react-router');
  const { Route: ListRoute } = await import('../src/routes/creator/statements/index');
  const { Route: DetailRoute } = await import('../src/routes/creator/statements/$id');
  const { requireSignedIn } = await import('../src/session/guard');
  expect(ListRoute.options.beforeLoad).toBe(requireSignedIn);
  expect(DetailRoute.options.beforeLoad).toBe(requireSignedIn);
  const pending: (ReturnType<typeof deferred<CurrentRead>> & { address: CreatorStatementsAddress })[] = [];
  const enqueue = (address: CreatorStatementsAddress) => {
    const work = { ...deferred<CurrentRead>(), address };
    pending.push(work);
    return work.promise;
  };
  const listRead = spyOn(reads, 'readCreatorStatementsCurrent').mockImplementation(
    ({ data }) =>
      enqueue({
        kind: 'list',
        locale: data.locale,
        cursor: data.cursor ?? null,
      }) as Promise<CreatorStatementsCurrentRead>,
  );
  const detailRead = spyOn(reads, 'readCreatorStatementCurrent').mockImplementation(
    ({ data }) =>
      enqueue({
        kind: 'detail',
        locale: data.locale,
        id: data.id,
        cursor: data.cursor ?? null,
        from: data.from ?? null,
      }) as Promise<CreatorStatementCurrentRead>,
  );
  let initialList = list();
  let initialDetail = detail();
  let search: { cursor?: string; from?: string } = {};
  let pointId = paidCreatorStatementFixture.id;
  let mode: 'list' | 'detail' = 'list';
  let locale: 'en' | 'fr' = 'en';
  const spies = [
    spyOn(ListRoute, 'useLoaderData').mockImplementation(() => initialList),
    spyOn(ListRoute, 'useSearch').mockImplementation(() => search),
    spyOn(DetailRoute, 'useLoaderData').mockImplementation(() => initialDetail),
    spyOn(DetailRoute, 'useSearch').mockImplementation(() => search),
    spyOn(DetailRoute, 'useParams').mockImplementation(() => ({ id: pointId })),
  ];
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createRouter({
    routeTree: createRootRoute(),
    history: createMemoryHistory({ initialEntries: ['/en/creator/statements'] }),
  });
  const host = document.createElement('main');
  document.body.append(host);
  let root: ReturnType<typeof createRoot> | undefined;
  const tree = () => {
    const Page = (mode === 'list' ? ListRoute.options.component : DetailRoute.options.component) as ComponentType;
    return (
      <StrictMode>
        <QueryClientProvider client={client}>
          <RouterContextProvider router={router}>
            <Page />
          </RouterContextProvider>
        </QueryClientProvider>
      </StrictMode>
    );
  };
  const viewer = (who = A) => ({ state: 'signed-in', subject: who, csrfToken: `csrf-${who}` });
  const show = async (
    session: { state: string; subject?: string; csrfToken: string | null } = viewer(),
    admitted = true,
    replaceSession = false,
  ) => {
    await act(async () =>
      flushSync(() => {
        const currentSession = client.getQueryData<{
          state: string;
          subject?: string;
          csrfToken: string | null;
        }>(['session']);
        if (
          replaceSession ||
          !currentSession ||
          session.state !== currentSession.state ||
          session.subject !== currentSession.subject ||
          session.csrfToken !== currentSession.csrfToken
        ) {
          client.setQueryData(['session'], session);
        }
        const observation = viewerExposureLifetime(client).getSnapshot();
        if (observation.state === 'signed-in') {
          const options = viewerExposureQuery(observation.observation);
          const value = {
            subject: observation.observation.subject,
            admitted: admitted ? ['selling'] : [],
          };
          const current = client.getQueryData<typeof value>(options.queryKey);
          if (
            !current ||
            current.subject !== value.subject ||
            current.admitted.length !== value.admitted.length ||
            current.admitted.some((group, index) => group !== value.admitted[index])
          )
            client.setQueryData(options.queryKey, value);
        }
        client.setQueryData(['exposure', 'anonymous'], []);
        window.history.replaceState(null, '', `/${locale}/creator/statements${mode === 'detail' ? `/${pointId}` : ''}`);
        setLocale(locale, { reload: false });
        root?.render(tree());
      }),
    );
  };
  const tick = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  const settle = async (index: number, value: CurrentRead) => {
    await act(async () => pending[index]!.resolve(value));
    await tick();
  };
  const privateAbsent = (who: string) => {
    expect(host.textContent).not.toContain(`Private payment ${who}`);
    expect(host.textContent).not.toContain(`txn-${who}`);
    expect(host.innerHTML).not.toContain(encodeURIComponent(`next-${who}+/=`));
    expect(host.textContent).not.toContain('$6.75');
  };
  try {
    // Route loaders preserve normalized display addresses, including detail back navigation.
    const loadList = ListRoute.options.loader as (input: {
      deps: { cursor: string };
    }) => Promise<CreatorStatementsCurrentRead>;
    const loadingList = loadList({ deps: { cursor: 'loader+/=' } });
    expect(pending[0]!.address).toEqual({ kind: 'list', locale: 'en', cursor: 'loader+/=' });
    pending[0]!.resolve(list(A, 'loader+/='));
    expect(await loadingList).toEqual(list(A, 'loader+/='));
    const loadDetail = DetailRoute.options.loader as (input: {
      params: { id: string };
      deps: { cursor: string; from: string };
    }) => Promise<CreatorStatementCurrentRead>;
    const loadingDetail = loadDetail({ params: { id: pointId }, deps: { cursor: 'line+/=', from: 'list+/=' } });
    expect(pending[1]!.address).toEqual({
      kind: 'detail',
      locale: 'en',
      id: pointId,
      cursor: 'line+/=',
      from: 'list+/=',
    });
    pending[1]!.resolve(detail(A, pointId, 'line+/=', 'list+/='));
    await loadingDetail;
    pending.length = 0;
    await show();
    const html = renderToString(tree());
    expect(html).toContain('-$3.15');
    initialList = { ...list(), sessionSubject: B };
    // SSR uses actual provenance; foreign rows cannot be certified even with an asserted subject.
    expect(renderToString(tree())).not.toContain('-$3.15');
    initialList = list();
    host.innerHTML = html;
    const hydrationErrors: unknown[] = [];
    await act(async () => {
      root = hydrateRoot(host, tree(), { onRecoverableError: (error) => hydrationErrors.push(error) });
    });
    await tick();
    expect(hydrationErrors).toEqual([]);
    expect(pending).toHaveLength(0);
    await show({ ...viewer(), csrfToken: 'rotated-credential' });
    expect(pending).toHaveLength(1);
    await settle(0, list());
    pending.length = 0;
    expect(host.querySelector(`a[href*="${creatorStatementFixture.id}"]`)).not.toBeNull();

    // Replacing the session with an equal snapshot still retires its admitted visit.
    await show({ ...viewer(), csrfToken: 'rotated-credential' }, true, true);
    expect(pending).toHaveLength(1);
    expect(host.querySelector(`a[href*="${creatorStatementFixture.id}"]`)).toBeNull();
    await settle(0, list());
    pending.length = 0;
    expect(host.querySelector(`a[href*="${creatorStatementFixture.id}"]`)).not.toBeNull();

    search = { cursor: 'pending-A+/=' };
    await show();
    expect(pending).toHaveLength(1);
    await show(viewer(B));
    privateAbsent(A);
    expect(host.querySelector(`a[href*="${creatorStatementFixture.id}"]`)).toBeNull();
    expect(pending).toHaveLength(2);
    await settle(1, list(B, search.cursor!)); // B is usable before unresolved A.
    expect(host.innerHTML).toContain(encodeURIComponent(`next-${B}+/=`));
    const b = host.innerHTML;
    await settle(0, list(A, search.cursor!));
    expect(host.innerHTML).toBe(b);

    // Unknown/unsigned/missing real identity/closed admission dispatch nothing and retire immediately.
    await show({ state: 'unknown', csrfToken: null });
    expect(host.textContent).toContain(m.statements_preparing());
    expect(pending).toHaveLength(2);
    await show({ state: 'signed-out', csrfToken: null });
    expect(host.textContent).toContain(m.statements_denied());
    await show(viewer(''));
    expect(pending).toHaveLength(2);
    await show({ state: 'unavailable', csrfToken: null });
    expect(host.textContent).toContain(m.statements_unavailable());
    await show(viewer(A), false);
    expect(pending).toHaveLength(2);
    search = {};
    await show(); // A's old matching SSR must never seed after replacement.
    expect(pending).toHaveLength(3);
    expect(host.textContent).not.toContain('-$3.15');
    const wrongEmpty = {
      ...list(B),
      page: { kind: 'ready', payoutStatements: [], next: null },
    } as CreatorStatementsCurrentRead;
    await settle(2, wrongEmpty);
    expect(host.textContent).not.toContain(m.statements_empty());
    expect(host.textContent).toContain(m.statements_preparing());
    await show(viewer(), false);
    await show();
    expect(pending).toHaveLength(4);
    await settle(3, list());
    expect(host.textContent).toContain('-$3.15');

    mode = 'detail';
    search = { cursor: 'line+/=', from: 'back+/=' };
    initialDetail = detail(A, pointId, search.cursor, search.from);
    await show();
    expect(host.textContent).toContain(`Private payment ${A}`);
    expect(host.textContent).toContain(`txn-${A}`);
    expect(host.querySelector('a[href*="cursor=back%2B%2F%3D"]')).not.toBeNull();
    expect(host.querySelector('a[href*="cursor=line%2B%2F%3D&from=back%2B%2F%3D"]')).not.toBeNull();
    expect(host.querySelector('a[href*="cursor=lines-"]')).not.toBeNull();

    // Exact from/cursor/id/locale replacements each require new acceptance, including address ABA.
    search = { ...search, from: 'other-back' };
    const oldA = pending.length;
    await show();
    privateAbsent(A);
    await show(viewer(B));
    const newB = pending.length - 1;
    await settle(newB, detail(B, pointId, search.cursor!, search.from!));
    expect(host.textContent).toContain(`Private payment ${B}`);
    const currentB = host.innerHTML;
    await act(async () => pending[oldA]!.reject(new Error('Late A transport failure')));
    await tick();
    expect(host.innerHTML).toBe(currentB);
    await show(viewer(B), false);
    privateAbsent(B);
    const admittedB = pending.length;
    await show(viewer(B));
    privateAbsent(B);
    expect(pending).toHaveLength(admittedB + 1);
    const wrongAddress = detail(B, pointId, search.cursor!, 'wrong-back');
    await settle(admittedB, wrongAddress);
    privateAbsent(B);
    search = { cursor: 'second-lines', from: 'other-back' };
    const secondLines = pending.length;
    await show(viewer(B));
    await settle(secondLines, detail(B, pointId, 'second-lines', 'other-back'));
    expect(host.textContent).toContain(`Private payment ${B}`);
    search = { cursor: 'line+/=', from: 'other-back' };
    const returning = pending.length;
    await show(viewer(B));
    privateAbsent(B);
    search = { cursor: 'second-lines', from: 'other-back' };
    const backAgain = pending.length;
    await show(viewer(B));
    privateAbsent(B);
    await settle(returning, detail(B, pointId, 'line+/=', 'other-back'));
    privateAbsent(B);
    await settle(backAgain, detail(B, pointId, search.cursor!, search.from!));
    expect(host.textContent).toContain(`Private payment ${B}`);
    pointId = creatorStatementFixture.id;
    locale = 'fr';
    initialDetail = detail(B, pointId, search.cursor!, search.from!, locale);
    const moved = pending.length;
    await show(viewer(B));
    privateAbsent(B);
    expect(pending.slice(moved).map(({ address }) => address)).toEqual([
      { kind: 'detail', locale: 'fr', id: pointId, cursor: search.cursor!, from: search.from! },
    ]);
    await settle(moved, detail(B, pointId, search.cursor!, search.from!, locale));
    expect(host.textContent).toContain(`Private payment ${B}`);
    expect(host.querySelector(`a[href^="/fr/creator/statements/${pointId}?"]`)).not.toBeNull();
    // Existing full navigation refresh/retry stays exact and useful after a current unavailable read.
    search = { cursor: 'retry-lines', from: 'back+/=' };
    const failed = pending.length;
    await show(viewer(B));
    await settle(failed, {
      ...detail(B, pointId, search.cursor!, search.from!, locale),
      page: { kind: 'unavailable' },
    });
    expect(host.textContent).toContain(m.statements_unavailable());
    const retry = host.querySelector<HTMLButtonElement>('button');
    expect(retry?.textContent).toBe(m.statements_retry());
    const retryCount = pending.length;
    await act(async () => retry!.click());
    await tick();
    expect(pending).toHaveLength(retryCount + 1);
    expect(pending[retryCount]!.address).toEqual({
      kind: 'detail',
      locale: 'fr',
      id: pointId,
      cursor: 'retry-lines',
      from: 'back+/=',
    });
    await settle(retryCount, detail(B, pointId, 'retry-lines', 'back+/=', locale));
    expect(host.textContent).toContain(`Private payment ${B}`);
    const after = pending.length;
    await act(async () => root!.unmount());
    root = undefined;
    expect(pending).toHaveLength(after);
  } finally {
    if (root) await act(async () => root!.unmount());
    client.clear();
    listRead.mockRestore();
    detailRead.mockRestore();
    for (const spy of spies) spy.mockRestore();
    host.remove();
  }
});
