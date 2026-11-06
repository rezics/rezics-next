import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import {
  deleteFollow,
  followListQuery,
  followStateOf,
  followWriteHeaders,
  followsList,
  followsPoint,
  getFollowList,
  getFollowPoint,
  putFollow,
} from '../src/library/follow-transport';

const origin = 'https://kernel.example.test';
const targetId = '0192f3a0-6c1e-7b2a-9d4e-000000000001';
const authorization = 'Bearer current-viewer';
const idempotencyKey = '123e4567-e89b-42d3-a456-426614174000';
const edge = {
  targetId,
  targetType: 'subject' as const,
  state: 'following' as const,
  reason: 'explicit' as const,
  updatedAt: '2026-11-06T12:00:00.000Z',
  target: { id: targetId, type: 'schema:Book', label: 'Followed book' },
};

test('list GET and point PUT/GET/DELETE bind distinct Eden callables and recover the acknowledged own edge', async () => {
  const requests: Request[] = [];
  const client = createKernelClient(origin, {
    fetch: async (input, init) => {
      const next = new Request(input, init);
      requests.push(next);
      const url = new URL(next.url);
      if (next.method === 'GET' && url.pathname === '/v1/follows') {
        expect(url.searchParams.get('view')).toBe('FULL');
        expect(url.searchParams.get('limit')).toBe('20');
        expect(url.searchParams.get('cursor')).toBe('opaque/page+');
        expect(url.searchParams.get('targetType')).toBe('subject');
        return Response.json({ follows: [edge], next: null });
      }
      expect(url.pathname).toBe(`/v1/follows/${targetId}`);
      if (next.method === 'GET') {
        expect(url.searchParams.get('view')).toBe('BASIC');
        return Response.json({ follow: edge });
      }
      expect(next.headers.get('idempotency-key')).toBe(idempotencyKey);
      return Response.json({ follow: { ...edge, state: next.method === 'DELETE' ? 'unfollowed' : 'following' } });
    },
  });
  expect(followsPoint(client, targetId)).not.toBe(followsList(client));
  const headers = followWriteHeaders(authorization, idempotencyKey);
  const created = await putFollow(client, targetId, headers);
  expect(followStateOf(created.data, targetId)).toBe('following');
  const replay = await putFollow(client, targetId, headers);
  expect(replay.data).toEqual(created.data);
  expect(followStateOf((await getFollowPoint(client, targetId, authorization)).data, targetId)).toBe('following');
  const page = await getFollowList(client, authorization, followListQuery('opaque/page+', 20, 'subject'));
  expect(page.data).toEqual({ follows: [edge], next: null });
  expect(followStateOf(page.data?.follows[0] ? { follow: page.data.follows[0] } : null, targetId)).toBe('following');
  expect(followStateOf((await deleteFollow(client, targetId, headers)).data, targetId)).toBe('unfollowed');
  expect(requests.map((item) => [item.method, new URL(item.url).pathname, item.headers.get('authorization')])).toEqual([
    ['PUT', `/v1/follows/${targetId}`, authorization],
    ['PUT', `/v1/follows/${targetId}`, authorization],
    ['GET', `/v1/follows/${targetId}`, authorization],
    ['GET', '/v1/follows', authorization],
    ['DELETE', `/v1/follows/${targetId}`, authorization],
  ]);
  expect(followStateOf({ follow: { ...edge, targetId: 'other' } }, targetId)).toBeNull();
});
