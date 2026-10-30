import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RealmParticipationView } from '../src/community/realm-membership';
import { refreshRealmMembership } from '../src/community/realm-membership-queries';
import { loadRealmMembership, requestRealmMembership } from '../src/community/space';
import { readFollowRecord, writeFollowRecord } from '../src/library/follow-records';

const realmId = '0192f3a0-6c1e-7b2a-9d4e-000000000201';
const spaceId = '0192f3a0-6c1e-7b2a-9d4e-000000000101';
const idempotencyKey = '123e4567-e89b-42d3-a456-426614174000';
const authorization = 'Bearer current-member';
const auth = { headers: { authorization } };
const request = () => new Request('https://site.example.test/action', { method: 'POST', ...auth });
const pause = async () => {};
const view = (
  state: 'none' | 'pending' | 'member' | 'banned' | 'unavailable',
  visibility: 'public' | 'protected' = 'public',
  refresh: 'pending' | 'unavailable' | null = null,
) =>
  renderToStaticMarkup(
    createElement(RealmParticipationView, {
      state,
      visibility,
      refresh,
      onChange: () => {},
      onRetry: () => {},
    }),
  );

// Protocol fixtures exercise the real bounded BFF readers/writers, not native workflow authority.
test('accepted join and leave settle visibly through bounded current reads; pending, denied and unavailable remain truthful', async () => {
  let state: 'none' | 'member' = 'none';
  let participation = 204;
  let membershipStatus = 200;
  let commandStatus = 202;
  let commands = 0;
  let reads = 0;
  const client = createKernelClient('https://kernel.example.test', {
    fetch: async (input, init) => {
      const next = new Request(input, init);
      expect(next.headers.get('authorization')).toBe(authorization);
      const path = new URL(next.url).pathname;
      if (path.endsWith('/membership')) {
        commands++;
        if (next.method === 'POST') expect(next.headers.get('idempotency-key')).toBe(JSON.stringify(idempotencyKey));
        return commandStatus === 202
          ? Response.json({ workflowId: 'native-membership-workflow' }, { status: 202 })
          : Response.json({ code: 'forbidden', detail: 'Native leave denied' }, { status: commandStatus });
      }
      reads++;
      if (path.endsWith('/members/me')) return Response.json({ state, since: null }, { status: membershipStatus });
      expect(path).toBe(`/v1/realms/${realmId}/participation`);
      return new Response(null, { status: participation });
    },
  });
  const change = (action: 'join' | 'leave') =>
    requestRealmMembership(client, request(), {}, { realmId, action, idempotencyKey });
  const read = () => loadRealmMembership(client, realmId, auth);
  expect(await change('join')).toEqual({ outcome: 'accepted', workflowId: 'native-membership-workflow' });
  expect(await refreshRealmMembership(read, 'member', { pause })).toEqual({ kind: 'pending' });
  expect(reads).toBe(8);
  expect(view('pending', 'public', 'pending')).toContain('Check membership');
  expect(view('pending', 'public', 'pending')).not.toContain('>Leave</button>');
  state = 'member';
  const joined = await refreshRealmMembership(read, 'member', { pause });
  expect(joined.kind).toBe('settled');
  if (joined.kind !== 'settled') throw new Error('Join did not settle');
  expect(view(joined.viewer.state)).toContain('>Leave</button>');
  expect(commands).toBe(1); // Manual refresh never resends the accepted command.
  expect((await change('leave')).outcome).toBe('accepted');
  let observations = 0;
  const left = await refreshRealmMembership(
    async () => {
      if (++observations === 2) state = 'none';
      return read();
    },
    'none',
    { pause },
  );
  expect(left.kind).toBe('settled');
  if (left.kind !== 'settled') throw new Error('Leave did not settle');
  expect(view(left.viewer.state)).toContain('>Join</button>');
  expect(view('none', 'protected')).not.toContain('>Join</button>');
  state = 'member';
  participation = 403;
  const denied = await refreshRealmMembership(read, 'member', { pause });
  expect(denied.kind).toBe('denied');
  expect(view('banned')).not.toContain('>Join</button>');
  for (membershipStatus of [403, 404, 503]) {
    expect(await refreshRealmMembership(read, 'none', { pause })).toEqual({ kind: 'unavailable' });
    expect(view('pending', 'public', 'unavailable')).toContain('current membership is unavailable');
  }
  membershipStatus = 200;
  participation = 503;
  expect(await refreshRealmMembership(read, 'member', { pause })).toEqual({ kind: 'unavailable' });
  commandStatus = 403;
  expect(await change('leave')).toEqual({ outcome: 'refused', detail: 'Native leave denied' });
  commandStatus = 200;
  expect((await change('join')).outcome).toBe('refused'); // A malformed acceptance is not success.
  expect(commands).toBe(4);
});

test('explicit Space unfollow survives visible leave and rejoin; membership never sends a follow write', async () => {
  let state: 'none' | 'member' = 'member';
  let explicitlyUnfollowed = false;
  let following = true;
  const followWrites: string[] = [];
  const follow = () => ({
    targetId: spaceId,
    targetType: 'space',
    state: following ? 'following' : 'unfollowed',
    reason: 'explicit',
    updatedAt: '2026-10-31T07:00:00Z',
  });
  const client = createKernelClient('https://kernel.example.test', {
    fetch: async (input, init) => {
      const next = new Request(input, init);
      const path = new URL(next.url).pathname;
      if (path.startsWith('/v1/follows/')) {
        expect(path).toBe(`/v1/follows/${spaceId}`);
        if (next.method !== 'GET') {
          followWrites.push(next.method);
          expect(next.headers.get('idempotency-key')).toBe(idempotencyKey);
          explicitlyUnfollowed = next.method === 'DELETE';
          following = next.method === 'PUT';
        }
        return Response.json({ follow: follow() });
      }
      if (path.endsWith('/membership')) {
        state = next.method === 'POST' ? 'member' : 'none';
        // The native workflow's explicit-unfollow precedence, represented by this protocol fixture.
        if (state === 'member' && !explicitlyUnfollowed) following = true;
        return Response.json({ workflowId: 'native-membership-workflow' }, { status: 202 });
      }
      if (path.endsWith('/members/me')) return Response.json({ state, since: null });
      expect(path).toBe(`/v1/realms/${realmId}/participation`);
      return new Response(null, { status: 204 });
    },
  });
  expect(await readFollowRecord(client, spaceId, authorization)).toEqual({ state: 'ready', following: true });
  expect(
    await writeFollowRecord(client, request(), {}, { targetId: spaceId, following: false, idempotencyKey }),
  ).toEqual({ ok: true, following: false });
  for (const action of ['leave', 'join'] as const) {
    expect((await requestRealmMembership(client, request(), {}, { realmId, action, idempotencyKey })).outcome).toBe(
      'accepted',
    );
    const result = await refreshRealmMembership(
      () => loadRealmMembership(client, realmId, auth),
      action === 'join' ? 'member' : 'none',
      { pause },
    );
    expect(result.kind).toBe('settled');
    if (result.kind !== 'settled') throw new Error('Membership did not settle');
    expect(view(result.viewer.state)).toContain(action === 'join' ? '>Leave</button>' : '>Join</button>');
    expect(await readFollowRecord(client, spaceId, authorization)).toEqual({ state: 'ready', following: false });
  }
  expect(followWrites).toEqual(['DELETE']);
});
