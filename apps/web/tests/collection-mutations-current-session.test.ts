import { expect, mock, spyOn, test } from 'bun:test';
import * as start from '../.storybook/react-start';
import * as session from '../src/session/request';

const origin = 'https://site.test';
const csrfToken = 'A'.repeat(22);
const idempotencyKey = '10203040-5060-4070-8090-102030405060';
const pin = { collectionId: 'collection', revision: 37, idempotencyKey };
const member = { intent: 'member' as const, subjectId: 'subject', collectionId: pin.collectionId, idempotencyKey };
let preparation: 'active' | 'absent' | 'unavailable' = 'active';
let accessToken = 'cached-viewer';
let credentialReads = 0;
const env = {
  KERNEL_ORIGIN: 'https://kernel.test',
  AUTH_ISSUER: 'https://auth.test',
  API_RESOURCE: 'https://kernel.test',
  WEBSITE_SCOPES: 'openid',
  WEBSITE_CLIENT_ID: 'web',
  WEBSITE_CLIENT_KEY: '{}',
  SITE_ORIGINS: origin,
  SESSIONS: {
    idFromName: (id: string) => id,
    get: () => ({
      credential: async () => {
        credentialReads++;
        return preparation === 'active'
          ? { status: preparation, accessToken, subject: 'owner', csrfToken }
          : { status: preparation, csrfToken };
      },
    }),
  },
};
function request(method = 'GET') {
  return new Request(`${origin}/en/subjects/subject`, {
    method,
    headers: { cookie: `__Host-rezics_session=${'a'.repeat(43)}`, origin, 'x-csrf-token': csrfToken },
  });
}
let currentRequest = request();
const responseHeaders = new Headers();
// Only the environment/RPC transport is substituted; admission and its Request caches are real.
mock.module('cloudflare:workers', () => ({ env }));
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => ({
  getRequest: () => currentRequest,
  setResponseHeader: (name: string, value: string) => responseHeaders.set(name, value),
}));
const { env: sessionEnv } = await import('cloudflare:workers');
const kernel = await import('../src/kernel/client');
const { pinCollection, unpinCollection } = await import('../src/library/pins-actions');
const { applySubjectLibraryMutation } = await import('../src/library/subject-slot-mutation');
const addMember = () => applySubjectLibraryMutation(currentRequest, sessionEnv, member);
const writes = [() => pinCollection({ data: pin }), () => unpinCollection({ data: pin }), addMember];

// UNRUN: controller integration owns execution of this focused regression and native/browser acceptance.
test('Refused current session prevents pin and subject Collection mutations before cached credential lookup or client construction', async () => {
  preparation = 'active';
  accessToken = 'cached-viewer';
  currentRequest = request();
  expect(await session.prepareSession(currentRequest, sessionEnv)).toBe(false);
  expect(session.viewerCredential(currentRequest)).toBe('Bearer cached-viewer');
  preparation = 'absent';
  expect(await session.prepareSession(currentRequest, sessionEnv)).toBe(true);
  const credential = spyOn(session, 'viewerCredential');
  const client = spyOn(kernel, 'kernelClient');
  const transport = spyOn(globalThis, 'fetch').mockImplementation(async () => {
    throw new Error('Refused preparation dispatched a native mutation');
  });
  try {
    for (const write of writes.slice(0, 2)) expect(await write()).toEqual({ ok: false, reason: 'signed-out' });
    expect(await addMember()).toEqual({ result: 'unavailable' });
    expect(credential).not.toHaveBeenCalled();
    expect(client).not.toHaveBeenCalled();
    expect(session.viewerCredential(currentRequest)).toBe('Bearer cached-viewer');

    preparation = 'unavailable';
    for (const write of writes.slice(0, 2))
      await expect(write()).rejects.toMatchObject({ problem: { status: 502, code: 'dependency_unavailable' } });
    expect(await addMember()).toEqual({ result: 'unavailable' });

    preparation = 'active';
    currentRequest = request('POST');
    expect(await session.prepareSession(currentRequest, sessionEnv)).toBe(false);
    for (const refusal of ['absent', 'origin', 'x-csrf-token'] as const) {
      preparation = refusal === 'absent' ? 'absent' : 'active';
      if (refusal !== 'absent') currentRequest.headers.set(refusal, 'invalid');
      for (const write of writes.slice(0, 2))
        await expect(write()).rejects.toMatchObject({ problem: { status: 403, code: 'forbidden' } });
      expect(await addMember()).toEqual({ result: 'unavailable' });
      currentRequest.headers.set('origin', origin);
      currentRequest.headers.set('x-csrf-token', csrfToken);
    }
    expect(client).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
    expect(responseHeaders.get('cache-control')).toBe('private, no-store');
  } finally {
    credential.mockRestore();
    client.mockRestore();
    transport.mockRestore();
  }
});

