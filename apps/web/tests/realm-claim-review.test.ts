import { describe, expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  createRealmClaimReview,
  realmClaimReviewPage,
  type RealmClaimReviewRead,
  type RealmClaimReviewRequest,
} from '../src/community/realm-claim-review';
import { approveRealmClaimReview, readRealmClaimReview } from '../src/community/realm-claim-review-native';
import { RealmClaimReviewView } from '../src/community/realm-claim-review-page';

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
    let current: RealmClaimReviewRead = pending;
    const control = createRealmClaimReview(
      realmId,
      pending,
      {
        read: async () => current,
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
