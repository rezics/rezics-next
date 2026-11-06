import { describe, expect, mock, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import type { SessionEnv } from '../src/session/client';

mock.module('cloudflare:workers', () => ({ env: {} }));
const { nativeContinueSource } = await import('../src/library/continue-adapter');
const { CONTINUE_LIMIT, loadContinue, loadContinueState } = await import('../src/library/continue-read');
const { followCountsSearch, loadPrivateFollowCounts } = await import('../src/library/private-follow-counts');
const { prepareSession, requestCsrfToken, sessionSubject, viewerCredential } = await import('../src/session/request');

const target = { targetType: 'collection' as const, targetId: '0192f3a0-6c1e-7b2a-9d4e-000000000021' };
const viewer = { subject: 'current-reader', csrfToken: 'A'.repeat(22) };
function session() {
  const current = { status: 'active' as 'active' | 'absent' | 'unavailable', reads: [] as string[] };
  const credential = async (kind: string) => {
    current.reads.push(kind);
    return { status: current.status, ...viewer, accessToken: 'current-token' };
  };
  const env = {
    AUTH_ISSUER: 'https://auth.test',
    API_RESOURCE: 'https://kernel.test',
    WEBSITE_SCOPES: 'openid',
    WEBSITE_CLIENT_ID: 'web',
    WEBSITE_CLIENT_KEY: 'unused',
    SESSIONS: {
      idFromName: (id: string) => id,
      get: () => ({ credential: () => credential('refresh'), credentialIfFresh: () => credential('fresh') }),
    },
  } as unknown as Partial<SessionEnv>;
  const request = new Request('https://site.test/en/library', {
    headers: { cookie: `__Host-rezics_session=${'a'.repeat(43)}` },
  });
  return { current, env, request };
}

// Only session storage and HTTP transport are fixtures; Request preparation and generated callers are real.
// Authored for controller integration and intentionally UNRUN in this source-only attempt.
describe('Continue and private follow counts discard refused current-session context before native reads and retain bounded honest healthy results', () => {
  test('actual absence overrides cached credentials, subject and CSRF before source or native reads', async () => {
    const { current, env, request } = session();
    expect(await prepareSession(request, env)).toBe(false);
    current.status = 'absent';
    expect(await prepareSession(request, env)).toBe(true);
    const transport = mock(async () => {
      throw new Error('Refused session reached native IO');
    });
    const client = createKernelClient('https://kernel.test', { fetch: transport });
    const source = mock(nativeContinueSource);
    expect(await loadContinueState(client, request, env, {}, source)).toEqual({ state: 'signed-out' });
    expect(await loadContinue(client, request, env)).toEqual([]);
    for (const input of [{}, target, { targetId: target.targetId }])
      expect(await loadPrivateFollowCounts(client, request, env, input)).toEqual({
        viewer: null,
        locale: 'en',
        context: followCountsSearch(input),
        outgoing: { state: 'signed-out' },
        target: null,
      });
    expect(source).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
    // Shared preparation keeps its cache semantics; each leaf must honor its current refusal.
    expect(viewerCredential(request)).toBe('Bearer current-token');
    expect(sessionSubject(request)).toBe(viewer.subject);
    expect(requestCsrfToken(request)).toBe(viewer.csrfToken);

    current.status = 'unavailable';
    expect(await loadContinueState(client, request, env)).toEqual({ state: 'unavailable', status: 502 });
    await expect(loadContinue(client, request, env)).rejects.toMatchObject({ state: 'unavailable' });
    expect(await loadPrivateFollowCounts(client, request, env, target)).toEqual({
      viewer: null,
      locale: 'en',
      context: target,
      outgoing: { state: 'unavailable', status: 502, code: 'dependency_unavailable' },
      target: null,
    });
    const explicit = new Request('https://site.test/en/library', { headers: { authorization: 'Bearer explicit' } });
    expect(await loadPrivateFollowCounts(client, explicit, env, target)).toEqual({
      viewer: null,
      locale: 'en',
      context: target,
      outgoing: { state: 'signed-out' },
      target: null,
    });
    expect(transport).not.toHaveBeenCalled();
  });

  test('current sessions keep one fresh-only FULL Continue read and one own plus one exact target count read', async () => {
    const { current, env, request } = session();
    const calls: Request[] = [];
    const cursor = 'signed/keyset+cursor==&next=private';
    const next = 'signed/next+cursor==';
    const row = {
      subjectId: target.targetId,
      state: null,
      lastActivityAt: '2026-10-31T00:00:00Z',
      subject: {
        id: target.targetId,
        type: 'schema:Book',
        types: ['schema:Book'],
        label: { value: 'Current book', language: 'en' },
        creativeWork: true,
        cover: null,
      },
      activeProgressSession: {
        id: '0192f3a0-6c1e-7b2a-9d4e-000000000022',
        subjectId: target.targetId,
        versionSubjectId: null,
        mode: 'scalar_amount',
        unit: 'page',
        total: '100',
        amount: '25',
        locator: null,
        position: null,
        completedUnitCount: 0,
        state: 'active',
        revision: 1,
        startedAt: '2026-10-31T00:00:00Z',
        completedAt: null,
      },
    };
    let status = 200;
    let code = 'dependency_unavailable';
    const client = createKernelClient('https://kernel.test', {
      async fetch(input, init) {
        const call = new Request(input, init);
        calls.push(call);
        const path = new URL(call.url).pathname;
        if (path === '/v1/libraryContinue') {
          expect(init?.signal).toBe(request.signal);
          return Response.json(status === 200 ? { subjects: [row], next } : {}, {
            status,
            headers: { 'retry-after': '7' },
          });
        }
        if (path === '/v1/followCounts/outgoing' || path === `/v1/followCounts/collection/${target.targetId}`)
          return Response.json(
            status === 200
              ? path.endsWith('/outgoing')
                ? { followingCount: 0 }
                : { ...target, followerCount: 8 }
              : { code },
            { status, headers: { 'retry-after': '7' } },
          );
        throw new Error(`Unexpected child read: ${path}`);
      },
    });
    const source = mock(nativeContinueSource);
    const continued = await loadContinueState(client, request, env, { cursor }, source);
    expect(source).toHaveBeenCalledWith(
      client,
      'Bearer current-token',
      { limit: CONTINUE_LIMIT, cursor },
      request.signal,
    );
    expect(current.reads).toEqual(['fresh']);
    expect(continued).toMatchObject({
      state: 'loaded',
      next,
      entries: [
        {
          subjectId: row.subjectId,
          label: 'Current book',
          summary: row.subject,
          progress: { sessionId: row.activeProgressSession.id, amount: '25', total: '100' },
        },
      ],
    });
    expect(await loadPrivateFollowCounts(client, request, env, target)).toEqual({
      viewer,
      locale: 'en',
      context: target,
      outgoing: { state: 'ready', count: 0 },
      target: { state: 'ready', count: 8 },
    });
    expect(current.reads).toEqual(['fresh', 'refresh']);
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
      '/v1/libraryContinue',
      '/v1/followCounts/outgoing',
      `/v1/followCounts/collection/${target.targetId}`,
    ]);
    expect(calls.map((call) => Object.fromEntries(new URL(call.url).searchParams))).toEqual([
      { limit: '6', view: 'FULL', cursor },
      {},
      {},
    ]);
    expect(
      calls.every(
        (call) =>
          call.method === 'GET' &&
          call.cache === 'no-store' &&
          call.redirect === 'manual' &&
          call.headers.get('authorization') === 'Bearer current-token',
      ),
    ).toBe(true);
    expect(await loadPrivateFollowCounts(null, request, env, target)).toEqual({
      viewer,
      locale: 'en',
      context: target,
      outgoing: { state: 'unavailable' },
      target: null,
    });
    expect(calls).toHaveLength(3);

    for (const [nativeStatus, nativeCode, state] of [
      [404, 'not_found', 'denied'],
      [403, 'platform_closed', 'closed'],
      [503, 'dependency_unavailable', 'unavailable'],
    ] as const) {
      status = nativeStatus;
      code = nativeCode;
      const page = await loadPrivateFollowCounts(client, request, env, target);
      expect(page.outgoing).toEqual({ state: status === 404 ? 'unavailable' : state, status, code, retryAfter: '7' });
      expect(page.target).toEqual({ state, status, code, retryAfter: '7' });
    }
    status = 202;
    expect(await loadContinueState(client, request, env)).toEqual({ state: 'preparing', retryAfter: 7 });
    await expect(loadContinue(client, request, env)).rejects.toMatchObject({ state: 'preparing' });
    status = 403;
    expect(await loadContinueState(client, request, env)).toEqual({ state: 'denied', status: 403 });
    await expect(loadContinue(client, request, env)).rejects.toMatchObject({ state: 'denied' });
  });
});
