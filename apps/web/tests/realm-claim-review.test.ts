import { describe, expect, spyOn, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  createRealmClaimReview,
  realmClaimReviewPage,
  type RealmClaimReviewRead,
  type RealmClaimReviewRequest,
} from '../src/community/realm-claim-review';
import {
  approveRealmClaimReview,
  readRealmClaimReview,
  type RealmClaimReviewEnv,
} from '../src/community/realm-claim-review-native';
import { RealmClaimReviewView } from '../src/community/realm-claim-review-page';
import { createRealmClaimCallerLifetime } from '../src/community/realm-claim-caller-lifetime';

const row: RealmClaimReviewRequest = {
  realmId: '01a1a000-0000-7000-8000-000000000011',
  requestId: '01a1a000-0000-7000-8000-000000000099',
  claimantAccountId: '01a1a000-0000-7000-8000-000000000033',
  state: 'pending',
  orphanedAt: '2026-09-01T10:00:00.000Z',
  claimEligibleAt: '2026-10-01T10:00:00.000Z',
  requestedAt: '2026-10-31T10:00:00.000Z',
};
const { realmId, requestId } = row;
const idempotencyKey = '01a1a000-0000-7000-8000-000000000090';
const input = { realmId, requestId, idempotencyKey };
const pending: RealmClaimReviewRead = { kind: 'ready', page: { claimRequests: [row], next: null } };
const empty: RealmClaimReviewRead = { kind: 'ready', page: { claimRequests: [], next: null } };
const claim = {
  realmId,
  requestId,
  claimantAccountId: row.claimantAccountId,
  state: 'owned' as const,
  orphanedAt: row.orphanedAt,
  approvedAt: '2026-10-31T10:05:00.000Z',
};
const request = () =>
  new Request('https://site.example.test/action', {
    method: 'POST',
    headers: { authorization: 'Bearer current-viewer' },
  });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('Platform Realm claim review and genuine native approval journey', () => {
  test('uses the actual generated approval method, explicit confirmation, exact receipt and fresh queue', async () => {
    const calls: Request[] = [];
    let current: RealmClaimReviewRead = pending;
    let reads = 0;
    const client = createKernelClient('https://kernel.example.test', {
      fetch: async (url, init) => {
        const call = new Request(url, init);
        calls.push(call);
        expect(new URL(call.url).pathname).toBe(`/v1/realms/${realmId}/claimRequests/${requestId}:approve`);
        expect(call.method).toBe('POST');
        expect(call.headers.get('authorization')).toBe('Bearer current-viewer');
        expect(call.headers.get('idempotency-key')).toBe(JSON.stringify(idempotencyKey));
        expect(await call.json()).toEqual({});
        current = empty;
        return Response.json({ claim });
      },
    });
    const control = createRealmClaimReview(
      realmId,
      pending,
      {
        read: async () => {
          reads++;
          return current;
        },
        approve: (data) => approveRealmClaimReview(client, request(), {}, data),
      },
      () => idempotencyKey,
    );
    await control.confirm();
    expect(calls).toHaveLength(0);
    await control.prepare(requestId);
    expect(reads).toBe(1);
    expect(control.getSnapshot().outcome).toBe('confirming');
    expect(calls).toHaveLength(0);
    await control.confirm();
    expect(control.getSnapshot()).toMatchObject({ outcome: 'approved', receipt: claim, read: empty });
    expect(reads).toBe(2);
    await control.confirm();
    await control.prepare(requestId);
    expect(calls).toHaveLength(1);
  });

  test('an uncertain applied approval recovers with the same key even after its row leaves the queue', async () => {
    const intents: unknown[] = [];
    const reads: unknown[] = [];
    let current: RealmClaimReviewRead = pending;
    const control = createRealmClaimReview(
      realmId,
      pending,
      {
        read: async (input) => {
          reads.push(input);
          return current;
        },
        approve: async (data) => {
          intents.push(data);
          current = empty;
          return intents.length === 1 ? { kind: 'unavailable' } : { kind: 'approved', claim };
        },
      },
      () => idempotencyKey,
    );
    await control.prepare(requestId);
    await control.confirm();
    expect(control.getSnapshot()).toMatchObject({ outcome: 'uncertain', receipt: null, read: { kind: 'unavailable' } });
    const uncertainReads = reads.length;
    await control.restart();
    await control.retryPage();
    expect(reads).toHaveLength(uncertainReads);
    await control.retry();
    expect(intents).toEqual([input, input]);
    expect(control.getSnapshot()).toMatchObject({ outcome: 'approved', receipt: claim });
  });

  test('current denial conceals the queue and prevents uncertain replay until a fresh admitted read', async () => {
    let current: RealmClaimReviewRead = pending;
    let posts = 0;
    const control = createRealmClaimReview(
      realmId,
      pending,
      {
        read: async () => current,
        approve: async () => {
          posts++;
          return { kind: 'unavailable' };
        },
      },
      () => idempotencyKey,
    );
    await control.prepare(requestId);
    await control.confirm();
    current = { kind: 'denied' };
    await control.retry();
    expect(posts).toBe(1);
    expect(control.getSnapshot()).toMatchObject({
      read: { kind: 'denied' },
      receipt: null,
      intent: { idempotencyKey },
    });
  });

  test('changed episodes and native race conflicts require refresh and deliberate current-source review', async () => {
    let current: RealmClaimReviewRead = {
      kind: 'ready',
      page: { claimRequests: [{ ...row, orphanedAt: '2026-08-01T10:00:00.000Z' }], next: null },
    };
    let posts = 0;
    const control = createRealmClaimReview(realmId, pending, {
      read: async () => current,
      approve: async () => {
        posts++;
        return { kind: 'conflict' };
      },
    });
    await control.prepare(requestId);
    expect(control.getSnapshot()).toMatchObject({ outcome: 'conflict', intent: null });
    await control.confirm();
    expect(posts).toBe(0);
    control.reviewCurrent();
    await control.prepare(requestId);
    await control.confirm();
    expect(control.getSnapshot()).toMatchObject({ outcome: 'conflict', read: { kind: 'unavailable' } });
    current = empty;
    control.reviewCurrent();
    expect(control.getSnapshot().outcome).toBe('conflict');
    await control.refresh();
    control.reviewCurrent();
    expect(control.getSnapshot().outcome).toBe('idle');
    expect(posts).toBe(1);
  });

  test('one next consumes one native page, preserving sparse pages without refilling or polling', async () => {
    const reads: unknown[] = [];
    const sparse: RealmClaimReviewRead = { kind: 'ready', page: { claimRequests: [], next: 'opaque-next' } };
    const control = createRealmClaimReview(realmId, sparse, {
      read: async (data) => {
        reads.push(data);
        return pending;
      },
      approve: async () => {
        throw new Error('Unexpected approval');
      },
    });
    expect(control.getSnapshot().read).toEqual(sparse);
    expect(reads).toHaveLength(0);
    await control.next();
    expect(reads).toEqual([{ realmId, cursor: 'opaque-next' }]);
    expect(control.getSnapshot().read).toEqual(pending);
  });

  test('a failed continuation retries its cursor and explicitly restarts at the first page', async () => {
    const cursor = 'expired.signed.cursor';
    const reads: unknown[] = [];
    let approvals = 0;
    const control = createRealmClaimReview(realmId, { kind: 'ready', page: { claimRequests: [], next: cursor } }, {
      read: async (input) => {
        reads.push(input);
        return reads.length < 3 ? { kind: 'unavailable' } : pending;
      },
      approve: async () => {
        approvals++;
        return { kind: 'unavailable' };
      },
    });
    await control.next();
    await control.retryPage();
    expect(reads).toEqual([{ realmId, cursor }, { realmId, cursor }]);
    await control.restart();
    expect(reads).toEqual([{ realmId, cursor }, { realmId, cursor }, { realmId }]);
    expect(control.getSnapshot()).toMatchObject({ read: pending, cursor: undefined });
    expect(approvals).toBe(0);
  });

  test('retirement fences late prepare, uncertain retry and approval receipt refresh', async () => {
    let current = true;
    const prepareRead = deferred<RealmClaimReviewRead>();
    const prepareLifetime = createRealmClaimCallerLifetime(() => current);
    let prepareSends = 0;
    const preparing = createRealmClaimReview(
      realmId,
      pending,
      {
        read: () => prepareRead.promise,
        approve: async () => {
          prepareSends++;
          return { kind: 'approved', claim };
        },
      },
      () => idempotencyKey,
      prepareLifetime,
    );
    const preparingResult = preparing.prepare(requestId);
    current = false;
    prepareLifetime.current();
    prepareRead.resolve(pending);
    await preparingResult;
    expect(prepareSends).toBe(0);
    expect(preparing.getSnapshot()).toMatchObject({ read: { kind: 'unavailable' }, intent: null });

    current = true;
    const approval = deferred<RealmClaimApprovalResult>();
    const approvalLifetime = createRealmClaimCallerLifetime(() => current);
    let approvalReads = 0;
    const approving = createRealmClaimReview(
      realmId,
      pending,
      {
        read: async () => {
          approvalReads++;
          return pending;
        },
        approve: () => approval.promise,
      },
      () => idempotencyKey,
      approvalLifetime,
    );
    await approving.prepare(requestId);
    const approvalResult = approving.confirm();
    expect(approvalReads).toBe(1);
    current = false;
    approvalLifetime.current();
    approval.resolve({ kind: 'approved', claim });
    await approvalResult;
    expect(approvalReads).toBe(1);
    expect(approving.getSnapshot()).toMatchObject({ read: { kind: 'unavailable' }, receipt: null });

    current = true;
    const retryRead = deferred<RealmClaimReviewRead>();
    const retryLifetime = createRealmClaimCallerLifetime(() => current);
    let retries = 0;
    let retryReads = 0;
    const retrying = createRealmClaimReview(
      realmId,
      pending,
      {
        read: () => {
          retryReads++;
          return retryReads === 1 ? Promise.resolve(pending) : retryRead.promise;
        },
        approve: async () => {
          retries++;
          return retries === 1 ? { kind: 'unavailable' } : { kind: 'approved', claim };
        },
      },
      () => idempotencyKey,
      retryLifetime,
    );
    await retrying.prepare(requestId);
    await retrying.confirm();
    const retryResult = retrying.retry();
    current = false;
    retryLifetime.current();
    retryRead.resolve(empty);
    await retryResult;
    expect(retries).toBe(1);
    expect(retrying.getSnapshot()).toMatchObject({ read: { kind: 'unavailable' }, receipt: null });

    current = true;
    const restartRead = deferred<RealmClaimReviewRead>();
    const restartLifetime = createRealmClaimCallerLifetime(() => current);
    let restartReads = 0;
    const restarting = createRealmClaimReview(
      realmId,
      { kind: 'unavailable' },
      {
        read: () => {
          restartReads++;
          return restartRead.promise;
        },
        approve: async () => ({ kind: 'unavailable' }),
      },
      () => idempotencyKey,
      restartLifetime,
    );
    const restartResult = restarting.restart();
    current = false;
    restartLifetime.current();
    restartRead.resolve(pending);
    await restartResult;
    await restarting.restart();
    expect(restartReads).toBe(1);
    expect(restarting.getSnapshot().read).toEqual({ kind: 'unavailable' });
  });

  test('closed bounded payloads reject private fields, malformed identifiers and false success', async () => {
    expect(realmClaimReviewPage({ claimRequests: [{ ...row, body: 'private' }], next: null }, realmId)).toBeNull();
    expect(realmClaimReviewPage({ claimRequests: [row], next: null, address: 'private' }, realmId)).toBeNull();
    expect(
      realmClaimReviewPage({ claimRequests: [{ ...row, claimantAccountId: '<script>' }], next: null }, realmId),
    ).toBeNull();
    expect(
      realmClaimReviewPage({ claimRequests: Array.from({ length: 21 }, () => row), next: null }, realmId),
    ).toBeNull();
    for (const body of [
      {},
      { claim: { ...claim, state: 'pending' } },
      { claim: { ...claim, body: 'private' } },
      { claim: { ...claim, requestId: realmId } },
    ]) {
      const client = createKernelClient('https://kernel.example.test', { fetch: async () => Response.json(body) });
      expect(await approveRealmClaimReview(client, request(), {}, input)).toEqual({ kind: 'unavailable' });
    }
  });

  test('native current denial, conflict, closure and session/CSRF failures remain distinct', async () => {
    for (const [status, code, kind] of [
      [403, 'forbidden', 'denied'],
      [409, 'conflict', 'conflict'],
      [403, 'platform_closed', 'closed'],
      [503, 'dependency_unavailable', 'unavailable'],
    ] as const) {
      const client = createKernelClient('https://kernel.example.test', {
        fetch: async () => Response.json({ code }, { status }),
      });
      expect(await approveRealmClaimReview(client, request(), {}, input)).toEqual({ kind });
    }
    let calls = 0;
    const client = createKernelClient('https://kernel.example.test', {
      fetch: async () => {
        calls++;
        return Response.json({ claim });
      },
    });
    const csrf = new Request('https://site.example.test/action', {
      method: 'POST',
      headers: {
        cookie: '__Host-rezics_session=invalid',
        origin: 'https://other.example.test',
      },
    });
    expect(await approveRealmClaimReview(client, csrf, {}, input)).toEqual({ kind: 'denied' });
    expect(calls).toBe(0);
    expect(await readRealmClaimReview(request(), {}, { realmId })).toEqual({ kind: 'unavailable' });
  });

  test('unavailable and denied never render empty, private details or an approval action', () => {
    const adapter = {
      read: async (): Promise<RealmClaimReviewRead> => ({ kind: 'unavailable' }),
      approve: async () => ({ kind: 'denied' as const }),
    };
    for (const kind of ['unavailable', 'denied', 'closed'] as const) {
      const html = renderToStaticMarkup(createElement(RealmClaimReviewView, { realmId, initial: { kind }, adapter }));
      expect(html).not.toContain('No pending requests');
      expect(html).not.toContain(row.claimantAccountId);
      expect(html).not.toContain('Confirm approval');
      expect(html).not.toContain('<main');
    }
  });
});

