import { afterAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { fromPlainText } from '@rezics/document';
import { bundledRelease } from '@rezics/definitions/bundled';
import { PLATFORM_RESOURCE } from '../../src/access/bootstrap-governance.ts';
import { threadTarget } from '../../src/content/commands.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { createNativeContentSystem, type NativeContentSystem } from './support/native-system.ts';

let system: NativeContentSystem | undefined;
let app: NativeContentSystem['kernel'];
let db: NativeContentSystem['database']['pool'];

type Scenario = {
  route: number;
  actorId: string;
  governorId: string;
  threadId: string;
  postId: string;
  ownerValid: string;
  actorToken: string;
  governorToken: string;
};

afterAll(async () => {
  await system?.close();
});

async function setup<T>(
  bearer: string,
  path: string,
  body: unknown,
  status = 201,
  method = 'POST',
  head?: string,
  key = randomUUID(),
): Promise<T> {
  const response = await app.handle(
    new Request(`https://content.test${path}`, {
      method,
      headers: {
        authorization: `Bearer ${bearer}`,
        'content-type': 'application/json',
        'idempotency-key': JSON.stringify(key),
        ...(head === undefined ? {} : { 'if-match': JSON.stringify(head) }),
      },
      body: JSON.stringify(body),
    }),
  );
  const wire = await response.text();
  if (response.status !== status) throw new Error(`${method} ${path}: ${response.status} ${wire}`);
  return JSON.parse(wire) as T;
}

async function fixture(): Promise<Scenario> {
  await system?.close();
  system = await createNativeContentSystem({ databaseUrl: process.env.DATABASE_URL! });
  app = system.kernel;
  db = system.database.pool;
  await bootstrapRelease(system.database.pool, bundledRelease);

  const actor = system.actors.author;
  const actorId = actor.actor.accountId;
  const governorId = (await db.query('SELECT account_id FROM access.governance_bootstrap')).rows[0]!
    .account_id as string;
  const governor = await system.auth.issue({
    accountId: governorId,
    clientId: system.auth.ordinaryClient.id,
    scopes: [...system.actions.keys()].filter((action) => action !== 'media:complete'),
  });
  const actorToken = actor.bearer;
  const governorToken = governor.bearer;

  await setup(governorToken, '/v1/grants', {
    resource: PLATFORM_RESOURCE,
    subject: { kind: 'account', id: actorId },
    actions: ['access:grant'],
    valid: '(,)',
  });
  await setup(actorToken, '/v1/grants', {
    resource: { route: routeOf(actorId)!, id: actorId },
    subject: { kind: 'account', id: governorId },
    actions: ['account:read'],
    valid: '(,)',
  });

  const scheme = await setup<{ subject: { id: string } }>(actorToken, '/v1/subjects', {
    type: 'skos:ConceptScheme',
    labels: { en: 'Author erasure replay fixture' },
  });
  const concept = await setup<{ subject: { id: string } }>(actorToken, '/v1/subjects', {
    type: 'skos:Concept',
    labels: { en: 'Author erasure replay board' },
    statements: {
      'skos:inScheme': [{ property: { id: 'skos:inScheme' }, value: { type: 'value', content: scheme.subject.id } }],
    },
  });
  const space = await setup<{ space: { spaceId: string } }>(actorToken, '/v1/spaces', {
    title: 'Author erasure replay fixture',
  });
  const realm = await setup<{ realm: { realmId: string; headRevisionId: string } }>(actorToken, '/v1/realms', {
    spaceId: space.space.spaceId,
    title: 'Author erasure replay fixture',
    visibility: 'public',
    contextId: GLOBAL_CONTEXT,
  });
  await setup(
    actorToken,
    `/v1/realms/${realm.realm.realmId}/boardScheme`,
    { schemeId: scheme.subject.id },
    200,
    'PUT',
    realm.realm.headRevisionId,
  );
  const board = await setup<{ board: { id: string } }>(actorToken, `/v1/realms/${realm.realm.realmId}/boards`, {
    conceptId: concept.subject.id,
    title: 'Author erasure replay fixture',
    visibility: 'published',
  });

  let threadKey = randomUUID();
  while (partitionOf(threadTarget(system.routeKey, actorId, threadKey).route) === partitionOf(routeOf(actorId)!))
    threadKey = randomUUID();
  const thread = await setup<{ thread: { id: string; firstPost: { id: string } } }>(
    actorToken,
    '/v1/threads',
    {
      title: 'Author erasure replay fixture',
      body: fromPlainText('A real authored post for replay authority checks.'),
      licence: 'CC0-1.0',
      subjectIds: [],
      boardId: board.board.id,
      visibility: 'published',
    },
    201,
    'POST',
    undefined,
    threadKey,
  );
  const threadId = thread.thread.id;
  const postId = thread.thread.firstPost.id;
  const route = routeOf(threadId)!;
  if (partitionOf(route) === partitionOf(routeOf(actorId)!))
    throw new Error('Scenario account and content must have independent command slots');

  await setup(actorToken, '/v1/grants', {
    resource: { route, id: postId },
    subject: { kind: 'account', id: governorId },
    actions: ['post:read', 'post:revise', 'media:create'],
    valid: '(,)',
  });

  await setup(
    actorToken,
    '/v1/grants:revoke',
    {
      resource: PLATFORM_RESOURCE,
      subject: { kind: 'account', id: actorId },
      actions: ['access:grant'],
      valid: '(,)',
    },
    200,
  );

  return {
    route,
    actorId,
    governorId,
    threadId,
    postId,
    ownerValid: (
      await db.query(
        "SELECT valid::text FROM access.resource_role_grant WHERE route=$1 AND resource_id=$2 AND subject_id=$3 AND grant_role='content.post.owner'",
        [route, postId, actorId],
      )
    ).rows[0]!.valid as string,
    actorToken: (
      await system.auth.issue({
        accountId: actorId,
        clientId: system.auth.ordinaryClient.id,
        scopes: ['account:read', 'access:grant', 'post:erase'],
      })
    ).bearer,
    governorToken,
  };
}

async function call(scenario: Scenario, method: string, path: string, body?: unknown, key: string = randomUUID()) {
  return app.handle(
    new Request(`https://content.test${path}`, {
      method,
      headers: {
        authorization: `Bearer ${scenario.actorToken}`,
        ...(method === 'GET' ? {} : { 'idempotency-key': JSON.stringify(key) }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

async function accountRead(scenario: Scenario, present: boolean) {
  await setup(
    scenario.governorToken,
    `/v1/grants${present ? '' : ':revoke'}`,
    {
      resource: { route: routeOf(scenario.actorId)!, id: scenario.actorId },
      subject: { kind: 'account', id: scenario.actorId },
      actions: ['account:read'],
      valid: '(,)',
    },
    present ? 201 : 200,
  );
}

async function postErase(scenario: Scenario, present: boolean) {
  await call({ ...scenario, actorToken: scenario.governorToken }, 'POST', `/v1/roleGrants${present ? '' : ':revoke'}`, {
    resource: { route: scenario.route, id: scenario.postId },
    subject: { kind: 'account', id: scenario.actorId },
    role: 'content.post.owner',
    valid: scenario.ownerValid,
  }).then(async (response) => {
    const expected = present ? 201 : 200;
    const wire = await response.text();
    if (response.status !== expected) throw new Error(`post erase role change: ${response.status} ${wire}`);
  });
}

async function effects(scenario: Scenario) {
  const partition = partitionOf(scenario.route);
  const [position, receipts, outbox, operations] = await Promise.all([
    db.query('SELECT * FROM core.partition WHERE partition_no=$1', [partition]),
    db.query('SELECT * FROM core.receipt WHERE partition_no=$1 ORDER BY idempotency_key', [partition]),
    db.query('SELECT * FROM core.outbox WHERE partition_no=$1 ORDER BY position,event_seq', [partition]),
    db.query('SELECT * FROM content.operation WHERE route=$1 ORDER BY operation_id', [scenario.route]),
  ]);
  return {
    position: position.rows,
    receipts: receipts.rows,
    outbox: outbox.rows,
    operations: operations.rows,
  };
}

const startPath = (scenario: Scenario) => `/v1/threads/${scenario.threadId}:erase`;
const startBody = (scenario: Scenario) => ({ authorId: scenario.actorId });
const statusPath = (operationId: string) => `/v1/operations/${operationId}`;

async function startedOperation(scenario: Scenario, key: string) {
  const response = await call(scenario, 'POST', startPath(scenario), startBody(scenario), key);
  const wire = await response.text();
  if (response.status !== 202) throw new Error(`author erase start: ${response.status} ${wire}`);
  const payload = JSON.parse(wire) as { name: string };
  return { wire, operationId: payload.name.slice('operations/'.length) };
}

test('author erasure replay requires current account read on the initiator account', async () => {
  const scenario = await fixture();
  const key = `author-erasure-self-read-${randomUUID()}`;
  const started = await startedOperation(scenario, key);
  const visible = await call(scenario, 'GET', statusPath(started.operationId));
  expect(visible.status).toBe(200);

  await accountRead(scenario, false);
  const before = await effects(scenario);
  const replay = await call(scenario, 'POST', startPath(scenario), startBody(scenario), key);
  const wire = await replay.text();
  expect(replay.status).toBe(403);
  expect(JSON.parse(wire).code).toBe('forbidden');
  expect(await effects(scenario)).toEqual(before);
});

test('author erasure replay requires current post erase on the anchor post', async () => {
  const scenario = await fixture();
  const key = `author-erasure-post-erase-${randomUUID()}`;
  const started = await startedOperation(scenario, key);
  const visible = await call(scenario, 'GET', statusPath(started.operationId));
  expect(visible.status).toBe(200);

  await postErase(scenario, false);
  const before = await effects(scenario);
  const replay = await call(scenario, 'POST', startPath(scenario), startBody(scenario), key);
  const wire = await replay.text();
  expect(replay.status).toBe(403);
  expect(JSON.parse(wire).code).toBe('forbidden');
  expect(await effects(scenario)).toEqual(before);
});

test('author erasure replay preserves the original 202 and a fresh authorized start creates one operation', async () => {
  const scenario = await fixture();
  const firstKey = `author-erasure-both-${randomUUID()}`;
  const started = await startedOperation(scenario, firstKey);
  const beforeReplay = await effects(scenario);

  const replay = await call(scenario, 'POST', startPath(scenario), startBody(scenario), firstKey);
  expect(replay.status).toBe(202);
  expect(await replay.text()).toBe(started.wire);
  expect(await effects(scenario)).toEqual(beforeReplay);

  const freshKey = `author-erasure-fresh-${randomUUID()}`;
  const fresh = await startedOperation(scenario, freshKey);
  expect(fresh.operationId).not.toBe(started.operationId);
  expect((await effects(scenario)).operations).toHaveLength(2);
});
