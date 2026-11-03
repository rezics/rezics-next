import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  createRealmClaim,
  mayRequestRealmClaim,
  mayRetryRealmClaim,
  type RealmClaimRead,
  type RealmClaimSnapshot,
} from '../src/community/realm-claim';
import { writeRealmClaim } from '../src/community/realm-claim-native';
import {
  createRealmClaimStatus,
  realmClaimStatusResponse,
  type RealmClaimStatus,
  type RealmClaimStatusRead,
} from '../src/community/realm-claim-status';
import { readRealmClaimStatus, type RealmClaimStatusEnv } from '../src/community/realm-claim-status-native';
import { RealmClaimStatusView } from '../src/community/realm-claim-status-page';
import { createRealmClaimCallerLifetime } from '../src/community/realm-claim-caller-lifetime';
import recording from '../src/kernel/recorded/realm.json';

const realmId = recording.realm.realmId;
const requestId = '01a1a000-0000-7000-8000-000000000099';
const key = '01a1a000-0000-7000-8000-000000000090';
const source: RealmClaimSnapshot = {
  realmId,
  spaceId: recording.realm.spaceId,
  contextId: recording.realm.contextId,
  headRevisionId: recording.realm.headRevisionId,
  ownershipState: 'orphaned',
  governanceReadOnly: true,
  orphanedAt: '2026-09-01T10:00:00.000Z',
  claimEligibleAt: '2026-10-01T10:00:00.000Z',
};
const pending: RealmClaimStatus = {
  realmId,
  requestId,
  orphanedAt: source.orphanedAt!,
  requestedAt: '2026-10-31T10:00:00.000Z',
  state: 'pending',
  approvedAt: null,
  currentEpisode: true,
};
const approved: RealmClaimStatus = { ...pending, state: 'approved', approvedAt: '2026-10-31T12:34:56.000Z' };
const ready: RealmClaimRead = { kind: 'ready', snapshot: source, admission: 'allowed' };
const own: RealmClaimStatusRead = { kind: 'ready', claimRequest: pending, source };
const origin = 'https://kernel.example.test';
const env: RealmClaimStatusEnv = {};
const request = () =>
  new Request('https://site.example.test/action', { headers: { authorization: 'Bearer current-viewer' } });
const display = (initial: RealmClaimStatusRead) =>
  renderToStaticMarkup(
    createElement(RealmClaimStatusView, {
      realmId,
      requestId,
      initial,
      adapter: { read: async () => initial },
    }),
  );
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('Return to a real own Realm claim request and current native outcome', async () => {
  let current = source;
  let fact = pending;
  let lost = true;
  const posts: Request[] = [];
  const points: Request[] = [];
  const client = createKernelClient(origin, {
    fetch: async (url, init) => {
      const call = new Request(url, init);
      expect(call.headers.get('authorization')).toBe('Bearer current-viewer');
      const path = new URL(call.url).pathname;
      if (path.endsWith(`/claimRequests/${requestId}`)) {
        points.push(call);
        return Response.json({ claimRequest: fact });
      }
      if (call.method === 'POST') {
        posts.push(call);
        expect(new URL(call.url).pathname).toBe(`/v1/realms/${realmId}/claimRequests`);
        expect(await call.json()).toEqual({});
        expect(call.headers.get('idempotency-key')).toBe(JSON.stringify(key));
        if (lost) {
          lost = false;
          throw new Error('Lost original response');
        }
        return Response.json(
          {
            realmId,
            requestId,
            state: 'pending',
            orphanedAt: source.orphanedAt,
            claimEligibleAt: source.claimEligibleAt,
            requestedAt: pending.requestedAt,
          },
          { status: 202 },
        );
      }
      return new URL(call.url).pathname.endsWith('/participation')
        ? new Response(null, { status: 204 })
        : Response.json({ realm: { ...recording.realm, ...current } });
    },
  });
  const claim = createRealmClaim(
    realmId,
    ready,
    {
      read: async () => ready,
      request: (input) => writeRealmClaim(client, new Request(request(), { method: 'POST' }), {}, input),
    },
    () => key,
  );
  await claim.submit();
  expect(mayRetryRealmClaim(claim.getSnapshot())).toBe(true);
  await claim.retry();
  expect(claim.getSnapshot().request?.requestId).toBe(requestId);
  const input = { realmId, requestId: claim.getSnapshot().request!.requestId };
  expect(await readRealmClaimStatus(client, request(), env, input)).toEqual(own);
  fact = approved;
  current = { ...source, ownershipState: 'owned', governanceReadOnly: false, orphanedAt: null, claimEligibleAt: null };
  const outcome = await readRealmClaimStatus(client, request(), env, input);
  expect(outcome).toEqual({ kind: 'ready', claimRequest: approved, source: current });
  const html = display(outcome);
  expect(html).toContain('Request approved');
  expect(html).toContain(approved.approvedAt!);
  expect(html).toContain('does not establish that you still own');
  expect(html).toContain(`/realms/${realmId}`);
  expect(html).not.toContain('/spaces/');
  expect(html).not.toContain('Manage Realm');
  expect(posts).toHaveLength(2);
  expect(points).toHaveLength(2);
});

