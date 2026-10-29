import { afterAll, beforeAll, expect, test } from 'bun:test';
import { fromPlainText } from '@rezics/document';
import { bundledRelease } from '@rezics/definitions/bundled';
import { PLATFORM_RESOURCE } from '../../src/access/bootstrap-governance.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { eraseAccountReactionsPage, type ReactionErasureCursor } from '../../src/content/account-erasure-reactions.ts';
import { createReactionCountEffect } from '../../src/content/reaction-projection.ts';
import { createReportEffect } from '../../src/content/report-effect.ts';
import { createReportOutcomeEffect } from '../../src/content/report-outcomes.ts';
import { createModerationDecisionEffect } from '../../src/content/moderation-decisions.ts';
import { setupContent } from '../../src/content/setup.ts';
import { readBatch } from '../../src/events/log.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { nativeFixture } from '../access/native-account-bindings-fixture.ts';
import { deletePersona, drainEffects } from '../support/account-deletion.ts';
import { checkGrowth, openGrowthDatabase } from '../support/growth.ts';
import { createPersonas, type Persona } from '../support/personas.ts';
import { testKernel, type TestKernel } from '../support/test-kernel.ts';

let db: Awaited<ReturnType<typeof openGrowthDatabase>>;
let auth: Awaited<ReturnType<typeof nativeFixture>>;
let kernel: TestKernel;
let people: Awaited<ReturnType<typeof createPersonas>>;
let subjectId: string;
let boardId: string;

