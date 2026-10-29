import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { fromPlainText } from '@rezics/document';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import {
  eraseAccountModerationPage,
  purgeAccountStatementsPage,
} from '../../src/content/account-erasure-moderation.ts';
import { createPartyLocatorEffect } from '../../src/content/party-locator.ts';
import { createReportEffect } from '../../src/content/report-effect.ts';
import { createReportOutcomeEffect } from '../../src/content/report-outcomes.ts';
import { bindAuthorErasureWorkflow } from '../../src/content/erasure-workflow-identity.ts';
import type { Effect } from '../../src/events/effects.ts';
import { projectBatch, readBatch, type Envelope } from '../../src/events/log.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { createWorkClient, type WorkClient } from '../../src/work/client.ts';
import { cookies, nativeFixture, password } from '../access/native-account-bindings-fixture.ts';
import { deletePersona, drainEffects } from '../support/account-deletion.ts';
import { createPersonas, type Persona } from '../support/personas.ts';
import { checkGrowth, openGrowthDatabase } from '../support/growth.ts';
import { registerTestClient, testKernel, type TestKernel } from '../support/test-kernel.ts';

setDefaultTimeout(360_000);
const DAY = 86400000;
let db: Awaited<ReturnType<typeof openGrowthDatabase>>;
let auth: Awaited<ReturnType<typeof nativeFixture>>;
let people: Awaited<ReturnType<typeof createPersonas>>;
let independentModerator: Persona;
let kernel: TestKernel;
let work: WorkClient;
let now = new Date();
let board: string;
const partitions = new Set<number>();
const granted = new Set<string>();
const operationClient = randomUUID();
const operationCredentials = new Map<string, Persona>();