test('reload recovers one current own receipt, unknown prevents duplication, and null alone permits a new intent', async () => {
  let result: RealmClaimStatusRead = own;
  let reads = 0;
  let posts = 0;
  const control = createRealmClaim(
    realmId,
    ready,
    {
      read: async () => ready,
      mine: async () => {
        reads++;
        return result;
      },
      request: async () => {
        posts++;
        return { kind: 'unavailable' };
      },
    },
    () => key,
  );
  expect(mayRequestRealmClaim(control.getSnapshot())).toBe(false);
  await control.refresh();
  expect(control.getSnapshot().recovered?.requestId).toBe(requestId);
  expect(mayRequestRealmClaim(control.getSnapshot())).toBe(false);
  result = { kind: 'unavailable' };
  await control.refresh();
  expect(control.getSnapshot().recovery).toBe('unavailable');
  await control.submit();
  expect(posts).toBe(0);
  result = { kind: 'ready', claimRequest: null, source };
  await control.refresh();
  expect(mayRequestRealmClaim(control.getSnapshot())).toBe(true);
  await control.submit();
  expect(control.getSnapshot().intent?.idempotencyKey).toBe(key);
  result = own;
  await control.refresh();
  expect(control.getSnapshot()).toMatchObject({ outcome: 'uncertain', intent: { idempotencyKey: key } });
  expect(mayRetryRealmClaim(control.getSnapshot())).toBe(true);
  await control.retry();
  expect(posts).toBe(2);
  expect(reads).toBe(4);
});

test('late recovery or point reads cannot replace a newer source, episode, denial or query', async () => {
  const late = deferred<RealmClaimStatusRead>();
  const entered = deferred<void>();
  const claim = createRealmClaim(realmId, ready, {
    read: async () => ready,
    mine: () => {
      entered.resolve();
      return late.promise;
    },
    request: async () => ({ kind: 'unavailable' }),
  });
  const refreshing = claim.refresh();
  await entered.promise;
  const newer = { ...source, orphanedAt: '2026-10-30T00:00:00.000Z', claimEligibleAt: '2026-11-29T00:00:00.000Z' };
  claim.observePage(newer);
  late.resolve(own);
  await refreshing;
  expect(claim.getSnapshot().read).toEqual({ kind: 'ready', snapshot: newer, admission: 'unavailable' });
  expect(claim.getSnapshot().recovered).toBeNull();
  const statusLate = deferred<RealmClaimStatusRead>();
  const status = createRealmClaimStatus({ realmId, requestId }, own, { read: () => statusLate.promise });
  const pendingRead = status.refresh();
  expect(status.getSnapshot().read.kind).toBe('unavailable');
  status.observe({ kind: 'denied' });
  statusLate.resolve(own);
  await pendingRead;
  expect(status.getSnapshot().read.kind).toBe('denied');
  const unrelated = createRealmClaimStatus({ realmId, requestId: key }, own, { read: async () => own });
  await unrelated.refresh();
  expect(unrelated.getSnapshot().read.kind).toBe('unavailable');
});

