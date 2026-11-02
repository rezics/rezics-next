import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement } from 'react';
import type { CurrentLabelShelfData } from '../src/library/label-shelf-read';
import type { SessionEnv } from '../src/session/client';
import definitions from '../src/kernel/recorded/definitions-release.json';

// Authored source regression, not native or browser proof. Keep the real route, reader and pure page child.
test('The actual named-label Library renders private FULL assignments and remove or Undo forms only for the current observed viewer and exact admitted source', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/library', width: 1280, height: 900 });
  window.document.documentElement.lang = 'en';
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement,
    Element: window.Element,
    Node: window.Node,
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const originalFetch = globalThis.fetch;
  const id = (n: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(n).padStart(12, '0')}`;
  const A = id(700);
  const B = id(701);
  const C = id(702);
  const labelId = id(800);
  const undoKey = id(801);
  const admitted = ['personal_library', 'reading_progress', 'library_label.assignment_list', 'library_label.unassign'];
  let credentialSubject = A;
  let noCsrf = true;
  let credentials = 0;
  const tokens = new Map([
    [A, 'credential-a'],
    [B, 'credential-b'],
    [C, 'credential-c'],
  ]);
  const csrf = (subject: string) => (subject === A ? 'a' : subject === B ? 'b' : 'c').repeat(22);
  const credential = async () => {
    credentials++;
    return {
      status: 'active',
      subject: credentialSubject,
      accessToken: tokens.get(credentialSubject),
      csrfToken: noCsrf ? null : csrf(credentialSubject),
    };
  };
  const sessionEnv = {
    KERNEL_ORIGIN: 'https://kernel.test',
    AUTH_ISSUER: 'https://auth.test',
    API_RESOURCE: 'https://kernel.test',
    WEBSITE_SCOPES: 'library_entry:list progress_session:list',
    WEBSITE_CLIENT_ID: 'label-current-test',
    WEBSITE_CLIENT_KEY: '{}',
    SESSIONS: { idFromName: (value: string) => value, get: () => ({ credential, credentialIfFresh: credential }) },
  };
  const parameters = new URLSearchParams({
    label: labelId,
    cursor: 'source-one',
    layout: 'table',
    undoLabelId: labelId,
    undoSubjectId: id(1),
    undoAssignmentId: id(10),
    undoRevision: '9',
    undoKey,
    labelResult: 'label-restore-stale',
  });
  let address = `/en/library?${parameters}`;
  const request = () =>
    new Request(`https://site.test${address}`, {
      headers: { cookie: `__Host-rezics_session=${'a'.repeat(43)}` },
    });
  const start = await import('../.storybook/react-start');
  mock.module('@tanstack/react-start', () => start);
  const cacheHeaders: string[] = [];
  mock.module('@tanstack/react-start/server', () => ({
    getRequest: request,
    setResponseHeader(name: string, value: string) {
      if (name.toLowerCase() === 'cache-control') cacheHeaders.push(value);
    },
  }));
  mock.module('cloudflare:workers', () => ({ env: sessionEnv }));
  const reads: Request[] = [];
  const held: {
    subject: string;
    cursor: string | null;
    resolve: (response: Response) => void;
    reject: (error: Error) => void;
    response: Response;
  }[] = [];
  let hold: string | 'all' | null = null;
  let serial = 0;
  const name = (subject: string) =>
    subject === A ? 'A private shelf' : subject === B ? 'B private shelf' : 'C private shelf';
  globalThis.fetch = (async (input, init) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    if (url.pathname === '/v1/definitions/active') return Response.json({ digest: definitions.digest });
    if (url.pathname.startsWith('/v1/definitions/releases/')) return Response.json(definitions);
    reads.push(req.clone());
    if (url.pathname === '/v1/platform/exposure') return Response.json({ admitted });
    if (url.pathname !== '/v1/libraryLabelAssignments') throw new Error(`Unexpected read ${req.url}`);
    const subject = [...tokens].find(([, token]) => req.headers.get('authorization') === `Bearer ${token}`)?.[0];
    if (!subject) throw new Error('Assignment read has no associated actual credential');
    const label = url.searchParams.get('labelId')!;
    const sequence = ++serial;
    const response = Response.json({
      label: { id: label, name: name(subject), revision: 3 },
      assignments: [
        {
          id: id(11),
          labelId: label,
          subjectId: id(2),
          revision: 7,
          subject: {
            id: id(2),
            type: 'schema:Book',
            types: ['schema:Book'],
            label: { value: `${name(subject)} entry`, language: 'en' },
            cover: null,
          },
          libraryEntry: {
            state: 'in_progress',
            activeProgressSession: {
              mode: 'cumulative',
              unit: 'percent',
              dimension: 'percent',
              amount: '42',
              total: '100',
              completedUnitCount: 0,
              locator: null,
            },
          },
        },
        { id: id(12), labelId: label, subjectId: id(3), revision: 8, subject: null, libraryEntry: null },
      ],
      next: `private-next-${subject}-${sequence}`,
    });
    if (hold === 'all' || hold === subject)
      return await new Promise<Response>((resolve, reject) =>
        held.push({ subject, cursor: url.searchParams.get('cursor'), resolve, reject, response }),
      );
    return response;
  }) as typeof fetch;
  const { QueryClient, QueryClientProvider, notifyManager } = await import('@tanstack/react-query');
  const { createMemoryHistory, createRootRouteWithContext, createRouter, Outlet, RouterProvider } =
    await import('@tanstack/react-router');
  const { sessionQuery, exposureQuery } = await import('../src/session/query');
  const { loadCurrentLabelShelfPage, loadLabelShelfPage } = await import('../src/library/label-shelf-read');
  const { kernelClient } = await import('../src/kernel/client');
  const { Route } = await import('../src/routes/library/index');
  const { renderToString } = await import('react-dom/server');
  const { hydrateRoot } = await import('react-dom/client');
  const { flushSync } = await import('react-dom');
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(sessionQuery.queryKey, { state: 'signed-in', subject: A, csrfToken: null });
  client.setQueryData(exposureQuery.queryKey, admitted);
  // Synchronous notifications let assertions inspect the committed render before a passive-effect cleanup could help.
  notifyManager.setScheduler((callback) => callback());
  const base = createRootRouteWithContext<{ queryClient: typeof client }>()({ component: Outlet });
  Route.update({ id: '/library/', path: '/library/', getParentRoute: () => base } as never);
  const router = createRouter({
    routeTree: base.addChildren([Route]),
    context: { queryClient: client },
    history: createMemoryHistory({ initialEntries: [address.replace('/en/', '/')] }),
  });
  const host = window.document.createElement('div') as unknown as HTMLDivElement;
  window.document.body.append(host);
  const tree = () => createElement(QueryClientProvider, { client }, createElement(RouterProvider, { router }));
  let root: ReturnType<typeof hydrateRoot> | undefined;
  const input = {
    labelId,
    limit: 100,
    cursor: 'source-one',
    undoKey,
    labelResult: 'label-restore-stale',
    undo: { labelId, subjectId: id(1), assignmentId: id(10), revision: 9 },
  };
  const fields = () =>
    Array.from(host.querySelectorAll('form')).map((form) =>
      Object.fromEntries(Array.from(form.querySelectorAll('input')).map((field) => [field.name, field.value])),
    );
  const absent = () => {
    expect(host.textContent).not.toContain('private shelf');
    expect(host.textContent).not.toContain('42%');
    expect(host.querySelector('a[href*="private-next-"]')).toBeNull();
    expect(host.querySelector('a[href*="/subjects/"]')).toBeNull();
    expect(host.querySelector('form')).toBeNull();
    expect(host.innerHTML).not.toContain('idempotencyKey');
  };
  const visible = (subject: string, token: string | null = csrf(subject)) => {
    expect(host.textContent).toContain(name(subject));
    expect(host.textContent).toContain(`${name(subject)} entry`);
    expect(host.textContent).toContain('42%');
    expect(host.querySelector(`a[href*="private-next-${subject}"]`)).not.toBeNull();
    expect(fields().find((form) => form.intent === 'restore')).toMatchObject({
      assignmentId: id(10),
      revision: '9',
      idempotencyKey: undoKey,
      csrf_token: token ?? '',
    });
    expect(fields().find((form) => form.intent === 'unassign')).toMatchObject({
      assignmentId: id(12),
      revision: '8',
      csrf_token: csrf(subject),
    });
  };
  const observe = (state: string, subject: string | null, token = subject ? csrf(subject) : null) => {
    flushSync(() => client.setQueryData(sessionQuery.queryKey, { state, subject, csrfToken: token }));
  };
  const settle = async () => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };
  const currentQuery = () =>
    client
      .getQueryCache()
      .findAll({ queryKey: ['library', 'label-shelf'] })
      .find((query) => query.getObserversCount() > 0)!;
  const navigate = (values: URLSearchParams) => {
    address = `/en/library?${values}`;
    return router.navigate({ href: address.replace('/en/', '/') });
  };
  try {
    const envelope = await loadCurrentLabelShelfPage(
      kernelClient(),
      request(),
      sessionEnv as unknown as SessionEnv,
      input,
    );
    expect(envelope.state).toBe('loaded');
    expect(envelope.csrfToken).toBeNull();
    expect(envelope.provenance).toEqual({
      subject: A,
      locale: 'en',
      source: { labelId, cursor: 'source-one', undo: input.undo, undoKey, labelResult: input.labelResult },
    });
    expect(envelope).not.toHaveProperty('page');
    expect(JSON.stringify(envelope)).not.toContain('credential-a');
    expect(credentials).toBe(1);
    expect(reads.map((req) => new URL(req.url).pathname)).toEqual([
      '/v1/platform/exposure',
      '/v1/libraryLabelAssignments',
    ]);
    expect(reads.map((req) => req.headers.get('authorization'))).toEqual([
      'Bearer credential-a',
      'Bearer credential-a',
    ]);
    expect(Object.fromEntries(new URL(reads[1]!.url).searchParams)).toEqual({
      labelId,
      view: 'FULL',
      limit: '100',
      cursor: 'source-one',
    });
    const old = await loadLabelShelfPage(kernelClient(), request(), sessionEnv as unknown as SessionEnv, input);
    expect(old).not.toHaveProperty('provenance');
    expect(old.state).toBe('loaded');
    expect(old.csrfToken).toBeNull();
    expect(credentials).toBe(2);
    expect(reads).toHaveLength(4);
    if (old.state !== 'loaded' || envelope.state !== 'loaded') throw new Error('Missing actual FULL result');
    expect(old.entries[0]?.subject).toEqual(envelope.entries[0]?.subject);
    expect(old.undoKey).toBe(undoKey);
    expect(old.undo).toEqual(input.undo);
    credentialSubject = '';
    expect(
      (await loadCurrentLabelShelfPage(kernelClient(), request(), sessionEnv as unknown as SessionEnv, input)).state,
    ).toBe('unavailable');
    expect(reads).toHaveLength(4);
    credentialSubject = A;

    await router.load();
    const initial = router.state.matches.find((match) => match.routeId === '/library/')!
      .loaderData as CurrentLabelShelfData;
    expect(initial.provenance.subject).toBe(A);
    expect(cacheHeaders).toContain('private, no-store');
    const beforeHydration = serial;
    host.innerHTML = renderToString(tree());
    expect(host.textContent).toContain('A private shelf entry');
    expect(host.textContent).toContain('42%');
    expect(host.querySelector('a[href*="private-next-"]')).not.toBeNull();
    await act(async () => {
      root = hydrateRoot(host, tree());
    });
    visible(A, null);
    const undoForm = host.querySelector<HTMLFormElement>('[data-label-undo]')!;
    const blockedSubmit = new window.Event('submit', { bubbles: true, cancelable: true });
    undoForm.dispatchEvent(blockedSubmit);
    expect(blockedSubmit.defaultPrevented).toBe(true);
    noCsrf = false;
    expect(serial).toBe(beforeHydration); // Matching SSR does not repeat the FULL page read.
    const originalForms = fields();
    const display = new URLSearchParams(parameters);
    display.set('layout', 'list');
    display.set('size', 'l');
    display.set('columns', 'title');
    await act(async () => {
      await navigate(display);
    });
    expect(serial).toBe(beforeHydration);
    expect(fields()).toEqual(originalForms);
    observe('signed-in', A, 'z'.repeat(22));
    expect(fields()).toEqual(originalForms); // Rotation cannot rebuild an unresolved command or change its captured CSRF.

    // A's old IO is still pending when B becomes independently healthy.
    hold = A;
    let oldIO!: Promise<void>;
    await act(async () => {
      oldIO = client.invalidateQueries({ queryKey: ['library', 'label-shelf'] });
    });
    expect(held).toHaveLength(1);
    credentialSubject = B;
    observe('signed-in', B);
    absent();
    await settle();
    visible(B);
    const bForms = fields();
    await act(async () => {
      const pending = held.shift()!;
      pending.resolve(pending.response);
      await oldIO;
    });
    visible(B);
    expect(fields()).toEqual(bForms);
    hold = null;

    observe('unknown', null);
    absent();
    observe('signed-in', B);
    absent();
    await settle();
    visible(B);
    observe('signed-out', null);
    absent();
    observe('signed-in', B);
    absent();
    await settle();
    visible(B);
    for (const group of admitted.slice(0, 3)) {
      flushSync(() =>
        client.setQueryData(
          exposureQuery.queryKey,
          admitted.filter((value) => value !== group),
        ),
      );
      absent();
      flushSync(() => client.setQueryData(exposureQuery.queryKey, admitted));
      absent();
      await settle();
      visible(B);
    }

    // Actual C credentials cannot authorize B's browser observation, even with the right address.
    observe('unknown', null);
    credentialSubject = C;
    observe('signed-in', B);
    await settle();
    absent();
    expect(host.textContent).not.toContain(name(C));
    credentialSubject = B;
    observe('unknown', null);
    observe('signed-in', B);
    await settle();
    visible(B);
    const current = currentQuery();
    const matching = current.state.data as CurrentLabelShelfData;
    const other = await loadCurrentLabelShelfPage(kernelClient(), request(), sessionEnv as unknown as SessionEnv, {
      ...input,
      labelId: id(899),
    });
    flushSync(() => client.setQueryData(current.queryKey, other));
    absent(); // Even a genuinely read envelope is unusable at a different label address.
    flushSync(() => client.setQueryData(current.queryKey, matching));
    visible(B);
    address = address.replace('/en/', '/ja/');
    const japanese = await loadCurrentLabelShelfPage(
      kernelClient(),
      request(),
      sessionEnv as unknown as SessionEnv,
      input,
    );
    address = address.replace('/ja/', '/en/');
    expect(japanese.provenance.locale).toBe('ja');
    flushSync(() => client.setQueryData(current.queryKey, japanese));
    absent();
    flushSync(() => client.setQueryData(current.queryKey, matching));
    visible(B);

    // Pending cursor/Undo replacement retires retained route data; returning to the original address is a new lifetime.
    hold = 'all';
    const changed = new URLSearchParams(display);
    changed.set('cursor', 'source-two');
    changed.set('undoKey', id(802));
    changed.set('labelResult', 'label-restore-expired');
    let away!: Promise<void>;
    await act(async () => {
      away = navigate(changed);
    });
    absent();
    let back!: Promise<void>;
    await act(async () => {
      back = navigate(display);
    });
    absent();
    expect(currentQuery().state.data).toBeUndefined();
    const returning = held.filter((pending) => pending.cursor === 'source-one');
    expect(returning.length).toBeGreaterThan(0);
    await act(async () => {
      for (const pending of returning) {
        held.splice(held.indexOf(pending), 1);
        pending.resolve(pending.response);
      }
      await back;
    });
    visible(B);
    expect(fields().find((form) => form.intent === 'unassign')?.idempotencyKey).not.toBe(
      bForms.find((form) => form.intent === 'unassign')?.idempotencyKey,
    );
    const returnedForms = fields();
    await act(async () => {
      for (const pending of held.splice(0)) pending.resolve(pending.response);
      await away;
    });
    visible(B);
    expect(fields()).toEqual(returnedForms);
    hold = null;

    // Replacing only Undo intent also retires the whole private population, without a cursor change.
    hold = 'all';
    const undoOnly = new URLSearchParams(display);
    undoOnly.set('undoKey', id(803));
    await act(async () => {
      away = navigate(undoOnly);
    });
    absent();
    await act(async () => {
      back = navigate(display);
    });
    absent();
    expect(currentQuery().state.data).toBeUndefined();
    // Both addresses have the same native keyset; settle the current route/query before its old loader.
    await act(async () => {
      for (const pending of held.splice(0)) pending.resolve(pending.response);
      await back;
      await away;
    });
    visible(B);
    expect(fields().find((form) => form.intent === 'restore')?.idempotencyKey).toBe(undoKey);
    hold = null;

    // A late failure/finally from a retired B lifetime cannot clear a newer matching B result.
    hold = B;
    await act(async () => {
      oldIO = client.invalidateQueries({ queryKey: ['library', 'label-shelf'] });
    });
    observe('unknown', null);
    absent();
    hold = null;
    observe('signed-in', B);
    await settle();
    visible(B);
    const finalForms = fields();
    await act(async () => {
      for (const pending of held.splice(0)) pending.reject(new Error('late old read'));
      await oldIO;
    });
    visible(B);
    expect(fields()).toEqual(finalForms);
    expect(
      reads
        .filter((req) => new URL(req.url).pathname === '/v1/libraryLabelAssignments')
        .every((req) => {
          const query = new URL(req.url).searchParams;
          return query.get('limit') === '100' && query.get('view') === 'FULL';
        }),
    ).toBe(true);
  } finally {
    hold = null;
    for (const pending of held.splice(0)) pending.resolve(pending.response);
    if (root) await act(async () => root!.unmount());
    client.clear();
    notifyManager.setScheduler((callback) => setTimeout(callback, 0));
    globalThis.fetch = originalFetch;
    mock.restore();
    for (const [key, descriptor] of previous)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    window.happyDOM.abort();
  }
});
