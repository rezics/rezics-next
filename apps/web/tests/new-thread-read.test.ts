import { expect, test } from 'bun:test';
import { createKernelClient, type KernelClient } from '@rezics/client';
import type { SessionEnv } from '../src/session/client';
import { loadNewThreadPage } from '../src/threads/new-thread-read';

type BoardResource = ReturnType<KernelClient['boards']>;
type Board = NonNullable<Awaited<ReturnType<BoardResource['get']>>['data']>['board'];
const boardId = '00000000-0000-4000-8000-000000000001';
const accessToken = 'current-server-session-secret';
const board: Board = {
  id: boardId,
  realmId: '00000000-0000-4000-8000-000000000002',
  community: null,
  route: 0,
  title: 'Members only',
  purpose: 'discussion',
  visibility: 'protected',
  securityRevision: '1',
  availability: 'available',
  createdAt: '2026-01-01T00:00:00.000Z',
};

function session(
  state: 'active' | 'absent' | 'unavailable' | 'failed' = 'active',
  subject: string | undefined = 'member',
) {
  let reads = 0;
  const env = {
    AUTH_ISSUER: 'https://auth.test',
    API_RESOURCE: 'https://api.test',
    WEBSITE_SCOPES: 'board:read',
    WEBSITE_CLIENT_ID: 'web',
    WEBSITE_CLIENT_KEY: 'test-only',
    SESSIONS: {
      idFromName: (id: string) => id,
      get: () => ({
        credential: async () => {
          reads += 1;
          if (state === 'failed') throw new Error('Session store unavailable');
          return state === 'active'
            ? { status: state, accessToken, subject, csrfToken: 'server-csrf-token' }
            : { status: state };
        },
      }),
    },
  } as unknown as SessionEnv;
  const request = (cookie = '__Host-rezics_session=' + 'a'.repeat(43)) =>
    new Request(`https://site.test/en/boards/${boardId}/new`, { headers: { cookie } });
  return { env, request, reads: () => reads };
}

function transport(answer: () => Response | Promise<Response> = () => Response.json({ board })) {
  const calls: Request[] = [];
  const client = createKernelClient('https://kernel.test', {
    fetch: (async (input, init) => {
      calls.push(new Request(input, init));
      return answer();
    }) as typeof fetch,
  });
  return { client, calls };
}

function expectBoardRead(calls: Request[]) {
  expect(calls).toHaveLength(1);
  expect(calls[0]!.method).toBe('GET');
  expect(calls[0]!.url).toBe(`https://kernel.test/v1/boards/${boardId}`);
  expect(calls[0]!.headers.get('authorization')).toBe(`Bearer ${accessToken}`);
  expect(calls[0]!.body).toBeNull();
}

test('The signed-in new-thread page reads its protected board through the existing server session and never retries anonymously on denied or unavailable credentials', async () => {
  const viewer = session();
  const { client, calls } = transport(() => {
    expect(viewer.reads()).toBe(1);
    return Response.json({ board });
  });

  const page = await loadNewThreadPage(client, viewer.request(), viewer.env, {
    id: boardId,
    expectedReaderSubject: 'member',
  });

  expectBoardRead(calls);
  expect(viewer.reads()).toBe(1);
  expect(page).toEqual({ board, idempotencyKey: expect.any(String), readerSubject: 'member' });
  expect(page.idempotencyKey).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(JSON.stringify(page)).not.toContain(accessToken);
  expect(JSON.stringify(page)).not.toContain('server-csrf-token');
});

test.each([401, 403, 404, 503])('board GET %s never retries anonymously or issues a create command', async (status) => {
  const viewer = session();
  const { client, calls } = transport(() =>
    Response.json({ code: status === 404 ? 'not_found' : 'unavailable', detail: accessToken }, { status }),
  );
  const failure = await loadNewThreadPage(client, viewer.request(), viewer.env, {
    id: boardId,
    expectedReaderSubject: 'member',
  }).catch((error: unknown) => error);

  expectBoardRead(calls);
  expect(viewer.reads()).toBe(1);
  if (status === 404) expect(failure).toMatchObject({ isNotFound: true });
  else expect(failure).toEqual(new Error('Kernel board read failed'));
  expect(JSON.stringify(failure)).not.toContain(accessToken);
});

test('a board transport failure remains an error without an anonymous retry', async () => {
  const viewer = session();
  const { client, calls } = transport(() => {
    throw new TypeError('Kernel connection unavailable');
  });

  await expect(
    loadNewThreadPage(client, viewer.request(), viewer.env, { id: boardId, expectedReaderSubject: 'member' }),
  ).rejects.toBeInstanceOf(Error);
  expectBoardRead(calls);
});

test.each(['absent', 'unavailable', 'failed'] as const)(
  'a %s session stops before any board read or create command',
  async (state) => {
    const viewer = session(state);
    const { client, calls } = transport();
    const failure = await loadNewThreadPage(client, viewer.request(), viewer.env, {
      id: boardId,
      expectedReaderSubject: 'member',
    }).catch((error: unknown) => error);

    if (state === 'absent') expect(failure).toEqual(new Error('A signed-in session is required to start a thread.'));
    else if (state === 'unavailable') expect(failure).toMatchObject({ problem: { code: 'dependency_unavailable' } });
    else expect(failure).toEqual(new Error('Session store unavailable'));
    expect(viewer.reads()).toBe(1);
    expect(calls).toEqual([]);
  },
);

test.each(['', '__Host-rezics_session=malformed'])(
  'a missing or invalid session cookie (%s) cannot fall back to an anonymous read',
  async (cookie) => {
    const viewer = session();
    const { client, calls } = transport();

    await expect(
      loadNewThreadPage(client, viewer.request(cookie), viewer.env, {
        id: boardId,
        expectedReaderSubject: 'member',
      }),
    ).rejects.toThrow('A signed-in session is required to start a thread.');
    expect(viewer.reads()).toBe(0);
    expect(calls).toEqual([]);
  },
);

test('an unconfigured session cannot fall back to an anonymous read', async () => {
  const viewer = session();
  const { client, calls } = transport();

  await expect(
    loadNewThreadPage(client, viewer.request(), {}, { id: boardId, expectedReaderSubject: 'member' }),
  ).rejects.toThrow('A signed-in session is required to start a thread.');
  expect(viewer.reads()).toBe(0);
  expect(calls).toEqual([]);
});

test('the returned board must have the exact requested identity', async () => {
  const viewer = session();
  const { client, calls } = transport(() => Response.json({ board: { ...board, id: board.realmId } }));

  await expect(
    loadNewThreadPage(client, viewer.request(), viewer.env, { id: boardId, expectedReaderSubject: 'member' }),
  ).rejects.toMatchObject({
    isNotFound: true,
  });
  expectBoardRead(calls);
});

test('a prepared credential with missing actual reader provenance is refused before the board read', async () => {
  const viewer = session('active', undefined);
  const { client, calls } = transport();

  await expect(
    loadNewThreadPage(client, viewer.request(), viewer.env, { id: boardId, expectedReaderSubject: 'member' }),
  ).rejects.toMatchObject({ isNotFound: true });
  expect(viewer.reads()).toBe(1);
  expect(calls).toEqual([]);
});

test('an expected reader compares with actual same-prepared provenance and never authenticates a replacement', async () => {
  const viewer = session();
  const { client, calls } = transport();

  await expect(
    loadNewThreadPage(client, viewer.request(), viewer.env, { id: boardId, expectedReaderSubject: 'other-member' }),
  ).rejects.toMatchObject({ isNotFound: true });
  expect(viewer.reads()).toBe(1);
  expect(calls).toEqual([]);
});
