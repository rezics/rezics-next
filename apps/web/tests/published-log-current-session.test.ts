import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import {
  deletePublishedLog,
  loadMyPublishedLogs,
  loadPublishedLog,
  publishProgressLog,
  restorePublishedLog,
} from '../src/library/logs-read';
import type { SessionEnv } from '../src/session/client';
import { prepareSession, sessionSubject, viewerCredential } from '../src/session/request';

const origin = 'https://site.example.test';
const csrfToken = 'A'.repeat(22);
const sessionId = 'selected-original-session';
const logId = 'selected-public-snapshot';
const key = '123e4567-e89b-42d3-a456-426614174000';
const deletionId = '123e4567-e89b-42d3-a456-426614174001';
const snapshot = {
  id: logId,
  accountId: 'owner',
  subjectId: 'original-subject',
  sessionState: 'completed',
  startedAt: '2026-04-01T10:00:00.000Z',
  completedAt: '2026-04-02T10:00:00.000Z',
  note: 'Captured public note',
  publishedAt: '2026-04-03T10:00:00.000Z',
  subject: null,
  account: { id: 'owner', handle: '@owner', displayName: 'Owner' },
};
const publicSnapshot = {
  id: logId,
  sessionState: snapshot.sessionState,
  startedAt: snapshot.startedAt,
  completedAt: snapshot.completedAt,
  note: snapshot.note,
  publishedAt: snapshot.publishedAt,
  subject: null,
  account: { handle: '@owner', displayName: 'Owner' },
};

function request(method = 'GET') {
  return new Request(`${origin}/en/logs/${logId}`, {
    method,
    headers: { cookie: `__Host-rezics_session=${'a'.repeat(43)}`, origin, 'x-csrf-token': csrfToken },
  });
}

function session() {
  const current = {
    status: 'active' as 'active' | 'absent' | 'unavailable',
    token: 'cached-viewer',
    subject: 'owner',
    calls: 0,
  };
  const env: Partial<SessionEnv> = {
    SITE_ORIGINS: origin,
    AUTH_ISSUER: 'https://auth.example.test',
    API_RESOURCE: 'https://kernel.example.test',
    WEBSITE_SCOPES: 'openid',
    WEBSITE_CLIENT_ID: 'web',
    WEBSITE_CLIENT_KEY: 'unused-by-credential-preparation',
    SESSIONS: {
      idFromName: (id: string) => {
        expect(id).toBe('a'.repeat(43));
        return id;
      },
      get: () => ({
        credential: async () => {
          current.calls++;
          return current.status === 'active'
            ? { status: 'active', accessToken: current.token, subject: current.subject, csrfToken }
            : { status: current.status, csrfToken };
        },
      }),
    } as unknown as SessionEnv['SESSIONS'],
  };
  return { current, env };
}

