import { expect, mock, spyOn, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import * as start from '../.storybook/react-start';
import {
  commandSetup,
  readSetup,
  readSetupChoice,
  setupAttempt,
  retainSetupAttempt,
  applySetupResult,
  type SetupSnapshot,
} from '../src/community/space-setup';
import {
  ContextChoiceError,
  createSetupContextPicker,
  unavailableContextChoiceSource,
  type ContextChoiceSource,
} from '../src/community/setup-context-picker';
import realmRecording from '../src/kernel/recorded/realm.json';
import spaceRecording from '../src/kernel/recorded/space.json';
import {
  nativeContextChoiceSource,
  readSetupContextDirectory,
  unavailableNativeContextDirectory,
  type ContextDirectoryEntry,
  type ContextDirectoryResult,
  type NativeContextDirectory,
} from '../src/community/setup-context-native';

const contextId = realmRecording.realm.contextId;
const otherId = '01a1a000-0000-7000-8000-000000000007';
const label = 'Reading';
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 5));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('Guided Realm setup chooses an actually readable current Context', async () => {
  const requests: Request[] = [];
  let readable = true;
  let commandStatus = 403;
  const client = createKernelClient('https://kernel.test', {
    fetch: async (input, init) => {
      const request = new Request(input, init);
      requests.push(request.clone());
      expect(request.headers.get('authorization')).toBe('Bearer creator');
      const path = new URL(request.url).pathname;
      if (request.method === 'GET' && path.startsWith('/v1/spaces/')) return Response.json(spaceRecording);
      if (request.method === 'GET' && path.startsWith('/v1/realms/'))
        return Response.json({ code: 'not_found' }, { status: 404 });
      if (request.method === 'GET')
        return readable
          ? Response.json({
              context: { id: contextId, kind: 'community', labels: { en: label }, settings: null, defaults: {} },
            })
          : Response.json({ code: 'not_found' }, { status: 404 });
      return Response.json({ code: 'forbidden' }, { status: commandStatus });
    },
  });
  const source = unavailableContextChoiceSource((id) =>
    readSetupChoice(client, 'Bearer creator', { kind: 'context', id }),
  );
  const picker = createSetupContextPicker(source);
  try {
    await expect(source.search({ query: 'Reading' })).rejects.toEqual(new ContextChoiceError('unavailable'));
    expect(requests).toHaveLength(0);
    await picker.current(contextId, realmRecording.realm.headRevisionId);
    expect(picker.getSnapshot().selected).toBeNull();
    expect(picker.getSnapshot().current?.choice).toEqual({ id: contextId, label });
    await picker.choose(contextId);
    const chosen = picker.getSnapshot().selected?.choice;
    expect(chosen).toEqual({ id: contextId, label });
    const intent = setupAttempt(
      null,
      {
        step: 'settings',
        realmId: realmRecording.realm.realmId,
        head: realmRecording.realm.headRevisionId,
        title: 'Keep my draft',
        summary: '',
        visibility: 'public',
        contextId: chosen!.id,
      },
      crypto.randomUUID(),
    );
    const denied = await commandSetup(client, 'Bearer creator', intent);
    expect(denied).toEqual({ kind: 'failure', reason: 'denied', status: 403 });
    readable = false;
    const version = picker.selectionVersion();
    const recheck = picker.retryCurrent();
    expect(picker.selection(contextId, version)).toBeNull();
    await Promise.all([recheck, picker.current(contextId, 'refreshed-head')]);
    expect(picker.getSnapshot().current).toEqual({ id: contextId, phase: 'denied', choice: null });
    expect(picker.getSnapshot().selected?.phase).toBe('denied');
    expect(await readSetup(client, 'Bearer creator', spaceRecording.space.spaceId)).toEqual({
      kind: 'failure',
      reason: 'denied',
      status: 404,
    });
    expect(new URL(requests.at(-1)!.url).pathname).toBe(`/v1/realms/${realmRecording.realm.realmId}`);
    expect(picker.getSnapshot().current?.id).toBe(contextId);
    commandStatus = 503;
    const uncertain = await commandSetup(client, 'Bearer creator', intent);
    expect(retainSetupAttempt(uncertain)).toBe(true);
    expect(setupAttempt(intent, { step: 'space', title: 'New draft', summary: '' }, crypto.randomUUID())).toBe(intent);
    const writes = requests.filter((request) => request.method !== 'GET');
    expect(await writes[0]!.json()).toEqual(await writes[1]!.json());
    expect(writes[0]!.headers.get('if-match')).toBe(JSON.stringify(realmRecording.realm.headRevisionId));
    expect(
      writes.every((request) => new URL(request.url).pathname === `/v1/realms/${realmRecording.realm.realmId}`),
    ).toBe(true);
    readable = true;
    await picker.choose(contextId);
    expect(picker.getSnapshot().selected?.choice?.label).toBe(label);
  } finally {
    picker.dispose();
  }
});

