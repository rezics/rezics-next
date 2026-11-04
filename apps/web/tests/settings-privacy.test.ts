import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { idempotencyKeyOf } from '../../../services/kernel/src/http/request.ts';
import {
  changeCollectionVisibility,
  readOwnedCollections,
  reloadOwnedCollection,
  type OwnedCollection,
  type OwnedCollectionsPage,
  type CollectionVisibilityWrite,
} from '../src/settings/preferences';
import { MediaProblem } from '../src/media/kernel';
import { preferenceRetryDeadline } from '../src/settings/preference-failure-retry';
import { collectionPrivacyRead, type CollectionPrivacyRead } from '../src/settings/collection-privacy-data';
import {
  CollectionPrivacyEditor,
  CollectionPrivacyPager,
  type VisibilityAttempt,
} from '../src/settings/collection-privacy-recovery';

const sessionId = 'a'.repeat(43);
const csrfToken = 'A'.repeat(22);
const env = {
  SITE_ORIGINS: 'https://site.example.test',
  AUTH_ISSUER: 'https://auth.example.test',
  API_RESOURCE: 'https://api.rezics.test',
  WEBSITE_SCOPES: 'openid account:read account:update collection:read collection:update',
  WEBSITE_CLIENT_ID: 'rezics-web-privacy',
  WEBSITE_CLIENT_KEY: 'unused',
  SESSIONS: {
    idFromName: (name: string) => name,
    get: () => ({
      async credential() {
        return { status: 'active', subject: 'alice', accessToken: 'page-token', csrfToken };
      },
      async signedIn() {
        return { signedIn: true, subject: 'alice', csrfToken };
      },
    }),
  },
} as never;

function request(method: 'GET' | 'POST' = 'GET') {
  return new Request('https://site.example.test/en/settings', {
    method,
    headers: {
      cookie: `__Host-rezics_session=${sessionId}`,
      ...(method === 'POST' ? { origin: 'https://site.example.test', 'x-csrf-token': csrfToken } : {}),
    },
  });
}

