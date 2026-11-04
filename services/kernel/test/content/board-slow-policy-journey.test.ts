import '../../src/http/kernel.ts';
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { createHash, createHmac } from 'node:crypto';
import { fromPlainText } from '@rezics/document';
import { routeOf } from '../../src/route/route.ts';
import { postPublicationFixture } from './support/post-publication-fixture.ts';
import { observeSql } from './support/sql-observer.ts';

setDefaultTimeout(180_000);

type ActorName = 'author' | 'other' | 'moderator';
let f: Awaited<ReturnType<typeof postPublicationFixture>>;
let threads: Awaited<ReturnType<typeof f.thread>>[];

const path = () => `/v1/boards/${f.board.id}/slowMode`;
const key = () => crypto.randomUUID();

async function call(actor: ActorName, method: string, url: string, body?: unknown, requestKey = key()) {
  const bearer = f.system.actors[actor].bearer;
  const response = await f.system.kernel.handle(
    new Request(`https://content.test${url}`, {
      method,
      headers: {
        authorization: `Bearer ${bearer}`,
        ...(method === 'GET' ? {} : { 'idempotency-key': JSON.stringify(requestKey) }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  return { status: response.status, value: (await response.json()) as Record<string, any> };
}

const set = (intervalSeconds: number, requestKey?: string) =>
  call('moderator', 'PUT', path(), { intervalSeconds }, requestKey);
const read = (actor: ActorName) => call(actor, 'GET', path());
const post = (actor: ActorName, threadId: string) =>
  call(actor, 'POST', `/v1/threads/${threadId}/posts`, {
    body: fromPlainText('A Board slow-mode journey reply'),
    licence: 'MIT',
  });

function actorKey(accountId: string): Buffer {
  return createHmac('sha256', f.system.routeKey).update(`content.board.slow-mode.actor\n${accountId}`).digest();
}

function legacyActorKey(accountId: string): Buffer {
  return createHmac('sha256', f.system.routeKey)
    .update(`content.board.slow-mode\n${f.board.id}\n${accountId}`)
    .digest();
}

async function addActor(key: Buffer) {
  const route = routeOf(f.board.id)!;
  await f.pool.query(
    `INSERT INTO content.board_slow_actor(route,board_id,actor_key,posted_at,next_episode)
     VALUES ($1,$2,$3,NULL,0) ON CONFLICT (route,board_id,actor_key) DO UPDATE SET posted_at=NULL`,
    [route, f.board.id, key],
  );
}

async function addPermit(actor: Buffer, state: 'reserved' | 'in_flight', suffix: string) {
  const route = routeOf(f.board.id)!;
  await f.pool.query(
    `INSERT INTO content.board_slow_permit
       (route,board_id,actor_key,command_key,request_digest,thread_route,command_kind,generation,
        security_episode,interval_seconds,state,recovery_from_state,updated_at,completed_at)
     VALUES ($1,$2,$3,$4,$5,$6,'content.post.create',1,1,300,$7,$8,clock_timestamp(),NULL)`,
    [
      route,
      f.board.id,
      actor,
      createHash('sha256').update(`slow permit key:${suffix}`).digest(),
      createHash('sha256').update(`slow permit digest:${suffix}`).digest(),
      routeOf(threads[0]!.id)!,
      state,
      state,
    ],
  );
}

async function addCompletedHistory(actor: Buffer, from: number, to: number) {
  const count = to - from;
  if (count <= 0) return;
  const commands = Array.from({ length: count }, (_, index) =>
    createHash('sha256')
      .update(`retained slow command:${from + index + 1}`)
      .digest(),
  );
  const digests = Array.from({ length: count }, (_, index) =>
    createHash('sha256')
      .update(`retained slow request:${from + index + 1}`)
      .digest(),
  );
  await f.pool.query(
    `INSERT INTO content.board_slow_permit
       (route,board_id,actor_key,command_key,request_digest,thread_route,command_kind,generation,
        security_episode,interval_seconds,state,recovery_from_state,updated_at,completed_at)
     SELECT $1,$2,$3,entry.command_key,entry.request_digest,$4,'content.post.create',
            $5 + entry.position,1,300,'complete','reserved',clock_timestamp(),clock_timestamp()
     FROM unnest($6::bytea[],$7::bytea[]) WITH ORDINALITY
       AS entry(command_key,request_digest,position)`,
    [routeOf(f.board.id), f.board.id, actor, routeOf(threads[0]!.id), from, commands, digests],
  );
}

async function addUnrelatedReservations(from: number, to: number) {
  const count = to - from;
  if (count <= 0) return;
  const actorKeys = Array.from({ length: count }, (_, index) =>
    createHmac('sha256', f.system.routeKey)
      .update(`slow unrelated actor:${from + index + 1}`)
      .digest(),
  );
  const commandKeys = Array.from({ length: count }, (_, index) =>
    createHash('sha256')
      .update(`slow unrelated command:${from + index + 1}`)
      .digest(),
  );
  const digests = Array.from({ length: count }, (_, index) =>
    createHash('sha256')
      .update(`slow unrelated request:${from + index + 1}`)
      .digest(),
  );
  const route = routeOf(f.board.id)!;
  await f.pool.query(
    `INSERT INTO content.board_slow_actor(route,board_id,actor_key,posted_at,next_episode)
     SELECT $1,$2,actor_key,NULL,0 FROM unnest($3::bytea[]) AS actor_key
     ON CONFLICT (route,board_id,actor_key) DO NOTHING`,
    [route, f.board.id, actorKeys],
  );
  await f.pool.query(
    `INSERT INTO content.board_slow_permit
       (route,board_id,actor_key,command_key,request_digest,thread_route,command_kind,generation,
        security_episode,interval_seconds,state,recovery_from_state,updated_at)
     SELECT $1,$2,entry.actor_key,entry.command_key,entry.request_digest,$3,'content.post.create',1,
            1,300,'reserved','reserved',clock_timestamp()
     FROM unnest($4::bytea[],$5::bytea[],$6::bytea[])
       AS entry(actor_key,command_key,request_digest)`,
    [route, f.board.id, routeOf(threads[0]!.id), actorKeys, commandKeys, digests],
  );
}

beforeAll(async () => {
  f = await postPublicationFixture();
  threads = [await f.thread(), await f.thread()];
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

test('complete policy journey, fresh pending classification and bounded retained-history reads', async () => {
  for (const intervalSeconds of [0, 45, 300, 86400]) {
    const result = await set(intervalSeconds);
    expect(result.status).toBe(200);
    expect(result.value.intervalSeconds).toBe(intervalSeconds);
  }
  for (const body of [{}, { intervalSeconds: -1 }, { intervalSeconds: 86401 }, { intervalSeconds: 45.5 }]) {
    const result = await call('moderator', 'PUT', path(), body);
    expect(result.status).toBe(400);
  }

  const interval = await set(300);
  expect(interval.status).toBe(200);
  expect((await post('other', threads[0]!.id)).status).toBe(201);
  const ordinary = await read('other');
  expect(ordinary.value.admissionState).toBe('interval');
  expect(ordinary.value.exempt).toBe(false);
  expect((await post('other', threads[1]!.id)).status).toBe(429);

  const reservationKey = actorKey(f.system.actors.author.actor.accountId);
  await addActor(reservationKey);
  await addPermit(reservationKey, 'in_flight', 'writer-reservation');
  await f.pool.query('UPDATE content.board_slow_mode SET in_flight_count=1 WHERE route=$1 AND board_id=$2', [
    routeOf(f.board.id),
    f.board.id,
  ]);
  expect((await set(45)).status).toBe(503);
  await f.pool.query('DELETE FROM content.board_slow_permit WHERE route=$1 AND board_id=$2 AND actor_key=$3', [
    routeOf(f.board.id),
    f.board.id,
    reservationKey,
  ]);
  await f.pool.query('UPDATE content.board_slow_mode SET in_flight_count=0 WHERE route=$1 AND board_id=$2', [
    routeOf(f.board.id),
    f.board.id,
  ]);
  expect((await read('moderator')).value.intervalSeconds).toBe(300);

  await set(86400);
  const exempt = await read('moderator');
  expect(exempt.value).toMatchObject({ canChange: true, exempt: true, admissionState: 'ready' });
  expect((await post('moderator', threads[1]!.id)).status).toBe(201);

  const replayKey = key();
  await set(45, replayKey); // The server commits; discard this response as if it was lost.
  await f.pool.query(
    `DELETE FROM access.resource_grant
     WHERE route=$1 AND resource_id=$2 AND subject_id=$3 AND action='moderation:takedown'`,
    [routeOf(f.board.id), f.board.id, f.system.actors.moderator.actor.accountId],
  );
  const replay = await set(45, replayKey);
  expect(replay.status).toBe(200);
  expect(replay.value.intervalSeconds).toBe(45);
  expect((await read('moderator')).value).toMatchObject({ canChange: false, exempt: false });
  expect((await set(300)).status).toBe(403);

  const currentKey = actorKey(f.system.actors.other.actor.accountId);
  const legacyKey = legacyActorKey(f.system.actors.other.actor.accountId);
  await addActor(currentKey);
  await addActor(legacyKey);
  await addPermit(currentKey, 'reserved', 'fresh-current-key');
  await addPermit(legacyKey, 'reserved', 'fresh-legacy-key');
  expect((await read('other')).value.admissionState).toBe('pending');
  await f.pool.query('DELETE FROM content.board_slow_permit WHERE route=$1 AND board_id=$2 AND actor_key=$3', [
    routeOf(f.board.id),
    f.board.id,
    currentKey,
  ]);
  expect((await read('other')).value.admissionState).toBe('pending');
  await f.pool.query('DELETE FROM content.board_slow_permit WHERE route=$1 AND board_id=$2 AND actor_key=$3', [
    routeOf(f.board.id),
    f.board.id,
    legacyKey,
  ]);
  expect((await read('other')).value.admissionState).toBe('ready');

  const measures: { statements: number; responseBytes: number }[] = [];
  let retained = 0;
  for (const size of [256, 1024, 4096]) {
    await addCompletedHistory(currentKey, retained, size);
    retained = size;
    const observer = observeSql(f.pool);
    let result: Awaited<ReturnType<typeof read>>;
    try {
      result = await read('other');
    } finally {
      await observer.close();
    }
    measures.push({
      statements: observer.records.length,
      responseBytes: Buffer.byteLength(JSON.stringify(result!.value)),
    });
  }
  expect(measures[1]!.statements).toBe(measures[0]!.statements);
  expect(measures[2]!.statements).toBe(measures[0]!.statements);
  expect(measures[1]!.responseBytes).toBe(measures[0]!.responseBytes);
  expect(measures[2]!.responseBytes).toBe(measures[0]!.responseBytes);

  let reservations = 0;
  for (const size of [256, 1024, 4096]) {
    await addUnrelatedReservations(reservations, size);
    reservations = size;
    const result = await read('other');
    expect(result.value.admissionState).toBe('ready');
  }
  const plan = await f.pool.query<{ 'QUERY PLAN': string }>(
    `EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
     SELECT (SELECT a.posted_at::text FROM content.board_slow_actor a
             WHERE a.route=$1 AND a.board_id=$2 AND a.actor_key IN ($3,$4)
             ORDER BY a.posted_at DESC NULLS LAST LIMIT 1) AS posted_at,
       EXISTS (SELECT 1 FROM content.board_slow_permit p
               WHERE p.route=$1 AND p.board_id=$2 AND p.actor_key IN ($3,$4)
                 AND p.state IN ('reserved','in_flight','reconciling')) AS pending`,
    [routeOf(f.board.id), f.board.id, currentKey, legacyKey],
  );
  const planText = plan.rows.map((row) => row['QUERY PLAN']).join('\n');
  expect(planText).toContain('board_slow_actor_pkey');
  expect(planText).toContain('board_slow_permit_one_active_actor_idx');
  expect(planText).not.toMatch(/Seq Scan on content\.board_slow_permit/i);
});