async function call(person: Persona, path: string, body: unknown, status = 200) {
  const response = await kernel.handle(
    new Request(`http://kernel.test${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${person.bearer}`,
        'content-type': 'application/json',
        'idempotency-key': JSON.stringify(randomUUID()),
      },
      body: JSON.stringify(body),
    }),
  );
  const value = await response.json();
  expect({ status: response.status, ...(response.status === status ? {} : { value }) }).toEqual({ status });
  return value;
}
async function grant(person: Persona, id: string, actions: string[]) {
  actions = actions.filter((action) => !granted.has(`${person.accountId}:${id}:${action}`));
  if (actions.length === 0) return;
  // Bootstrap only the fixture grantor; participants receive native HTTP grants.
  await db.admin.query(
    `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
    SELECT $1,$2,$3,action,'(,)',$3 FROM unnest($4::text[]) AS action ON CONFLICT DO NOTHING`,
    [routeOf(id), id, people.staff.accountId, actions],
  );
  await call(
    people.staff,
    '/v1/grants',
    {
      resource: { route: routeOf(id), id },
      subject: { kind: 'account', id: person.accountId },
      actions,
      valid: '(,)',
    },
    201,
  );
  for (const action of actions) granted.add(`${person.accountId}:${id}:${action}`);
}
async function thread(author: Persona) {
  await grant(author, board, ['thread:create', 'board:read']);
  const value = await call(
    author,
    '/v1/threads',
    {
      boardId: board,
      title: 'Moderation retention',
      body: fromPlainText('Another author’s contribution'),
      licence: 'MIT',
      subjectIds: [],
      visibility: 'published',
    },
    201,
  );
  partitions.add(partitionOf(routeOf(value.thread.id)!));
  return value.thread;
}
async function decide(moderator: Persona, author: Persona, at: Date, reporter?: Persona) {
  const target = await thread(author);
  let reportId: string | null = null;
  if (reporter) {
    await grant(reporter, target.firstPost.id, ['report:create']);
    reportId = (
      await call(
        reporter,
        '/v1/reports',
        {
          target: { kind: 'post', id: target.firstPost.id },
          reason: 'spam',
        },
        201,
      )
    ).reportId;
  }
  await grant(moderator, target.firstPost.id, ['moderation:takedown', 'post:erase']);
  now = at;
  try {
    await call(moderator, `/v1/posts/${target.firstPost.id}:takeDown`, { reason: 'Retained complaint statement' });
  } finally {
    now = new Date();
  }
  const {
    rows: [decision],
  } = await db.admin.query('SELECT * FROM content.moderation_decision WHERE route=$1 AND target_id=$2', [
    routeOf(target.id),
    target.firstPost.id,
  ]);
  return { target, decision, reportId };
}
async function deliverReport(effect: Effect, reportId: string) {
  const { rows } = await db.admin.query(
    `SELECT * FROM core.outbox WHERE data->>'reportId'=$1 AND type=ANY($2::text[]) ORDER BY position,event_seq`,
    [reportId, effect.types],
  );
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows)
    await effect.run({
      specversion: '1.0',
      id: row.id,
      source: `urn:rezics:log:${row.partition_no}.${row.epoch}`,
      type: row.type,
      time: new Date(row.recorded_at).toISOString(),
      datacontenttype: 'application/json',
      sequence: String(row.position).padStart(19, '0'),
      subject: row.subject,
      data: row.data,
    });
}
async function project() {
  const effect = createPartyLocatorEffect(db.pool);
  for (const partition of partitions) {
    for (;;) {
      const batch = await projectBatch(db.pool, {
        consumer: 'effects',
        partition,
        apply: async (envelopes) => {
          for (const envelope of envelopes)
            for (const event of envelope.events)
              if (effect.types.includes(event.type)) {
                await effect.run(event);
                await effect.run(event);
              }
        },
      });
      if (batch.status !== 'read' || batch.envelopes === 0) break;
    }
    await drainEffects(db.pool, partition);
  }
}
async function remove(person: Persona, actingHuman?: Persona) {
  const deleted = await deletePersona({ version: 1, pool: db.pool, auth }, person, actingHuman ? { actingHuman } : {});
  partitions.add(partitionOf(routeOf(person.accountId)!));
  await project();
  return new Date(deleted.at);
}
async function erase(person: Persona, erasedAt: Date) {
  let after: string | null = null;
  let latest: Date | null = null;
  let found = 0;
  do {
    const page = await eraseAccountModerationPage({ pool: db.pool }, person.accountId, { erasedAt, after });
    expect(page.found).toBeLessThanOrEqual(50);
    expect(page.pending).toBe(0);
    found += page.found;
    if (page.statementsKeptUntil && (!latest || page.statementsKeptUntil > latest)) latest = page.statementsKeptUntil;
    after = page.next;
  } while (after);
  return { found, latest };
}

async function operation(
  initiator: Persona & { requestedBy?: string },
  target: { id: string; firstPost: { id: string } },
  author: Persona,
  terminal = true,
) {
  // Durable initiator records deliberately bound their scope snapshot. Obtain a
  // real bearer with only the two actions this operation needs.
  let credential = operationCredentials.get(initiator.accountId);
  if (!credential) {
    const login = await auth.request('/signin', {
      account_id: initiator.accountId,
      password,
      client_id: operationClient,
      scope: ['post:erase', 'account:read'],
    });
    expect(login.status).toBe(200);
    const token = await auth.request(
      '/token',
      initiator.requestedBy ? { requested_by: initiator.requestedBy } : {},
      cookies(login),
    );
    expect(token.status).toBe(200);
    credential = { accountId: initiator.accountId, bearer: (await token.json()).access_token };
    operationCredentials.set(initiator.accountId, credential);
  }
  const started = await call(credential, `/v1/threads/${target.id}:erase`, { authorId: author.accountId }, 202);
  const id = started.name.split('/')[1];
  // A real queued native operation becomes terminal by cancellation; no executor or initiator is restored.
  const envelopes: Envelope[] = [];
  await readBatch(db.pool, {
    consumer: 'terminal_fixture',
    partition: partitionOf(routeOf(id)!),
    apply: async (page) => {
      envelopes.push(...page);
    },
  });
  const source = envelopes.find((entry) =>
    entry.events.some((event) => (event.data as { operationId?: string }).operationId === id),
  )!;
  const index = source.events.findIndex((event) => (event.data as { operationId?: string }).operationId === id);
  const connection = await db.pool.connect();
  let workflow: string;
  try {
    workflow = await bindAuthorErasureWorkflow(connection, id, source, index);
  } finally {
    connection.release();
  }
  await work.enqueue({ workflowName: 'content.authorErasure', workflowID: workflow!, queueName: 'governance' }, {});
  if (terminal) await work.cancelWorkflow(workflow!);
  return { id, workflow: workflow! };
}