test('admitted requests preserve exact revision and idempotency inputs, placement, transport and native conflict results', async () => {
  preparation = 'active';
  accessToken = 'cached-viewer';
  currentRequest = request('POST');
  expect(await session.prepareSession(currentRequest, sessionEnv)).toBe(false);
  accessToken = 'current-viewer';
  const preparations = credentialReads;
  const calls: Request[] = [];
  let status = 200;
  let code = '';
  let failTransport = false;
  const transport = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    calls.push(new Request(input, init));
    if (failTransport) throw new Error('Native dependency unavailable');
    return Response.json(status === 200 ? { revision: 41 } : { code }, { status });
  });
  try {
    for (const after of [undefined, null, 'anchor'])
      expect(await pinCollection({ data: { ...pin, after } })).toEqual({ ok: true, revision: 41 });
    expect(await unpinCollection({ data: pin })).toEqual({ ok: true, revision: 41 });
    expect(await addMember()).toEqual({ result: 'added' });
    expect(
      await Promise.all(
        calls.map(async (call) => [
          call.method,
          new URL(call.url).pathname,
          Object.fromEntries(new URL(call.url).searchParams),
          await call.text(),
          call.headers.get('idempotency-key'),
        ]),
      ),
    ).toEqual([
      ['PUT', '/v1/libraryPins/collection', {}, JSON.stringify({ revision: 37 }), JSON.stringify(idempotencyKey)],
      [
        'PUT',
        '/v1/libraryPins/collection',
        {},
        JSON.stringify({ revision: 37, after: null }),
        JSON.stringify(idempotencyKey),
      ],
      [
        'PUT',
        '/v1/libraryPins/collection',
        {},
        JSON.stringify({ revision: 37, after: 'anchor' }),
        JSON.stringify(idempotencyKey),
      ],
      ['DELETE', '/v1/libraryPins/collection', { revision: '37' }, '', JSON.stringify(idempotencyKey)],
      ['POST', '/v1/collections/collection/members', {}, JSON.stringify({ subjectId: 'subject' }), idempotencyKey],
    ]);

    for (const [nativeStatus, nativeCode, pinReason, memberResult] of [
      [409, 'collection_full', 'full', 'collection-full'],
      [409, 'conflict', 'conflict', 'unavailable'],
      [401, 'invalid_credentials', 'unavailable', 'unavailable'],
      [403, 'insufficient_scope', 'unavailable', 'unavailable'],
      [403, 'platform_closed', 'unavailable', 'closed'],
      [422, 'idempotency_conflict', 'unavailable', 'unavailable'],
      [503, 'dependency_unavailable', 'unavailable', 'unavailable'],
    ] as const) {
      status = nativeStatus;
      code = nativeCode;
      const before = calls.length;
      expect(await pinCollection({ data: pin })).toEqual({ ok: false, reason: pinReason });
      expect(await unpinCollection({ data: pin })).toEqual({
        ok: false,
        reason: status === 409 ? 'conflict' : 'unavailable',
      });
      expect(await addMember()).toEqual({ result: memberResult });
      expect(calls).toHaveLength(before + 3);
    }
    failTransport = true;
    const before = calls.length;
    for (const write of writes.slice(0, 2)) expect(await write()).toEqual({ ok: false, reason: 'unavailable' });
    expect(await addMember()).toEqual({ result: 'unavailable' });
    expect(calls).toHaveLength(before + 3);
    expect(credentialReads - preparations).toBe(calls.length);
    expect(
      calls.every(
        (call) =>
          call.cache === 'no-store' &&
          call.redirect === 'manual' &&
          call.headers.get('authorization') === 'Bearer current-viewer',
      ),
    ).toBe(true);
    expect(responseHeaders.get('cache-control')).toBe('private, no-store');
  } finally {
    transport.mockRestore();
  }
});