test('Published Logs refuse cached identity for private IO after real session refusal but still read anonymous public snapshots', async () => {
  const calls: Request[] = [];
  let reply = Response.json({ publishedLog: snapshot }, { headers: { 'Library-Published-Log-Revision': '17' } });
  const client = createKernelClient('https://kernel.example.test', {
    fetch: async (input, init) => {
      const call = new Request(input, init);
      calls.push(call);
      expect(call.method).toBe('GET');
      expect(new URL(call.url).pathname).toBe(`/v1/publishedLogs/${logId}`);
      expect(Object.fromEntries(new URL(call.url).searchParams)).toEqual({ view: 'FULL' });
      expect(call.headers.has('authorization')).toBe(false);
      expect([call.cache, call.redirect]).toEqual(['no-store', 'manual']);
      return reply.clone();
    },
  });
  const { current, env } = session();
  const cached = request();
  expect(await prepareSession(cached, env)).toBe(false);
  expect(viewerCredential(cached)).toBe('Bearer cached-viewer');
  expect(sessionSubject(cached)).toBe('owner');
  const writes = [
    (req: Request) => publishProgressLog(client, req, env, { sessionId, idempotencyKey: key }),
    (req: Request) => deletePublishedLog(client, req, env, { id: logId, revision: 17, idempotencyKey: key }),
    (req: Request) =>
      restorePublishedLog(client, req, env, { id: logId, deletionId, revision: 18, idempotencyKey: key }),
  ];

  // Safe preparation really returns true for an absent session, retaining both Request WeakMaps.
  current.status = 'absent';
  expect(await loadMyPublishedLogs(client, cached, env, { cursor: 'private-signed-cursor' })).toEqual({
    signedIn: false,
    logs: [],
    next: null,
  });
  for (const write of writes) expect(await write(cached)).toEqual({ ok: false, reason: 'forbidden' });
  expect(current.calls).toBe(5);
  expect(calls).toHaveLength(0);
  expect(await loadPublishedLog(client, cached, env, { id: logId })).toEqual({
    log: publicSnapshot,
    isOwner: false,
  });
  expect(viewerCredential(cached)).toBe('Bearer cached-viewer');
  expect(sessionSubject(cached)).toBe('owner');

  reply = Response.json({ publishedLog: { id: logId, deleted: true } });
  await expect(loadPublishedLog(client, cached, env, { id: logId })).rejects.toMatchObject({ isNotFound: true });
  reply = Response.json({ code: 'not_found' }, { status: 404 });
  await expect(loadPublishedLog(client, cached, env, { id: logId })).rejects.toMatchObject({ isNotFound: true });
  reply = Response.json({ code: 'platform_closed' }, { status: 403 });
  await expect(loadPublishedLog(client, cached, env, { id: logId })).rejects.toMatchObject({
    name: 'PlatformClosedError',
  });
  expect(calls).toHaveLength(4);

  current.status = 'unavailable';
  const reads = [
    (req: Request) => loadMyPublishedLogs(client, req, env, {}),
    (req: Request) => loadPublishedLog(client, req, env, { id: logId }),
  ];
  for (const operation of [...reads, ...writes])
    await expect(operation(cached)).rejects.toMatchObject({
      problem: { status: 502, code: 'dependency_unavailable' },
    });

  // Unsafe cookie requests keep real CSRF and origin enforcement, including absent-session rejection.
  current.status = 'active';
  const unsafe = request('POST');
  expect(await prepareSession(unsafe, env)).toBe(false);
  current.status = 'absent';
  for (const write of writes)
    await expect(write(unsafe)).rejects.toMatchObject({ problem: { status: 403, code: 'forbidden' } });
  current.status = 'active';
  unsafe.headers.set('x-csrf-token', 'B'.repeat(22));
  for (const write of writes)
    await expect(write(unsafe)).rejects.toMatchObject({ problem: { status: 403, code: 'forbidden' } });
  unsafe.headers.set('x-csrf-token', csrfToken);
  unsafe.headers.set('origin', 'https://other.example.test');
  for (const write of writes)
    await expect(write(unsafe)).rejects.toMatchObject({ problem: { status: 403, code: 'forbidden' } });
  expect(calls).toHaveLength(4);
});

