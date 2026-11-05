import { afterAll, expect, mock, spyOn, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, StrictMode } from 'react';
import { createKernelClient } from '@rezics/client';
import * as start from '../.storybook/react-start';
import type { SessionEnv } from '../src/session/client';
import type { PublishedLogCurrentRead } from '../src/library/logs-read';

// UNRUN: focused actual-reader/mounted-composition assertions for integration, not native or visual proof.
const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/logs/original' });
const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  HTMLButtonElement: window.HTMLButtonElement,
  Element: window.Element,
  Node: window.Node,
  DocumentFragment: window.DocumentFragment,
  MutationObserver: window.MutationObserver,
  ResizeObserver: window.ResizeObserver,
  getComputedStyle: window.getComputedStyle.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
afterAll(async () => {
  mock.restore();
  await window.happyDOM.close();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
type Viewer = { state: 'signed-in' | 'signed-out' | 'unknown'; subject?: string; csrfToken: string | null };
const viewer = (subject = 'A', csrfToken = `${subject}-csrf-token-1234567890`): Viewer => ({
  state: 'signed-in',
  subject,
  csrfToken,
});
let current = viewer();
let request: Request;
let preparation: 'active' | 'absent' = 'active';
let prepared = 0;
const requestFor = (method = 'GET') =>
  new Request('https://site.test/en/logs/original', {
    method,
    headers: {
      cookie: `__Host-rezics_session=${'a'.repeat(43)}`,
      origin: 'https://site.test',
      'x-csrf-token': current.csrfToken ?? '',
    },
  });
const env: Partial<SessionEnv> = {
  SITE_ORIGINS: 'https://site.test',
  AUTH_ISSUER: 'https://auth.test',
  API_RESOURCE: 'https://kernel.test',
  WEBSITE_SCOPES: 'openid',
  WEBSITE_CLIENT_ID: 'web',
  WEBSITE_CLIENT_KEY: 'unused',
  SESSIONS: {
    idFromName: (id: string) => id,
    get: () => ({
      credential: async () => {
        prepared++;
        return preparation === 'absent'
          ? { status: 'absent' }
          : {
              status: 'active',
              subject: current.subject,
              accessToken: `access-${current.subject}`,
              csrfToken: current.csrfToken,
            };
      },
    }),
  } as unknown as SessionEnv['SESSIONS'],
};
let nativeOwner = 'A';
let nativeRevision = 7;
let readFailure: Response | null = null;
const stamp = '2026-04-01T10:00:00.000Z';
function snapshot(id: string) {
  return {
    id,
    accountId: nativeOwner,
    subjectId: 'subject',
    sessionState: 'completed',
    startedAt: stamp,
    completedAt: stamp,
    publishedAt: stamp,
    note: `Public snapshot ${id}`,
    subject: { id: 'subject', type: 'book', types: ['book'], label: 'Public subject', cover: null },
    account: { id: nativeOwner, handle: 'B', displayName: 'Public reader' },
  };
}
const nativeReads: Request[] = [];
const writes: { request: Request; body: unknown; work: ReturnType<typeof deferred<Response>> }[] = [];
const client = createKernelClient('https://kernel.test', {
  fetch: async (input, init) => {
    const call = new Request(input, init);
    if (call.method === 'GET') {
      nativeReads.push(call);
      if (readFailure) return readFailure.clone();
      const id = new URL(call.url).pathname.split('/').at(-1)!;
      return Response.json(
        { publishedLog: snapshot(id) },
        { headers: { 'Library-Published-Log-Revision': String(nativeRevision) } },
      );
    }
    const work = deferred<Response>();
    writes.push({ request: call, body: call.method === 'POST' ? await call.json() : null, work });
    return work.promise;
  },
});
mock.module('cloudflare:workers', () => ({ env }));
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => ({ ...start, getRequest: () => request }));
mock.module('../src/kernel/client', () => ({ kernelClient: () => client }));
mock.module('../src/subject/definitions', () => ({ nameSubjectTypes: async () => {} }));
const server = await import('../src/library/logs-server');
const actualRead = server.readPublishedLogCurrent;
const { prepareSession } = await import('../src/session/request');
const { UndoNotice } = await import('../src/library/copies-undo');
let undoProps: Parameters<typeof UndoNotice>[0] | undefined;
mock.module('../src/library/copies-undo', () => ({
  UndoNotice: (props: Parameters<typeof UndoNotice>[0]) => {
    undoProps = props;
    return <UndoNotice {...props} />;
  },
}));
const { CurrentPublishedLog } = await import('../src/library/log-current');
const exposure = await import('../src/kernel/exposure');
const { QueryClient, QueryClientProvider, useQuery } = await import('@tanstack/react-query');
const { createRoot, hydrateRoot } = await import('react-dom/client');
const { renderToString } = await import('react-dom/server');
const { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } =
  await import('@tanstack/react-router');
const { m } = await import('../src/paraglide/messages.js');
const { setLocale } = await import('../src/paraglide/runtime.js');
setLocale('en', { reload: false });
const settle = (action: () => void) =>
  act(async () => {
    action();
  });
async function read(owner = 'A', id = 'original', revision = 7) {
  current = viewer(owner);
  nativeOwner = owner;
  nativeRevision = revision;
  preparation = 'active';
  request = requestFor();
  return actualRead({ data: { id } });
}
function retainedClick(button: HTMLButtonElement) {
  const key = Object.keys(button).find((key) => key.startsWith('__reactProps$'))!;
  return (button as unknown as Record<string, { onClick: () => void }>)[key]!.onClick;
}
async function mount(initial?: PublishedLogCurrentRead, observed?: Viewer, hydrate = false) {
  const loaded = initial ?? (await read());
  writes.length = 0;
  undoProps = undefined;
  current = observed ?? current;
  request = requestFor('POST');
  const reads: { data: { id: string }; work: ReturnType<typeof deferred<PublishedLogCurrentRead>> }[] = [];
  const reading = spyOn(server, 'readPublishedLogCurrent').mockImplementation(({ data }) => {
    const work = deferred<PublishedLogCurrentRead>();
    reads.push({ data, work });
    return work.promise;
  });
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  cache.setQueryData(['session'], current);
  cache.setQueryData(['exposure', 'viewer'], ['reading_progress', 'published_log.delete', 'published_log.create']);
  cache.setQueryData(['exposure', 'anonymous'], ['reading_progress']);
  const router = createRouter({
    routeTree: createRootRoute(),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  await router.load();
  const host = document.createElement('main');
  document.body.append(host);
  let at = loaded.log.id;
  let root: ReturnType<typeof createRoot>;
  const tree = (visible = true) => (
    <StrictMode>
      <QueryClientProvider client={cache}>
        <RouterContextProvider router={router}>
          {visible && <CurrentPublishedLog loaded={loaded} id={at} />}
        </RouterContextProvider>
      </QueryClientProvider>
    </StrictMode>
  );
  const hydrationErrors: unknown[] = [];
  let html = '';
  await act(async () => {
    if (hydrate) {
      html = renderToString(tree());
      host.innerHTML = html;
      root = hydrateRoot(host, tree(), { onRecoverableError: (error) => hydrationErrors.push(error) });
    } else {
      root = createRoot(host);
      root.render(tree());
    }
  });
  const button = (name: string) =>
    [...host.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent === name);
  const click = (name: string) =>
    settle(() => {
      expect(button(name)).toBeDefined();
      button(name)!.click();
    });
  const remove = async () => {
    await click(m.library_logs_delete());
    await click(m.library_logs_confirm_delete());
  };
  const show = (options: { session?: Viewer; id?: string; admitted?: boolean; visible?: boolean } = {}) =>
    act(async () => {
      if (options.session) {
        current = options.session;
        request = requestFor('POST');
        cache.setQueryData(['session'], current);
      }
      if (options.id) at = options.id;
      if (options.admitted !== undefined)
        cache.setQueryData(['exposure', 'viewer'], options.admitted ? ['reading_progress'] : []);
      root.render(tree(options.visible ?? true));
    });
  const resolveRead = async (owner = current.subject!, id = at, revision = 7) => {
    const value = await read(owner, id, revision);
    request = requestFor('POST');
    await settle(() => reads.at(-1)!.work.resolve(value));
  };
  return {
    host,
    cache,
    reads,
    html,
    hydrationErrors,
    button,
    click,
    remove,
    show,
    resolveRead,
    close: async () => {
      await act(async () => root.unmount());
      reading.mockRestore();
      cache.clear();
      host.remove();
    },
  };
}
const deletionId = '123e4567-e89b-42d3-a456-426614174001';
const deleted = (id = 'original', revision = 8) =>
  Response.json(
    { publishedLog: { id } },
    {
      headers: {
        'Library-Published-Log-Deletion-Id': deletionId,
        'Library-Published-Log-Deletion-Revision': String(revision),
      },
    },
  );

test('the actual point read proves native ownership once; anonymous snapshots hydrate without private authority', async () => {
  nativeReads.length = 0;
  prepared = 0;
  const owner = await read();
  expect(prepared).toBe(1);
  expect(nativeReads).toHaveLength(1);
  expect(owner.owner).toEqual({ sessionSubject: 'A', accountId: 'A', id: 'original', revision: 7 });
  expect(owner.log.account?.handle).toBe('B'); // Public handles do not decide ownership.
  expect(nativeReads[0]!.headers.get('authorization')).toBe('Bearer access-A');
  expect([nativeReads[0]!.cache, nativeReads[0]!.redirect]).toEqual(['no-store', 'manual']);
  expect(Object.fromEntries(new URL(nativeReads[0]!.url).searchParams)).toEqual({ view: 'FULL' });
  expect(JSON.stringify(owner)).not.toContain('access-A');
  current = viewer('B');
  request = requestFor();
  expect(await actualRead({ data: { id: 'original' } })).toMatchObject({ isOwner: false, owner: null });
  current = viewer();
  request = requestFor();
  await prepareSession(request, env);
  preparation = 'absent';
  const anonymous = await actualRead({ data: { id: 'original' } });
  expect(anonymous).toMatchObject({ isOwner: false, owner: null, log: owner.log });
  expect(nativeReads.at(-1)!.headers.has('authorization')).toBe(false);
  request.headers.delete('cookie');
  expect(await server.readPublishedLog({ data: { id: 'original' } })).toEqual({ log: owner.log, isOwner: false });
  expect(nativeReads.at(-1)!.headers.has('authorization')).toBe(false);
  request.headers.set('authorization', 'Bearer explicit-owner');
  preparation = 'active';
  expect(await actualRead({ data: { id: 'original' } })).toMatchObject({ isOwner: false, owner: null });
  request = new Request('https://site.test/en/logs/original');
  expect(await actualRead({ data: { id: 'original' } })).toMatchObject({ isOwner: false, owner: null });
  readFailure = Response.json({ code: 'not_found' }, { status: 404 });
  await expect(actualRead({ data: { id: 'original' } })).rejects.toMatchObject({ isNotFound: true });
  readFailure = null;
  const h = await mount(anonymous, { state: 'signed-out', csrfToken: null }, true);
  try {
    expect(h.html).toContain(owner.log.note!);
    expect(h.hydrationErrors).toEqual([]);
    expect(h.host.textContent).toContain('Public reader');
    expect(h.host.textContent).toContain('Public subject');
    expect(h.host.textContent).toContain(m.library_progress_state_completed());
    expect(h.host.querySelectorAll('time')).toHaveLength(3);
    expect(h.host.querySelector('button')).toBeNull();
    expect(h.reads).toHaveLength(0);
    expect(h.host.innerHTML).not.toContain('sessionSubject');
  } finally {
    await h.close();
  }
});

test('matching actual owner provenance remains useful through initial hydration', async () => {
  const initial = await read();
  const h = await mount(initial, viewer(), true);
  try {
    expect(h.hydrationErrors).toEqual([]);
    expect(h.button(m.library_logs_delete())).toBeDefined();
    expect(h.reads).toHaveLength(0);
    await h.remove();
    expect(new URL(writes[0]!.request.url).searchParams.get('revision')).toBe('7');
    await settle(() => writes[0]!.work.resolve(Response.json({ code: 'conflict' }, { status: 409 })));
    expect(h.host.querySelector('[role="alert"]')?.textContent).toBe(m.library_logs_write_failed());
  } finally {
    await h.close();
  }
});

test('new viewer/address is usable before late old success; retained callbacks and unmount cannot dispatch', async () => {
  const h = await mount();
  try {
    await h.click(m.library_logs_delete());
    const oldClick = retainedClick(h.button(m.library_logs_confirm_delete())!);
    await settle(oldClick);
    const old = writes[0]!;
    await h.show({ session: viewer('B'), id: 'replacement' });
    expect(h.button(m.library_logs_confirm_delete())).toBeUndefined();
    await settle(oldClick);
    expect(writes).toHaveLength(1);
    await h.resolveRead('B', 'replacement', 23);
    await h.remove();
    const replacement = writes[1]!;
    expect(new URL(replacement.request.url).pathname).toBe('/v1/publishedLogs/replacement');
    expect(replacement.request.headers.get('authorization')).toBe('Bearer access-B');
    expect(new URL(replacement.request.url).searchParams.get('revision')).toBe('23');
    await settle(() => old.work.resolve(deleted()));
    expect(h.host.textContent).toContain('Public snapshot replacement');
    expect(h.host.querySelector('[role="status"]')).toBeNull();
    expect(h.button(m.library_logs_confirm_delete())!.disabled).toBe(true);
    await settle(retainedClick(h.button(m.library_logs_confirm_delete())!));
    expect(writes).toHaveLength(2);
    const retained = retainedClick(h.button(m.library_logs_confirm_delete())!);
    await h.show({ visible: false });
    await settle(retained);
    await settle(() => replacement.work.reject(new Error('late old address failure')));
    expect(writes).toHaveLength(2);
    expect(h.host.textContent).toBe('');
  } finally {
    await h.close();
  }
});

test('observed viewer/admission ABA retires private state and requires a fresh actual owner read', async () => {
  const h = await mount();
  try {
    await h.remove();
    const old = writes[0]!;
    const callback = retainedClick(h.button(m.library_logs_confirm_delete())!);
    await act(async () => {
      h.cache.setQueryData(['session'], viewer('B'));
      h.cache.setQueryData(['session'], viewer());
      callback();
    });
    expect(writes).toHaveLength(1);
    expect(h.button(m.library_logs_delete())).toBeUndefined();
    await h.resolveRead();
    await h.remove();
    const fresh = writes[1]!;
    expect(fresh.request.headers.get('idempotency-key')).not.toBe(old.request.headers.get('idempotency-key'));
    await settle(() => old.work.reject(new Error('retired failure/finally')));
    expect(h.host.querySelector('[role="alert"]')).toBeNull();
    expect(h.button(m.library_logs_confirm_delete())!.disabled).toBe(true);
    const next = retainedClick(h.button(m.library_logs_confirm_delete())!);
    await act(async () => {
      h.cache.setQueryData(['exposure', 'viewer'], []);
      h.cache.setQueryData(['exposure', 'viewer'], ['reading_progress']);
      next();
    });
    expect(writes).toHaveLength(2);
    expect(h.button(m.library_logs_confirm_delete())).toBeUndefined();
    await h.resolveRead();
    await h.remove();
    await settle(() => fresh.work.resolve(deleted()));
    expect(h.button(m.library_logs_confirm_delete())!.disabled).toBe(true);
    await h.show({ session: { state: 'unknown', csrfToken: null } });
    expect(h.host.textContent).toContain('Public snapshot original');
    expect(h.host.querySelector('button')).toBeNull();
    await settle(() => writes[2]!.work.resolve(deleted()));
    await h.show({ session: { state: 'signed-out', csrfToken: null } });
    expect(h.host.textContent).toContain('Public snapshot original');
    expect(h.host.querySelector('[role="alert"]')).toBeNull();
  } finally {
    await h.close();
  }
});

test('independent admission loss preserves the other operation and readmission needs fresh evidence', async () => {
  // Exercise the two existing operations independently even while today's catalogue maps them to one group.
  const admitted = spyOn(exposure, 'operationIsAdmitted').mockImplementation(
    (operation, groups) => groups?.includes(operation) ?? false,
  );
  const operation = spyOn(exposure, 'useOperation').mockImplementation((operation) => {
    const { data } = useQuery<string[]>({ queryKey: ['exposure', 'viewer'], enabled: false });
    return data?.includes(operation) ?? false;
  });
  try {
    const deleting = await mount();
    try {
      await deleting.remove();
      const first = writes[0]!;
      await settle(() =>
        deleting.cache.setQueryData(['exposure', 'viewer'], ['reading_progress', 'published_log.delete']),
      );
      expect(deleting.reads).toHaveLength(0);
      expect(deleting.button(m.library_logs_confirm_delete())!.disabled).toBe(true);
      await settle(() => first.work.resolve(Response.json({ code: 'conflict' }, { status: 409 })));
      await deleting.click(m.library_logs_confirm_delete());
      expect(writes[1]!.request.headers.get('idempotency-key')).toBe(first.request.headers.get('idempotency-key'));
      await settle(() => writes[1]!.work.resolve(deleted()));
      expect(deleting.button(m.editor_undo())).toBeUndefined();
    } finally {
      await deleting.close();
    }
    const restoring = await mount();
    try {
      await restoring.remove();
      await settle(() => writes[0]!.work.resolve(deleted()));
      const deadline = undoProps!.deadline;
      await settle(() =>
        restoring.cache.setQueryData(['exposure', 'viewer'], ['reading_progress', 'published_log.create']),
      );
      expect(restoring.reads).toHaveLength(0);
      expect(undoProps!.deadline).toBe(deadline);
      await restoring.click(m.editor_undo());
      expect(writes[1]!.body).toEqual({ deletionId, revision: 8 });
      await settle(() =>
        writes[1]!.work.resolve(
          Response.json(
            { publishedLog: { id: 'original' } },
            {
              headers: { 'Library-Published-Log-Revision': '11' },
            },
          ),
        ),
      );
      expect(restoring.button(m.library_logs_delete())).toBeUndefined();
      await settle(() =>
        restoring.cache.setQueryData(
          ['exposure', 'viewer'],
          ['reading_progress', 'published_log.create', 'published_log.delete'],
        ),
      );
      expect(restoring.button(m.library_logs_delete())).toBeUndefined();
      await restoring.resolveRead('A', 'original', 11);
      expect(restoring.button(m.library_logs_delete())).toBeDefined();
    } finally {
      await restoring.close();
    }
  } finally {
    operation.mockRestore();
    admitted.mockRestore();
  }
});

test('token rotation preserves uncertain exact delete/Undo keys, original deadline and returned restore revision', async () => {
  let now = 1_800_000_000_000;
  const clock = spyOn(Date, 'now').mockImplementation(() => now);
  const h = await mount();
  try {
    await h.remove();
    const first = writes[0]!;
    const key = first.request.headers.get('idempotency-key');
    await settle(() => first.work.reject(new Error('unknown deletion outcome')));
    now += 1_000;
    await h.show({ session: viewer('A', 'rotated-csrf-token-123456789') });
    await h.click(m.library_logs_confirm_delete());
    expect(writes[1]!.request.url).toBe(first.request.url);
    expect(writes[1]!.request.headers.get('idempotency-key')).toBe(key);
    expect(h.reads).toHaveLength(0);
    await settle(() => writes[1]!.work.resolve(deleted()));
    expect(undoProps!.deadline).toBe(now - 1_000 + 30_000);
    await h.click(m.editor_undo());
    const undo = writes[2]!;
    expect(undo.body).toEqual({ deletionId, revision: 8 });
    expect(new URL(undo.request.url).pathname).toBe('/v1/publishedLogs/original:restore');
    await settle(() => undo.work.reject(new Error('unknown restore outcome')));
    await h.show({ session: viewer('A', 'second-csrf-token-1234567890') });
    await h.click(m.editor_undo());
    expect(writes[3]!.body).toEqual(undo.body);
    expect(writes[3]!.request.headers.get('idempotency-key')).toBe(undo.request.headers.get('idempotency-key'));
    await settle(() =>
      writes[3]!.work.resolve(
        Response.json(
          { publishedLog: { id: 'original' } },
          {
            headers: { 'Library-Published-Log-Revision': '11' },
          },
        ),
      ),
    );
    await h.remove();
    expect(new URL(writes[4]!.request.url).searchParams.get('revision')).toBe('11');
    expect(writes[4]!.request.headers.get('idempotency-key')).not.toBe(key);
    await settle(() => writes[4]!.work.resolve(deleted('original', 12)));
    now = undoProps!.deadline;
    expect(await undoProps!.restore(crypto.randomUUID())).toBe(false);
    expect(writes).toHaveLength(5);
    const staleUndo = undoProps!.restore;
    await h.show({ admitted: false });
    expect(h.button(m.editor_undo())).toBeUndefined();
    expect(await staleUndo(crypto.randomUUID())).toBe(false);
  } finally {
    await h.close();
    clock.mockRestore();
  }
});
