import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFeed } from '../../../services/main/src/modules/feed/read.ts';
import { WorkReadMoved, WorkReadSession, workRead } from '../../../services/main/src/modules/work/read-session.ts';
import { seedHome, startHomeStack } from './feed-read-support.ts';
import { cloneQaOwnerDatabases } from '../support/fake-delivery.ts';

test('G-593: All matches followed cards once and fences their inventory; Following keeps its cursor head', async () => {
  const databases = await cloneQaOwnerDatabases(Bun.env.REZICS_QA_RUN_ID!, ['access', 'content', 'relay']);
  const original = [Bun.env.ACCESS_DATABASE_URL, Bun.env.CONTENT_DATABASE_URL, Bun.env.ACCOUNT_RELAY_DATABASE_URL];
  let home: Awaited<ReturnType<typeof startHomeStack>>;
  try {
    // The projection inventory belongs to this file, and its relay starts
    // immediately before this file's commands rather than replaying the shard.
    [Bun.env.ACCESS_DATABASE_URL, Bun.env.CONTENT_DATABASE_URL, Bun.env.ACCOUNT_RELAY_DATABASE_URL] =
      [databases.urls.access, databases.urls.content, databases.urls.relay];
    home = await startHomeStack('g-593-follow-fence', { projectionStart: 'current' });
  } catch (error) { await databases.close(); throw error; }
  finally {
    [Bun.env.ACCESS_DATABASE_URL, Bun.env.CONTENT_DATABASE_URL, Bun.env.ACCOUNT_RELAY_DATABASE_URL] = original;
  }
  const openFrame = home.deps.feed.openFrame.bind(home.deps.feed);
  try {
    const seeded = await seedHome(home);
    expect(await home.json(await home.call('GET', '/health/feed-ready'))).toMatchObject({
      status: 'ready', targets: { status: 'current' },
    });
    const request = new Request('http://main.local/v1/feed', {
      headers: { authorization: `Bearer ${home.reader.token}` } });
    const principal = await home.deps.account.verify(request);
    // Home hydrates public cards; the separate reader binds private preferences.
    const publicRequest = new Request('http://main.local/v1/feed');
    const liveSession = () => workRead(home.deps, publicRequest, {}, async session => session);
    const reader = { principal, agent: seeded.reader };
    const calls: number[] = [];
    let observedScope: 'all' | 'following' = 'all';
    let changeDuringMatch = false;
    // Home matches inside its Access frame, not FollowsStore.matches. Observe
    // the actual card batch and closing inventory fence. Following also reads
    // the opening inventory head before it validates a continuation.
    home.deps.feed.openFrame = async (...args) => {
      const frame = await openFrame(...args);
      if (observedScope === 'following') calls.push(0);
      const cardAccess = frame.cardAccess.bind(frame), close = frame.close.bind(frame);
      frame.cardAccess = async (...cardArgs) => {
        calls.push(cardArgs[1].length);
        const result = await cardAccess(...cardArgs);
        if (changeDuringMatch && cardArgs[1].length) {
          await home.stack.accessPool.query('UPDATE access.follow_inventory SET revision = $2 WHERE principal_id = $1',
            [home.reader.principalId, randomUUID()]);
        }
        return result;
      };
      frame.close = async () => { calls.push(0); return close(); };
      return frame;
    };
    for (const sort of ['best', 'top'] as const) {
      calls.length = 0;
      const page = await workRead(home.deps, publicRequest, {}, session =>
        readFeed(session, { scope: 'all', sort }, reader));
      expect(page.items.length).toBeGreaterThanOrEqual(5);
      // Realm follows are stored against their owning Space; card reasons use
      // that canonical target rather than the submitted capability alias.
      expect(page.items.some(item => item.reason.kind === 'followed'
        && [seeded.realm.space, seeded.works[1]!.work].includes(item.reason.target))).toBe(true);
      expect(calls).toHaveLength(2);
      expect(calls[0]).toBeGreaterThan(0);
      expect(calls[1]).toBe(0);
    }
    observedScope = 'following';
    const following = await workRead(home.deps, publicRequest, {}, session =>
      readFeed(session, { scope: 'following', sort: 'best', limit: 1 }, reader));
    expect(following.nextCursor).not.toBeNull();
    const continuation = { scope: 'following' as const, sort: 'best' as const,
      limit: 1, cursor: following.nextCursor! };
    await workRead(home.deps, publicRequest, {}, session => readFeed(session, continuation, reader));
    await home.stack.accessPool.query('UPDATE access.follow_inventory SET revision = $2 WHERE principal_id = $1',
      [home.reader.principalId, randomUUID()]);
    calls.length = 0;
    const cursorSession = await liveSession();
    await expect(readFeed(new WorkReadSession(home.deps, publicRequest, {}, cursorSession.position),
      continuation, reader)).rejects.toBeInstanceOf(WorkReadMoved);
    // The inventory head rejects a stale continuation before card matching.
    expect(calls).toEqual([0]);
    // A live, unfenced graph read with unchanged owners must reach the closing
    // inventory check rather than fail on unrelated author presentation data.
    observedScope = 'all';
    calls.length = 0;
    const stableSession = await liveSession();
    const stable = await readFeed(new WorkReadSession(home.deps, publicRequest, {}, stableSession.position),
      { scope: 'all', sort: 'best' }, reader);
    expect(stable.items.length).toBeGreaterThanOrEqual(5);
    expect(calls).toHaveLength(2);
    // A follow change after the card-match batch must never return stale reasons.
    changeDuringMatch = true;
    for (const scope of ['all', 'following'] as const) {
      observedScope = scope;
      calls.length = 0;
      // Capture the live graph position, independently of the retained feed
      // checkpoint, then bypass retries so this injected follow race is observed.
      const session = await liveSession();
      await expect(readFeed(new WorkReadSession(home.deps, publicRequest, {}, session.position),
        { scope, sort: 'best' }, reader))
        .rejects.toBeInstanceOf(WorkReadMoved);
      expect(calls).toHaveLength(scope === 'all' ? 2 : 3);
      expect(calls.at(-1)).toBe(0);
    }
  } finally {
    home.deps.feed.openFrame = openFrame;
    try { await home.stop(); } finally { await databases.close(); }
  }
}, 120_000);