test('search debounces, aborts and isolates old pages; Next requests exactly one page without row resolution', async () => {
  type Page = Awaited<ReturnType<ContextChoiceSource['search']>>;
  const oldPage = deferred<Page>();
  const calls: Parameters<ContextChoiceSource['search']>[0][] = [];
  let resolutions = 0;
  let fail = true;
  const picker = createSetupContextPicker({
    search: async (input) => {
      calls.push(input);
      if (calls.length === 1) return oldPage.promise;
      if (input.cursor === '') return { contexts: [], next: null };
      if (input.cursor === 'page-two') {
        if (fail) throw new ContextChoiceError('unavailable');
        return { contexts: [], next: '' };
      }
      return { contexts: [{ id: otherId, label: 'New result' }], next: 'page-two' };
    },
    resolve: async (id) => {
      resolutions++;
      return { id, label };
    },
  });
  try {
    picker.search('old');
    picker.retrySearch();
    await tick();
    picker.search('n');
    picker.search('new');
    expect(calls[0]!.signal?.aborted).toBe(true);
    expect(picker.getSnapshot().page.contexts).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 270));
    oldPage.resolve({ contexts: [{ id: contextId, label: 'Old result' }], next: null });
    await tick();
    expect(calls.map((call) => call.query)).toEqual(['old', 'new']);
    expect(picker.getSnapshot().page.contexts.map((choice) => choice.id)).toEqual([otherId]);
    picker.next();
    picker.next();
    await tick();
    expect(calls).toHaveLength(3);
    expect(picker.getSnapshot().page.phase).toBe('unavailable');
    expect(picker.getSnapshot().page.contexts).toEqual([]);
    fail = false;
    picker.retrySearch();
    await tick();
    expect(calls[3]!.cursor).toBe('page-two');
    expect(picker.getSnapshot().page).toMatchObject({ phase: 'ready', contexts: [], next: '' });
    expect(resolutions).toBe(0);
    expect(calls).toHaveLength(4);
    picker.next();
    await tick();
    expect(calls[4]!.cursor).toBe('');
    expect(picker.getSnapshot().page.next).toBeNull();
  } finally {
    picker.dispose();
  }
});

test('continuation restart preserves admitted choices and rejects retired restart intent', async () => {
  const late = deferred<Awaited<ReturnType<ContextChoiceSource['search']>>>();
  const calls: Parameters<ContextChoiceSource['search']>[0][] = [];
  const resolve = mock(async (id: string) => ({ id, label }));
  const picker = createSetupContextPicker(
    {
      search: async (input) => {
        calls.push(input);
        if (input.cursor !== undefined) throw new ContextChoiceError('unavailable');
        return calls.length === 1 ? { contexts: [], next: '' } : late.promise;
      },
      resolve,
    },
    contextId,
  );
  await picker.current(contextId, 'saved-head');
  await picker.choose(contextId);
  const selectionVersion = picker.selectionVersion();
  picker.search(' Reading ');
  await new Promise((done) => setTimeout(done, 270));
  picker.next();
  await tick();
  const expected = { query: ' Reading ', cursor: '', version: picker.searchVersion() };
  expect(picker.restartSearch({ ...expected, query: 'other' })).toBe(false);
  expect(picker.restartSearch({ ...expected, cursor: 'other' })).toBe(false);
  picker.retrySearch(expected);
  await tick();
  expect(calls.map((call) => call.cursor)).toEqual([undefined, '', '']);
  expect(picker.restartSearch(expected)).toBe(false);
  const before = picker.getSnapshot();
  const restart = { ...expected, version: picker.searchVersion() };
  expect(picker.restartSearch(restart)).toBe(true);
  expect(picker.restartSearch(restart)).toBe(false);
  await tick();
  expect(calls).toHaveLength(4);
  expect(calls[3]!.cursor).toBeUndefined();
  expect(calls.every((call) => call.query === 'Reading')).toBe(true);
  expect({ ...picker.getSnapshot(), page: before.page }).toEqual(before);
  expect(picker.selection(contextId, selectionVersion)?.id).toBe(contextId);
  expect(resolve).toHaveBeenCalledTimes(2);
  await picker.choose(otherId);
  expect(picker.restartSearch(restart)).toBe(false);
  late.resolve({ contexts: [{ id: contextId, label: 'Retired page' }], next: 'retired' });
  await tick();
  expect(picker.getSnapshot().page.phase).toBe('idle');
  expect(picker.getSnapshot().selected?.id).toBe(otherId);
  picker.dispose();
});

