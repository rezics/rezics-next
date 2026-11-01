import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import {
  finishProgress,
  loadProgressIndex,
  loadProgressSession,
  recordProgress,
  startProgress,
  type NativeProgressSession,
  type ProgressMode,
} from '../src/library/progress-reads';
import type { SessionEnv } from '../src/session/client';
import { prepareSession, viewerCredential } from '../src/session/request';

const origin = 'https://site.example.test';
const subjectId = '0192f3a0-6c1e-7b2a-9d4e-000000000001';
const versionSubjectId = '0192f3a0-6c1e-7b2a-9d4e-000000000002';
const sessionId = '0192f3a0-6c1e-7b2a-9d4e-000000000020';
const idempotencyKey = '10203040-5060-4070-8090-102030405060';
const csrfToken = 'A'.repeat(22);
const stamp = '2026-04-02T15:04:05.000Z';
const sparseUnits = ['episode:2', 'disc~7.part_31'];
const startInput = { subjectId, versionSubjectId, mode: 'scalar_amount', unit: 'page', idempotencyKey };
const recordInput = { sessionId, revision: 17, amount: '1.250000', idempotencyKey };

function request(method = 'GET') {
  return new Request(`${origin}/en/library/progress`, {
    method,
    headers: {
      cookie: `__Host-rezics_session=${'a'.repeat(43)}`,
      origin,
      'x-csrf-token': csrfToken,
    },
  });
}

function session() {
  const current = { status: 'active' as 'active' | 'absent' | 'unavailable', token: 'cached-viewer', calls: 0 };
  const env: Partial<SessionEnv> = {
    SITE_ORIGINS: origin,
    AUTH_ISSUER: 'https://auth.example.test',
    API_RESOURCE: 'https://kernel.example.test',
    WEBSITE_SCOPES: 'openid',
    WEBSITE_CLIENT_ID: 'web',
    WEBSITE_CLIENT_KEY: 'unused-by-credential-preparation',
    SESSIONS: {
      idFromName: (id: string) => id,
      get: () => ({
        credential: async () => {
          current.calls++;
          return current.status === 'active'
            ? { status: 'active', accessToken: current.token, subject: 'owner', csrfToken }
            : { status: current.status, csrfToken };
        },
      }),
    } as unknown as SessionEnv['SESSIONS'],
  };
  return { current, env };
}

test('Progress refuses a prepared stale session before private IO and preserves preparation errors', async () => {
  const calls: Request[] = [];
  const client = createKernelClient('https://kernel.example.test', {
    fetch: async (input, init) => {
      calls.push(new Request(input, init));
      throw new Error('Refused preparation must make zero native child calls');
    },
  });
  const { current, env } = session();
  const cached = request();
  expect(await prepareSession(cached, env)).toBe(false);
  expect(viewerCredential(cached)).toBe('Bearer cached-viewer');
  current.status = 'absent';
  // GET preparation really returns true, while the same Request retains its earlier WeakMap credential.
  expect(await loadProgressIndex(client, cached, env, { subjectId, cursor: 'signed/list+cursor=' })).toEqual({
    signedIn: false,
    subjectId,
    selectedSubject: null,
    sessions: [],
    next: null,
    idempotencyKey: expect.stringMatching(/^[0-9a-f-]{36}$/),
  });
  expect(await loadProgressSession(client, cached, env, { id: sessionId })).toEqual({
    signedIn: false,
    idempotencyKey: expect.stringMatching(/^[0-9a-f-]{36}$/),
  });
  const writes = (req: Request) => [
    () => startProgress(client, req, env, startInput),
    () => recordProgress(client, req, env, recordInput),
    ...(['complete', 'abandon'] as const).map(
      (action) => () => finishProgress(client, req, env, { sessionId, action, revision: 17, idempotencyKey }),
    ),
  ];
  for (const write of writes(cached)) expect(await write()).toEqual({ ok: false, reason: 'forbidden' });
  expect(current.calls).toBe(7);
  expect(viewerCredential(cached)).toBe('Bearer cached-viewer');
  expect(calls).toHaveLength(0);

  current.status = 'unavailable';
  const unavailable = { problem: { status: 502, code: 'dependency_unavailable' } };
  await expect(loadProgressIndex(client, cached, env, { subjectId })).rejects.toMatchObject(unavailable);
  await expect(loadProgressSession(client, cached, env, { id: sessionId })).rejects.toMatchObject(unavailable);
  for (const write of writes(cached)) await expect(write()).rejects.toMatchObject(unavailable);

  current.status = 'active';
  const unsafe = request('POST');
  expect(await prepareSession(unsafe, env)).toBe(false);
  current.status = 'absent';
  const forbidden = { problem: { status: 403, code: 'forbidden' } };
  for (const write of writes(unsafe)) await expect(write()).rejects.toMatchObject(forbidden);
  current.status = 'active';
  unsafe.headers.set('x-csrf-token', 'B'.repeat(22));
  for (const write of writes(unsafe)) await expect(write()).rejects.toMatchObject(forbidden);
  unsafe.headers.set('x-csrf-token', csrfToken);
  unsafe.headers.set('origin', 'https://other.example.test');
  for (const write of writes(unsafe)) await expect(write()).rejects.toMatchObject(forbidden);
  expect(calls).toHaveLength(0);
});