test('current session credentials and before/final read and participation bind each exact native point', async () => {
  const calls: string[] = [];
  let token = 'session-one';
  let sessionReads = 0;
  const sessionEnv: RealmClaimStatusEnv = {
    ...env,
    AUTH_ISSUER: 'https://auth.example.test',
    API_RESOURCE: origin,
    WEBSITE_SCOPES: 'openid',
    WEBSITE_CLIENT_ID: 'web',
    WEBSITE_CLIENT_KEY: 'unused',
    SESSIONS: {
      idFromName: (name: string) => name,
      get: () => ({
        credential: async () => {
          sessionReads++;
          return { status: 'active', accessToken: token, subject: key, csrfToken: 'csrf' };
        },
      }),
    } as unknown as NonNullable<RealmClaimStatusEnv['SESSIONS']>,
  };
  const cookieRequest = () =>
    new Request('https://site.example.test/action', { headers: { cookie: `__Host-rezics_session=${'a'.repeat(43)}` } });
  const client = createKernelClient(origin, {
    fetch: async (url, init) => {
      const call = new Request(url, init);
      expect(call.headers.get('authorization')).toBe(`Bearer ${token}`);
      const path = new URL(call.url).pathname;
      calls.push(path);
      return path.endsWith('/claimRequests/mine')
        ? Response.json({ claimRequest: pending })
        : path.endsWith('/participation')
        ? new Response(null, { status: 204 })
        : Response.json({ realm: { ...recording.realm, ...source } });
    },
  });
  for (const next of ['session-one', 'session-two']) {
    token = next;
    expect(await readRealmClaimStatus(client, cookieRequest(), sessionEnv, { realmId })).toEqual(own);
  }
  expect(sessionReads).toBe(2);
  const root = `/v1/realms/${realmId}`;
  expect(calls).toEqual(
    Array(2)
      .fill([root, `${root}/participation`, `${root}/claimRequests/mine`, root, `${root}/participation`])
      .flat(),
  );
});

test('source failures, unrelated identity, closure and revoked final access never become an empty own result', async () => {
  let round = 0;
  let finalStatus = 204;
  let claimResponse = Response.json({ claimRequest: pending });
  const client = createKernelClient(origin, {
    fetch: async (url) => {
      const path = new URL(String(url)).pathname;
      if (path.includes('/claimRequests/')) return claimResponse;
      if (path.endsWith('/participation')) {
        round++;
        return new Response(null, { status: round % 2 === 0 ? finalStatus : 204 });
      }
      return Response.json({ realm: { ...recording.realm, ...source } });
    },
  });
  for (const [status, code, kind] of [
    [401, 'unauthorized', 'signed-out'],
    [404, 'not_found', 'denied'],
    [403, 'forbidden', 'denied'],
    [403, 'platform_closed', 'closed'],
    [503, 'unavailable', 'unavailable'],
  ] as const) {
    claimResponse = Response.json({ code }, { status });
    expect(
      await readRealmClaimStatus(client, request(), env, { realmId }),
    ).toEqual({ kind });
    round = 0;
  }
  finalStatus = 403;
  claimResponse = Response.json({ claimRequest: pending });
  expect(
    await readRealmClaimStatus(client, request(), env, { realmId, requestId }),
  ).toEqual({ kind: 'denied' });
  finalStatus = 204;
  round = 0;
  claimResponse = Response.json({ claimRequest: null });
  expect(
    await readRealmClaimStatus(client, request(), env, { realmId }),
  ).toEqual({ kind: 'ready', claimRequest: null, source });
  expect(await readRealmClaimStatus(client, new Request('https://site.example.test/action'), env, { realmId })).toEqual(
    { kind: 'signed-out' },
  );
  expect(await readRealmClaimStatus(client, request(), {}, { realmId })).toEqual({ kind: 'ready', claimRequest: null, source });
  for (const kind of ['denied', 'closed', 'unavailable', 'signed-out'] as const) {
    const html = display({ kind });
    expect(html).not.toContain(requestId);
    expect(html).not.toContain(pending.requestedAt);
    expect(html).not.toContain('/spaces/');
  }
});