test('disconnected and disposed Context callbacks cannot start fresh search, exact, current, retry or label work', async () => {
  const late = deferred<{ id: string; label: string } | null>();
  const calls: string[] = [];
  const picker = createSetupContextPicker({
    search: async ({ query }) => {
      calls.push(`search:${query}`);
      return { contexts: [{ id: contextId, label: 'Current search result' }], next: 'opaque-next' };
    },
    resolve: async (id) => {
      calls.push(`resolve:${id}`);
      return late.promise;
    },
  });
  picker.search('reading');
  await new Promise((resolve) => setTimeout(resolve, 270));
  const oldResolution = picker.choose(contextId);
  picker.search('replacement');
  expect(picker.getSnapshot().selected).toBeNull();
  const disconnect = picker.connect();
  disconnect();
  picker.dispose();
  const count = calls.length;
  picker.search('hidden');
  picker.next();
  picker.retrySearch();
  picker.restartSearch({ query: 'replacement', cursor: '', version: picker.searchVersion() });
  await picker.choose(contextId);
  await picker.choosePage(contextId);
  await picker.chooseCurrent(contextId);
  await picker.retrySelected(contextId, 'unavailable');
  await picker.current(contextId, 'new-head');
  await picker.retryCurrent(contextId);
  picker.reference(otherId);
  picker.clear();
  late.resolve({ id: contextId, label: 'Retired private label' });
  await oldResolution;
  expect(calls).toHaveLength(count);
  expect(picker.getSnapshot().selected?.choice?.label).not.toBe('Retired private label');
});

test('StrictMode-style Context picker reconnect can run a fresh current read without reviving its old promise', async () => {
  const reads: ReturnType<typeof deferred<{ id: string; label: string } | null>>[] = [];
  const picker = createSetupContextPicker({
    search: async () => ({ contexts: [], next: null }),
    resolve: async () => {
      const pending = deferred<{ id: string; label: string } | null>();
      reads.push(pending);
      return pending.promise;
    },
  });
  const disconnect = picker.connect();
  const oldCurrent = picker.current(contextId, 'head-one');
  disconnect();
  const replayCleanup = picker.connect();
  const newCurrent = picker.current(contextId, 'head-one');
  expect(reads).toHaveLength(2);
  reads[0]!.resolve({ id: contextId, label: 'Old session label' });
  await oldCurrent;
  expect(picker.getSnapshot().current?.phase).toBe('loading');
  reads[1]!.resolve({ id: contextId, label: 'Current session label' });
  await newCurrent;
  expect(picker.getSnapshot().current?.choice?.label).toBe('Current session label');
  replayCleanup();
  picker.dispose();
});