test('healthy Published Logs keep current credentials, restrictive keysets and exact snapshot, revision and Undo episode identity', async () => {
  const calls: Request[] = [];
  const staleCursor = 'signed/old+cursor=';
  const nextCursor = 'signed/next+cursor=';
  const { current, env } = session();
  let authorization = 'Bearer current-owner';
  let alwaysStale = false;
  const client = createKernelClient('https://kernel.example.test', {
    fetch: async (input, init) => {
      const call = new Request(input, init);
      calls.push(call.clone());
      expect(call.headers.get('authorization')).toBe(authorization);
      const url = new URL(call.url);
      if (call.method === 'GET') {
        expect([call.cache, call.redirect]).toEqual(['no-store', 'manual']);
        if (url.pathname === '/v1/publishedLogs') {
          expect(Object.fromEntries(url.searchParams)).toEqual({
            view: 'FULL',
            limit: '100',
            accountId: 'owner',
            ...(url.searchParams.has('cursor') ? { cursor: staleCursor } : {}),
          });
          if (alwaysStale || url.searchParams.has('cursor'))
            return Response.json({ code: 'stale_cursor' }, { status: 409 });
          return Response.json({
            publishedLogs: [snapshot, { ...snapshot, id: 'older-snapshot', publishedAt: snapshot.startedAt }],
            next: nextCursor,
          });
        }
        expect(url.pathname).toBe(`/v1/publishedLogs/${logId}`);
        expect(Object.fromEntries(url.searchParams)).toEqual({ view: 'FULL' });
        return Response.json({ publishedLog: snapshot }, { headers: { 'Library-Published-Log-Revision': '17' } });
      }
      expect(call.headers.get('idempotency-key')).toBe(JSON.stringify(key));
      if (call.method === 'POST' && url.pathname === '/v1/publishedLogs') {
        expect(await call.json()).toEqual({ sessionId, note: snapshot.note });
        expect(url.search).toBe('');
        return Response.json({ publishedLog: snapshot }, { status: 201 });
      }
      if (call.method === 'DELETE' && url.pathname === `/v1/publishedLogs/${logId}`) {
        expect(Object.fromEntries(url.searchParams)).toEqual({ revision: '17' });
        return Response.json(
          { publishedLog: snapshot },
          {
            headers: {
              'Library-Published-Log-Deletion-Id': deletionId,
              'Library-Published-Log-Deletion-Revision': '18',
            },
          },
        );
      }
      if (call.method === 'POST' && url.pathname === `/v1/publishedLogs/${logId}:restore`) {
        expect(await call.json()).toEqual({ deletionId, revision: 18 });
        expect(url.search).toBe('');
        return Response.json({ publishedLog: snapshot }, { headers: { 'Library-Published-Log-Revision': '19' } });
      }
      throw new Error(`Unexpected published-log request: ${call.method} ${url}`);
    },
  });
  const cached = request();
  current.subject = 'previous-owner';
  expect(await prepareSession(cached, env)).toBe(false);
  current.subject = 'owner';
  current.token = 'current-owner';
  const page = await loadMyPublishedLogs(client, cached, env, { cursor: staleCursor });
  expect(page).toEqual({
    signedIn: true,
    logs: [publicSnapshot, { ...publicSnapshot, id: 'older-snapshot', publishedAt: snapshot.startedAt }],
    next: nextCursor,
    restarted: true,
  });
  expect(calls).toHaveLength(2);
  expect(current.calls).toBe(2);
  expect(await loadPublishedLog(client, cached, env, { id: logId })).toEqual({
    log: publicSnapshot,
    isOwner: true,
    revision: 17,
  });
  authorization = 'Bearer current-write-owner';
  current.token = 'current-write-owner';
  const unsafe = request('POST');
  expect(
    await publishProgressLog(client, unsafe, env, { sessionId, note: `  ${snapshot.note}  `, idempotencyKey: key }),
  ).toEqual({ ok: true, id: logId });
  const removed = await deletePublishedLog(client, unsafe, env, { id: logId, revision: 17, idempotencyKey: key });
  expect(removed).toEqual({ ok: true, id: logId, undo: { deletionId, revision: 18 } });
  if (!removed.ok || !removed.undo) throw new Error('Expected the exact native deletion episode');
  expect(
    await restorePublishedLog(client, unsafe, env, { id: removed.id, ...removed.undo, idempotencyKey: key }),
  ).toEqual({ ok: true, id: logId, revision: 19 });
  expect(removed.undo).toEqual({ deletionId, revision: 18 });
  expect(calls.map((call) => `${call.method} ${new URL(call.url).pathname}`)).toEqual([
    'GET /v1/publishedLogs',
    'GET /v1/publishedLogs',
    `GET /v1/publishedLogs/${logId}`,
    'POST /v1/publishedLogs',
    `DELETE /v1/publishedLogs/${logId}`,
    `POST /v1/publishedLogs/${logId}:restore`,
  ]);
  expect(current.calls).toBe(6);

  // No cookie legitimately permits an explicit credential; it supplies no inferred owner identity.
  authorization = 'Bearer explicit-owner';
  const explicit = new Request(`${origin}/action`, { headers: { authorization } });
  expect(await loadPublishedLog(client, explicit, env, { id: logId })).toEqual({ log: publicSnapshot, isOwner: false });
  expect(
    await publishProgressLog(client, explicit, env, { sessionId, note: snapshot.note, idempotencyKey: key }),
  ).toEqual({ ok: true, id: logId });
  expect(current.calls).toBe(6);

  authorization = 'Bearer current-write-owner';
  alwaysStale = true;
  const beforeRestart = calls.length;
  await expect(loadMyPublishedLogs(client, cached, env, { cursor: staleCursor })).rejects.toThrow('stale_cursor');
  expect(calls.length - beforeRestart).toBe(2);
  const beforeInvalid = calls.length;
  expect(
    await publishProgressLog(client, unsafe, env, { sessionId, note: 'x'.repeat(1001), idempotencyKey: key }),
  ).toEqual({ ok: false, reason: 'invalid' });
  expect(calls).toHaveLength(beforeInvalid);
});
