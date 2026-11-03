import '../../src/http/kernel.ts';
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { fromPlainText } from '@rezics/document';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { postPublicationFixture } from './support/post-publication-fixture.ts';
import { observeSql } from './support/sql-observer.ts';

setDefaultTimeout(180_000);
let f: Awaited<ReturnType<typeof postPublicationFixture>>;
let threads: Awaited<ReturnType<typeof f.thread>>[];

const key = () => crypto.randomUUID();
const path = () => `/v1/boards/${f.board.id}/slowMode`;

async function setSlowMode(intervalSeconds: number) {
  return f.system.kernel.handle(
    new Request(`https://content.test${path()}`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${f.system.actors.moderator.bearer}`,
        'content-type': 'application/json',
        'idempotency-key': JSON.stringify(key()),
      },
      body: JSON.stringify({ intervalSeconds }),
    }),
  );
}

async function post(threadId: string, requestKey: string) {
  return f.call(
    'POST',
    `/v1/threads/${threadId}/posts`,
    { body: fromPlainText('A cross-home reply'), licence: 'MIT' },
    { key: requestKey },
  );
}

beforeAll(async () => {
  f = await postPublicationFixture();
  const used = new Set([partitionOf(routeOf(f.board.id)!)]);
  threads = [];
  while (threads.length < 2) {
    const candidate = await f.thread();
    const home = partitionOf(routeOf(candidate.id)!);
    if (used.has(home)) continue;
    used.add(home);
    threads.push(candidate);
  }
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

test('independent thread homes share admission without a foreign-home write in either post transaction', async () => {
  const boardHome = partitionOf(routeOf(f.board.id)!);
  expect(threads.map((thread) => partitionOf(routeOf(thread.id)!))).toHaveLength(2);
  expect(new Set(threads.map((thread) => partitionOf(routeOf(thread.id)!))).size).toBe(2);
  expect(threads.every((thread) => partitionOf(routeOf(thread.id)!) !== boardHome)).toBe(true);
  expect((await setSlowMode(60)).status).toBe(200);

  const observer = observeSql(f.pool);
  try {
    const requestKeys = [key(), key()];
    const outcomes = await Promise.all(threads.map((thread, index) => post(thread.id, requestKeys[index]!)));
    expect(outcomes.filter((outcome) => outcome.status === 201)).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status !== 201)).toHaveLength(1);
    expect([429, 503]).toContain(outcomes.filter((outcome) => outcome.status !== 201)[0]!.status);

    const transactions = new Map<number, { slow: boolean; post: boolean }>();
    for (const record of observer.records) {
      const statement = record.statement.trim();
      if (/^BEGIN\b/i.test(statement)) transactions.set(record.connectionId, { slow: false, post: false });
      const current = transactions.get(record.connectionId);
      if (current && /\bcontent\.board_slow_(mode|actor|permit)\b/i.test(statement)) current.slow = true;
      if (current && /\b(?:INSERT|UPDATE)\s+content\.(?:post|thread|revision)\b/i.test(statement)) current.post = true;
      if (/^(?:COMMIT|ROLLBACK)\b/i.test(statement)) {
        if (current?.post) expect(current.slow).toBe(false);
        transactions.delete(record.connectionId);
      }
    }

    const winner = outcomes.findIndex((outcome) => outcome.status === 201);
    const replay = await post(threads[winner]!.id, requestKeys[winner]!);
    expect(replay.status).toBe(201);
    expect(replay.value.post.id).toBe(outcomes[winner]!.value.post.id);
  } finally {
    await observer.close();
  }
});