async function call(method: string, path: string, person: Persona, body?: unknown, status = 200) {
  const response = await kernel.handle(
    new Request(`http://kernel.test${path}`, {
      method,
      headers: {
        authorization: `Bearer ${person.bearer}`,
        'content-type': 'application/json',
        'idempotency-key': JSON.stringify(crypto.randomUUID()),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  const value = await response.json();
  expect({ status: response.status, ...(response.status === status ? {} : { value }) }).toEqual({ status });
  return value;
}

async function grant(person: Persona, actions: string[], resource = PLATFORM_RESOURCE) {
  await call(
    'POST',
    '/v1/grants',
    people.staff,
    {
      resource,
      subject: { kind: 'account', id: person.accountId },
      actions,
      valid: '(,)',
    },
    201,
  );
}

beforeAll(async () => {
  db = await openGrowthDatabase();
  auth = await nativeFixture(db.pool);
  kernel = testKernel({
    pool: db.pool,
    auth: { ...auth.host.service.verifier, fetch: (url, init) => auth.host.service.handler(new Request(url, init)) },
    writeRate: createWriteRateLimiter({
      secret: 'account-erasure-reactions-native-write-secret',
      overrides: JSON.stringify({
        'new-account': { write: { maximum: 100000, seconds: 86400 }, report: { maximum: 100000, seconds: 86400 } },
      }),
    }),
  });
  people = await createPersonas(kernel, { version: 1, pool: db.pool, auth });
  await bootstrapRelease(db.pool, bundledRelease);
  await setupContent(db.pool);
  await grant(people.staff, ['subject:create', 'board:create']);
  subjectId = (
    await call('POST', '/v1/subjects', people.staff, { type: 'schema:Book', labels: { en: 'Erasure subject' } }, 201)
  ).subject.id;
  boardId = (await call('POST', '/v1/boards', people.staff, { subjectId, title: 'Erasure board' }, 201)).board.id;
  for (const person of [people.alice, people.bob, people.orgOwner, people.operator]) {
    await grant(person, ['thread:create', 'reaction:set', 'report:create', 'board:read', 'thread:read', 'post:read'], {
      route: routeOf(boardId)!,
      id: boardId,
    });
    await grant(person, ['reaction:set'], { route: 0, id: GLOBAL_CONTEXT });
  }
}, 360000);

afterAll(async () => {
  try {
    await auth?.close();
  } finally {
    await db?.close();
  }
});

async function thread() {
  return (
    await call(
      'POST',
      '/v1/threads',
      people.staff,
      {
        boardId,
        title: 'Retained target',
        body: fromPlainText('Retained contribution'),
        licence: 'MIT',
        subjectIds: [],
      },
      201,
    )
  ).thread;
}

// Use the native log consumer and real effects, then the shared deletion drain.
// A locator is explicitly delivered before the phase, as required by its committed-locator boundary.
async function settle() {
  const { createReportLocatorEffect } = await import('../../src/content/' + 'report-locator.ts');
  const effects = [
    createReactionCountEffect(db.pool),
    createReportEffect(db.pool),
    createModerationDecisionEffect(db.pool),
    createReportOutcomeEffect(db.pool),
    createReportLocatorEffect(db.pool),
  ];
  for (let pass = 0; pass < 20; pass++) {
    let advanced = false;
    const { rows } = await db.admin.query<{ partition_no: number }>(
      'SELECT partition_no FROM core.partition WHERE position>0',
    );
    for (const row of rows) {
      const batch = await readBatch(db.pool, {
        consumer: 'effects',
        partition: row.partition_no,
        async apply(envelopes) {
          for (const envelope of envelopes)
            for (const event of envelope.events)
              for (const effect of effects) if (effect.types.includes(event.type)) await effect.run(event);
        },
      });
      if (batch.status !== 'read') throw new Error('Effects partition unavailable');
      advanced ||= batch.envelopes > 0;
    }
    if (!advanced) {
      for (const row of rows) await drainEffects(db.pool, row.partition_no);
      return;
    }
  }
  throw new Error('Effects did not settle');
}

async function erase(person: Persona) {
  await deletePersona({ version: 1, pool: db.pool, auth }, person);
  await settle();
  let cursor: ReactionErasureCursor | null = null;
  let total = 0;
  for (let page = 0; page < 30; page++) {
    const result = await eraseAccountReactionsPage(db, person.accountId, cursor);
    expect(result.found).toBeLessThanOrEqual(50);
    total += result.found;
    cursor = result.next;
    if (!cursor) {
      await settle();
      return total;
    }
  }
  throw new Error('Erasure did not finish');
}

test("account erasure clears the account's reactions with their counts and projections and leaves other reactors' reactions", async () => {
  const first = await thread();
  const second = await thread();
  const targets = [`posts/${first.firstPost.id}`, `posts/${second.firstPost.id}`, `subjects/${subjectId}`];
  for (const target of targets)
    for (const person of [people.alice, people.bob])
      await call('PUT', `/v1/${target}/reaction`, person, { kind: 'like' });
  await settle();
  for (const target of targets) {
    const id = target.split('/')[1]!;
    expect(
      (
        await db.admin.query('SELECT count FROM content.reaction_total WHERE route=$1 AND target_id=$2 AND kind=$3', [
          routeOf(id),
          id,
          'like',
        ])
      ).rows,
    ).toEqual([{ count: 2 }]);
  }
  expect(await erase(people.alice)).toBe(3);
  expect(
    (
      await db.admin.query('SELECT * FROM content.reaction WHERE route=$1 AND actor_account_id=$2', [
        routeOf(people.alice.accountId),
        people.alice.accountId,
      ])
    ).rows,
  ).toHaveLength(0);
  for (const target of targets) {
    const id = target.split('/')[1]!;
    expect((await call('GET', `/v1/${target}/reaction`, people.bob)).reaction.kind).toBe('like');
    expect(
      (
        await db.admin.query('SELECT count FROM content.reaction_total WHERE route=$1 AND target_id=$2 AND kind=$3', [
          routeOf(id),
          id,
          'like',
        ])
      ).rows,
    ).toEqual([{ count: 1 }]);
    expect(
      (
        await db.admin.query(
          'SELECT sum(count)::integer AS count FROM content.reaction_count WHERE route=$1 AND target_id=$2 AND kind=$3',
          [routeOf(id), id, 'like'],
        )
      ).rows,
    ).toEqual([{ count: 1 }]);
  }
  expect(
    (
      await db.admin.query('SELECT actor_account_id FROM content.subject_reactor WHERE route=$1 AND subject_id=$2', [
        routeOf(subjectId),
        subjectId,
      ])
    ).rows,
  ).toEqual([{ actor_account_id: people.bob.accountId }]);
  const post = await call('GET', `/v1/posts/${first.firstPost.id}`, people.bob);
  expect(post.post.reactions.like).toBe(1);
  const subject = await call('GET', `/v1/subjects/${subjectId}/reactions`, people.bob);
  expect(subject.reactions.like).toBe(1);
  expect(await eraseAccountReactionsPage(db, people.alice.accountId, null)).toEqual({
    next: { phase: 'reports', after: null },
    found: 0,
  });
}, 180000);

test("account erasure removes the account's report evidence text and reporter id and keeps the report and its decision", async () => {
  const target = await thread();
  const reports: string[] = [];
  for (const person of [people.orgOwner, people.bob])
    reports.push(
      (
        await call(
          'POST',
          '/v1/reports',
          person,
          {
            target: { kind: 'thread', id: target.id },
            reason: 'other',
            evidence: `Private evidence ${person.accountId}`,
          },
          201,
        )
      ).reportId,
    );
  await settle();
  await call('POST', `/v1/threads/${target.id}:takeDown`, people.staff, { reason: 'Retained decision' });
  await settle();
  const before = await call('GET', `/v1/reports/${reports[0]}`, people.staff);
  const other = await call('GET', `/v1/reports/${reports[1]}`, people.staff);
  const decision = (await db.admin.query('SELECT * FROM content.moderation_decision WHERE target_id=$1', [target.id]))
    .rows;
  expect(decision).toHaveLength(1);
  expect(before.report.outcome).toBe('actioned');
  expect(await erase(people.orgOwner)).toBe(1);
  const after = await call('GET', `/v1/reports/${reports[0]}`, people.staff);
  expect(after.report).toEqual({ ...before.report, evidence: null, reporterId: null });
  expect(await call('GET', `/v1/reports/${reports[1]}`, people.staff)).toEqual(other);
  expect(
    (await db.admin.query('SELECT * FROM content.moderation_decision WHERE target_id=$1', [target.id])).rows,
  ).toEqual(decision);
  expect(
    (
      await db.admin.query('SELECT * FROM content.report_reporter WHERE route=$1 AND reporter_account_id=$2', [
        routeOf(people.orgOwner.accountId),
        people.orgOwner.accountId,
      ])
    ).rows,
  ).toHaveLength(0);
  // A replay consults the minimized source and cannot recreate the reporter locator.
  const { createReportLocatorEffect } = await import('../../src/content/' + 'report-locator.ts');
  const { rows: events } = await db.admin.query('SELECT * FROM core.outbox WHERE type=$1 AND subject=$2', [
    'com.rezics.content.report.created.v1',
    reports[0],
  ]);
  const event = events[0];
  await createReportLocatorEffect(db.pool).run({
    specversion: '1.0',
    id: event.id,
    source: `urn:rezics:log:${event.partition_no}.${event.epoch}`,
    sequence: String(event.position).padStart(19, '0'),
    type: event.type,
    subject: event.subject,
    datacontenttype: 'application/json',
    time: new Date(event.recorded_at).toISOString(),
    data: event.data,
  });
  expect(
    (
      await db.admin.query('SELECT * FROM content.report_reporter WHERE route=$1 AND reporter_account_id=$2', [
        routeOf(people.orgOwner.accountId),
        people.orgOwner.accountId,
      ])
    ).rows,
  ).toHaveLength(0);
}, 180000);

test("an account reaction and report erasure page stays within its bound as other accounts' reactions and reports grow", async () => {
  const person = people.operator;
  const target = await thread();
  await call('PUT', `/v1/posts/${target.firstPost.id}/reaction`, person, { kind: 'like' });
  await call(
    'POST',
    '/v1/reports',
    person,
    { target: { kind: 'thread', id: target.id }, reason: 'spam', evidence: 'Native evidence' },
    201,
  );
  await deletePersona({ version: 1, pool: db.pool, auth }, person);
  await settle();
  // Fixed-size consumable pages for warmups and repetitions; distractors grow in the same routes.
  // Raw writes here are cost fixtures, after native creation and terminal account deletion above.
  const home = routeOf(person.accountId)!;
  const reportRoute = routeOf(target.id)!;
  const ownTargets = Array.from({ length: 1000 }, () => newId(reportRoute));
  const ownReports = Array.from({ length: 1000 }, () => newId(reportRoute));
  await db.admin.query(
    "INSERT INTO content.reaction(route,actor_account_id,target_kind,target_route,target_id,kind,updated_at) SELECT $1,$2,'post',$3,id,'like',now() FROM unnest($4::uuid[]) id",
    [home, person.accountId, reportRoute, ownTargets],
  );
  await db.admin.query(
    "INSERT INTO content.report(route,report_id,target_kind,target_id,reason,evidence,reporter_account_id,created_at,recorded_transaction_id) SELECT $1,id,'thread',$2,'spam','Private evidence',$3,now(),$4 FROM unnest($5::uuid[]) id",
    [reportRoute, target.id, person.accountId, crypto.randomUUID(), ownReports],
  );
  await db.admin.query(
    'INSERT INTO content.report_reporter(route,reporter_account_id,report_route,report_id) SELECT $1,$2,$3,id FROM unnest($4::uuid[]) id',
    [home, person.accountId, reportRoute, ownReports],
  );
  let reactionCursor: ReactionErasureCursor = { phase: 'reactions', after: null };
  let reportCursor: ReactionErasureCursor = { phase: 'reports', after: null };
  const growth = await checkGrowth(db, {
    name: 'Account reactor and reporter erasure',
    rule: 'series',
    scales: [256, 1024, 4096],
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    async grow(database, scale, previous) {
      const actors = Array.from({ length: scale - previous }, () => newId(home));
      const ids = actors.map(() => newId(reportRoute));
      await database.admin.query(
        "INSERT INTO content.reaction(route,actor_account_id,target_kind,target_route,target_id,kind,updated_at) SELECT $1,id,'post',$2,$3,'like',now() FROM unnest($4::uuid[]) id",
        [home, reportRoute, target.firstPost.id, actors],
      );
      await database.admin.query(
        "INSERT INTO content.report(route,report_id,target_kind,target_id,reason,evidence,reporter_account_id,created_at,recorded_transaction_id) SELECT $1,id,'thread',$2,'spam','Other evidence',actor,now(),$3 FROM unnest($4::uuid[],$5::uuid[]) row(id,actor)",
        [reportRoute, target.id, crypto.randomUUID(), ids, actors],
      );
      await database.admin.query(
        'INSERT INTO content.report_reporter(route,reporter_account_id,report_route,report_id) SELECT $1,actor,$2,id FROM unnest($3::uuid[],$4::uuid[]) row(id,actor)',
        [home, reportRoute, ids, actors],
      );
    },
    async operation() {
      const reactions = await eraseAccountReactionsPage(db, person.accountId, reactionCursor);
      const reports = await eraseAccountReactionsPage(db, person.accountId, reportCursor);
      expect(reactions.found).toBe(50);
      expect(reports.found).toBe(50);
      expect(reactions.next?.phase).toBe('reactions');
      expect(reports.next?.phase).toBe('reports');
      reactionCursor = reactions.next!;
      reportCursor = reports.next!;
    },
  });
  expect(growth.samples.map((sample) => sample.scale)).toEqual([256, 1024, 4096]);
  for (const sample of growth.samples) {
    expect(sample.cost.rows).toBe(growth.samples[0]!.cost.rows);
    expect(sample.cost.statements).toBe(growth.samples[0]!.cost.statements);
  }
  expect(partitionOf(home)).not.toBe(partitionOf(reportRoute));
}, 240000);