test('historical pending differs from approval and closed DTOs exclude private identity or invented dates', () => {
  const old: RealmClaimStatusRead = { kind: 'ready', source, claimRequest: { ...pending, currentEpisode: false } };
  expect(display(old)).toContain('earlier orphan episode');
  expect(display(old)).not.toContain('Request approved');
  for (const bad of [
    null,
    { ...pending, requestId: key },
    { ...pending, claimantAccountId: key },
    { ...pending, approvedAt: approved.approvedAt },
    { ...approved, approvedAt: null },
    { ...pending, requestedAt: 'unknown' },
    { ...pending, body: 'private' },
  ]) {
    expect(realmClaimStatusResponse({ claimRequest: bad }, { realmId, requestId })).toBeUndefined();
  }
  expect(
    realmClaimStatusResponse({ claimRequest: { ...pending, currentEpisode: false } }, { realmId }),
  ).toBeUndefined();
});

test('own-status keeps validated absence on observe and refresh; exact null and private reads stay concealed', async () => {
  const none: RealmClaimStatusRead = { kind: 'ready', claimRequest: null, source };
  const adapter = { read: async () => none };
  const ownStatus = createRealmClaimStatus({ realmId }, none, adapter);
  expect(ownStatus.getSnapshot().read).toEqual(none);
  ownStatus.observe(own);
  expect(ownStatus.getSnapshot().read).toEqual(own);
  ownStatus.observe(none);
  expect(ownStatus.getSnapshot().read).toEqual(none);
  await ownStatus.refresh();
  expect(ownStatus.getSnapshot().read).toEqual(none);
  const exact = createRealmClaimStatus({ realmId, requestId }, none, adapter);
  expect(exact.getSnapshot().read.kind).toBe('unavailable');
  await exact.refresh();
  expect(exact.getSnapshot().read.kind).toBe('unavailable');
  expect(
    createRealmClaimStatus(
      { realmId },
      { kind: 'ready', claimRequest: null, source: { ...source, realmId: key } },
      adapter,
    ).getSnapshot().read.kind,
  ).toBe('unavailable');
  expect(
    createRealmClaimStatus(
      { realmId },
      { kind: 'ready', claimRequest: { ...pending, claimantAccountId: key } as never, source },
      adapter,
    ).getSnapshot().read.kind,
  ).toBe('unavailable');
  for (const kind of ['signed-out', 'denied', 'closed'] as const) {
    expect(createRealmClaimStatus({ realmId }, { kind }, adapter).getSnapshot().read).toEqual({ kind });
  }
  const late = deferred<RealmClaimStatusRead>();
  let live = true;
  const lifetime = createRealmClaimCallerLifetime(() => live);
  const retired = createRealmClaimStatus({ realmId }, none, { read: () => late.promise }, lifetime);
  const hiding = retired.refresh();
  live = false;
  lifetime.current();
  late.resolve(none);
  await hiding;
  expect(retired.getSnapshot().read.kind).toBe('unavailable');
});

test('caller retirement withholds the original status and suppresses its late point read', async () => {
  const late = deferred<RealmClaimStatusRead>();
  let current = true;
  let reads = 0;
  const lifetime = createRealmClaimCallerLifetime(() => current);
  const control = createRealmClaimStatus(
    { realmId, requestId },
    own,
    {
      read: () => {
        reads++;
        return late.promise;
      },
    },
    lifetime,
  );
  const refreshing = control.refresh();
  expect(control.getSnapshot().read.kind).toBe('unavailable');
  expect(reads).toBe(1);
  current = false;
  lifetime.current();
  late.resolve(own);
  await refreshing;
  expect(control.getSnapshot()).toMatchObject({ read: { kind: 'unavailable' }, busy: false });
  expect(reads).toBe(1);
});