test('Context exact, current, and page callbacks expire when query or reference text leaves and returns', async () => {
  let searches = 0;
  let resolutions = 0;
  const picker = createSetupContextPicker(
    {
      search: async () => {
        searches++;
        return { contexts: [{ id: contextId, label: 'Current search result' }], next: 'opaque-next' };
      },
      resolve: async (id) => {
        resolutions++;
        return { id, label: 'Current exact result' };
      },
    },
    contextId,
  );

  picker.search('same');
  await new Promise((resolve) => setTimeout(resolve, 270));
  const priorPage = { query: 'same', cursor: undefined, version: picker.pageVersion() };
  picker.search('other');
  picker.search('same');
  await new Promise((resolve) => setTimeout(resolve, 270));
  await picker.choosePage(contextId, priorPage);
  expect(searches).toBe(2);
  expect(resolutions).toBe(0);

  const priorReference = picker.referenceVersion();
  picker.reference('other-reference');
  picker.reference(contextId);
  await picker.chooseReference(contextId, priorReference);
  expect(resolutions).toBe(0);

  await picker.current(contextId, 'head-one');
  const priorCurrent = picker.currentVersion();
  await picker.current(contextId, 'head-two');
  await picker.chooseCurrent(contextId, priorCurrent);
  expect(resolutions).toBe(2);
  await picker.choose(contextId);
  const selectedVersion = picker.selectionVersion();
  expect(picker.selection(contextId, selectedVersion)?.id).toBe(contextId);
  picker.reference(otherId);
  picker.reference(contextId);
  await picker.choose(contextId);
  expect(picker.selection(contextId, selectedVersion)).toBeNull();
  picker.dispose();
});

test('new selections and current pointer validity stay independent through denial, removal and recovery', async () => {
  const late = deferred<{ id: string; label: string } | null>();
  let available = false;
  const picker = createSetupContextPicker(
    {
      search: async () => {
        throw new ContextChoiceError('denied');
      },
      resolve: async (id) => (id === contextId ? late.promise : available ? { id, label: 'Different Context' } : null),
    },
    contextId,
  );
  try {
    const oldSelection = picker.choose(contextId);
    await picker.choose(otherId);
    late.resolve({ id: contextId, label });
    await oldSelection;
    expect(picker.getSnapshot().selected).toEqual({ id: otherId, phase: 'denied', choice: null });
    available = true;
    await picker.choose(otherId);
    await picker.current(contextId, 'saved-head');
    expect(picker.getSnapshot().current?.id).toBe(contextId);
    expect(picker.getSnapshot().selected?.id).toBe(otherId);
    picker.reference('entered-reference');
    expect(picker.getSnapshot().selected).toBeNull();
    await picker.choose(otherId);
    await picker.current(null, 'removed');
    expect(picker.getSnapshot().selected?.choice?.id).toBe(otherId);
    expect(picker.getSnapshot().reference).toBe('entered-reference');
    const saved: SetupSnapshot = {
      kind: 'ready',
      space: {
        id: spaceRecording.space.spaceId,
        head: spaceRecording.space.headRevisionId,
        title: 'Saved Space',
        summary: '',
        address: 'saved-space',
        realmId: null,
      },
      realm: null,
      permitted: { address: true, settings: false, scheme: false, board: false },
    };
    expect(applySetupResult(saved, { kind: 'failure', reason: 'denied', status: 404 })).toBe(saved);
    picker.retrySearch();
    await tick();
    expect(picker.getSnapshot().page.phase).toBe('denied');
    expect(picker.getSnapshot().selected?.choice?.id).toBe(otherId);
    const mismatched = createSetupContextPicker({
      search: async () => ({ contexts: [], next: null }),
      resolve: async () => ({ id: contextId, label }),
    });
    await mismatched.choose(otherId);
    expect(mismatched.getSnapshot().selected).toEqual({ id: otherId, phase: 'unavailable', choice: null });
    mismatched.dispose();
    const stale = deferred<{ id: string; label: string } | null>();
    let reads = 0;
    const concurrent = createSetupContextPicker({
      search: async () => ({ contexts: [], next: null }),
      resolve: async (id) => (++reads === 1 ? stale.promise : { id, label }),
    });
    const oldCurrent = concurrent.current(contextId);
    await concurrent.choose(contextId);
    stale.resolve(null);
    await oldCurrent;
    expect(concurrent.getSnapshot().current?.phase).toBe('denied');
    expect(concurrent.getSnapshot().selected?.choice).toEqual({ id: contextId, label });
    concurrent.dispose();
  } finally {
    picker.dispose();
  }
});

