import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createAccess } from '../../src/access/index.ts';
import { GLOBAL_CONTEXT } from '../../src/access/gates/catalogue.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { EVENT_TYPES } from '../../src/events/catalogue.ts';
import { createKernel } from '../../src/http/kernel.ts';
import type { AccountActor } from '../../src/request/access.ts';
import { applyRatingChanges } from '../../src/rating/aggregate-effect.ts';
import {
  drainPublicFigures,
  pagePublicFigures,
  readPublicFigures,
  type PublicFigure,
} from '../../src/rating/public-figure.ts';
import { STANDARD_QUESTION_ID } from '../../src/rating/votes.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { readWorkerConfig, startWorker } from '../../src/worker.ts';
import { bootstrapRelease } from '../../src/semantic/definitions.ts';
import { createSubject, subjectTarget } from '../../src/semantic/subject.ts';
import { openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import { workerTestEnv } from '../support/worker-env.ts';

const route = 0x4321;
const figureEvent = 'com.rezics.rating.public_figure.changed.v1';
const at = '2026-10-27T10:00:00.000Z';
let database: GrowthDatabase;

function change(input: {
  targetId: string;
  populationId: string;
  units: number;
  voterId?: string;
  ordinal: number;
  questionId?: string;
}) {
  return {
    voterId: input.voterId ?? newId(route),
    countingKey: input.ordinal.toString(16).padStart(2, '0').padEnd(64, '0'),
    questionId: input.questionId ?? STANDARD_QUESTION_ID,
    populationId: input.populationId,
    targetId: input.targetId,
    units: input.units,
    revision: 1,
    at,
  };
}

async function figureEvents(targetId: string): Promise<PublicFigure[]> {
  const result = await database.admin.query<{ data: unknown }>(
    `SELECT data FROM core.outbox WHERE type = $1 AND subject = $2 ORDER BY position, event_seq`,
    [figureEvent, targetId],
  );
  return result.rows.map(({ data }) => data as PublicFigure);
}

beforeAll(async () => {
  database = await openGrowthDatabase();
});

afterAll(async () => {
  await database?.close();
});

test('a vote change publishes one figure event for each affected population, with mean only at or above the threshold', async () => {
  expect(EVENT_TYPES[figureEvent]).toBeDefined();
  const targetId = newId(route);
  const realmId = newId(0x5321);
  const populations = [GLOBAL_CONTEXT.id, realmId];
  const firstBatch = Array.from({ length: 4 }, (_, index) =>
    populations.map((populationId) =>
      change({ targetId, populationId, units: index * 2, ordinal: index * 2 + (populationId === realmId ? 100 : 1) }),
    ),
  ).flat();
  await applyRatingChanges(database.pool, firstBatch);

  const partition = partitionOf(routeOf(targetId)!);
  expect(await drainPublicFigures(database.pool, partition)).toBe(2);
  const firstEvents = await figureEvents(targetId);
  expect(firstEvents).toHaveLength(2);
  expect(firstEvents.map((event) => event.populationId).sort()).toEqual([...populations].sort());
  for (const event of firstEvents) {
    expect(event).toMatchObject({ questionId: STANDARD_QUESTION_ID, subjectId: targetId, count: 4, mean: null });
    expect(event.score).toBeNull();
    expect(event.priorEpoch).toBeNull();
    expect(event.m).toBeNull();
    expect(event.C).toBeNull();
  }

  await applyRatingChanges(
    database.pool,
    populations.map((populationId, index) => change({ targetId, populationId, units: 8, ordinal: 200 + index })),
  );
  expect(await drainPublicFigures(database.pool, partition)).toBe(2);
  const events = await figureEvents(targetId);
  expect(events).toHaveLength(4);
  for (const event of events.slice(2)) {
    expect(event).toMatchObject({ count: 5, mean: 2, score: null, priorEpoch: null });
  }
});

test('many votes on one subject coalesce into one figure event per drain with an increasing revision', async () => {
  const targetId = newId(route);
  const populationId = GLOBAL_CONTEXT.id;
  const voters = Array.from({ length: 20 }, (_, ordinal) =>
    change({ targetId, populationId, units: ordinal % 21, ordinal: ordinal + 1 }),
  );
  await applyRatingChanges(database.pool, voters);
  const partition = partitionOf(routeOf(targetId)!);
  expect(await drainPublicFigures(database.pool, partition)).toBe(1);

  await applyRatingChanges(
    database.pool,
    Array.from({ length: 10 }, (_, ordinal) => change({ targetId, populationId, units: 6, ordinal: 50 + ordinal })),
  );
  expect(await drainPublicFigures(database.pool, partition)).toBe(1);

  const events = await figureEvents(targetId);
  expect(events).toHaveLength(2);
  expect(events.map((event) => event.revision)).toEqual(['1', '2']);
  expect(events.map((event) => event.count)).toEqual([20, 30]);
  expect(await drainPublicFigures(database.pool, partition)).toBe(0);
});

test('readPublicFigures and pagePublicFigures return the same current figures the events carried, in one statement per call', async () => {
  const targetId = newId(route);
  const populationId = GLOBAL_CONTEXT.id;
  await applyRatingChanges(
    database.pool,
    Array.from({ length: 7 }, (_, ordinal) => change({ targetId, populationId, units: 10, ordinal: ordinal + 1 })),
  );
  const partition = partitionOf(routeOf(targetId)!);
  expect(await drainPublicFigures(database.pool, partition)).toBe(1);
  const event = (await figureEvents(targetId))[0]!;
  expect(event).toBeDefined();

  let statements = 0;
  const client = {
    query(...args: Parameters<GrowthDatabase['pool']['query']>) {
      statements += 1;
      return database.pool.query(...args);
    },
  } as GrowthDatabase['pool'];
  const requested = { partition, questionId: STANDARD_QUESTION_ID, populationId, subjectIds: [targetId] };
  const figures = await readPublicFigures(client, requested);
  expect(statements).toBe(1);
  expect(figures).toEqual([event]);

  statements = 0;
  const page = await pagePublicFigures(client, {
    partition,
    questionId: STANDARD_QUESTION_ID,
    populationId,
    after: null,
    limit: 500,
  });
  expect(statements).toBe(1);
  expect(page.filter(({ subjectId }) => subjectId === targetId)).toEqual([event]);
});

test('Realm-defined questions do not publish public figures', async () => {
  const targetId = newId(route);
  const populationId = GLOBAL_CONTEXT.id;
  const realmQuestionId = newId(route);
  await database.admin.query(
    `INSERT INTO rating.question
       (id, owner_id, revision, label, grain, minimum_units, maximum_units, step_units)
     VALUES ($1, $2, 1, 'Realm question', 'work', 0, 20, 1)`,
    [realmQuestionId, newId(route)],
  );
  await applyRatingChanges(database.pool, [
    change({ targetId, populationId, units: 10, ordinal: 1, questionId: realmQuestionId }),
  ]);
  expect(await drainPublicFigures(database.pool, partitionOf(routeOf(targetId)!))).toBe(0);
  expect(await figureEvents(targetId)).toEqual([]);
});

test('the default worker composition turns real votes into figure events and runs the epoch check and republish', async () => {
  database.pool.options.max = 1;
  await database.admin.query(`DELETE FROM rating.public_figure WHERE question_id = $1 AND population_id = $2`, [
    STANDARD_QUESTION_ID,
    GLOBAL_CONTEXT.id,
  ]);
  await database.admin.query(
    `DELETE FROM rating.population_prior_republish WHERE question_id = $1 AND population_id = $2`,
    [STANDARD_QUESTION_ID, GLOBAL_CONTEXT.id],
  );
  await database.admin.query(
    `DELETE FROM rating.population_prior_epoch WHERE question_id = $1 AND population_id = $2`,
    [STANDARD_QUESTION_ID, GLOBAL_CONTEXT.id],
  );
  await database.admin.query(
    `DELETE FROM rating.population_total_component WHERE question_id = $1 AND population_id = $2`,
    [STANDARD_QUESTION_ID, GLOBAL_CONTEXT.id],
  );
  await database.admin.query(`DELETE FROM rating.aggregate_component WHERE question_id = $1 AND population_id = $2`, [
    STANDARD_QUESTION_ID,
    GLOBAL_CONTEXT.id,
  ]);
  await database.admin.query(`DELETE FROM rating.population_vote WHERE question_id = $1 AND population_id = $2`, [
    STANDARD_QUESTION_ID,
    GLOBAL_CONTEXT.id,
  ]);
  const env = workerTestEnv({
    DATABASE_URL: database.url,
    KERNEL_EXECUTOR_ID: `rating-prior-epoch-${crypto.randomUUID()}`,
  });
  const routeKey = randomBytes(32);
  const ownerId = newId(0x4123);
  const owner: AccountActor = {
    kind: 'account',
    accountId: ownerId,
    clientId: 'rating-prior-epoch-worker',
    scopes: ['subject:read', 'rating:vote'],
    requestedBy: null,
    authnEpoch: 1,
  };
  let app: ReturnType<typeof createKernel>;
  let worker: Awaited<ReturnType<typeof startWorker>> | undefined;
  try {
    await bootstrapRelease(database.pool, bundledRelease);
    const signing = await generateKeyPair('ES256', { extractable: true });
    const jwk = { ...(await exportJWK(signing.publicKey)), kid: 'rating-prior-epoch-worker', alg: 'ES256' };
    app = createKernel({
      pool: database.pool,
      requestDeadlineMs: 30_000,
      writeRate: createWriteRateLimiter({
        secret: 'rating-prior-epoch-worker-secret-32-bytes',
        overrides: JSON.stringify({ 'new-account': { write: { maximum: 1000, seconds: 60 } } }),
      }),
      ratePeer: () => '127.0.0.1',
      routeKey,
      clock: () => new Date(),
      tokens: { current: 1, keys: new Map([[1, new Uint8Array(32).fill(17)]]) },
      access: (config) => {
        const access = createAccess({
          ...config,
          auth: {
            issuer: 'https://auth.rating-prior.test',
            audience: 'https://kernel.rating-prior.test',
            jwksUrl: 'https://auth.rating-prior.test/jwks',
            fetch: async () => Response.json({ keys: [jwk] }),
          },
        });
        access.prepare = async () => undefined;
        access.authorize = async () => true;
        return access;
      },
    });

    const voters = Array.from({ length: 50 }, (_, index) => newId(0x1000 + index * 16));
    for (const voterId of [ownerId, ...voters])
      await database.admin.query(
        `INSERT INTO access.account(route, account_id, kind, state, transaction_id)
         VALUES ($1, $2, 'actor', 'active', $2)`,
        [routeOf(voterId), voterId],
      );
    await database.admin.query(
      `INSERT INTO access.exposure_opening ("group", valid, transaction_id)
       VALUES ('personal_library', tstzrange('2020-01-01T00:00:00Z', NULL, '[)'), $1)`,
      [newId(0x4123)],
    );

    const targets: string[] = [];
    for (const label of ['Prior epoch worker target A', 'Prior epoch worker target B']) {
      const key = crypto.randomUUID();
      const created = await createSubject(database.pool, {
        actor: owner,
        target: subjectTarget(routeKey, ownerId, key),
        idempotencyKey: key,
        digest: createHash('sha256').update(key).digest(),
        item: { type: 'schema:Book', labels: { en: label } },
        release: { digest: bundledDigest, release: bundledRelease },
        authorize: async () => true,
      });
      targets.push(created.subject.id);
    }

    const castVote = async (index: number): Promise<void> => {
      const voterId = voters[index]!;
      const token = await new SignJWT({
        client_id: 'rating-prior-epoch-worker',
        scope: 'subject:read rating:vote',
        authn_epoch: 1,
        auth_time: Math.floor(Date.now() / 1000),
        amr: ['pwd'],
      })
        .setProtectedHeader({ alg: 'ES256', kid: 'rating-prior-epoch-worker', typ: 'at+jwt' })
        .setIssuer('https://auth.rating-prior.test')
        .setAudience('https://kernel.rating-prior.test')
        .setSubject(voterId)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(signing.privateKey);
      const key = JSON.stringify(crypto.randomUUID());
      let response: Response;
      for (let attempt = 0; attempt < 4; attempt += 1) {
        response = await app.handle(
          new Request(
            `http://kernel.test/v1/subjects/${targets[index % targets.length]}/ratings/${STANDARD_QUESTION_ID}/vote`,
            {
              method: 'PUT',
              headers: {
                authorization: `Bearer ${token}`,
                'content-type': 'application/json',
                'idempotency-key': key,
                'x-request-id': 'rating-prior-epoch-worker',
              },
              body: JSON.stringify({ units: 10 }),
            },
          ),
        );
        if (response.status !== 503) break;
        const problem = (await response
          .clone()
          .json()
          .catch(() => null)) as { code?: string; effect_status?: string } | null;
        if (
          !problem ||
          !['deadline_exceeded', 'overloaded'].includes(problem.code ?? '') ||
          problem.effect_status !== 'not_applied'
        )
          break;
        await Bun.sleep(100);
      }
      expect(response!.status, await response!.text()).toBe(200);
    };
    await castVote(0);
    await castVote(1);
    worker = await startWorker(readWorkerConfig(env), undefined, env);

    const initialDeadline = performance.now() + 15_000;
    let initialFigures = new Map<string, PublicFigure>();
    while (performance.now() < initialDeadline) {
      const figures = await database.admin.query<{ subject: string; data: PublicFigure }>(
        `SELECT subject, data FROM core.outbox
         WHERE type = $1 AND subject = ANY($2::text[])
         ORDER BY position, event_seq`,
        [figureEvent, targets],
      );
      initialFigures = new Map(figures.rows.map(({ subject, data }) => [subject, data]));
      if (targets.every((targetId) => initialFigures.get(targetId)?.count === 1)) break;
      await Bun.sleep(10);
    }
    expect(targets.map((targetId) => initialFigures.get(targetId)?.count)).toEqual([1, 1]);

    for (let index = 2; index < voters.length; index += 1) await castVote(index);

    const deadline = performance.now() + 60_000;
    while (performance.now() < deadline) {
      const figures = await database.admin.query<{ subject: string; data: PublicFigure }>(
        `SELECT subject, data FROM core.outbox
         WHERE type = $1 AND subject = ANY($2::text[])
         ORDER BY position, event_seq`,
        [figureEvent, targets],
      );
      const latest = new Map<string, PublicFigure>();
      for (const { subject, data } of figures.rows) latest.set(subject, data);
      if (targets.every((targetId) => latest.get(targetId)?.count === 25 && latest.get(targetId)?.priorEpoch === 1))
        break;
      await Bun.sleep(10);
    }

    const current = await database.admin.query<{ subject: string; data: PublicFigure }>(
      `SELECT subject, data FROM core.outbox
       WHERE type = $1 AND subject = ANY($2::text[])
       ORDER BY position, event_seq`,
      [figureEvent, targets],
    );
    const latest = new Map<string, PublicFigure>();
    for (const { subject, data } of current.rows) latest.set(subject, data);
    expect(targets.map((targetId) => latest.get(targetId))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ count: 25, score: 5, m: 5, C: 5, priorEpoch: 1 }),
        expect.objectContaining({ count: 25, score: 5, m: 5, C: 5, priorEpoch: 1 }),
      ]),
    );
    expect(targets.every((targetId) => current.rows.filter(({ subject }) => subject === targetId).length >= 2)).toBe(
      true,
    );
  } finally {
    await worker?.stop();
  }
}, 120_000);