async function operatedTerminal(operator: Persona, target: { id: string; firstPost: { id: string } }, author: Persona) {
  const automated = await auth.automated(`retention_${randomUUID()}`, operator);
  const login = await auth.request('/signin', {
    account_id: operator.accountId,
    password,
    client_id: operationClient,
    scope: ['post:erase', 'account:read', 'account:manage'],
  });
  expect(login.status).toBe(200);
  const operatorToken = await auth.request('/token', {}, cookies(login));
  expect(operatorToken.status).toBe(200);
  const operatorBearer = (await operatorToken.json()).access_token as string;
  const key = randomUUID();
  const opening = {
    kind: 'opening' as const,
    operatorAccountId: operator.accountId,
    subjectAccountId: automated.accountId,
    authorization: 'request',
  };
  const approval = await auth
    .approval()
    .approve(
      operatorBearer,
      { operationKey: key, operation: opening },
      { pool: db.pool, deadline: Date.now() + 10000 },
    );
  const opened = await auth.host.workflows.openOperatorSession({
    ...opening,
    key,
    authorization: approval.reference,
    headers: cookies(login),
  });
  expect(opened.status).toBe(200);
  const token = await auth.request('/token', {}, cookies(opened));
  expect(token.status).toBe(200);
  const persona = { accountId: automated.accountId, bearer: (await token.json()).access_token };
  operationCredentials.set(persona.accountId, persona);
  await grant(persona, target.firstPost.id, ['post:erase']);
  const terminal = await operation(persona, target, author);
  // Release the real operator responsibility before deleting its human owner.
  await remove(persona, operator);
  return terminal;
}

beforeAll(async () => {
  db = await openGrowthDatabase();
  auth = await nativeFixture(db.pool);
  const service = auth.host.service;
  kernel = testKernel({
    pool: db.pool,
    clock: () => now,
    auth: { ...service.verifier, fetch: (url, init) => service.handler(new Request(url, init)) },
    writeRate: createWriteRateLimiter({ secret: 'moderation-erasure-native-test-secret-32-bytes' }),
  });
  people = await createPersonas(kernel, { version: 1, pool: db.pool, auth });
  independentModerator = await people.unscoped('account:read');
  await registerTestClient(service, {
    clientId: operationClient,
    firstParty: true,
    scopes: ['post:erase', 'account:read', 'account:manage'],
  });
  work = await createWorkClient(db.url, db.pool);
  await work.registerQueue('governance', {});
  board = newId(0x4321);
  await db.admin.query(
    `INSERT INTO content.board(route,board_id,subject_id,title,visibility,security_revision,recorded_transaction_id)
    VALUES ($1,$2,$3,'Retention board','published',1,$4)`,
    [routeOf(board), board, newId(0x4322), randomUUID()],
  );
});
afterAll(async () => {
  await work?.close();
  await auth?.close();
  await db?.close();
});