test('Bind delivered Context picker to exact declared native active directory', async () => {
  const entry: ContextDirectoryEntry = {
    id: contextId,
    kind: 'community',
    labels: { fr: 'Catalogue alias', en: 'Reading', ja: 'Reading in Japanese' },
    state: 'active',
    deletedAt: null,
    purgeAfter: null,
  };
  const restoredId = '01a1a000-0000-7000-8000-000000000008';
  const pages: Parameters<NativeContextDirectory['get']>[0][] = [];
  const directory: NativeContextDirectory = {
    async get(options) {
      pages.push(options);
      return {
        status: 200,
        error: null,
        data:
          options.query.cursor === undefined
            ? {
                contexts: [
                  entry,
                  { ...entry, id: otherId, kind: 'global', labels: { de: 'Canonical fallback', fr: 'Later fallback' } },
                  {
                    ...entry,
                    id: restoredId,
                    labels: {},
                    deletedAt: '2026-10-01T00:00:00Z',
                    purgeAfter: '2026-10-31T00:00:00Z',
                  },
                  { ...entry, state: 'deleted', deletedAt: '2026-10-01T00:00:00Z', purgeAfter: '2026-11-01T00:00:00Z' },
                ],
                next: 'second',
              }
            : { contexts: [], next: options.query.cursor === 'second' ? '' : null },
      };
    },
  };
  const exactReads: Request[] = [];
  let readable = true;
  const client = createKernelClient('https://kernel.test', {
    fetch: async (input, init) => {
      const request = new Request(input, init);
      exactReads.push(request);
      return readable
        ? Response.json({ context: { ...entry, labels: { en: 'Current English', ja: 'Current Japanese' } } })
        : Response.json({ code: 'not_found' }, { status: 404 });
    },
  });
  const source = nativeContextChoiceSource(
    (input) => readSetupContextDirectory(directory, 'Bearer current-viewer', input),
    (id) => readSetupChoice(client, 'Bearer current-viewer', { kind: 'context', id }, 'ja'),
    'ja',
  );
  const picker = createSetupContextPicker(source);
  try {
    picker.search(' Catalogue ');
    picker.retrySearch();
    await tick();
    expect(pages).toHaveLength(1);
    expect(pages[0]!.query).toEqual({ query: 'Catalogue', limit: 20, deleted: false });
    expect(pages[0]!.headers).toEqual({ authorization: 'Bearer current-viewer' });
    expect(pages[0]!.fetch?.signal).toBeInstanceOf(AbortSignal);
    expect(picker.getSnapshot().page.contexts).toEqual([
      { id: contextId, label: 'Reading in Japanese' },
      { id: otherId, label: 'Canonical fallback' },
      { id: restoredId, label: restoredId },
    ]);
    expect(exactReads).toHaveLength(0);
    picker.next();
    await tick();
    expect(pages).toHaveLength(2);
    expect(pages[1]!.query).toEqual({ query: 'Catalogue', limit: 20, deleted: false, cursor: 'second' });
    expect(picker.getSnapshot().page).toMatchObject({ phase: 'ready', contexts: [], next: '' });
    picker.next();
    await tick();
    expect(pages).toHaveLength(3);
    expect(pages[2]!.query.cursor).toBe('');
    expect(picker.getSnapshot().page.next).toBeNull();
    await picker.choose(contextId);
    expect(exactReads).toHaveLength(1);
    expect(exactReads[0]!.method).toBe('GET');
    expect(new URL(exactReads[0]!.url).pathname).toBe(`/v1/contexts/${contextId}`);
    expect(exactReads[0]!.headers.get('authorization')).toBe('Bearer current-viewer');
    expect(picker.getSnapshot().selected?.choice).toEqual({ id: contextId, label: 'Current Japanese' });
    readable = false;
    await picker.choose(contextId);
    expect(picker.getSnapshot().selected).toEqual({ id: contextId, phase: 'denied', choice: null });
    expect(pages).toHaveLength(3);
    await source.search({ query: '' });
    expect(pages.at(-1)!.query).toEqual({ limit: 20, deleted: false });
  } finally {
    picker.dispose();
  }
});

test('native directory unavailable, preparing and unknown responses never become an empty final page', async () => {
  const resolve = async (id: string) => ({ id, label });
  const unavailable = nativeContextChoiceSource(
    (input) => readSetupContextDirectory(unavailableNativeContextDirectory, 'Bearer viewer', input),
    resolve,
    'en',
  );
  await expect(unavailable.search({ query: '' })).rejects.toEqual(new ContextChoiceError('unavailable'));
  for (const status of [200, 202, 500, 503, 401, 403, 404]) {
    const source = nativeContextChoiceSource(
      (input) =>
        readSetupContextDirectory({ get: async () => ({ data: null, error: null, status }) }, 'Bearer viewer', input),
      resolve,
      'en',
    );
    await expect(source.search({ query: '' })).rejects.toEqual(
      new ContextChoiceError([401, 403, 404].includes(status) ? 'denied' : 'unavailable'),
    );
  }
  const unknown = nativeContextChoiceSource(
    (input) =>
      readSetupContextDirectory(
        {
          get: async () => ({ data: { contexts: [], next: null, preparing: true } as never, error: null, status: 200 }),
        },
        'Bearer viewer',
        input,
      ),
    resolve,
    'en',
  );
  await expect(unknown.search({ query: '' })).rejects.toEqual(new ContextChoiceError('unavailable'));
});