test('healthy current and explicit-header Progress retain restrictive GETs, bounded independent paging and exact native write identity', async () => {
  const calls: Request[] = [];
  const listCursor = 'signed/list+cursor=';
  const changesCursor = 'signed/changes+cursor=';
  const unitsCursor = 'signed/units+cursor=';
  const stale = 'signed/stale+cursor=';
  const next = 'signed/next+cursor=';
  let embedded = false;
  let mode: ProgressMode = 'scalar_amount';
  const native = (): NativeProgressSession => ({
    id: sessionId,
    subjectId,
    versionSubjectId,
    mode,
    unit: 'segment-x',
    total: mode === 'scalar_amount' ? '12.500000' : null,
    amount: mode === 'scalar_amount' ? '1.250000' : null,
    locator: mode === 'cursor_position' ? 'chapter:09' : null,
    position: mode === 'cursor_position' ? '0.750000' : null,
    completedUnitCount: mode === 'completed_units' ? 2 : 0,
    state: 'active',
    revision: 17,
    startedAt: stamp,
    completedAt: null,
    subject: { id: subjectId, type: 'schema:Book', label: 'Stored subject' },
    versionSubject: { id: versionSubjectId, type: 'schema:Book', label: 'Stored version' },
    presentation: {
      meaning: 'known',
      structure: 'unverified',
      unitLabel: 'segment',
      recording: { state: 'supported', inputRules: { step: '0.000001', total: 'optional' } },
    },
  });
  const client = createKernelClient('https://kernel.example.test', {
    fetch: async (input, init) => {
      const call = new Request(input, init);
      calls.push(call);
      const url = new URL(call.url);
      if (call.method === 'GET' && url.searchParams.get('cursor') === stale)
        return Response.json({ code: 'stale_cursor' }, { status: 409 });
      if (call.method === 'POST')
        return Response.json({
          progressSession: {
            ...native(),
            revision: 18,
            state: url.pathname.endsWith(':complete')
              ? 'completed'
              : url.pathname.endsWith(':abandon')
                ? 'abandoned'
                : 'active',
            completedAt: url.pathname.endsWith(':complete') ? stamp : null,
          },
        });
      if (url.pathname === '/v1/progressSessions')
        return Response.json({ progressSessions: embedded ? [native()] : [], next });
      if (url.pathname === `/v1/subjects/${subjectId}`)
        return Response.json({ subject: { id: subjectId, type: 'schema:Book' }, summary: native().subject });
      if (url.pathname === `/v1/progressSessions/${sessionId}`) return Response.json({ progressSession: native() });
      if (url.pathname === `/v1/progressSessions/${sessionId}/changes`)
        return Response.json({
          changes: [{ id: 'change-17', revision: 17, intent: { add: sparseUnits }, createdAt: stamp }],
          next: `${next}changes`,
        });
      if (url.pathname === `/v1/progressSessions/${sessionId}/completedUnits`)
        return Response.json({ completedUnits: sparseUnits, next: `${next}units` });
      throw new Error(`Unexpected child request: ${call.method} ${url}`);
    },
  });
  const { current, env } = session();
  const cached = request();
  expect(await prepareSession(cached, env)).toBe(false);
  current.token = 'current-viewer';
  const query = (call: Request) => Object.fromEntries(new URL(call.url).searchParams);
  const index = await loadProgressIndex(client, cached, env, { subjectId, cursor: listCursor });
  expect(index).toMatchObject({
    signedIn: true,
    sessions: [],
    next,
    selectedSubject: { id: subjectId, label: 'Stored subject' },
  });
  expect(calls.map((call) => [new URL(call.url).pathname, query(call)])).toEqual([
    ['/v1/progressSessions', { view: 'FULL', limit: '100', subjectId, cursor: listCursor }],
    [`/v1/subjects/${subjectId}`, {}],
  ]);
  embedded = true;
  const beforeList = calls.length;
  const listed = await loadProgressIndex(client, cached, env, { subjectId, cursor: stale });
  expect(listed.sessions).toHaveLength(1);
  expect(listed.next).toBe(next);
  expect(calls.slice(beforeList).map(query)).toEqual([
    { view: 'FULL', limit: '100', subjectId, cursor: stale },
    { view: 'FULL', limit: '100', subjectId },
  ]);
  for (const value of ['scalar_amount', 'cursor_position', 'completed_units'] as const) {
    mode = value;
    const before = calls.length;
    const changes = mode === 'scalar_amount' ? stale : changesCursor;
    const units = mode === 'completed_units' ? stale : unitsCursor;
    const page = await loadProgressSession(client, cached, env, { id: sessionId, changes, units });
    expect(page.signedIn).toBe(true);
    if (!page.signedIn) throw new Error('Current owner must have a session page');
    const { presentation, ...expected } = native();
    expect(page.session).toMatchObject({
      ...expected,
      unitLabel: presentation!.unitLabel,
      recordingState: 'supported',
      units: sparseUnits,
    });
    expect(page.session.changes).toEqual([
      {
        id: 'change-17',
        revision: 17,
        createdAt: stamp,
        action: null,
        amount: null,
        locator: null,
        position: null,
        add: sparseUnits,
        remove: [],
      },
    ]);
    expect([page.changesCursor, page.unitsCursor, page.session.changesNext, page.session.unitsNext]).toEqual([
      changes === stale ? undefined : changes,
      units === stale ? undefined : units,
      `${next}changes`,
      `${next}units`,
    ]);
    const reads = calls.slice(before);
    expect(
      reads.filter((call) => new URL(call.url).pathname === `/v1/progressSessions/${sessionId}`).map(query),
    ).toEqual([{ view: 'FULL', presentation: 'FULL' }]);
    for (const [child, cursor] of [
      ['changes', changes],
      ['completedUnits', units],
    ] as const) {
      expect(reads.filter((call) => new URL(call.url).pathname.endsWith(`/${child}`)).map(query)).toEqual([
        { view: 'FULL', limit: '100', cursor },
        ...(cursor === stale ? [{ view: 'FULL', limit: '100' }] : []),
      ]);
    }
    expect(reads).toHaveLength(changes === stale || units === stale ? 4 : 3);
  }
  expect(calls.every((call) => call.headers.get('authorization') === 'Bearer current-viewer')).toBe(true);
  const explicit = new Request(`${origin}/en/library/progress`, {
    headers: { authorization: 'Bearer explicit-viewer' },
  });
  const preparations = current.calls;
  const beforeExplicit = calls.length;
  expect(
    (await loadProgressSession(client, explicit, env, { id: sessionId, changes: changesCursor, units: unitsCursor }))
      .signedIn,
  ).toBe(true);
  expect(calls.slice(beforeExplicit)).toHaveLength(3);
  expect(
    calls.slice(beforeExplicit).every((call) => call.headers.get('authorization') === 'Bearer explicit-viewer'),
  ).toBe(true);
  expect(current.calls).toBe(preparations);

  const beforeWrites = calls.length;
  const expectedWrites: [string, unknown, string, string][] = [];
  for (const value of ['scalar_amount', 'cursor_position', 'completed_units'] as const) {
    mode = value;
    const req = mode === 'cursor_position' ? new Request(explicit, { method: 'POST' }) : request('POST');
    const authorization = mode === 'cursor_position' ? 'Bearer explicit-viewer' : 'Bearer current-viewer';
    const startKey = crypto.randomUUID();
    const recordKey = crypto.randomUUID();
    const body = {
      subjectId,
      versionSubjectId,
      mode,
      unit: 'segment-x',
      ...(mode === 'scalar_amount' ? { total: '12.500000' } : {}),
    };
    expect(await startProgress(client, req, env, { ...body, idempotencyKey: startKey })).toEqual({
      ok: true,
      id: sessionId,
    });
    expectedWrites.push(['/v1/progressSessions', body, authorization, startKey]);
    const intent =
      mode === 'scalar_amount'
        ? { amount: '1.250000' }
        : mode === 'cursor_position'
          ? { locator: 'chapter:09', position: '0.750000' }
          : { add: sparseUnits };
    expect(
      await recordProgress(client, req, env, { sessionId, revision: 17, idempotencyKey: recordKey, ...intent }),
    ).toMatchObject({ ok: true, session: { id: sessionId, revision: 18 } });
    expectedWrites.push([
      `/v1/progressSessions/${sessionId}:record`,
      { revision: 17, ...intent },
      authorization,
      recordKey,
    ]);
  }
  const unsafe = request('POST');
  expect(
    await recordProgress(client, unsafe, env, { sessionId, revision: 17, idempotencyKey, remove: sparseUnits }),
  ).toMatchObject({ ok: true });
  expectedWrites.push([
    `/v1/progressSessions/${sessionId}:record`,
    { revision: 17, remove: sparseUnits },
    'Bearer current-viewer',
    idempotencyKey,
  ]);
  for (const action of ['complete', 'abandon'] as const) {
    const finishKey = crypto.randomUUID();
    expect(
      await finishProgress(client, unsafe, env, { sessionId, revision: 17, idempotencyKey: finishKey, action }),
    ).toMatchObject({
      ok: true,
      session: {
        id: sessionId,
        revision: 18,
        state: action === 'complete' ? 'completed' : 'abandoned',
        completedAt: action === 'complete' ? stamp : null,
      },
    });
    expectedWrites.push([
      `/v1/progressSessions/${sessionId}:${action}`,
      { revision: 17 },
      'Bearer current-viewer',
      finishKey,
    ]);
  }
  expect(
    await Promise.all(
      calls.slice(beforeWrites).map(async (call) => {
        expect(call.method).toBe('POST');
        return [
          new URL(call.url).pathname,
          await call.json(),
          call.headers.get('authorization'),
          call.headers.get('idempotency-key'),
        ];
      }),
    ),
  ).toEqual(expectedWrites);
  const beforeInvalid = calls.length;
  expect(
    await recordProgress(client, unsafe, env, {
      sessionId,
      revision: 17,
      idempotencyKey,
      add: Array.from({ length: 101 }, (_, n) => `unit:${n}`),
    }),
  ).toEqual({ ok: false, reason: 'invalid' });
  expect(calls).toHaveLength(beforeInvalid);
  expect(
    calls
      .filter((call) => call.method === 'GET')
      .every((call) => call.cache === 'no-store' && call.redirect === 'manual'),
  ).toBe(true);
});
