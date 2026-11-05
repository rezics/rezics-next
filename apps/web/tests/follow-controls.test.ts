import { expect, test } from 'bun:test';
import { createKernelClient, withPlatformClosedRecognition } from '@rezics/client';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { FollowControl, followAction } from '../src/library/follow-control';
import {
  loadFollowState,
  readFollowRecord,
  writeFollowRecord,
  type FollowTargetType,
} from '../src/library/follow-records';
import { sendFollowRecord } from '../src/library/follow-transport';

const targetId = '01a17a3b-70ea-712a-9ff7-81fc6a9381b6';
const idempotencyKey = '123e4567-e89b-42d3-a456-426614174000';
const followIdempotencyKey = '123e4567-e89b-42d3-a456-426614174001';
const authorization = 'Bearer current-viewer';
const request = () => new Request('https://site.example.test/action', { method: 'POST', headers: { authorization } });
const follow = (following: boolean, targetType: FollowTargetType = 'subject') => ({
  targetId,
  targetType,
  state: following ? 'following' : 'unfollowed',
  reason: 'explicit',
  updatedAt: '2026-10-31T07:00:00Z',
});

test('raw and wrapped native clients preserve platform closure separately from target denial', async () => {
  for (const wrap of [false, true]) {
    for (const code of ['platform_closed', 'forbidden']) {
      const raw = createKernelClient('https://kernel.example.test', {
        fetch: async () => Response.json({ code }, { status: 403 }),
      });
      const client = wrap ? withPlatformClosedRecognition(raw) : raw;
      const reason = code === 'platform_closed' ? 'closed' : 'forbidden';
      expect(await readFollowRecord(client, targetId, authorization)).toEqual({ state: reason });
      expect(await sendFollowRecord(client, authorization, { targetId, following: true, idempotencyKey })).toEqual({
        ok: false,
        reason,
      });
    }
  }
});

test('the complete assigned visible journey uses actual current native data and preserves its privacy failure and request bounds', async () => {
  const requests: Request[] = [];
  let following = false;
  const client = createKernelClient('https://kernel.example.test', {
    fetch: async (input, init) => {
      const next = new Request(input, init);
      requests.push(next);
      expect(new URL(next.url).pathname).toBe(`/v1/follows/${targetId}`);
      expect(next.headers.get('authorization')).toBe(authorization);
      if (next.method === 'GET') {
        expect(new URL(next.url).searchParams.get('view')).toBe('BASIC');
        return following
          ? Response.json({ follow: follow(true) })
          : Response.json({ code: 'not_found' }, { status: 404 });
      }
      expect(next.headers.get('idempotency-key')).toBe(
        JSON.stringify(next.method === 'PUT' ? followIdempotencyKey : idempotencyKey),
      );
      expect(await next.text()).toBe('');
      following = next.method === 'PUT';
      return Response.json({ follow: follow(following) });
    },
  });
  const absent = await readFollowRecord(client, targetId, authorization);
  expect(followAction(absent, true, true)).toBe('follow');
  expect(
    await writeFollowRecord(client, request(), {}, { targetId, following: true, idempotencyKey: followIdempotencyKey }),
  ).toEqual({ ok: true, following: true });
  const present = await readFollowRecord(client, targetId, authorization);
  expect(present).toEqual({ state: 'ready', following: true });
  expect(followAction(present, false, true)).toBe('remove');
  const html = renderToStaticMarkup(
    createElement(FollowControl, {
      targetId,
      initial: present,
      canFollow: false,
      canRemove: true,
      ready: true,
      write: async () => ({ ok: false, reason: 'unavailable' }),
    }),
  );
  expect(html).toContain('Unfollow');
  expect(html).not.toMatch(/<button[^>]*\sdisabled(?:=|\s|>)/);
  expect(await writeFollowRecord(client, request(), {}, { targetId, following: false, idempotencyKey })).toEqual({
    ok: true,
    following: false,
  });
  expect(requests.map((item) => item.method)).toEqual(['GET', 'PUT', 'GET', 'DELETE']);
  expect(html).not.toContain('followerCount');
});

test('delete-only removal of a known unavailable edge never reads or replaces its target identity', async () => {
  const requests: Request[] = [];
  let attempt = 0;
  const client = createKernelClient('https://kernel.example.test', {
    fetch: async (input, init) => {
      const next = new Request(input, init);
      requests.push(next);
      expect(next.method).toBe('DELETE');
      expect(new URL(next.url).pathname).toBe(`/v1/follows/${targetId}`);
      if (++attempt === 1) throw new TypeError('Response lost');
      return Response.json({ follow: follow(false, 'space') });
    },
  });
  expect(followAction({ state: 'forbidden' }, false, true)).toBe('remove');
  expect(followAction({ state: 'unavailable' }, false, true)).toBe('remove');
  const input = { targetId, following: false, idempotencyKey };
  expect(await writeFollowRecord(client, request(), {}, input)).toEqual({ ok: false, reason: 'unavailable' });
  expect(await writeFollowRecord(client, request(), {}, input)).toEqual({ ok: true, following: false });
  expect(requests.map((item) => item.headers.get('idempotency-key'))).toEqual([
    JSON.stringify(idempotencyKey),
    JSON.stringify(idempotencyKey),
  ]);
});

test('dependency, concealed target, revocation, key conflict and CSRF failures remain failures', async () => {
  let status = 503;
  let code = 'partition_unavailable';
  let reads = 0;
  const client = createKernelClient('https://kernel.example.test', {
    fetch: async () => {
      reads++;
      return Response.json({ code, title: 'Private target title must never escape' }, { status });
    },
  });
  expect(await readFollowRecord(client, targetId, authorization)).toEqual({ state: 'unavailable' });
  const input = { targetId, following: false, idempotencyKey };
  for (const failure of [
    { status: 503, code: 'partition_unavailable', reason: 'unavailable' },
    { status: 404, code: 'not_found', reason: 'invalid' },
    { status: 403, code: 'forbidden', reason: 'forbidden' },
    { status: 422, code: 'idempotency_conflict', reason: 'conflict' },
  ]) {
    status = failure.status;
    code = failure.code;
    expect(await writeFollowRecord(client, request(), {}, input)).toEqual({ ok: false, reason: failure.reason });
  }
  const before = reads;
  const unsafe = new Request('https://site.example.test/action', {
    method: 'POST',
    headers: { cookie: `__Host-rezics_session=${'a'.repeat(43)}`, origin: 'https://other.example.test' },
  });
  expect(await writeFollowRecord(client, unsafe, { SITE_ORIGINS: 'https://site.example.test' }, input)).toEqual({
    ok: false,
    reason: 'forbidden',
  });
  expect(await loadFollowState(client, new Request('https://site.example.test/page'), {}, targetId)).toEqual({
    state: 'signed-out',
  });
  expect(reads).toBe(before);
});

test('a response for another edge or without its identity cannot acknowledge this command', async () => {
  for (const returnedId of [undefined, 'another-target']) {
    const client = createKernelClient('https://kernel.example.test', {
      fetch: async () => Response.json({ follow: { ...follow(true), targetId: returnedId } }),
    });
    expect(await readFollowRecord(client, targetId, authorization)).toEqual({ state: 'unavailable' });
    expect(await writeFollowRecord(client, request(), {}, { targetId, following: true, idempotencyKey })).toEqual({
      ok: false,
      reason: 'unavailable',
    });
  }
});