test('cancelled directory reads and a disposed viewer cannot publish labels from the prior session', async () => {
  const late = deferred<ContextDirectoryResult>();
  const exact = deferred<{ id: string; label: string }>();
  const source = nativeContextChoiceSource(
    () => late.promise,
    () => exact.promise,
    'en',
  );
  const picker = createSetupContextPicker(source);
  picker.retrySearch();
  await tick();
  const current = picker.current(contextId, 'head');
  const chosen = picker.choose(contextId);
  picker.dispose();
  const nextViewer = createSetupContextPicker(
    nativeContextChoiceSource(
      async () => ({ kind: 'denied' }),
      async () => ({ kind: 'failure', reason: 'denied', status: 401 }),
      'en',
    ),
  );
  try {
    late.resolve({ contexts: [], next: 'must-not-publish' });
    exact.resolve({ id: contextId, label: 'Prior viewer label' });
    await Promise.all([current, chosen]);
    await tick();
    expect(picker.getSnapshot().page.next).toBeNull();
    expect(picker.getSnapshot().current?.choice).toBeNull();
    expect(picker.getSnapshot().selected?.choice).toBeNull();
    expect(nextViewer.getSnapshot().selected).toBeNull();
    await nextViewer.choose(contextId);
    expect(nextViewer.getSnapshot().selected).toEqual({ id: contextId, phase: 'denied', choice: null });
  } finally {
    nextViewer.dispose();
  }
});

