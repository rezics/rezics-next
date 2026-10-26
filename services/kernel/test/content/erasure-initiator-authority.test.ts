import { afterAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { fromPlainText } from '@rezics/document';
import { bundledRelease } from '@rezics/definitions/bundled';
import { PLATFORM_RESOURCE } from '../../src/access/bootstrap-governance.ts';
import { threadTarget } from '../../src/content/commands.ts';
import { SESSION_HEADER } from '../../src/http/request.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { createNativeContentSystem, type NativeContentSystem } from './support/native-system.ts';

let system: NativeContentSystem;
let app: NativeContentSystem['kernel'];
let db: { admin: NativeContentSystem['database']['pool'] };

type Scenario = {
  route: number;
  actorId: string;
  governorId: string;
  threadId: string;
  postId: string;
  revisionId: string;
  ownerValid: string;
  boardId: string;
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
  // Each scenario owns its accounts, Global grants, content and command slots.
  await system?.close();
  system = await createNativeContentSystem({ databaseUrl: process.env.DATABASE_URL! });
  app = system.kernel;
  db = { admin: system.database.pool };
  await bootstrapRelease(db.admin, bundledRelease);
  const actor = system.actors.author;
  const actorId = actor.actor.accountId;
  const governorId = (await db.admin.query('SELECT account_id FROM access.governance_bootstrap')).rows[0]!
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
  // Retain a separate holder so public grant administration can restore self-read.
  await setup(actorToken, '/v1/grants', {
    resource: { route: routeOf(actorId)!, id: actorId },
    subject: { kind: 'account', id: governorId },
    actions: ['account:read'],
    valid: '(,)',
  });
  const scheme = await setup<{ subject: { id: string } }>(actorToken, '/v1/subjects', {
    type: 'skos:ConceptScheme',
    labels: { en: 'Erasure fixture' },
  });
  const concept = await setup<{ subject: { id: string } }>(actorToken, '/v1/subjects', {
    type: 'skos:Concept',
    labels: { en: 'Erasure board' },
    statements: {
      'skos:inScheme': [{ property: { id: 'skos:inScheme' }, value: { type: 'value', content: scheme.subject.id } }],
    },
  });
  const space = await setup<{ space: { spaceId: string } }>(actorToken, '/v1/spaces', { title: 'Erasure fixture' });
  const realm = await setup<{ realm: { realmId: string; headRevisionId: string } }>(actorToken, '/v1/realms', {
    spaceId: space.space.spaceId,
    title: 'Erasure fixture',
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
    title: 'Erasure fixture',
    visibility: 'published',
  });
  let threadKey = randomUUID();
  while (partitionOf(threadTarget(system.routeKey, actorId, threadKey).route) === partitionOf(routeOf(actorId)!))
    threadKey = randomUUID();
  const thread = await setup<{ thread: { id: string; firstPost: { id: string; revisionId: string } } }>(
    actorToken,
    '/v1/threads',
    {
      title: 'Erasure fixture',
      body: fromPlainText('Erasure authority fixture'),
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
  // The governor borrows only the non-Global actions needed to manage this role.
  // Its access:grant and post:erase come from operator-bootstrapped Global governance.
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
    revisionId: thread.thread.firstPost.revisionId,
    ownerValid: (
      await db.admin.query(
        "SELECT valid::text FROM access.resource_role_grant WHERE route=$1 AND resource_id=$2 AND subject_id=$3 AND grant_role='content.post.owner'",
        [route, postId, actorId],
      )
    ).rows[0]!.valid as string,
    boardId: board.board.id,
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

async function call(
  scenario: Scenario,
  method: string,
  path: string,
  body?: unknown,
  account: 'actor' | 'governor' = 'actor',
  key: string = randomUUID(),
) {
  const bearer = account === 'actor' ? scenario.actorToken : scenario.governorToken;
  return app.handle(
    new Request(`http://kernel.test${path}`, {
      method,
      headers: {
        authorization: `Bearer ${bearer}`,
        ...(method === 'GET' ? {} : { 'idempotency-key': JSON.stringify(key) }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

function commandPath(kind: 'delete' | 'point' | 'thread', scenario: Scenario) {
  if (kind === 'delete') return { method: 'DELETE', path: `/v1/posts/${scenario.postId}`, body: undefined };
  if (kind === 'point')
    return {
      method: 'POST',
      path: `/v1/posts/${scenario.postId}:erase`,
      body: { reason: 'Initiator authority fixture' },
    };
  return { method: 'POST', path: `/v1/threads/${scenario.threadId}:erase`, body: { authorId: scenario.actorId } };
}

async function roleGrant(scenario: Scenario, operation: 'revoke' | 'create') {
  return call(
    scenario,
    'POST',
    `/v1/roleGrants${operation === 'revoke' ? ':revoke' : ''}`,
    {
      resource: { route: scenario.route, id: scenario.postId },
      subject: { kind: 'account', id: scenario.actorId },
      role: 'content.post.owner',
      valid: scenario.ownerValid,
    },
    'governor',
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

async function effects(scenario: Scenario) {
  const partition = partitionOf(scenario.route);
  const [position, receipts, outbox, operation, post, revisions, roles] = await Promise.all([
    db.admin.query('SELECT * FROM core.partition WHERE partition_no=$1', [partition]),
    db.admin.query('SELECT * FROM core.receipt WHERE partition_no=$1 ORDER BY idempotency_key', [partition]),
    db.admin.query('SELECT * FROM core.outbox WHERE partition_no=$1 ORDER BY position,event_seq', [partition]),
    db.admin.query('SELECT * FROM content.operation WHERE route=$1 ORDER BY operation_id', [scenario.route]),
    db.admin.query('SELECT * FROM content.post WHERE route=$1 AND post_id=$2', [scenario.route, scenario.postId]),
    db.admin.query('SELECT * FROM content.revision WHERE route=$1 AND post_id=$2 ORDER BY revision_id', [
      scenario.route,
      scenario.postId,
    ]),
    db.admin.query('SELECT * FROM access.resource_role_grant WHERE route=$1 AND resource_id=$2', [
      scenario.route,
      scenario.postId,
    ]),
  ]);
  return {
    position: position.rows,
    receipts: receipts.rows,
    outbox: outbox.rows,
    operation: operation.rows,
    post: post.rows,
    revisions: revisions.rows,
    roles: roles.rows,
  };
}

test('post:erase receipts require current self account read across all command routes', async () => {
  for (const kind of ['delete', 'point', 'thread'] as const) {
    const scenario = await fixture();
    const command = commandPath(kind, scenario);
    const key = `erasure-${kind}-${randomUUID()}`;
    const first = await call(scenario, command.method, command.path, command.body, 'actor', key);
    const firstWire = await first.text();
    expect(first.status).toBe(kind === 'thread' ? 202 : kind === 'delete' ? 204 : 200);

    const revoked = await roleGrant(scenario, 'revoke');
    expect(revoked.status).toBe(200);
    const committed = await effects(scenario);
    const receiptOnly = await call(scenario, command.method, command.path, command.body, 'actor', key);
    if (kind === 'thread') {
      // Author erasure initiation replays only while both the anchor post:erase and the self account read hold.
      expect(receiptOnly.status).toBe(403);
      expect(JSON.parse(await receiptOnly.text()).code).toBe('forbidden');
      expect(receiptOnly.headers.get(SESSION_HEADER)).toBeNull();
      expect(await effects(scenario)).toEqual(committed);
    } else {
      expect(receiptOnly.status).toBe(first.status);
      expect(await receiptOnly.text()).toBe(firstWire);
    }

    await accountRead(scenario, false);
    const denied = await call(scenario, command.method, command.path, command.body, 'actor', key);
    expect(denied.status).toBe(403);
    expect(JSON.parse(await denied.text()).code).toBe('forbidden');
    expect(denied.headers.get(SESSION_HEADER)).toBeNull();
    expect(await effects(scenario)).toEqual(committed);
  }
});

test('operation status follows current account read and the original post erase anchor', async () => {
  const scenario = await fixture();
  const started = await call(scenario, 'POST', `/v1/threads/${scenario.threadId}:erase`, {
    authorId: scenario.actorId,
  });
  expect(started.status).toBe(202);
  const startWire = await started.text();
  const operationId = (JSON.parse(startWire) as { name: string }).name.slice('operations/'.length);
  const anchor = await db.admin.query(
    'SELECT anchor_post_id FROM content.operation WHERE route=$1 AND operation_id=$2',
    [scenario.route, operationId],
  );
  expect(anchor.rows[0]?.anchor_post_id).toBe(scenario.postId);

  const visible = async () => call(scenario, 'GET', `/v1/operations/${operationId}`);
  const initial = await visible();
  expect(initial.status).toBe(200);
  const visibleWire = await initial.text();

  await accountRead(scenario, false);
  const accountHidden = await visible();
  expect(accountHidden.status).toBe(404);
  expect(JSON.parse(await accountHidden.text()).code).toBe('not_found');
  await accountRead(scenario, true);
  const accountRestored = await visible();
  expect(accountRestored.status).toBe(200);
  expect(await accountRestored.text()).toBe(visibleWire);

  const revoked = await roleGrant(scenario, 'revoke');
  expect(revoked.status).toBe(200);
  const postHidden = await visible();
  expect(postHidden.status).toBe(404);
  expect(JSON.parse(await postHidden.text()).code).toBe('not_found');
  const restored = await roleGrant(scenario, 'create');
  expect(restored.status).toBe(201);
  const postRestored = await visible();
  expect(postRestored.status).toBe(200);
  expect(await postRestored.text()).toBe(visibleWire);
});
