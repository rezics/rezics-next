import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { bundledRelease } from '@rezics/definitions/bundled';
import { createKernel } from '../../src/http/kernel.ts';
import { actionCatalogue } from '../../src/http/request.ts';
import { GLOBAL_CONTEXT, bootstrapRelease } from '../../src/semantic/definitions.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import type { AccountActor } from '../../src/request/access.ts';
import type { WorkContext } from '../../src/work/registry.ts';
import type { Effect } from '../../src/events/effects.ts';
import type { CloudEvent } from '../../src/events/log.ts';
import { EVENT_TYPES } from '../../src/events/catalogue.ts';
import {
  createNativeRatingCapabilities,
  createRatingModule,
  type RatingCapabilities,
} from '../../src/rating/module.ts';
import { createClassificationBallotRelay } from '../../src/rating/classification-ballot-projector.ts';
import { STANDARD_QUESTION_ID } from '../../src/rating/standard-question.ts';
import { createRealAccess, type RealAccessFixture } from '../semantic/real-access.ts';
import { openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import { configureTestReceiptKeys, testReceiptKeys } from '../support/receipt-keys.ts';
import { stepIdentityEpochBootstrap } from '../../src/semantic/identity-epoch-bootstrap.ts';
import { installIdentityEpochBootstrap } from '../../src/semantic/identity-epoch-bootstrap-install.ts';
import associationRead from '../../src/semantic/classification-association-read.sql';
import { effectiveGlobalSlotFacts } from '../../src/semantic/slots.ts';
import { readCandidateDisclosure } from '../../src/semantic/disclosure.ts';
import { accessCheck } from '../../src/request/access.ts';
import { subjectReadEligibility } from '../../src/semantic/eligibility.ts';
import { withReadTransaction } from '../../src/semantic/read.ts';

const route = 0x5ab1;
const accountId = newId(route);
const actions = [
  'subject:create',
  'subject:read',
  'realm:read',
  'realm:manage',
  'rating:vote',
  'classification_ballot:set',
  'classification_ballot:read_own',
  'classification_ballot:read_aggregate',
];
let actor: AccountActor;
let applicationAccess: ReturnType<RealAccessFixture<'voter'>['access']>;
const tokens = {
  current: 1,
  keys: new Map([[1, new Uint8Array(32).fill(23)]]),
};
const routeKey = new Uint8Array(32).fill(31);
let database: GrowthDatabase;
let access: RealAccessFixture<'voter'>;
let app: ReturnType<typeof createKernel>;
let rating: ReturnType<typeof createRatingModule>;
let capabilities: RatingCapabilities;
let at = new Date(Date.now() + 60_000).toISOString();
let idCalls = 0;
let executions = 0;
let projections = 0;
const questionId = newId(route);

beforeAll(async () => {
  database = await openGrowthDatabase();
  configureTestReceiptKeys(database.pool);
  await installIdentityEpochBootstrap(database.pool);
  await bootstrapRelease(database.pool, bundledRelease);
  access = await createRealAccess(database.admin, { voter: accountId }, actions);
  await access.grant({ route: 0, id: GLOBAL_CONTEXT }, 'voter', 'subject:create');
  const native = createNativeRatingCapabilities({
    clock: () => new Date(at),
    id: () => {
      idCalls++;
      return questionId;
    },
  });
  capabilities = {
    ...native,
    command: (pool, input, execute) => {
      executions++;
      return 'principal' in input ? native.command(pool, input, execute) : native.command(pool, input, execute);
    },
    projectBatch: (pool, input) => {
      projections++;
      return native.projectBatch(pool, input);
    },
  };
  rating = createRatingModule({ pool: database.pool, capabilities });
  app = createKernel({
    pool: database.pool,
    access: access.access,
    tokens,
    routeKey,
    rating: capabilities,
    clock: capabilities.clock,
    receiptKeys: testReceiptKeys(),
    writeRate: access.writeRate,
  });
  applicationAccess = access.access({ actions: actionCatalogue(app), clock: capabilities.clock });
  actor = await applicationAccess.authenticate(access.bearer('voter'), {
    pool: database.pool,
    deadline: Date.now() + 30_000,
  });
});
afterAll(async () => {
  await database?.close();
});

async function request(method: string, path: string, body?: unknown, key = randomUUID(), status = 200) {
  const response = await app.handle(
    new Request(`http://kernel.test${path}`, {
      method,
      headers: {
        authorization: `Bearer ${access.bearer('voter')}`,
        'content-type': 'application/json',
        'idempotency-key': JSON.stringify(key),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  if (response.status !== status) throw new Error(`${response.status}: ${await response.text()}`);
  return response.json();
}
async function subject(body: unknown) {
  const created = (await request('POST', '/v1/subjects', body, randomUUID(), 201)).subject as {
    id: string;
    statements: Record<string, { id: string }[]>;
  };
  while ((await stepIdentityEpochBootstrap(database.pool, partitionOf(routeOf(created.id)!))).state !== 'caught-up') {}
  return created;
}
function application() {
  return rating.application({
    access: applicationAccess,
    tokens,
    routeKey,
  });
}

// The owner factory is exercised through native adapters, with current Access and no global replacements.
test('declared routes, permission contributions and events are the native mounted inventory', () => {
  expect(rating.definition.http).toHaveLength(28);
  for (const declaration of rating.definition.http) {
    const mounted = app.routes.find((route) => route.method === declaration.method && route.path === declaration.path);
    expect(mounted?.hooks.detail?.operationId).toBe(declaration.options.detail.operationId);
    expect(mounted?.hooks.detail?.['x-action']).toBe(declaration.options.detail['x-action']);
  }
  for (const type of Object.keys(rating.definition.events)) expect(EVENT_TYPES()[type]).toBeDefined();
  expect(rating.definition.permissions).toContain('rating:vote');
  expect(rating.definition.permissions).toContain('source_statistic:write');
});

test('vote execution, immutable replay and aggregate delivery use one supplied capability', async () => {
  const target = await subject({
    type: 'schema:Book',
    labels: { en: 'Constructed rating target' },
  });
  const commands = application();
  const input = {
    questionId: STANDARD_QUESTION_ID,
    targetId: target.id,
    units: 12,
  };
  const key = randomUUID();
  const vote = await commands.votes.putVote(actor, input, key);
  expect(vote?.changedAt).toBe(at);
  at = new Date(Date.parse(at) + 60_000).toISOString();
  expect(await commands.votes.putVote(actor, input, key)).toEqual(vote);
  expect(executions).toBeGreaterThanOrEqual(2);
  const effects: Effect[] = [];
  await rating
    .work(async () => '01'.padEnd(64, '0'))
    .register({
      pool: database.pool,
      env: {},
      clock: () => {
        throw new Error('Host clock must not replace the supplied capability');
      },
      addEffects: (entries: Effect[]) => effects.push(...entries),
    } as unknown as WorkContext);
  expect(effects.map((effect) => effect.name)).toEqual(
    rating.definition.work.effects.filter((entry) => !entry.requiresClient).map((entry) => entry.name),
  );
  const row = (
    await database.admin.query(
      `SELECT id,partition_no,epoch,position::text,data,recorded_at::text AS time FROM core.outbox
     WHERE type='com.rezics.rating.vote.changed.v1' AND subject=$1 ORDER BY position DESC LIMIT 1`,
      [accountId],
    )
  ).rows[0]!;
  const event: CloudEvent = {
    specversion: '1.0',
    id: row.id,
    source: `urn:rezics:log:${row.partition_no}.${row.epoch}`,
    type: 'com.rezics.rating.vote.changed.v1',
    subject: accountId,
    time: row.time,
    datacontenttype: 'application/json',
    sequence: row.position.padStart(19, '0'),
    data: row.data,
  };
  const aggregate = effects.find((effect) => effect.name === 'rating_aggregate')!;
  const before = executions;
  await aggregate.run(event);
  const figure = await commands.aggregate({
    questionId: STANDARD_QUESTION_ID,
    populationId: GLOBAL_CONTEXT,
    targetId: target.id,
  });
  expect(figure).toMatchObject({ count: 1, remaining: 4 });
  expect(executions).toBeGreaterThan(before);
  await aggregate.run(event);
  expect(
    await commands.aggregate({
      questionId: STANDARD_QUESTION_ID,
      populationId: GLOBAL_CONTEXT,
      targetId: target.id,
    }),
  ).toEqual(figure);
  const response = await request(
    'GET',
    `/v1/subjects/${target.id}/ratings?question=${STANDARD_QUESTION_ID}&population=${GLOBAL_CONTEXT}`,
  );
  expect(response.figures[0]).toEqual(figure);
  expect(access.readChecks.some((check) => check.action === 'subject:read' && check.resource.id === target.id)).toBe(
    true,
  );
});

test('classification commands and projector use supplied execution without changing their visibility threshold', async () => {
  const concept = await subject({
    type: 'skos:Concept',
    labels: { en: 'Constructed classification' },
  });
  const target = await subject({
    type: 'wd:Q95074',
    labels: { en: 'Constructed character' },
    statements: {
      'schema:gender': [
        {
          property: { id: 'schema:gender' },
          value: { type: 'value', content: concept.id },
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
  const associationId = target.statements['schema:gender']![0]!.id;
  for (const action of [
    'classification_ballot:set',
    'classification_ballot:read_own',
    'classification_ballot:read_aggregate',
  ]) {
    await access.grant({ route: routeOf(target.id)!, id: target.id }, 'voter', action);
  }
  const ballots = application().classifications;
  const association = await associationRead.run(database.admin, {
    route: routeOf(target.id)!,
    subject_id: target.id,
    candidate_id: associationId,
  });
  const check = await accessCheck(
    applicationAccess,
    actor,
    'classification_ballot:set',
    {
      route: routeOf(target.id)!,
      id: target.id,
      eligibility: subjectReadEligibility({ route: routeOf(target.id)!, id: target.id }, 'classification_ballot:set'),
    },
    { pool: database.pool, deadline: Date.now() + 30_000 },
  );
  console.info(
    'classification receiving',
    JSON.stringify(
      await withReadTransaction(database.pool, async (tx) => ({
        association,
        selected: await effectiveGlobalSlotFacts(tx, target.id, 'schema:gender', association!.slotId),
        disclosure: await readCandidateDisclosure(tx, { subject: target.id, candidate: associationId }),
        authorized: await check(tx),
      })),
    ),
  );
  const first = await ballots.set(
    actor,
    {
      subjectId: target.id,
      associationId,
      assessment: 'support',
      falsePositive: false,
    },
    randomUUID(),
  );
  expect(first.delivery).toBe('enqueued');
  expect(await ballots.readOwn(actor, target.id, associationId, Date.now() + 5_000)).toMatchObject({
    assessment: 'support',
  });
  const relay = createClassificationBallotRelay(database.pool, capabilities.clock, capabilities);
  for (const partition of new Set([partitionOf(route), partitionOf(routeOf(target.id)!)])) {
    for (;;) {
      const result = await relay.run(partition);
      if (result.status !== 'read') throw new Error(`Unexpected projection ${result.status}`);
      if (result.envelopes === 0) break;
    }
  }
  expect(projections).toBeGreaterThan(0);
  expect(await ballots.readAggregate(actor, target.id, associationId, Date.now() + 5_000)).toMatchObject({
    state: 'suppressed',
  });
});

test('question identity is allocated inside its command once and replay still requires current manage authority', async () => {
  const realmId = newId(route),
    spaceId = newId(route),
    revisionId = newId(route);
  const tx = await database.admin.connect();
  try {
    await tx.query('BEGIN');
    await tx.query(
      `INSERT INTO community.space(route,space_id,state,head_revision_id,created_at,creator)
    VALUES($1,$2,'active',$3,$4,$5)`,
      [route, spaceId, revisionId, at, accountId],
    );
    await tx.query(
      `INSERT INTO community.space_revision(route,space_id,revision_id,predecessor,title,summary,created_at,author)
    VALUES($1,$2,$3,NULL,'Rating construction','',$4,$5)`,
      [route, spaceId, revisionId, at, accountId],
    );
    await tx.query(
      `INSERT INTO community.realm(route,realm_id,space_id,state,visibility,context_id,head_revision_id,created_at,creator)
    VALUES($1,$2,$3,'active','public',$4,$5,$6,$7)`,
      [route, realmId, spaceId, GLOBAL_CONTEXT, revisionId, at, accountId],
    );
    await tx.query(
      `INSERT INTO community.realm_revision(route,realm_id,revision_id,predecessor,title,summary,visibility,context_id,created_at,author)
    VALUES($1,$2,$3,NULL,'Rating construction','','public',$4,$5,$6)`,
      [route, realmId, revisionId, GLOBAL_CONTEXT, at, accountId],
    );
    await tx.query('COMMIT');
  } finally {
    await tx.query('ROLLBACK');
    tx.release();
  }
  await access.grant({ route, id: realmId }, 'voter', 'realm:manage');
  const commands = application();
  const input = {
    realmId,
    meaning: 'Judge the accuracy of the translation.',
    label: 'Translation accuracy',
    grain: 'release' as const,
    scale: { min: 0, max: 20, displayStep: 2 },
  };
  const key = randomUUID();
  const created = await commands.createQuestion(actor, input, {
    deadline: Date.now() + 5_000,
    idempotencyKey: key,
  });
  expect(created.value.id).toBe(questionId);
  expect(idCalls).toBe(1);
  expect(
    (
      await commands.createQuestion(actor, input, {
        deadline: Date.now() + 5_000,
        idempotencyKey: key,
      })
    ).value,
  ).toEqual(created.value);
  expect(idCalls).toBe(1);
  await access.revoke({ route, id: realmId }, 'voter', 'realm:manage');
  await expect(
    commands.createQuestion(actor, input, {
      deadline: Date.now() + 5_000,
      idempotencyKey: key,
    }),
  ).rejects.toBeDefined();
  expect(idCalls).toBe(1);
});
