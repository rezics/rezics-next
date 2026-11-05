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
import { readRealmClaim, writeRealmClaim } from '../src/community/realm-claim-native';
import { RealmClaimControls } from '../src/community/realm-claim-controls';
import { loadSpacePage } from '../src/community/space';
import realmRecording from '../src/kernel/recorded/realm.json';
import spaceRecording from '../src/kernel/recorded/space.json';

const realmId = realmRecording.realm.realmId;
const source: RealmClaimSnapshot = {
  realmId,
  spaceId: realmRecording.realm.spaceId,
  contextId: realmRecording.realm.contextId,
  headRevisionId: realmRecording.realm.headRevisionId,
  ownershipState: 'orphaned',
  governanceReadOnly: true,
  orphanedAt: '2026-09-01T10:00:00.000Z',
  claimEligibleAt: '2026-10-01T10:00:00.000Z',
};
const pending = {
  realmId,
  requestId: '01a1a000-0000-7000-8000-000000000099',
  state: 'pending' as const,
  orphanedAt: source.orphanedAt!,
  claimEligibleAt: source.claimEligibleAt!,
  requestedAt: '2026-10-31T10:00:00.000Z',
};
const key = '01a1a000-0000-7000-8000-000000000090';
const auth = 'Bearer current-viewer';
const request = (method = 'GET', signedIn = true) =>
  new Request('https://site.example.test/action', {
    method,
    headers: signedIn ? { authorization: auth } : {},
  });
const ready: RealmClaimRead = { kind: 'ready', snapshot: source, admission: 'allowed' };

test('the assigned real current-authorized journey binds its native source while privacy retry and request bounds remain meaningful', async () => {
  let current = source;
  let status = 202;
  let lost = true;
  const calls: Request[] = [];
  const client = createKernelClient('https://kernel.example.test', {
    fetch: async (url, init) => {
      const next = new Request(url, init);
      calls.push(next);
      const path = new URL(next.url).pathname;
      expect(next.headers.get('authorization')).toBe(auth);
      if (path.endsWith('/participation')) return new Response(null, { status: 204 });
      if (next.method === 'GET') return Response.json({ realm: { ...realmRecording.realm, ...current } });
      expect(path).toBe(`/v1/realms/${realmId}/claimRequests`);
      expect(await next.json()).toEqual({});
      expect(next.headers.get('idempotency-key')).toBe(JSON.stringify(key));
      expect(next.headers.has('if-match')).toBe(false);
      if (status !== 202) return Response.json({ code: 'forbidden' }, { status });
      if (lost) {
        lost = false;
        throw new Error('Reply lost after submission');
      }
      return Response.json(pending, { status: 202 });
    },
  });
  const adapter = {
    read: (realmId: string) => readRealmClaim(client, request(), {}, { realmId, credentialMode: 'session' }),
    request: (input: { realmId: string; idempotencyKey: string }) =>
      writeRealmClaim(client, request('POST'), {}, input),
  };
  const control = createRealmClaim(realmId, { kind: 'unavailable' }, adapter, () => key);
  await control.refresh();
  expect(control.getSnapshot().read).toEqual(ready);
  expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
    `/v1/realms/${realmId}`,
    `/v1/realms/${realmId}/participation`,
    `/v1/realms/${realmId}`,
  ]);
  expect(mayRequestRealmClaim(control.getSnapshot())).toBe(true);
  await control.submit();
  expect(control.getSnapshot()).toMatchObject({
    outcome: 'uncertain',
    request: null,
    intent: { idempotencyKey: key, source },
  });
  expect(mayRetryRealmClaim(control.getSnapshot())).toBe(true);
  // Native authorization is rechecked even for an uncertain replay. A ban preserves the intent without a receipt.
  status = 403;
  await control.retry();
  expect(control.getSnapshot()).toMatchObject({ outcome: 'refused', request: null, intent: { idempotencyKey: key } });
  expect(mayRetryRealmClaim(control.getSnapshot())).toBe(false);
  await control.refresh();
  control.review();
  status = 202;
  await control.submit();
  expect(control.getSnapshot()).toMatchObject({ outcome: 'pending', request: pending, read: ready });
  expect(mayRequestRealmClaim(control.getSnapshot())).toBe(false);
  expect(calls.filter((call) => call.method === 'POST')).toHaveLength(3);
  // Neither request acceptance nor a browser timer changes ownership. Only a later native read does.
  current = { ...source, ownershipState: 'owned', orphanedAt: null, claimEligibleAt: null, governanceReadOnly: false };
  await control.refresh();
  expect(control.getSnapshot().read).toEqual({ kind: 'ready', snapshot: current, admission: 'allowed' });
  expect(control.getSnapshot().request?.requestId).toBe(pending.requestId);
  expect(mayRequestRealmClaim(control.getSnapshot())).toBe(false);
  expect(current.contextId).toBe(source.contextId);
  expect(calls).toHaveLength(12);
});