test('The existing setup Context picker reads the actual installed native directory through its production default while selection independently rechecks current Context authority and unavailable is never empty', async () => {
  const entry: ContextDirectoryEntry = {
    id: contextId,
    kind: 'community',
    labels: { en: 'Directory label' },
    state: 'active',
    deletedAt: null,
    purgeAfter: null,
  };
  let accessToken = 'current-viewer';
  let credentials = 0;
  const responseHeaders = new Headers();
  const sessionHeaders = { cookie: `__Host-rezics_session=${'a'.repeat(43)}` };
  const reader = { kind: 'session' as const, subject: 'setup-viewer' };
  let request = new Request('https://site.test/en/realms/new', { headers: sessionHeaders });
  mock.module('@tanstack/react-start', () => start);
  mock.module('@tanstack/react-start/server', () => ({
    ...start,
    getRequest: () => request,
    setResponseHeader: (name: string, value: string) => responseHeaders.set(name, value),
  }));
  mock.module('cloudflare:workers', () => ({
    env: {
      KERNEL_ORIGIN: 'https://kernel.test',
      AUTH_ISSUER: 'https://auth.test',
      API_RESOURCE: 'https://kernel.test',
      WEBSITE_SCOPES: 'openid',
      WEBSITE_CLIENT_ID: 'website',
      WEBSITE_CLIENT_KEY: 'configured',
      SESSIONS: {
        idFromName: (id: string) => id,
        get: () => ({
          credential: async () => {
            credentials++;
            return { status: 'active', accessToken, subject: 'setup-viewer', csrfToken: 'server-csrf' };
          },
        }),
      },
    },
  }));
  const requests: Request[] = [];
  let readable = true;
  let directoryStatus = 200;
  let directoryBody: unknown = { contexts: [entry], next: 'opaque-native-next' };
  const late = deferred<Response>();
  const entered = deferred<AbortSignal>();
  const fetcher = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const native = new Request(input, init);
    requests.push(native);
    const url = new URL(native.url);
    if (url.pathname === '/v1/contexts') {
      if (url.searchParams.get('query') === 'cancelled') {
        entered.resolve(native.signal);
        return late.promise;
      }
      return Response.json(directoryBody, { status: directoryStatus });
    }
    if (url.pathname === `/v1/contexts/${contextId}`)
      return readable
        ? Response.json({
            context: {
              id: contextId,
              kind: 'community',
              labels: { en: 'Current label' },
              settings: null,
              defaults: {},
            },
          })
        : Response.json({ code: 'not_found' }, { status: 404 });
    throw new Error(`Unexpected setup request: ${native.method} ${native.url}`);
  });
  let picker: ReturnType<typeof createSetupContextPicker> | undefined;
  try {
    const { searchSpaceSetupContexts, resolveSpaceSetupChoice } = await import('../src/community/space-actions');
    picker = createSetupContextPicker(
      nativeContextChoiceSource(
        ({ query, cursor }) =>
          searchSpaceSetupContexts({ data: { query, ...(cursor === undefined ? {} : { cursor }) } }),
        (id) => resolveSpaceSetupChoice({ data: { kind: 'context', id } }),
        'en',
      ),
    );
    picker.search(' Reading ');
    picker.retrySearch();
    await tick();
    expect(picker.getSnapshot().page).toMatchObject({
      phase: 'ready',
      contexts: [{ id: contextId, label: 'Directory label' }],
      next: 'opaque-native-next',
    });
    expect(requests).toHaveLength(1);
    expect(new URL(requests[0]!.url).pathname).toBe('/v1/contexts');
    expect(Object.fromEntries(new URL(requests[0]!.url).searchParams)).toEqual({
      query: 'Reading',
      limit: '20',
      deleted: 'false',
    });
    expect(requests[0]!.headers.get('authorization')).toBe('Bearer current-viewer');
    expect(credentials).toBe(1);
    expect(responseHeaders.get('cache-control')).toBe('private, no-store');

    directoryBody = { contexts: [], next: null };
    picker.next();
    await tick();
    expect(requests).toHaveLength(2);
    expect(Object.fromEntries(new URL(requests[1]!.url).searchParams)).toEqual({
      query: 'Reading',
      limit: '20',
      deleted: 'false',
      cursor: 'opaque-native-next',
    });
    expect(picker.getSnapshot().page).toMatchObject({ phase: 'ready', contexts: [], next: null });
    await picker.choose(contextId);
    expect(picker.getSnapshot().selected?.choice).toEqual({ id: contextId, label: 'Current label', reader });
    expect(requests).toHaveLength(3);
    expect(new URL(requests[2]!.url).pathname).toBe(`/v1/contexts/${contextId}`);
    readable = false;
    accessToken = 'refreshed-viewer';
    request = new Request(request.url, { headers: sessionHeaders });
    await picker.choose(contextId);
    expect(picker.getSnapshot().selected).toEqual({ id: contextId, phase: 'denied', choice: null });
    expect(requests).toHaveLength(4);
    expect(requests[3]!.headers.get('authorization')).toBe('Bearer refreshed-viewer');

    directoryStatus = 503;
    directoryBody = { code: 'semantic_not_ready' };
    picker.retrySearch();
    await tick();
    expect(picker.getSnapshot().page).toMatchObject({ phase: 'unavailable', contexts: [], next: null });
    directoryStatus = 200;
    directoryBody = { contexts: [], next: null, preparing: true };
    expect(await searchSpaceSetupContexts({ data: { query: '' } })).toEqual({ kind: 'unavailable', reader });
    expect(new URL(requests.at(-1)!.url).searchParams.has('query')).toBe(false);

    const cancellation = new AbortController();
    request = new Request(request.url, { headers: sessionHeaders, signal: cancellation.signal });
    const pending = searchSpaceSetupContexts({ data: { query: 'cancelled' } });
    const nativeSignal = await entered.promise;
    cancellation.abort();
    expect(nativeSignal.aborted).toBe(true);
    late.resolve(Response.json({ contexts: [entry], next: 'prior-viewer-cursor' }));
    expect(await pending).toEqual({ kind: 'unavailable', reader });

    const count = requests.length;
    request = new Request(request.url);
    expect(await searchSpaceSetupContexts({ data: { query: '' } })).toEqual({
      kind: 'denied',
      reader: { kind: 'unbound' },
    });
    expect(requests).toHaveLength(count);
    expect(requests.every((native) => native.method === 'GET')).toBe(true);
  } finally {
    picker?.dispose();
    fetcher.mockRestore();
  }
});
