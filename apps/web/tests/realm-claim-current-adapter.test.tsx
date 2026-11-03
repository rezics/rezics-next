import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import {
  createRealmClaimReview,
  realmClaimReviewPage,
  type NativeRealmClaimReviewPage,
  type RealmClaimReviewRead,
} from '../src/community/realm-claim-review';
import { readRealmClaimReview, approveRealmClaimReview } from '../src/community/realm-claim-review-native';
import { createRealmClaimCallerLifetime } from '../src/community/realm-claim-caller-lifetime';
import { realmClaimStatusResponse } from '../src/community/realm-claim-status';

const realmId = '01a1a000-0000-7000-8000-000000000011';
const id = (n: number) => `01a1a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const key = id(500);
const row = (n = 1): NativeRealmClaimReviewPage['claimRequests'][number] => ({
  realmId,
  requestId: id(n),
  claimantAccountId: id(n + 100),
  state: 'pending',
  orphanedAt: '2026-09-01T10:00:00.000Z',
  claimEligibleAt: '2026-10-01T10:00:00.000Z',
  requestedAt: '2026-10-31T10:00:00.000Z',
  claimant: { label: 'Claimant', href: null },
  approvalAdvice: {
    method: 'POST',
    destination: `/v1/realms/${realmId}/claimRequests/${id(n)}:approve`,
    requiredAction: 'realm:approve_claim',
    requiredHeader: 'Idempotency-Key',
  },
});
const selected = (item = row()) => {
  const { realmId: _realm, ...observation } = item;
  return { ...observation, currentEpisode: true as const };
};
const page = (count: number, next: string | null = null): NativeRealmClaimReviewPage => ({
  claimRequests: Array.from({ length: count }, (_, i) => row(i + 1)),
  next,
  selectedRequest: null,
  realmPresentation: { state: 'unavailable' },
});
const request = () =>
  new Request('https://web.test/action', { headers: { authorization: 'Bearer original-reviewer' } });

test('actual bounded adapters keep raw pages, opaque retries and exact selection independent at 1/10/20 rows', async () => {
  for (const count of [1, 10, 20]) {
    const cursor = 'signed+/opaque?unchanged=%2F';
    let nativeReads = 0,
      inspections = 0,
      posts = 0,
      bytes = 0,
      failNext = true;
    const client = createKernelClient('https://kernel.test', {
      fetch: async (url, init) => {
        const call = new Request(url, init),
          query = new URL(call.url).searchParams;
        expect(call.headers.get('authorization')).toBe('Bearer original-reviewer');
        expect(new URL(call.url).pathname).toBe(`/v1/realms/${realmId}/claimRequests`);
        expect(call.method).toBe('GET');
        nativeReads++;
        let response = page(count, cursor);
        if (query.has('inspectRequestId')) {
          inspections++;
          expect(query.has('cursor')).toBe(false);
          response = { ...page(0), selectedRequest: selected() }; // selected row need not appear in this page
        } else if (query.has('cursor')) {
          expect(query.get('cursor')).toBe(cursor);
          if (failNext) {
            failNext = false;
            return new Response('', { status: 503 });
          }
          response = page(0, cursor); // sparse pages do not refill
        }
        bytes += JSON.stringify(response).length;
        return Response.json(response);
      },
    });
    const adapter = {
      read: (input: Parameters<typeof readRealmClaimReview>[3]) => readRealmClaimReview(client, request(), {}, input),
      approve: async () => {
        posts++;
        return { kind: 'unavailable' as const };
      },
    };
    const initial = await adapter.read({ realmId });
    const lifetime = createRealmClaimCallerLifetime(() => true);
    const control = createRealmClaimReview(realmId, initial, adapter, () => key, lifetime);
    await control.prepare(id(1));
    expect(control.getSnapshot().outcome).toBe('confirming');
    expect(control.getSnapshot().intent?.observation).toEqual(selected());
    expect(control.getSnapshot().read).toEqual(initial);
    control.cancel();
    await control.next();
    expect(control.getSnapshot().read.kind).toBe('unavailable');
    await control.retryPage();
    expect(control.getSnapshot().read).toMatchObject({ kind: 'ready', page: { claimRequests: [], next: cursor } });
    expect({ nativeReads, inspections, posts }).toEqual({ nativeReads: 4, inspections: 1, posts: 0 });
    expect(bytes).toBeLessThan(17000);
    const retained = JSON.stringify(control.getSnapshot()).length;
    expect(retained).toBeLessThan(500); // no accumulated pages or inspection retained after cancel
    lifetime.retire();
    expect(JSON.stringify(control.getSnapshot())).not.toContain('claimantAccountId');
    await control.next();
    await control.inspectOriginal();
    await control.retry();
    expect(nativeReads).toBe(4);
  }
});

test('unknown native approval has read-only inspection, separate original-key recovery and committed receipt during readback', async () => {
  let writes = 0,
    reads = 0,
    readback!: (value: RealmClaimReviewRead) => void;
  let ready!: () => void;
  const readbackReady = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const sent: string[] = [];
  const claim = {
    realmId,
    requestId: id(1),
    claimantAccountId: row().claimantAccountId,
    state: 'owned',
    orphanedAt: row().orphanedAt,
    approvedAt: '2026-10-31T11:00:00.000Z',
  };
  const client = createKernelClient('https://kernel.test', {
    fetch: async (url, init) => {
      const call = new Request(url, init);
      if (call.method === 'POST') {
        writes++;
        sent.push(call.headers.get('idempotency-key')!);
        expect(new URL(call.url).pathname).toBe(row().approvalAdvice.destination);
        return writes === 1 ? new Response('', { status: 503 }) : Response.json({ claim });
      }
      reads++;
      return Response.json({
        ...page(0),
        selectedRequest: writes
          ? {
              requestId: id(1),
              state: 'approved',
              orphanedAt: row().orphanedAt,
              requestedAt: row().requestedAt,
              approvedAt: claim.approvedAt,
              currentEpisode: false,
            }
          : selected(),
      });
    },
  });
  const lifetime = createRealmClaimCallerLifetime(() => true);
  const control = createRealmClaimReview(
    realmId,
    { kind: 'ready', page: page(1) },
    {
      read: (input) =>
        !input.inspectRequestId
          ? new Promise((resolve) => {
              readback = resolve;
              ready();
            })
          : readRealmClaimReview(client, request(), {}, input),
      approve: (input) => approveRealmClaimReview(client, request(), {}, input),
    },
    () => key,
    lifetime,
  );
  await control.prepare(id(1));
  await control.confirm();
  const original = control.getSnapshot().intent;
  await control.retry(); // no implicit inspection or write
  await control.refresh();
  await control.restart();
  expect(writes).toBe(1);
  await control.inspectOriginal();
  expect(control.getSnapshot().intent).toBe(original);
  expect(control.getSnapshot()).toMatchObject({
    outcome: 'uncertain',
    receipt: null,
    inspection: { state: 'approved' },
    recoveryReady: true,
  });
  expect({ writes, reads }).toEqual({ writes: 1, reads: 2 });
  const recovery = control.retry();
  await readbackReady;
  expect(control.getSnapshot()).toMatchObject({ outcome: 'approved', busy: true, receipt: claim });
  expect(sent).toEqual([JSON.stringify(key), JSON.stringify(key)]);
  lifetime.retire();
  readback({ kind: 'ready', page: page(0) });
  await recovery;
  expect(control.getSnapshot()).toMatchObject({ receipt: null, intent: null, inspection: null });
  await control.retry();
  expect(writes).toBe(2);
});

test('native disclosure is closed; advice, exact episode and requester status never substitute for authority', async () => {
  const valid = { ...page(1), selectedRequest: selected() };
  for (const altered of [
    { ...valid, privateBody: 'hidden' },
    { ...valid, claimRequests: [{ ...row(), claimant: { label: 'unsafe', href: '//elsewhere.test' } }] },
    {
      ...valid,
      selectedRequest: { ...selected(), approvalAdvice: { ...row().approvalAdvice, destination: '/other' } },
    },
  ])
    expect(realmClaimReviewPage(altered, realmId, true)).toBeNull();
  const control = createRealmClaimReview(
    realmId,
    { kind: 'ready', page: page(1) },
    {
      read: async () => ({
        kind: 'ready',
        page: { ...page(0), selectedRequest: { ...selected(), orphanedAt: '2025-01-01T00:00:00Z' } },
      }),
      approve: async () => {
        throw new Error('No command from mismatched episode');
      },
    },
  );
  await control.prepare(id(1));
  await control.confirm();
  expect(control.getSnapshot()).toMatchObject({ outcome: 'conflict', intent: null });
  expect(realmClaimStatusResponse({ claimRequest: null }, { realmId })).toBeNull();
  expect(realmClaimStatusResponse({ claimRequest: null }, { realmId, requestId: id(1) })).toBeUndefined();
  expect(realmClaimStatusResponse({ claimRequest: selected() }, { realmId, requestId: id(1) })).toBeUndefined();
});
