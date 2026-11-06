import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { boardPinAdviceInput, receiveBoardPinAdvice, type BoardPinAdviceQuery } from '../src/threads/board-pins/advice';
import { readBoardPinAdviceRequest } from '../src/threads/board-pins/native';
import { SESSION_COOKIE } from '../src/session/cookies';

const boardId = '01a17a3b-09b4-77bf-a24b-1234ebeab5b3';
const threadId = '01a17a3b-09b4-77bf-a24b-1234ebeab5b4';
const sourceRevisionId = '01a17a3b-09b4-77bf-a24b-1234ebeab5b5';
const viewerId = '01a17a3b-09b4-77bf-a24b-1234ebeab5b6';
const selected = [{ threadId, placeId: boardId, sourceRevisionId }];
const query = (): BoardPinAdviceQuery => ({
  boardId,
  viewerId,
  selected,
  pinRevision: '4',
  signal: new AbortController().signal,
});
const ready = () => ({
  state: 'ready',
  boardId,
  viewer: { kind: 'account', id: viewerId },
  pinRevision: '4',
  management: 'allowed',
  threads: [{ threadId, pinned: true, actions: ['unpin'] }],
});
test('selected advice input rejects duplicates, foreign parents, malformed revisions and open fields', () => {
  const invalid = [
    { selected: [...selected, ...selected] },
    { selected: [{ ...selected[0], placeId: viewerId }] },
    { selected: [{ ...selected[0], sourceRevisionId: 'head' }] },
    { selected: Array(26).fill(selected[0]) },
    { selected, pinRevision: '9223372036854775808' },
    { selected, pinRevision: '-1' },
    { selected, actions: ['pin'] },
    { selected: [{ ...selected[0], pinned: true }] },
  ];
  for (const input of invalid) expect(boardPinAdviceInput(boardId, input)).toBeUndefined();
  expect(boardPinAdviceInput(boardId, { selected: [...selected, ...selected] })).toBeUndefined();
});

test('the receiver binds viewer, Board, generation, and the exact bounded selected response', () => {
  const result = receiveBoardPinAdvice(query(), 200, ready());
  expect(result).toEqual(ready());
  expect(Object.isFrozen(result)).toBe(true);
});

test('malformed advice, denial and full capacity never invent selected actions', () => {
  const malformed = [
    { ...ready(), viewer: { kind: 'account', id: threadId } },
    { ...ready(), boardId: threadId },
    { ...ready(), pinRevision: '5' },
    { ...ready(), threads: [] },
    { ...ready(), threads: [{ threadId: viewerId, pinned: true, actions: ['unpin'] }] },
    { ...ready(), management: 'denied' },
    { ...ready(), threads: [{ threadId, pinned: true, actions: ['pin'] }] },
    { ...ready(), hiddenPins: [viewerId] },
  ];
  for (const body of malformed) expect(receiveBoardPinAdvice(query(), 200, body)).toEqual({ state: 'unavailable' });
  const denied = { ...ready(), management: 'denied', threads: [{ threadId, pinned: true, actions: [] }] };
  expect(receiveBoardPinAdvice(query(), 200, denied)).toEqual(denied);
  const full = { ...ready(), threads: [{ threadId, pinned: false, actions: [] }] };
  expect(receiveBoardPinAdvice(query(), 200, full)).toEqual(full);
  for (const status of [401, 403, 404]) expect(receiveBoardPinAdvice(query(), status, {})).toEqual({ state: 'denied' });
  expect(receiveBoardPinAdvice(query(), 200, { state: 'stale' })).toEqual({ state: 'stale' });
});

test('the installed callable receives the admitted generation and current session through no-store transport', async () => {
  const calls: { url: string; method: string; headers: Headers; body: unknown; cache?: RequestCache }[] = [];
  const client = createKernelClient('https://kernel.test', {
    fetch: async (input, init) => {
      const request = new Request(input, init);
      calls.push({
        url: new URL(request.url).pathname,
        method: request.method,
        headers: request.headers,
        body: await request.json(),
        cache: init?.cache,
      });
      return Response.json(ready());
    },
  });
  const env = {
    AUTH_ISSUER: 'https://auth.test',
    API_RESOURCE: 'https://kernel.test',
    WEBSITE_SCOPES: 'openid',
    WEBSITE_CLIENT_ID: 'web',
    WEBSITE_CLIENT_KEY: 'secret',
    SESSIONS: {
      idFromName: (id: string) => id,
      get: () => ({
        credential: async () => ({
          status: 'active',
          subject: viewerId,
          accessToken: 'native-access',
          csrfToken: 'csrf',
        }),
      }),
    },
  } as never;
  const request = new Request('https://web.test/board-pin-advice', {
    headers: { cookie: `${SESSION_COOKIE}=${'a'.repeat(43)}` },
  });
  expect(
    await readBoardPinAdviceRequest({ boardId, viewerId, selected, pinRevision: '4' }, request, env, client, true),
  ).toEqual(ready());
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({
    url: `/v1/boards/${boardId}/pin-advice`,
    method: 'POST',
    cache: 'no-store',
    body: { selected, pinRevision: '4' },
  });
  expect(calls[0]?.headers.get('authorization')).toBe('Bearer native-access');
});

test('session mismatch is denied before transport and aborted advice is withheld', async () => {
  let calls = 0;
  const client = createKernelClient('https://kernel.test', {
    fetch: async () => {
      calls++;
      return Response.json(ready());
    },
  });
  const env = {
    AUTH_ISSUER: 'https://auth.test',
    API_RESOURCE: 'https://kernel.test',
    WEBSITE_SCOPES: 'openid',
    WEBSITE_CLIENT_ID: 'web',
    WEBSITE_CLIENT_KEY: 'secret',
    SESSIONS: {
      idFromName: (id: string) => id,
      get: () => ({
        credential: async () => ({
          status: 'active',
          subject: threadId,
          accessToken: 'wrong-access',
          csrfToken: 'csrf',
        }),
      }),
    },
  } as never;
  const request = new Request('https://web.test/board-pin-advice', {
    headers: { cookie: `${SESSION_COOKIE}=${'a'.repeat(43)}` },
  });
  expect(
    await readBoardPinAdviceRequest({ boardId, viewerId, selected, pinRevision: '4' }, request, env, client, true),
  ).toEqual({ state: 'denied' });
  expect(calls).toBe(0);
  const controller = new AbortController();
  controller.abort();
  expect(receiveBoardPinAdvice({ ...query(), signal: controller.signal }, 200, ready())).toEqual({
    state: 'unavailable',
  });
});