function collection(id: string, title: string, visibility: 'private' | 'unlisted' | 'public', revision = 7) {
  return {
    id,
    title,
    description: null,
    visibility,
    revision,
    curatorAccountId: 'alice',
    membershipKind: 'curated',
    allowedVisibilityActions: (['private', 'unlisted', 'public'] as const).filter((value) => value !== visibility),
    state: 'active',
    memberCount: 0,
    orderEpoch: 0,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
}

function ownerPage(collections: unknown[], next: string | null) {
  return { ownerManagement: 'owner', ownerAccountId: 'alice', collections, next };
}

function owned(
  id: string,
  title: string,
  visibility: 'private' | 'unlisted' | 'public',
  revision = 7,
): OwnedCollection {
  return {
    id,
    title,
    kind: 'curated',
    membershipKind: 'curated',
    visibility,
    revision,
    allowedVisibilityActions: (['private', 'unlisted', 'public'] as const).filter((value) => value !== visibility),
  };
}

test('privacy page reads one bounded owner page at a time and preserves its cursor', async () => {
  const calls: Request[] = [];
  const client = createKernelClient('https://kernel.example.test', {
    fetch: (async (input, init) => {
      const current = new Request(input, init);
      calls.push(current);
      return Response.json(
        ownerPage([collection(`c${calls.length}`, 'Reading list', 'unlisted')], calls.length === 1 ? 'cursor-2' : null),
      );
    }) as typeof fetch,
  });
  const first = await readOwnedCollections(client, request(), env, null);
  expect(first.collections.map((item) => item.id)).toEqual(['c1']);
  expect(first.next).toBe('cursor-2');
  expect(calls).toHaveLength(1);
  expect(new URL(calls[0]!.url).pathname).toBe('/v1/collections');
  expect(new URL(calls[0]!.url).searchParams.get('curatorAccountId')).toBe('alice');
  expect(new URL(calls[0]!.url).searchParams.get('ownerManagement')).toBe('true');
  expect(new URL(calls[0]!.url).searchParams.get('limit')).toBe('20');
  expect(calls[0]!.headers.get('authorization')).toBe('Bearer page-token');

  const second = await readOwnedCollections(client, request(), env, first.next);
  expect(second.collections).toHaveLength(1);
  expect(calls).toHaveLength(2);
  expect(new URL(calls[1]!.url).searchParams.get('cursor')).toBe('cursor-2');
});

test('first-page cost stays fixed for 5, 50 and 500 Collections, then grows by one read per requested page', async () => {
  for (const size of [5, 50, 500]) {
    let reads = 0;
    const client = createKernelClient('https://kernel.example.test', {
      fetch: (async (input) => {
        reads += 1;
        const url = new URL(input instanceof Request ? input.url : input.toString());
        const second = url.searchParams.get('cursor') === 'next-page';
        const start = second ? 20 : 0;
        const count = Math.min(20, size - start);
        return Response.json(
          ownerPage(
            Array.from({ length: Math.max(0, count) }, (_, index) =>
              collection(`c${start + index}`, `Collection ${start + index}`, 'private'),
            ),
            start + count < size ? 'next-page' : null,
          ),
        );
      }) as typeof fetch,
    });
    const first = await readOwnedCollections(client, request(), env, null);
    expect(first.collections).toHaveLength(Math.min(20, size));
    expect(reads).toBe(1);
    if (first.next) {
      await readOwnedCollections(client, request(), env, first.next);
      expect(reads).toBe(2);
    }
  }
});

test('visibility changes send the collection revision and expose the server answer', async () => {
  for (const visibility of ['private', 'unlisted', 'public'] as const) {
    let sent: Request | undefined;
    const client = createKernelClient('https://kernel.example.test', {
      fetch: (async (input, init) => {
        sent = new Request(input, init);
        return Response.json({ collection: collection('c1', 'Reading list', visibility, 8) });
      }) as typeof fetch,
    });
    const result = await changeCollectionVisibility(client, request('POST'), env, {
      collectionId: 'c1',
      revision: 7,
      visibility,
      idempotencyKey: '123e4567-e89b-42d3-a456-426614174000',
    });
    expect(result).toEqual({ ok: true, collection: expect.objectContaining({ visibility, revision: 8 }) });
    expect(sent?.method).toBe('PATCH');
    expect(new URL(sent!.url).pathname).toBe('/v1/collections/c1');
    expect(new URL(sent!.url).searchParams.get('ownerManagement')).toBe('true');
    expect(await sent!.clone().json()).toEqual({ revision: 7, visibility });
  }
});

test('Collection visibility serializes the original key without changing the revision or replay request', async () => {
  for (const idempotencyKey of ['123e4567-e89b-42d3-a456-426614174000', '  command "quoted" \\ path  ', '123']) {
    const change = Object.freeze({ collectionId: 'c1', revision: 7, visibility: 'private' as const, idempotencyKey });
    const original = structuredClone(change);
    const calls: Request[] = [];
    const client = createKernelClient('https://kernel.example.test', {
      fetch: (async (input, init) => {
        calls.push(new Request(input, init));
        return Response.json({ code: 'dependency_unavailable' }, { status: 503 });
      }) as typeof fetch,
    });
    for (const attempt of [1, 2]) {
      expect(await changeCollectionVisibility(client, request('POST'), env, change)).toEqual({
        ok: false,
        reason: 'unavailable',
      });
      expect(calls).toHaveLength(attempt);
      const sent = calls[attempt - 1]!;
      expect(sent.method).toBe('PATCH');
      expect(new URL(sent.url).pathname).toBe('/v1/collections/c1');
      expect(sent.headers.get('authorization')).toBe('Bearer page-token');
      expect(idempotencyKeyOf(sent.headers.get('idempotency-key'))).toBe(idempotencyKey);
      expect(await sent.clone().json()).toEqual({ revision: 7, visibility: 'private' });
      expect(change).toEqual(original);
    }
    expect(calls[1]!.headers.get('idempotency-key')).toBe(calls[0]!.headers.get('idempotency-key'));
  }
});

test('stale and failed writes report a refusal without inventing a new collection value', async () => {
  const conflictClient = createKernelClient('https://kernel.example.test', {
    fetch: (async () => Response.json({ code: 'conflict' }, { status: 409 })) as typeof fetch,
  });
  const conflict = await changeCollectionVisibility(conflictClient, request('POST'), env, {
    collectionId: 'c1',
    revision: 7,
    visibility: 'private',
    idempotencyKey: '123e4567-e89b-42d3-a456-426614174000',
  });
  expect(conflict).toEqual({ ok: false, reason: 'conflict' });

  const unavailableClient = createKernelClient('https://kernel.example.test', {
    fetch: (async () => new Response('down', { status: 503 })) as typeof fetch,
  });
  const unavailable = await changeCollectionVisibility(unavailableClient, request('POST'), env, {
    collectionId: 'c1',
    revision: 7,
    visibility: 'private',
    idempotencyKey: '123e4567-e89b-42d3-a456-426614174000',
  });
  expect(unavailable).toEqual({ ok: false, reason: 'unavailable' });
});

test('settings collection rows have a stable privacy-page contract', () => {
  const page: OwnedCollectionsPage = { collections: [owned('c1', 'Reading list', 'private')], next: null };
  expect(page.collections[0]).toMatchObject({ id: 'c1', title: 'Reading list', visibility: 'private', revision: 7 });
});

test('the strict owner decoder preserves curated, saved dynamic and logical identity plus native action advice', async () => {
  const dynamic = { ...collection('saved-dynamic', 'Saved search', 'private', 9), membershipKind: 'dynamic' };
  const logical = {
    ...collection('builtin-everything', 'Everything', 'private', 0),
    membershipKind: 'dynamic',
    builtinKind: 'everything',
    builtin: { kind: 'everything' },
    allowedVisibilityActions: [],
  };
  const client = createKernelClient('https://kernel.example.test', {
    fetch: (async () =>
      Response.json(
        ownerPage([collection('curated', 'Private list', 'private'), dynamic, logical], null),
      )) as typeof fetch,
  });
  const result = await readOwnedCollections(client, request(), env, null);
  expect(result.collections).toMatchObject([
    {
      id: 'curated',
      kind: 'curated',
      membershipKind: 'curated',
      revision: 7,
      allowedVisibilityActions: ['unlisted', 'public'],
    },
    { id: 'saved-dynamic', kind: 'dynamic', membershipKind: 'dynamic', revision: 9 },
    {
      id: 'builtin-everything',
      kind: 'builtin',
      builtinKind: 'everything',
      revision: null,
      allowedVisibilityActions: [],
    },
  ]);

  const wrongOwner = createKernelClient('https://kernel.example.test', {
    fetch: (async () => Response.json({ ...ownerPage([], null), ownerAccountId: 'someone-else' })) as typeof fetch,
  });
  expect(await collectionPrivacyRead(() => readOwnedCollections(wrongOwner, request(), env, null))).toEqual({
    ok: false,
    reason: 'unavailable',
  });
});

test('A current native read refusal removes retained private Collection row details and controls, while transient next-page failures preserve same-actor readable pages and retry the same cursor', async () => {
  const original = collection('private-old', 'Private reading plans', 'private');
  const refreshed = collection('private-current', 'Current native page', 'unlisted', 12);
  for (const [status, code, reason] of [
    [401, 'authentication_required', 'forbidden'],
    [403, 'forbidden', 'forbidden'],
    [403, 'not_visible', 'forbidden'],
    [403, 'platform_closed', 'closed'],
    [404, 'not_found', 'unavailable'],
    [404, 'not_visible', 'unavailable'],
    [503, 'dependency_unavailable', 'unavailable'],
    [503, 'platform_closed', 'unavailable'],
  ] as const) {
    const calls: Request[] = [];
    const client = createKernelClient('https://kernel.example.test', {
      fetch: (async (input, init) => {
        const native = new Request(input, init);
        calls.push(native);
        expect(native.headers.get('authorization')).toBe('Bearer page-token');
        expect(new URL(native.url).searchParams.get('limit')).toBe('20');
        if (calls.length === 1) return Response.json(ownerPage([original], 'opaque+/cursor=='));
        if (calls.length === 2) return Response.json({ code }, { status });
        return Response.json(ownerPage([refreshed], null));
      }) as typeof fetch,
    });
    const pager = new CollectionPrivacyPager((cursor) =>
      collectionPrivacyRead(() => readOwnedCollections(client, request(), env, cursor)),
    );
    await pager.load();
    await pager.load();
    const denied = reason !== 'unavailable';
    expect(pager.snapshot()).toMatchObject({
      failure: reason,
      loaded: !denied,
      loading: false,
      next: denied ? null : 'opaque+/cursor==',
    });
    expect(pager.snapshot().collections.map((row) => row.id)).toEqual(denied ? [] : [original.id]);
    expect(calls).toHaveLength(2); // No automatic retry, including native forbidden.
    await pager.load();
    expect(calls.map((call) => new URL(call.url).searchParams.get('cursor'))).toEqual([
      null,
      'opaque+/cursor==',
      denied ? null : 'opaque+/cursor==',
    ]);
    expect(pager.snapshot().collections.map((row) => row.id)).toEqual(
      denied ? [refreshed.id] : [original.id, refreshed.id],
    );
    expect(pager.snapshot()).toMatchObject({ loaded: true, next: null, failure: null });
  }
  let nativeReads = 0;
  const signedOutClient = createKernelClient('https://kernel.example.test', {
    fetch: (async () => {
      nativeReads++;
      throw new Error('A signed-out request must not use the old viewer credential');
    }) as typeof fetch,
  });
  const signedOutRequest = () => new Request('https://site.example.test/en/settings');
  expect(
    await collectionPrivacyRead(() => readOwnedCollections(signedOutClient, signedOutRequest(), env, null)),
  ).toEqual({ ok: false, reason: 'forbidden' });
  expect(
    await collectionPrivacyRead(() => reloadOwnedCollection(signedOutClient, signedOutRequest(), env, original.id)),
  ).toEqual({ ok: false, reason: 'forbidden' });
  expect(nativeReads).toBe(0);
});

test('native row read refusal withholds presentation without resolving or replacing the original uncertain visibility command', async () => {
  const original = collection('private-row', 'Private reading plans', 'private');
  for (const recovery of ['reload', 'replay'] as const) {
    for (const [status, code, reason] of [
      [401, 'authentication_required', 'forbidden'],
      [403, 'not_visible', 'forbidden'],
      [403, 'platform_closed', 'closed'],
    ] as const) {
      const commands: VisibilityAttempt[] = [];
      const reads: Request[] = [];
      let response = () => Response.json({ code }, { status });
      const client = createKernelClient('https://kernel.example.test', {
        fetch: (async (input, init) => {
          const native = new Request(input, init);
          reads.push(native);
          expect(new URL(native.url).pathname).toBe(`/v1/collections/${original.id}`);
          expect(new URL(native.url).searchParams.get('view')).toBe('FULL');
          expect(new URL(native.url).searchParams.get('ownerManagement')).toBe('true');
          return response();
        }) as typeof fetch,
      });
      const editor = new CollectionPrivacyEditor(original, {
        save: async (attempt) => {
          commands.push(attempt);
          return commands.length === 1
            ? { ok: false, reason: 'unavailable' }
            : { ok: true, collection: { ...original, visibility: 'public', revision: 8 } };
        },
        read: (id) => collectionPrivacyRead(() => reloadOwnedCollection(client, request(), env, id)),
      });
      await editor.edit('public');
      const attempt = editor.snapshot().attempt!;
      await editor.edit('unlisted');
      if (recovery === 'reload') await editor.reload();
      else await editor.retry();
      expect(editor.snapshot()).toMatchObject({
        current: original,
        desired: 'unlisted',
        phase: 'uncertain',
        failure: reason,
        readRefusal: reason,
      });
      expect(editor.snapshot().attempt).toBe(attempt);
      expect(Object.isFrozen(attempt)).toBe(true);
      await editor.edit('private');
      await editor.submit();
      await editor.retry();
      expect(commands).toHaveLength(recovery === 'reload' ? 1 : 2);
      expect(commands.every((command) => command === attempt)).toBe(true);
      expect(reads).toHaveLength(1);

      response = () => Response.json({ code: 'dependency_unavailable' }, { status: 503 });
      await editor.reload();
      expect(editor.snapshot()).toMatchObject({ readRefusal: reason, phase: 'uncertain', failure: 'unavailable' });
      expect(editor.snapshot().attempt).toBe(attempt);
      // Neither a different row nor an impossible same-version observation can reopen presentation.
      for (const value of [
        { ...original, id: 'other-row', revision: 9 },
        { ...original, visibility: 'public' },
        { ...original, revision: 6 },
      ]) {
        response = () => Response.json({ collection: value });
        await editor.reload();
        expect(editor.snapshot()).toMatchObject({ readRefusal: reason, phase: 'uncertain', desired: 'unlisted' });
        expect(editor.snapshot().attempt).toBe(attempt);
      }
      const current: OwnedCollection = {
        id: original.id,
        title: 'Fresh native title',
        kind: 'curated',
        membershipKind: 'curated',
        visibility: 'public',
        revision: 10,
        allowedVisibilityActions: ['private', 'unlisted'],
      };
      response = () => Response.json({ collection: { ...original, ...current } });
      await editor.reload();
      expect(editor.snapshot()).toMatchObject({
        current,
        desired: 'public',
        phase: 'idle',
        readRefusal: null,
        attempt: null,
        failure: undefined,
      });
    }
  }
});

test('actor teardown rejects late pages and row reads, and a successful explicit reload preserves edits made in flight', async () => {
  const original = collection('private-row', 'Private reading plans', 'private');
  const page = Promise.withResolvers<CollectionPrivacyRead<OwnedCollectionsPage>>();
  const row = Promise.withResolvers<CollectionPrivacyRead<OwnedCollection>>();
  const previousPager = new CollectionPrivacyPager(() => page.promise);
  const previousEditor = new CollectionPrivacyEditor(original, {
    save: async () => ({ ok: false, reason: 'unavailable' }),
    read: () => row.promise,
  });
  const loading = previousPager.load();
  await previousEditor.edit('public');
  const reloading = previousEditor.reload();
  const before = previousEditor.snapshot();
  previousPager.dispose();
  previousEditor.dispose();
  const nextPager = new CollectionPrivacyPager(async () => ({ ok: true, value: { collections: [], next: null } }));
  await nextPager.load();
  page.resolve({ ok: true, value: { collections: [original], next: 'previous-viewer' } });
  row.resolve({ ok: true, value: { ...original, title: 'Late private title', revision: 9 } });
  await Promise.all([loading, reloading]);
  expect(previousPager.snapshot()).toMatchObject({ collections: [], loading: false, next: null });
  expect(previousEditor.snapshot()).not.toBe(before);
  expect(previousEditor.snapshot()).toMatchObject({ current: null, attempt: null, desired: 'private' });
  expect(nextPager.snapshot()).toMatchObject({ collections: [], loaded: true });

  const replay = Promise.withResolvers<CollectionVisibilityWrite>();
  let saves = 0;
  let readbacks = 0;
  const departing = new CollectionPrivacyEditor(original, {
    save: async () => (++saves === 1 ? { ok: false, reason: 'unavailable' } : replay.promise),
    read: async () => {
      readbacks++;
      return { ok: true, value: original };
    },
  });
  await departing.edit('public');
  const retry = departing.retry();
  departing.dispose();
  replay.resolve({ ok: true, collection: { ...original, visibility: 'public', revision: 8 } });
  await retry;
  expect(readbacks).toBe(0); // A late old-viewer receipt must not trigger a read under new credentials.

  const fresh = Promise.withResolvers<CollectionPrivacyRead<OwnedCollection>>();
  const editor = new CollectionPrivacyEditor(original, {
    save: async () => ({ ok: false, reason: 'conflict' }),
    read: () => fresh.promise,
  });
  await editor.edit('public');
  const refresh = editor.reload();
  await editor.edit('unlisted');
  fresh.resolve({ ok: true, value: { ...original, visibility: 'public', revision: 9 } });
  await refresh;
  expect(editor.snapshot()).toMatchObject({
    current: { visibility: 'public', revision: 9 },
    desired: 'unlisted',
    phase: 'review',
    readRefusal: null,
    attempt: null,
  });
});

test('native Collection privacy failures retain actual retry metadata across page, row and write adapters', async () => {
  for (const [status, code, retryAfter] of [
    [429, 'rate_limited', '17'],
    [503, 'dependency_unavailable', 'Sat, 31 Oct 2026 12:00:00 GMT'],
  ] as const) {
    const calls: Request[] = [];
    const client = createKernelClient('https://kernel.example.test', {
      fetch: (async (input, init) => {
        calls.push(new Request(input, init));
        return Response.json(
          {
            type: `https://rezics.com/problems/${code}`,
            title: code,
            status,
            code,
            retryable: true,
            request_id: 'native-request',
          },
          { status, headers: { 'Retry-After': retryAfter } },
        );
      }) as typeof fetch,
    });
    const expected = {
      ok: false,
      reason: 'unavailable',
      failure: { status, code, retryable: true, requestId: 'native-request', retryAfter },
    };
    expect(await collectionPrivacyRead(() => readOwnedCollections(client, request(), env, 'exact+/cursor=='))).toEqual(
      expected,
    );
    expect(await collectionPrivacyRead(() => reloadOwnedCollection(client, request(), env, 'c1'))).toEqual(expected);
    expect(
      await changeCollectionVisibility(client, request('POST'), env, {
        collectionId: 'c1',
        revision: 7,
        visibility: 'private',
        idempotencyKey: '123e4567-e89b-42d3-a456-426614174000',
      }),
    ).toEqual(expected);
    expect(calls).toHaveLength(3);
    expect(calls.every((call) => call.headers.get('authorization') === 'Bearer page-token')).toBe(true);
    expect(new URL(calls[0]!.url).searchParams.get('cursor')).toBe('exact+/cursor==');
    expect(calls[2]!.headers.get('idempotency-key')).toBe('123e4567-e89b-42d3-a456-426614174000');
    expect(await calls[2]!.json()).toEqual({ revision: 7, visibility: 'private' });
  }
});

test('thrown native problems retain metadata and invalid, past or absent retry headers invent no wait', async () => {
  const now = Date.parse('2026-10-31T11:00:00Z');
  for (const retryAfter of [
    '9',
    'Sat, 31 Oct 2026 11:00:12 GMT',
    'invalid',
    '-1',
    '0',
    'Sat, 31 Oct 2026 10:00:00 GMT',
    undefined,
  ]) {
    const problem = {
      type: 'https://rezics.com/problems/dependency_unavailable',
      title: 'Unavailable',
      status: 503,
      code: 'dependency_unavailable',
      retryable: true,
      request_id: 'thrown-request',
    };
    const error = new MediaProblem(problem, retryAfter === undefined ? undefined : { 'retry-after': retryAfter });
    const failure = {
      status: 503,
      code: problem.code,
      retryable: true,
      requestId: 'thrown-request',
      ...(retryAfter ? { retryAfter } : {}),
    };
    expect(
      await collectionPrivacyRead(async () => {
        throw error;
      }),
    ).toEqual({ ok: false, reason: 'unavailable', failure });
    const client = createKernelClient('https://kernel.example.test', {
      fetch: (async () => {
        throw error;
      }) as typeof fetch,
    });
    expect(
      await changeCollectionVisibility(client, request('POST'), env, {
        collectionId: 'c1',
        revision: 7,
        visibility: 'private',
        idempotencyKey: '123e4567-e89b-42d3-a456-426614174000',
      }),
    ).toEqual({ ok: false, reason: 'unavailable', failure });
    expect(preferenceRetryDeadline(failure.retryAfter, now)).toBe(
      retryAfter === '9' ? now + 9000 : retryAfter === 'Sat, 31 Oct 2026 11:00:12 GMT' ? now + 12000 : 0,
    );
  }
});

test('Respect native retry delays during Collection privacy recovery without weakening native identity, exact recovery or draft invariants', async () => {
  const first = collection('first', 'First collection', 'public');
  const second = collection('second', 'Second collection', 'public');
  const originalFailure = { status: 429, code: 'rate_limited', retryAfter: '17' };
  const readbackFailure = { status: 503, code: 'dependency_unavailable', retryAfter: '31' };
  const pageFailure = { status: 503, code: 'dependency_unavailable', retryAfter: '47' };
  const commands: VisibilityAttempt[] = [];
  let reads = 0;
  const editor = new CollectionPrivacyEditor(first, {
    save: async (attempt) => {
      commands.push(attempt);
      return commands.length === 1
        ? { ok: false, reason: 'unavailable', failure: originalFailure }
        : { ok: true, collection: { ...first, visibility: 'private', revision: 8 } };
    },
    read: async () =>
      ++reads === 1
        ? { ok: false, reason: 'unavailable', failure: readbackFailure }
        : { ok: true, value: { ...first, visibility: 'unlisted', revision: 10 } },
  });
  const other = new CollectionPrivacyEditor(second, {
    save: async () => ({ ok: true, collection: { ...second, visibility: 'private', revision: 8 } }),
    read: async () => ({ ok: true, value: second }),
  });
  const cursors: (string | null)[] = [];
  const pager = new CollectionPrivacyPager(async (cursor) => {
    cursors.push(cursor);
    if (cursors.length === 1) return { ok: true, value: { collections: [first, second], next: 'exact+/cursor==' } };
    return cursors.length === 2
      ? { ok: false, reason: 'unavailable', failure: pageFailure }
      : { ok: true, value: { collections: [], next: null } };
  });
  await pager.load();
  await editor.edit('private');
  const attempt = editor.snapshot().attempt!;
  await editor.edit('unlisted');
  await pager.load();
  await other.edit('private');
  expect(editor.snapshot().nativeFailure).toBe(originalFailure); // Draft edits preserve the hook's deadline anchor.
  expect(pager.snapshot()).toMatchObject({
    nativeFailure: pageFailure,
    next: 'exact+/cursor==',
    collections: [first, second],
  });
  expect(other.snapshot()).toMatchObject({ phase: 'saved', nativeFailure: undefined });
  expect(commands).toHaveLength(1);
  expect(reads).toBe(0);
  const now = Date.parse('2026-10-31T11:00:00Z');
  expect(preferenceRetryDeadline(editor.snapshot().nativeFailure?.retryAfter, now)).toBe(now + 17_000);
  expect(preferenceRetryDeadline(pager.snapshot().nativeFailure?.retryAfter, now)).toBe(now + 47_000);
  // The component's canonical hook enables these deliberate actions only after its own delay expires.
  await editor.retry();
  expect(editor.snapshot()).toMatchObject({
    nativeFailure: readbackFailure,
    attempt,
    desired: 'unlisted',
    current: first,
  });
  expect(editor.snapshot().attempt).toBe(attempt);
  expect(commands[1]).toBe(attempt);
  expect(pager.snapshot().nativeFailure).toBe(pageFailure);
  await editor.edit('public');
  expect(editor.snapshot().nativeFailure).toBe(readbackFailure);
  expect(commands).toHaveLength(2);
  await editor.retry();
  expect(commands[2]).toBe(attempt);
  expect(editor.snapshot()).toMatchObject({
    phase: 'review',
    attempt: null,
    desired: 'public',
    current: { visibility: 'unlisted', revision: 10 },
    nativeFailure: undefined,
  });
  expect(reads).toBe(2);
  await pager.load();
  expect(cursors).toEqual([null, 'exact+/cursor==', 'exact+/cursor==']);
  expect(pager.snapshot()).toMatchObject({ loaded: true, next: null, failure: null, nativeFailure: undefined });
});

test('Recover the Collection privacy list from a rejected cursor with original request/privacy/recovery bounds intact', async () => {
  const calls: Request[] = [];
  const original = collection('old-page', 'Old private page', 'private');
  const current = collection('current-page', 'Current native page', 'unlisted', 11);
  const cursor = 'opaque+/expired==';
  const client = createKernelClient('https://kernel.example.test', {
    fetch: (async (input, init) => {
      calls.push(new Request(input, init));
      if (calls.length === 1) return Response.json(ownerPage([original], cursor));
      if (calls.length <= 3) return Response.json({ code: 'invalid_cursor' }, { status: 400 });
      if (calls.length === 4)
        return Response.json(
          { code: 'dependency_unavailable', retryable: true, request_id: 'refresh-failure' },
          { status: 503, headers: { 'Retry-After': '17' } },
        );
      return Response.json(ownerPage(calls.length === 5 ? [current] : [], null));
    }) as typeof fetch,
  });
  const pager = new CollectionPrivacyPager((next) =>
    collectionPrivacyRead(() => readOwnedCollections(client, request(), env, next)),
  );
  await pager.load();
  await pager.load();
  expect(pager.snapshot()).toMatchObject({
    collections: [expect.objectContaining({ id: original.id })],
    next: cursor,
    failure: 'unavailable',
  });
  expect(calls).toHaveLength(2); // Rejected continuation does not trigger an automatic first-page read.
  await pager.load();
  expect(calls).toHaveLength(3); // Retry still sends the exact failed cursor.
  await pager.restart();
  expect(pager.snapshot()).toMatchObject({
    collections: [expect.objectContaining({ id: original.id })],
    next: cursor,
    failure: 'unavailable',
    nativeFailure: { status: 503, retryAfter: '17', requestId: 'refresh-failure' },
  });
  expect(calls).toHaveLength(4);
  await pager.load(); // Deliberate retry of the failed refresh uses null, not the old continuation.
  expect(pager.snapshot()).toMatchObject({
    collections: [expect.objectContaining({ id: current.id })],
    next: null,
    failure: null,
  });
  await pager.restart();
  expect(pager.snapshot()).toMatchObject({ collections: [], loaded: true, failure: null, next: null });
  expect(calls.map((call) => new URL(call.url).searchParams.get('cursor'))).toEqual([
    null,
    cursor,
    cursor,
    null,
    null,
    null,
  ]);
  for (const call of calls) {
    expect(call.method).toBe('GET');
    expect(new URL(call.url).pathname).toBe('/v1/accounts/alice/collections');
    expect(new URL(call.url).searchParams.get('limit')).toBe('20');
    expect(call.headers.get('authorization')).toBe('Bearer page-token');
  }
});