test('account erasure removes the account from its moderation decisions and terminal operations and keeps only statements of the last six months until their expiry', async () => {
  const moderator = people.alice;
  const recent = await decide(moderator, people.orgOwner, new Date(), people.operator);
  const old = await decide(moderator, people.bob, new Date(Date.now() - 200 * DAY));
  const terminal = await operation(moderator, recent.target, people.orgOwner);
  const pending = await operation(moderator, recent.target, people.orgOwner, false);
  const authored = await thread(moderator);
  await grant(people.operator, authored.firstPost.id, ['post:erase']);
  const authorOperation = await operation(people.operator, authored, moderator);
  await grant(people.delegated, recent.target.firstPost.id, ['post:erase']);
  await grant(moderator, people.delegated.accountId, ['account:read']);
  const requestedOperation = await operation(people.delegated, recent.target, people.orgOwner);
  const originalOperatorOperation = await operatedTerminal(moderator, recent.target, people.orgOwner);
  const erasedAt = await remove(moderator);
  const firstPage = await eraseAccountModerationPage({ pool: db.pool }, moderator.accountId, { erasedAt, after: null });
  expect(firstPage).toMatchObject({ found: 7, pending: 1, next: null });
  await work.cancelWorkflow(pending.workflow);
  const result = await erase(moderator, erasedAt);
  expect(result.found).toBe(2);
  expect(result.latest).toEqual(new Date(new Date(recent.decision.decided_at).getTime() + 183 * DAY));
  const decisions = (
    await db.admin.query('SELECT * FROM content.moderation_decision WHERE decision_id=ANY($1::uuid[])', [
      [recent.decision.decision_id, old.decision.decision_id],
    ])
  ).rows;
  expect(decisions.every((row) => row.decider_account_id === null)).toBe(true);
  expect(decisions.find((row) => row.decision_id === recent.decision.decision_id).statement).toBe(
    recent.decision.statement,
  );
  expect(decisions.find((row) => row.decision_id === old.decision.decision_id).statement).toBe('');
  // A delayed projection still resolves the report without restoring its erased moderator.
  await deliverReport(createReportEffect(db.pool), recent.reportId!);
  await deliverReport(createReportOutcomeEffect(db.pool), recent.reportId!);
  expect(
    (
      await db.admin.query('SELECT outcome,resolved_by,decision_id FROM content.report WHERE report_id=$1', [
        recent.reportId,
      ])
    ).rows[0],
  ).toEqual({ outcome: 'actioned', resolved_by: null, decision_id: recent.decision.decision_id });
  const storedOperation = (
    await db.admin.query('SELECT * FROM content.operation WHERE route=$1 AND operation_id=$2', [
      routeOf(terminal.id),
      terminal.id,
    ])
  ).rows[0];
  expect(storedOperation).toMatchObject({
    initiator_account_id: null,
    actor_account_id: null,
    actor_client_id: null,
    actor_requested_by: null,
  });
  expect(storedOperation.author_account_id).toBe(people.orgOwner.accountId);
  expect(JSON.stringify(storedOperation)).not.toContain(moderator.accountId);
  for (const id of [requestedOperation.id, originalOperatorOperation.id]) {
    const row = (
      await db.admin.query('SELECT * FROM content.operation WHERE route=$1 AND operation_id=$2', [routeOf(id), id])
    ).rows[0];
    expect(row.actor_client_id).toBeNull();
    expect(row.actor_requested_by).toBeNull();
    expect(JSON.stringify(row)).not.toContain(moderator.accountId);
  }
  await expect(
    db.admin.query('UPDATE content.operation SET actor_client_id=$3 WHERE route=$1 AND operation_id=$2', [
      routeOf(terminal.id),
      terminal.id,
      'restored-client',
    ]),
  ).rejects.toThrow('immutable');
  expect(
    (
      await db.admin.query(
        'SELECT author_account_id,initiator_account_id FROM content.operation WHERE route=$1 AND operation_id=$2',
        [routeOf(authorOperation.id), authorOperation.id],
      )
    ).rows[0],
  ).toEqual({ author_account_id: null, initiator_account_id: people.operator.accountId });
  expect(
    (
      await db.admin.query('SELECT kind FROM content.party_locator WHERE route=$1 AND account_id=$2', [
        routeOf(moderator.accountId),
        moderator.accountId,
      ])
    ).rows,
  ).toEqual([{ kind: 'decision' }]);
  await project(); // A later effect replay cannot restore minimized party fields.
});