describe('declared native Realm claim review read transport', () => {
  const env = { KERNEL_ORIGIN: 'https://kernel.example.test' };

  test('Connect existing reviewer read to declared sole native claim-review endpoint', async () => {
    const cursor = 'original.signed+/cursor?realm=exact&signature=%2F';
    const pages = [
      { claimRequests: [row], next: cursor },
      { claimRequests: [], next: 'signed-sparse-continuation' },
    ];
    const calls: Request[] = [];
    const fetches = spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      calls.push(new Request(url, init));
      expect(init?.cache).toBe('no-store');
      expect(init?.credentials).toBe('omit');
      expect(init?.redirect).toBe('error');
      return Response.json(pages[calls.length - 1]);
    });
    let token = 'current-session';
    let sessions = 0;
    const sessionEnv: RealmClaimReviewEnv = {
      ...env,
      AUTH_ISSUER: 'https://auth.example.test',
      API_RESOURCE: env.KERNEL_ORIGIN,
      WEBSITE_SCOPES: 'openid',
      WEBSITE_CLIENT_ID: 'web',
      WEBSITE_CLIENT_KEY: 'unused-by-this-read',
      SESSIONS: {
        idFromName: (name: string) => name,
        get: () => ({
          credential: async () => {
            sessions++;
            return { status: 'active', accessToken: token, subject: row.claimantAccountId, csrfToken: 'csrf' };
          },
        }),
      } as unknown as NonNullable<RealmClaimReviewEnv['SESSIONS']>,
    };
    const sessionRequest = () =>
      new Request('https://site.example.test/action', {
        headers: { cookie: `__Host-rezics_session=${'a'.repeat(43)}` },
      });
    try {
      expect(await readRealmClaimReview(sessionRequest(), sessionEnv, { realmId })).toEqual({
        kind: 'ready',
        page: pages[0],
      });
      token = 'refreshed-session';
      expect(await readRealmClaimReview(sessionRequest(), sessionEnv, { realmId, cursor })).toEqual({
        kind: 'ready',
        page: pages[1],
      });
      expect(sessions).toBe(2);
      expect(calls).toHaveLength(2);
      for (const [index, call] of calls.entries()) {
        const url = new URL(call.url);
        expect(url.origin).toBe(env.KERNEL_ORIGIN);
        expect(url.pathname).toBe(`/v1/realms/${realmId}/claimRequests`);
        expect([...url.searchParams]).toEqual([['limit', '20'], ...(index === 1 ? [['cursor', cursor]] : [])]);
        expect(call.method).toBe('GET');
        expect(call.headers.get('authorization')).toBe(`Bearer ${index ? 'refreshed-session' : 'current-session'}`);
        expect(call.headers.has('cookie')).toBe(false);
        expect(call.headers.has('idempotency-key')).toBe(false);
        expect(await call.text()).toBe('');
      }
    } finally {
      fetches.mockRestore();
    }
  });

  test('native denial, closure, stale cursors and absent or malformed sources never become an empty queue', async () => {
    for (const [status, body, kind] of [
      [401, { code: 'unauthorized' }, 'signed-out'],
      [403, { code: 'forbidden' }, 'denied'],
      [404, { code: 'not_found' }, 'denied'],
      [403, { code: 'platform_closed' }, 'closed'],
      [503, { code: 'dependency_unavailable' }, 'unavailable'],
      [400, { code: 'stale_cursor' }, 'unavailable'],
      [200, { claimRequests: [{ ...row, realmId: row.claimantAccountId }], next: null }, 'unavailable'],
      [200, { claimRequests: [row], next: null, mayApprove: true }, 'unavailable'],
    ] as const) {
      let calls = 0;
      const fetcher = (async () => {
        calls++;
        return Response.json(body, { status });
      }) as typeof fetch;
      expect(
        await readRealmClaimReview(request(), env, { realmId, cursor: 'original-signed-cursor' }, fetcher),
      ).toEqual({
        kind,
      });
      expect(calls).toBe(1);
    }
    for (const response of [new Response('not JSON'), new Response('Forbidden', { status: 403 })]) {
      const fetcher = (async () => response) as typeof fetch;
      expect(await readRealmClaimReview(request(), env, { realmId }, fetcher)).toEqual({
        kind: response.status === 403 ? 'denied' : 'unavailable',
      });
    }
  });

  test('signed-out, missing-source and invalid local reads send no GET; a lost GET waits for explicit retry', async () => {
    let calls = 0;
    const fetcher = (async () => {
      calls++;
      throw new Error('Read response lost');
    }) as typeof fetch;
    expect(
      await readRealmClaimReview(new Request('https://site.example.test/action'), env, { realmId }, fetcher),
    ).toEqual({
      kind: 'signed-out',
    });
    expect(await readRealmClaimReview(request(), {}, { realmId }, fetcher)).toEqual({ kind: 'unavailable' });
    await expect(readRealmClaimReview(request(), env, { realmId: 'invalid' }, fetcher)).rejects.toThrow();
    await expect(readRealmClaimReview(request(), env, { realmId, cursor: '' }, fetcher)).rejects.toThrow();
    expect(calls).toBe(0);
    expect(await readRealmClaimReview(request(), env, { realmId }, fetcher)).toEqual({ kind: 'unavailable' });
    expect(calls).toBe(1);
    expect(await readRealmClaimReview(request(), env, { realmId }, fetcher)).toEqual({ kind: 'unavailable' });
    expect(calls).toBe(2);
  });
});
