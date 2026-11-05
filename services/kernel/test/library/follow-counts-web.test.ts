import { expect, test } from 'bun:test';

test('Web follow transport uses native receipts and reads persisted edges independently of old acknowledgements', async () => {
  const { createKernelClient } = await import('@rezics/client');
  const { readFollowRecord, sendFollowRecord } = await import('../../../../apps/web/src/library/follow-transport.ts');
  const { createFollowCountsDriver } = await import('./support/follow-counts-driver.ts');
  const native = await createFollowCountsDriver();
  try {
    const f = await native.fixture('person');
    const authorization = `Bearer ${f.follower.credential}`;
    let loseResponse = false;
    const client = createKernelClient('https://kernel.test', {
      fetch: (async (input, init) => {
        const request = new Request(input, init);
        expect(request.headers.get('authorization')).toBe(authorization);
        const url = new URL(request.url);
        const response = await native.request(f.follower.credential, url.pathname + url.search, {
          method: request.method,
          headers: request.headers,
          ...(request.body ? { body: await request.text() } : {}),
        });
        if (loseResponse) {
          loseResponse = false;
          throw new TypeError('Response lost after native commit');
        }
        return response;
      }) as typeof fetch,
    });
    const intent = { targetId: f.target.targetId, following: true, idempotencyKey: crypto.randomUUID() };
    expect(await readFollowRecord(client, intent.targetId, authorization)).toEqual({
      state: 'ready',
      following: false,
    });
    loseResponse = true;
    expect(await sendFollowRecord(client, authorization, intent)).toEqual({ ok: false, reason: 'unavailable' });
    const committed = (await native.inspect(f.follower, f.target)).source;
    expect(committed?.state).toBe('following');
    expect(await sendFollowRecord(client, authorization, intent)).toEqual({ ok: true, following: true });
    expect((await native.inspect(f.follower, f.target)).source).toEqual(committed);
    await native.reconcile(f.follower, f.target);
    const path = `/v1/followCounts/subject/${intent.targetId}`;
    expect(await (await native.request(f.manager.credential, path)).json()).toMatchObject({ followerCount: 1 });
    expect((await native.request(f.other.credential, path)).status).toBe(404);
    expect((await native.request(f.granted.credential, path)).status).toBe(200);
    await native.revokeManagement(f);
    expect((await native.request(f.granted.credential, path)).status).toBe(404);
    const removal = { ...intent, following: false, idempotencyKey: crypto.randomUUID() };
    expect(await sendFollowRecord(client, authorization, removal)).toEqual({ ok: true, following: false });
    // The first receipt still acknowledges Follow, while deliberate return reads the current Unfollow.
    expect(await sendFollowRecord(client, authorization, intent)).toEqual({ ok: true, following: true });
    expect(await readFollowRecord(client, intent.targetId, authorization)).toEqual({
      state: 'ready',
      following: false,
    });
    expect((await native.inspect(f.follower, f.target)).source?.state).toBe('unfollowed');
    await native.reconcile(f.follower, f.target);
    expect(await (await native.request(f.manager.credential, path)).json()).toMatchObject({ followerCount: 0 });
    expect(await (await native.request(f.follower.credential, '/v1/followCounts/outgoing')).json()).toEqual({
      followingCount: 0,
    });
  } finally {
    await native.close();
  }
}, 240_000);