test('the statement purge erases each kept statement once its own decision time plus 183 days has passed, in decision-time order, and leaves the outcomes', async () => {
  const moderator = people.bob;
  const first = await decide(moderator, people.orgOwner, new Date(Date.now() - 60 * DAY));
  const second = await decide(moderator, people.operator, new Date(Date.now() - 30 * DAY));
  await erase(moderator, await remove(moderator));
  const firstDue = new Date(new Date(first.decision.decided_at).getTime() + 183 * DAY);
  const secondDue = new Date(new Date(second.decision.decided_at).getTime() + 183 * DAY);
  expect(
    await purgeAccountStatementsPage({ pool: db.pool }, moderator.accountId, {
      asOf: new Date(firstDue.getTime() - 1),
      after: null,
    }),
  ).toMatchObject({ found: 0, next: null, nextDueAt: firstDue });
  expect(
    await purgeAccountStatementsPage({ pool: db.pool }, moderator.accountId, { asOf: firstDue, after: null }),
  ).toEqual({ found: 1, next: null, nextDueAt: secondDue });
  const read = async () =>
    (
      await db.admin.query(
        'SELECT decision_id,action,target_kind,target_id,decided_at,statement FROM content.moderation_decision WHERE decision_id=ANY($1::uuid[]) ORDER BY decided_at',
        [[first.decision.decision_id, second.decision.decision_id]],
      )
    ).rows;
  const halfway = await read();
  expect(halfway).toEqual(
    [first.decision, second.decision].map(
      ({ decision_id, action, target_kind, target_id, decided_at, statement }, index) => ({
        decision_id,
        action,
        target_kind,
        target_id,
        decided_at,
        statement: index === 0 ? '' : statement,
      }),
    ),
  );
  expect(halfway.map((row) => row.statement)).toEqual(['', second.decision.statement]);
  expect(
    await purgeAccountStatementsPage({ pool: db.pool }, moderator.accountId, { asOf: secondDue, after: null }),
  ).toEqual({ found: 1, next: null, nextDueAt: null });
  expect(await read()).toEqual(halfway.map((row) => ({ ...row, statement: '' })));
  expect(
    await purgeAccountStatementsPage({ pool: db.pool }, moderator.accountId, { asOf: secondDue, after: null }),
  ).toEqual({ found: 0, next: null, nextDueAt: null });
});

test("an account moderation record erasure page stays within its bound as other moderators' decisions and operations grow", async () => {
  // An independent human has no organization-owner hold that prevents deletion.
  const moderator = independentModerator;
  const own = await decide(moderator, people.operator, new Date());
  const erasedAt = await remove(moderator);
  await erase(moderator, erasedAt);
  await checkGrowth(db, {
    name: 'account moderation record erasure',
    rule: 'series',
    scales: [256, 1024, 4096],
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    async grow(database, scale, previous) {
      const route = routeOf(own.target.id)!;
      const ids = Array.from({ length: scale - previous }, () => newId(route));
      const other = newId(routeOf(moderator.accountId)!);
      await database.admin.query(
        `INSERT INTO content.moderation_decision
        (route,decision_id,target_kind,target_id,action,statement,decider_account_id,security_revision)
        SELECT $1,id,'post',$2,'takedown','Unrelated',$3,10000+$4+n FROM unnest($5::uuid[]) WITH ORDINALITY AS t(id,n)`,
        [route, own.target.firstPost.id, other, previous, ids],
      );
      await database.admin.query(
        `INSERT INTO content.operation
        (route,operation_id,initiator_account_id,author_account_id,thread_id,anchor_post_id,actor_kind,actor_account_id,
         actor_client_id,actor_scopes,actor_authn_epoch,empty_scope,requested_at,recorded_transaction_id)
        SELECT $1,id,$2,$2,$3,$4,'account',$2,'growth','{}',1,true,now(),id FROM unnest($5::uuid[]) AS t(id)`,
        [route, other, own.target.id, own.target.firstPost.id, ids],
      );
      for (const kind of ['decision', 'operation'])
        await database.admin.query(
          `INSERT INTO content.party_locator
        (route,account_id,kind,due_at,owner_route,owner_id) SELECT $1,$2,$3,now(),$4,id FROM unnest($5::uuid[]) AS t(id)`,
          [routeOf(other), other, kind, route, ids],
        );
    },
    async operation() {
      expect(
        await eraseAccountModerationPage({ pool: db.pool }, moderator.accountId, { erasedAt, after: null }),
      ).toMatchObject({ found: 1, pending: 0, next: null });
    },
  });
});
