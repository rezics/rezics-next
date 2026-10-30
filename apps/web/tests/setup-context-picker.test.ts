import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
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
    await picker.retryCurrent();
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