test('uncertain replay keeps exactly one key and source; changed source and conflicts require current review', async () => {
  let current = ready;
  let keys = 0;
  const intents: unknown[] = [];
  const control = createRealmClaim(
    realmId,
    ready,
    {
      read: async () => current,
      request: async (input) => {
        intents.push(input);
        return intents.length === 1 ? { kind: 'unavailable' } : { kind: 'pending', request: pending };
      },
    },
    () => {
      keys++;
      return key;
    },
  );
  await control.submit();
  await control.submit();
  await control.refresh();
  await control.retry();
  expect(keys).toBe(1);
  expect(intents).toEqual([
    { realmId, idempotencyKey: key },
    { realmId, idempotencyKey: key },
  ]);
  expect(control.getSnapshot().request).toEqual(pending);

  const conflict = createRealmClaim(
    realmId,
    ready,
    {
      read: async () => current,
      request: async () => ({ kind: 'conflict' }),
    },
    () => key,
  );
  await conflict.submit();
  conflict.review();
  expect(conflict.getSnapshot().intent).not.toBeNull();
  current = { kind: 'ready', admission: 'allowed', snapshot: { ...source, headRevisionId: key } };
  await conflict.refresh();
  expect(conflict.getSnapshot().intent?.source.headRevisionId).toBe(source.headRevisionId);
  conflict.review();
  expect(conflict.getSnapshot().intent).toBeNull();

  const uncertain = createRealmClaim(
    realmId,
    ready,
    {
      read: async () => current,
      request: async () => ({ kind: 'unavailable' }),
    },
    () => key,
  );
  await uncertain.submit();
  if (current.kind !== 'ready') throw new Error('Current source missing');
  uncertain.observePage(current.snapshot);
  expect(uncertain.getSnapshot().read).toEqual({ ...current, admission: 'unavailable' });
  expect(uncertain.getSnapshot().intent?.idempotencyKey).toBe(key);
  await uncertain.refresh();
  expect(mayRetryRealmClaim(uncertain.getSnapshot())).toBe(false);
  expect(uncertain.getSnapshot().intent?.source).toEqual(source);
});

test('native privacy, missing metadata, closure and before/final binding never infer request admission', async () => {
  let status = 200;
  let participation = 403;
  let metadata = true;
  let changed = false;
  let closed = false;
  let reads = 0;
  let calls = 0;
  const client = createKernelClient('https://kernel.example.test', {
    fetch: async (url, init) => {
      const next = new Request(url, init);
      calls++;
      if (closed) return Response.json({ code: 'platform_closed' }, { status: 403 });
      if (new URL(next.url).pathname.endsWith('/participation'))
        return participation === 204
          ? new Response(null, { status: 204 })
          : Response.json({ code: 'forbidden' }, { status: participation });
      if (status !== 200)
        return Response.json({ code: status === 503 ? 'partition_unavailable' : 'not_found' }, { status });
      reads++;
      return Response.json({
        realm: {
          ...realmRecording.realm,
          ...(metadata ? source : {}),
          ...(changed && reads % 2 === 0 ? { contextId: key } : {}),
        },
      });
    },
  });
  const read = () => readRealmClaim(client, request(), {}, { realmId, credentialMode: 'session' });
  expect(await read()).toEqual({ kind: 'ready', snapshot: source, admission: 'denied' });
  status = 404;
  const before = calls;
  expect(await read()).toEqual({ kind: 'denied' });
  expect(calls - before).toBe(1);
  status = 503;
  expect(await read()).toEqual({ kind: 'unavailable' });
  closed = true;
  expect(await read()).toEqual({ kind: 'closed' });
  expect(await writeRealmClaim(client, request('POST'), {}, { realmId, idempotencyKey: key })).toEqual({
    kind: 'closed',
  });
  closed = false;
  status = 200;
  metadata = false;
  expect(await read()).toEqual({ kind: 'unavailable' });
  metadata = true;
  participation = 204;
  changed = true;
  reads = 0;
  expect(await read()).toEqual({ kind: 'unavailable' });
  changed = false;
  const publicRead = await readRealmClaim(client, request('GET', false), {}, { realmId, credentialMode: 'anonymous' });
  expect(publicRead).toEqual({ kind: 'ready', snapshot: source, admission: 'signed-out' });
  const noWrite = calls;
  expect(await writeRealmClaim(client, request('POST', false), {}, { realmId, idempotencyKey: key })).toEqual({
    kind: 'signed-out',
  });
  expect(calls).toBe(noWrite);
  const csrf = new Request('https://site.example.test/action', {
    method: 'POST',
    headers: { cookie: '__Host-rezics_session=invalid', origin: 'https://other.example.test' },
  });
  expect(await writeRealmClaim(client, csrf, {}, { realmId, idempotencyKey: key })).toEqual({ kind: 'denied' });
  expect(calls).toBe(noWrite);
});

test('Space source retains continuity and the actual controls show original dates and existing sign-in without an owner inference', async () => {
  const client = createKernelClient('https://kernel.example.test', {
    fetch: async (url) => {
      const path = new URL(String(url)).pathname;
      if (path.includes('/spaceAddresses/')) return Response.json({ spaceId: source.spaceId });
      if (path.includes('/spaces/')) return Response.json({ space: { ...spaceRecording.space, realmId } });
      if (path.endsWith('/boards') || path.endsWith('/publications')) return Response.json({ items: [], next: null });
      return Response.json({ realm: { ...realmRecording.realm, ...source } });
    },
  });
  const page = await loadSpacePage(client, request('GET', false), {}, { address: 'quiet-novel-club' }, 'anonymous');
  expect(page.realm?.continuity).toEqual(source);
  const html = renderToStaticMarkup(
    createElement(RealmClaimControls, {
      realmId,
      initial: { kind: 'ready', snapshot: source, admission: 'signed-out' },
      adapter: { read: async () => ready, request: async () => ({ kind: 'unavailable' }) },
      returnTo: '/en/spaces/quiet-novel-club',
    }),
  );
  expect(html).toContain('read-only');
  expect(html).toContain(source.claimEligibleAt!);
  expect(html).toContain('/auth/sign-in?return_to=');
  expect(html).not.toContain(pending.requestId);
  expect(html).not.toContain('Request platform review</button>');
});
