import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createRealAccess, type RealAccessFixture } from '../semantic/real-access.ts';
import { suspendAccount } from '../support/native-suspension-driver.ts';
import { openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { bundledRelease } from '@rezics/definitions/bundled';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import {
  classificationBallotCountDelta,
  classificationBallotEnvelopeIsNewer,
  createClassificationBallotRelay,
} from '../../src/rating/classification-ballot-projector.ts';
import type { KeyRing } from '../../src/tokens/seal.ts';
import { Value } from 'typebox/value';
import { EVENT_TYPES } from '../../src/events/catalogue.ts';
import { CLASSIFICATION_AGGREGATE_CHANGED, CLASSIFICATION_BALLOT_CHANGED } from '../../src/rating/events.ts';
import { classificationAggregateView } from '../../src/rating/classification-ballot.ts';

const accounts = {
  voter0: '019a1b2c-3d4e-7f00-8a00-5ab1ec700101',
  voter1: '019a1b2c-3d4e-7f00-8a00-5ab1ec700102',
  voter2: '019a1b2c-3d4e-7f00-8a00-5ab1ec700103',
  voter3: '019a1b2c-3d4e-7f00-8a00-5ab1ec700104',
  voter4: '019a1b2c-3d4e-7f00-8a00-5ab1ec700105',
  voter5: '019a1b2c-3d4e-7f00-8a00-5ab1ec700106',
  moderator: '019a1b2c-3d4e-7f00-8a00-5ab1ec700107',
} as const;
type Persona = keyof typeof accounts;
type TestSubject = { id: string; statements: Record<string, Array<{ id: string }>> };
const actions = [
  'subject:create',
  'subject:read',
  'moderation:hide',
  'classification_ballot:set',
  'classification_ballot:read-own',
  'classification_ballot:read-aggregate',
];
const routeKey = new Uint8Array(32).fill(31);
const tokens: KeyRing = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(23)]]) };
const receiptKeys: KeyRing = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(17)]]) };
let database: GrowthDatabase;
let realAccess: RealAccessFixture<Persona>;
let app: ReturnType<typeof createKernel>;
const consumer = 'rating_classification_ballot';

beforeAll(async () => {
  database = await openGrowthDatabase();
  database.pool.options.max = 1;
  await bootstrapRelease(database.pool, bundledRelease);
  realAccess = await createRealAccess(database.admin, accounts, actions, {
    credentialClock: () => new Date(Date.now() - 1_000),
  });
  app = createKernel({
    pool: database.pool,
    access: realAccess.access,
    tokens,
    receiptKeys,
    routeKey,
    writeRate: realAccess.writeRate,
  });
  await realAccess.grant({ route: 0, id: GLOBAL_CONTEXT }, 'voter0', 'subject:create');
  await realAccess.grant({ route: 0, id: GLOBAL_CONTEXT }, 'moderator', 'moderation:hide');
});

afterAll(async () => {
  await database?.close();
});

