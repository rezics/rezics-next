import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { fromPlainText } from '@rezics/document';
import { routeOf } from '../../src/route/route.ts';
import { postPublicationFixture } from './support/post-publication-fixture.ts';
import { observeSql } from './support/sql-observer.ts';

setDefaultTimeout(180_000);
let f: Awaited<ReturnType<typeof postPublicationFixture>>;
let threads: Awaited<ReturnType<typeof f.thread>>[];
const input = { body: fromPlainText('An ordinary post'), licence: 'MIT' };
const key = (): string => crypto.randomUUID();
const path = () => `/v1/boards/${f.board.id}/slowMode`;
async function moderator(method: string, body?: unknown, requestKey = key()) {
  const response = await f.system.kernel.handle(
    new Request(`https://content.test${path()}`, {
      method,
      headers: {
        authorization: `Bearer ${f.system.actors.moderator.bearer}`,
        'content-type': 'application/json',
        'idempotency-key': JSON.stringify(requestKey),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  return { status: response.status, value: (await response.json()) as Record<string, any> };
}
const set = (intervalSeconds: number, requestKey?: string) => moderator('PUT', { intervalSeconds }, requestKey);
const post = (thread = threads[0]!, requestKey = key(), body = input) =>
  f.call('POST', `/v1/threads/${thread.id}/posts`, body, { key: requestKey });

beforeAll(async () => {
  f = await postPublicationFixture();
  threads = [await f.thread(), await f.thread(), await f.thread('draft')];
  // A real explicit action grant, not a role-name or permissive Access adapter.
  await f.pool.query(
    `INSERT INTO access.resource_grant
    (route,resource_id,subject_id,action,valid,transaction_id)
    VALUES ($1,$2,$3,'moderation:takedown','(,)',$2)`,
    [routeOf(f.board.id), f.board.id, f.system.actors.moderator.actor.accountId],
  );
});
afterAll(async () => {
  await f?.close();
});

test('bounded moderator setting, cross-thread concurrent admission, stable retry, replay and ordinary edits', async () => {
  expect((await f.call('GET', path())).value).toEqual({ intervalSeconds: 0, retryAt: null, exempt: false });
  expect((await f.call('PUT', path(), { intervalSeconds: 60 })).status).toBe(403);
  for (const intervalSeconds of [-1, 86401, 0.5]) expect((await set(intervalSeconds)).status).toBe(400);
  const settingKey = key();
  expect((await set(60, settingKey)).status).toBe(200);
  const observer = observeSql(f.pool);
  try {
    const requestKeys = [key(), key()];
    const attempts = await Promise.all([post(threads[0], requestKeys[0]), post(threads[1], requestKeys[1])]);
    expect(attempts.map((r) => r.status).sort()).toEqual([201, 429]);
    const winner = attempts.findIndex((r) => r.status === 201);
    const retryAt = attempts[1 - winner]!.value.retryAt;
    expect(attempts[1 - winner]!.value).toMatchObject({
      code: 'board_slow_mode',
      effect_status: 'not_applied',
      intervalSeconds: 60,
    });
    expect(Date.parse(retryAt)).toBeGreaterThan(Date.now());
    const before = observer.records.length;
    const replay = await post(threads[winner], requestKeys[winner]);
    expect(replay.status).toBe(201);
    expect(replay.value.post.id).toBe(attempts[winner]!.value.post.id);
    expect(
      observer.records.slice(before).filter((r) => r.statement.includes('INSERT INTO content.board_slow_actor')),
    ).toHaveLength(0);
    const deniedStart = observer.records.length;
    expect((await post()).value.retryAt).toBe(retryAt);
    // One setting seek, one attempted reservation and one exact retry point.
    expect(observer.records.slice(deniedStart).filter((r) => r.statement.includes('content.board_slow_'))).toHaveLength(
      3,
    );
    await f.pool.query("UPDATE access.account SET state='suspended' WHERE route=$1 AND account_id=$2", [
      routeOf(f.author.actor.accountId),
      f.author.actor.accountId,
    ]);
    try {
      expect((await post(threads[winner], requestKeys[winner])).status).toBe(403);
    } finally {
      await f.pool.query("UPDATE access.account SET state='active' WHERE route=$1 AND account_id=$2", [
        routeOf(f.author.actor.accountId),
        f.author.actor.accountId,
      ]);
    }

    expect((await f.call('GET', path())).value).toMatchObject({ intervalSeconds: 60, retryAt, exempt: false });
    expect((await f.revise(attempts[winner]!.value.post, {})).status).toBe(429);
    expect((await f.revise(threads[2]!.firstPost, { visibility: 'published' })).status).toBe(429);
    expect(
      (
        await f.call('POST', '/v1/threads', {
          ...input,
          title: 'Another opening',
          subjectIds: [],
          boardId: f.board.id,
          visibility: 'draft',
        })
      ).status,
    ).toBe(429);
    // Another account has its own lane; a draft still reserves that lane.
    expect(
      (await f.call('POST', `/v1/threads/${threads[0]!.id}/posts`, { ...input, visibility: 'draft' }, { other: true }))
        .status,
    ).toBe(201);
    expect((await f.call('POST', `/v1/threads/${threads[1]!.id}/posts`, input, { other: true })).status).toBe(429);
    // Status reports only the actual actor; explicit moderator writes reserve nothing.
    expect((await moderator('GET')).value).toEqual({ intervalSeconds: 60, retryAt: null, exempt: true });
    for (let i = 0; i < 2; i++) {
      const response = await f.system.kernel.handle(
        new Request(`https://content.test/v1/threads/${threads[0]!.id}/posts`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${f.system.actors.moderator.bearer}`,
            'content-type': 'application/json',
            'idempotency-key': JSON.stringify(key()),
          },
          body: JSON.stringify(input),
        }),
      );
      expect(response.status).toBe(201);
    }
    expect((await set(0)).status).toBe(200);
    expect((await post()).status).toBe(201);
    expect((await set(60, settingKey)).value.intervalSeconds).toBe(60); // Original receipt, not a new setting write.
    expect((await f.call('GET', path())).value.intervalSeconds).toBe(0);
  } finally {
    await observer.close();
  }
});

test('late write failure rolls back the reservation; same key can retry and successful replay charges once', async () => {
  // Reset only this fixture board before the independent rollback outcome.
  await f.pool.query('DELETE FROM content.board_slow_actor WHERE route=$1 AND board_id=$2', [
    routeOf(f.board.id),
    f.board.id,
  ]);
  expect((await set(60)).status).toBe(200);
  await f.pool.query(`CREATE FUNCTION public.reject_slow_post() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.type='com.rezics.content.post.created.v1' THEN RAISE EXCEPTION 'slow rollback fault'; END IF; RETURN NEW; END $$`);
  await f.pool.query(
    'CREATE TRIGGER reject_slow_post BEFORE INSERT ON core.outbox FOR EACH ROW EXECUTE FUNCTION public.reject_slow_post()',
  );
  const requestKey = key();
  try {
    expect((await post(threads[0], requestKey)).status).toBe(500);
  } finally {
    await f.pool.query('DROP TRIGGER reject_slow_post ON core.outbox');
    await f.pool.query('DROP FUNCTION public.reject_slow_post()');
  }
  expect((await f.call('GET', path())).value.retryAt).toBeNull();
  expect((await post(threads[0], requestKey)).status).toBe(201);
  expect((await post(threads[0], requestKey)).status).toBe(201);
  const denied = await post();
  expect(denied.status).toBe(429);
  // At the exposed retry boundary, an ordinary request is admitted again.
  await f.system.clock.setCommandTime(denied.value.retryAt);
  expect((await post()).status).toBe(201);
});