function request(persona: Persona, method: string, path: string, body?: unknown, idempotencyKey = randomUUID()) {
  return app.handle(
    new Request(`http://kernel.test${path}`, {
      method,
      headers: {
        authorization: `Bearer ${realAccess.bearer(persona)}`,
        ...(method === 'GET' ? {} : { 'idempotency-key': JSON.stringify(idempotencyKey) }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

async function responseJson(response: Response, status = 200): Promise<Record<string, unknown>> {
  if (response.status !== status)
    throw new Error(`Expected HTTP ${status}, received ${response.status}: ${await response.clone().text()}`);
  return response.json() as Promise<Record<string, unknown>>;
}

async function createSubject(body: Record<string, unknown>): Promise<TestSubject> {
  const result = await responseJson(await request('voter0', 'POST', '/v1/subjects', body), 201);
  return result.subject as TestSubject;
}

async function createCharacter(targetId: string, label: string): Promise<TestSubject> {
  return createSubject({
    type: 'wd:Q95074',
    labels: { en: label },
    statements: {
      'schema:gender': [
        {
          property: { id: 'schema:gender' },
          value: { type: 'value', content: targetId },
          qualifiers: [
            {
              property: { id: 'rezics:spoilerLevel' },
              value: { type: 'value', content: { amount: '+1', unit: '1' } },
            },
          ],
        },
      ],
    },
  });
}

async function setBallot(
  persona: Persona,
  subjectId: string,
  associationId: string,
  assessment: 'support' | 'oppose',
  falsePositive: boolean,
  idempotencyKey = randomUUID(),
) {
  return responseJson(
    await request(
      persona,
      'PUT',
      `/v1/subjects/${subjectId}/classification-associations/${associationId}/assessment`,
      {
        assessment,
        falsePositive,
      },
      idempotencyKey,
    ),
  );
}

async function seedCheckpoint(partition: number): Promise<void> {
  const head = await database.admin.query<{ epoch: number; position: string }>(
    'SELECT epoch, position::text AS position FROM core.partition WHERE partition_no = $1',
    [partition],
  );
  const position = BigInt(head.rows[0]?.position ?? '0');
  const epoch = position === 0n ? null : head.rows[0]!.epoch;
  await database.admin.query(
    `INSERT INTO core.consumer_checkpoint(partition_no, consumer, epoch, position)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (partition_no, consumer) DO UPDATE SET epoch = EXCLUDED.epoch, position = EXCLUDED.position`,
    [partition, consumer, epoch, position.toString()],
  );
}

async function driveWorker(partitions: readonly number[]): Promise<void> {
  const relay = createClassificationBallotRelay(database.pool);
  const homes = [...new Set(partitions)];
  for (let pass = 0; pass < 20; pass++) {
    let delivered = 0;
    for (const partition of homes) {
      const result = await relay.run(partition);
      if (result.status === 'stopped') throw new Error(`Classification ballot relay stopped: ${result.reason}`);
      if (result.status === 'busy') throw new Error('Classification ballot relay is already running');
      delivered += result.envelopes;
    }
    if (delivered === 0) return;
  }
  throw new Error('Classification ballot relay did not catch up');
}

function ballotPath(subjectId: string, associationId: string, suffix: 'assessment' | 'aggregate') {
  return `/v1/subjects/${subjectId}/classification-associations/${associationId}/${suffix}`;
}

async function aggregate(persona: Persona, subjectId: string, associationId: string) {
  return responseJson(await request(persona, 'GET', ballotPath(subjectId, associationId, 'aggregate')));
}

async function ownBallot(persona: Persona, subjectId: string, associationId: string) {
  return responseJson(await request(persona, 'GET', ballotPath(subjectId, associationId, 'assessment')));
}

test('classification ballot updates subtract the retained choice and count false-positive flags independently', () => {
  const support = { assessment: 'support' as const, falsePositive: false, eligible: true };
  expect(classificationBallotCountDelta(support, { ...support, falsePositive: true })).toEqual({
    support: 0,
    oppose: 0,
    falsePositive: 1,
  });
  expect(
    classificationBallotCountDelta(
      { ...support, falsePositive: true },
      {
        assessment: 'oppose',
        falsePositive: true,
        eligible: true,
      },
    ),
  ).toEqual({ support: -1, oppose: 1, falsePositive: 0 });
  expect(classificationBallotCountDelta(support, { assessment: null, falsePositive: false, eligible: true })).toEqual({
    support: -1,
    oppose: 0,
    falsePositive: 0,
  });
  expect(classificationBallotCountDelta(support, { ...support, eligible: false })).toEqual({
    support: -1,
    oppose: 0,
    falsePositive: 0,
  });
});

test('the actor envelope and slot revision reject duplicate or late change-clear-change deliveries', () => {
  const applied = { revision: '3', sourceEpoch: 1, sourcePosition: '20' };
  expect(classificationBallotEnvelopeIsNewer(applied, { revision: '3', epoch: 1, position: 20n })).toBe(false);
  expect(classificationBallotEnvelopeIsNewer(applied, { revision: '2', epoch: 1, position: 19n })).toBe(false);
  expect(classificationBallotEnvelopeIsNewer(applied, { revision: '3', epoch: 1, position: 21n })).toBe(false);
  expect(classificationBallotEnvelopeIsNewer(applied, { revision: '4', epoch: 1, position: 21n })).toBe(true);
  expect(classificationBallotEnvelopeIsNewer(applied, { revision: '4', epoch: 2, position: 1n })).toBe(true);
});

test('small samples disclose no numeric fields and published fractions use support plus oppose only', () => {
  expect(
    classificationAggregateView('association', {
      supportCount: 2,
      opposeCount: 2,
      falsePositiveCount: 1,
      generation: '5',
      asOf: '2026-11-03T00:00:00.000Z',
    }),
  ).toEqual({ associationId: 'association', state: 'suppressed', pending: 'unknown' });
  expect(
    classificationAggregateView('association', {
      supportCount: 2,
      opposeCount: 3,
      falsePositiveCount: 4,
      generation: '6',
      asOf: '2026-11-03T00:00:00.000Z',
    }),
  ).toEqual({
    associationId: 'association',
    state: 'published',
    supportCount: 2,
    opposeCount: 3,
    falsePositiveCount: 4,
    supportFraction: 0.4,
    asOf: '2026-11-03T00:00:00.000Z',
    generation: '6',
    pending: 'unknown',
  });
});

test('classification ballot and aggregate events have registered schemas separate from native ratings', () => {
  expect(
    Value.Check(EVENT_TYPES[CLASSIFICATION_BALLOT_CHANGED]!, {
      actorId: '00000000-0000-8000-8000-000000000001',
      subjectId: '00000000-0000-8000-8000-000000000002',
      associationId: '00000000-0000-8000-8000-000000000003',
      bindingHash: 'a'.repeat(64),
      assessment: 'support',
      falsePositive: false,
      revision: '1',
      eligibilityGeneration: '1',
      eligible: true,
    }),
  ).toBe(true);
  expect(EVENT_TYPES[CLASSIFICATION_AGGREGATE_CHANGED]).toBeDefined();
});

test('mounted classification ballots stay private and converge through the durable worker under current disclosure', async () => {
  const target = await createSubject({ type: 'skos:Concept', labels: { en: 'Native concept' } });
  const subject = await createCharacter(target.id, 'Public classification subject');
  const moderatedSubject = await createCharacter(target.id, 'Moderated classification subject');
  const associationId = subject.statements['schema:gender']![0]!.id;
  const moderatedAssociationId = moderatedSubject.statements['schema:gender']![0]!.id;
  const actorPartition = partitionOf(routeOf(accounts.voter0)!)!;
  const subjectPartition = partitionOf(routeOf(subject.id)!)!;
  const moderatedPartition = partitionOf(routeOf(moderatedSubject.id)!)!;
  const targetPartition = partitionOf(routeOf(target.id)!)!;
  const partitions = [actorPartition, subjectPartition, moderatedPartition, targetPartition];
  for (const partition of new Set(partitions)) await seedCheckpoint(partition);

  const secondary = await setBallot('voter5', moderatedSubject.id, moderatedAssociationId, 'support', false);
  expect(secondary.delivery).toBe('enqueued');
  await driveWorker(partitions);
  expect(await aggregate('voter5', moderatedSubject.id, moderatedAssociationId)).toEqual({
    associationId: moderatedAssociationId,
    state: 'suppressed',
    pending: 'unknown',
  });
  expect(
    (
      await request('moderator', 'POST', `/v1/subjects/${moderatedSubject.id}:hide`, {
        reason: 'Hide this association subject for the privacy check.',
      })
    ).status,
  ).toBe(200);
  const moderatedPublic = await request(
    'voter5',
    'GET',
    ballotPath(moderatedSubject.id, moderatedAssociationId, 'aggregate'),
  );
  const moderatedOwn = await request(
    'voter5',
    'GET',
    ballotPath(moderatedSubject.id, moderatedAssociationId, 'assessment'),
  );
  expect(moderatedPublic.status).toBe(404);
  expect(moderatedOwn.status).toBe(404);

  const firstKey = randomUUID();
  expect((await setBallot('voter0', subject.id, associationId, 'support', false, firstKey)).delivery).toBe('enqueued');
  expect(await ownBallot('voter0', subject.id, associationId)).toEqual({
    associationId,
    hasBallot: true,
    assessment: 'support',
    falsePositive: false,
    revision: '1',
    pending: true,
  });
  expect(await ownBallot('voter3', subject.id, associationId)).toEqual({
    associationId,
    hasBallot: false,
    assessment: null,
    falsePositive: false,
    revision: null,
    pending: false,
  });
  for (const [persona, assessment, falsePositive] of [
    ['voter1', 'support', true],
    ['voter2', 'support', false],
    ['voter3', 'oppose', true],
  ] as const)
    await setBallot(persona, subject.id, associationId, assessment, falsePositive);
  await driveWorker(partitions);
  expect(await aggregate('voter3', subject.id, associationId)).toEqual({
    associationId,
    state: 'suppressed',
    pending: 'unknown',
  });

  await setBallot('voter4', subject.id, associationId, 'oppose', false);
  await driveWorker(partitions);
  const fiveBallots = await aggregate('voter4', subject.id, associationId);
  expect(fiveBallots).toMatchObject({
    state: 'published',
    supportCount: 3,
    opposeCount: 2,
    falsePositiveCount: 2,
    supportFraction: 0.6,
    pending: 'unknown',
    generation: expect.any(String),
    asOf: expect.any(String),
  });

  await setBallot('voter5', subject.id, associationId, 'support', true);
  await driveWorker(partitions);
  const sixBallots = await aggregate('voter5', subject.id, associationId);
  expect(sixBallots).toMatchObject({
    state: 'published',
    supportCount: 4,
    opposeCount: 2,
    falsePositiveCount: 3,
    supportFraction: 2 / 3,
  });

  const changed = await setBallot('voter0', subject.id, associationId, 'oppose', true);
  expect(changed).toEqual({ associationId, revision: '2', delivery: 'enqueued' });
  expect(await ownBallot('voter0', subject.id, associationId)).toMatchObject({
    hasBallot: true,
    assessment: 'oppose',
    falsePositive: true,
    revision: '2',
    pending: true,
  });
  expect(await aggregate('voter0', subject.id, associationId)).toEqual(sixBallots);
  expect(await setBallot('voter0', subject.id, associationId, 'oppose', true)).toEqual({
    associationId,
    revision: '2',
    delivery: 'unchanged',
  });
  await driveWorker(partitions);
  const changedAggregate = await aggregate('voter0', subject.id, associationId);
  expect(changedAggregate).toMatchObject({
    state: 'published',
    supportCount: 3,
    opposeCount: 3,
    falsePositiveCount: 4,
    supportFraction: 0.5,
  });
  expect((await ownBallot('voter0', subject.id, associationId)).pending).toBe(false);

  const firstEvent = await database.admin.query<{ position: string; epoch: number }>(
    `SELECT position::text AS position, epoch FROM core.outbox
     WHERE partition_no = $1 AND type = $2 AND data->>'actorId' = $3
       AND data->>'subjectId' = $4 AND data->>'associationId' = $5
     ORDER BY position LIMIT 1`,
    [actorPartition, CLASSIFICATION_BALLOT_CHANGED, accounts.voter0, subject.id, associationId],
  );
  expect(firstEvent.rows).toHaveLength(2);
  const replayFrom = BigInt(firstEvent.rows[0]!.position) - 1n;
  await database.admin.query(
    `UPDATE core.consumer_checkpoint SET epoch = $3, position = $4
     WHERE partition_no = $1 AND consumer = $2`,
    [actorPartition, consumer, replayFrom === 0n ? null : firstEvent.rows[0]!.epoch, replayFrom.toString()],
  );
  await driveWorker(partitions);
  expect(await aggregate('voter0', subject.id, associationId)).toEqual(changedAggregate);

  await suspendAccount(database.admin, accounts.voter1);
  await driveWorker(partitions);
  expect(await aggregate('voter0', subject.id, associationId)).toEqual({
    associationId,
    state: 'suppressed',
    pending: 'unknown',
  });
  const suspendedWrite = await request('voter1', 'PUT', ballotPath(subject.id, associationId, 'assessment'), {
    assessment: 'oppose',
    falsePositive: false,
  });
  expect([401, 403]).toContain(suspendedWrite.status);
  await suspendAccount(database.admin, accounts.voter2);
  await driveWorker(partitions);

  await request('moderator', 'POST', `/v1/subjects/${target.id}:hide`, {
    reason: 'Hide the classification target for the disclosure check.',
  }).then(async (response) => expect(response.status).toBe(200));
  const hiddenAggregate = await request('voter0', 'GET', ballotPath(subject.id, associationId, 'aggregate'));
  const hiddenOwn = await request('voter0', 'GET', ballotPath(subject.id, associationId, 'assessment'));
  const unknown = await request('voter0', 'GET', ballotPath(subject.id, newId(routeOf(subject.id)!), 'aggregate'));
  expect(hiddenAggregate.status).toBe(404);
  expect(hiddenOwn.status).toBe(404);
  expect(unknown.status).toBe(404);
  const publicProblem = await hiddenAggregate.json();
  const ownProblem = await hiddenOwn.json();
  const unknownProblem = await unknown.json();
  for (const field of ['type', 'title', 'status', 'code', 'retryable', 'effect_status']) {
    expect(publicProblem[field]).toBe(unknownProblem[field]);
    expect(ownProblem[field]).toBe(unknownProblem[field]);
  }
  const revokedReplay = await request(
    'voter0',
    'PUT',
    ballotPath(subject.id, associationId, 'assessment'),
    { assessment: 'support', falsePositive: false },
    firstKey,
  );
  expect(revokedReplay.status).toBe(404);
  expect((await request('voter3', 'DELETE', ballotPath(subject.id, associationId, 'assessment'))).status).toBe(204);
  await driveWorker(partitions);
  const withdrawn = await database.admin.query<{ assessment: string | null; revision: string }>(
    `SELECT assessment, revision::text AS revision FROM rating.classification_ballot
     WHERE route = $1 AND actor_id = $2 AND subject_id = $3 AND association_id = $4`,
    [routeOf(accounts.voter3), accounts.voter3, subject.id, associationId],
  );
  expect(withdrawn.rows).toEqual([{ assessment: null, revision: '2' }]);
});
