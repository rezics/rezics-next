import { afterAll, beforeAll, expect, test } from 'bun:test';
import { bundledRelease } from '@rezics/definitions/bundled';
import { fromPlainText } from '@rezics/document';
import type { CloudEvent } from '../../src/events/log.ts';
import { closeErasureFence, lockErasureFence } from '../../src/content/erasure-fence.ts';
import { createAuthorItemEffect } from '../../src/content/author-item-index.ts';
import { eraseAccountAuthoredPage } from '../../src/content/account-erasure-authored.ts';
import { createReportLocatorEffect } from '../../src/content/report-locator.ts';
import { eraseAccountReactionsPage } from '../../src/content/account-erasure-reactions.ts';
import { noEffect, runCommand } from '../../src/command/command.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { accountDeletionRuntime, deletePersona } from '../support/account-deletion.ts';
import { createNativeContentSystemWithWriteRateOverrides, type NativeContentSystem } from './support/native-system.ts';
import { HIGH_RATE_OVERRIDES, seedGovernanceAuthority } from './support/disclosure-fixtures.ts';

type Person = { accountId: string; bearer: string };
type Thread = { id: string; firstPost: { id: string; revisionId: string } };
type OutboxRow = {
  partition_no: number;
  position: string;
  event_seq: number;
  epoch: number;
  id: string;
  type: string;
  subject: string | null;
  data: unknown;
  recorded_at: Date;
};

let system: NativeContentSystem;
let boardId: string;
const threadCreatorsGranted = new Set<string>();
const fixed = (): Person => ({
  accountId: system.actors.other.actor.accountId,
  bearer: system.actors.other.bearer,
});

async function request<T>(person: Person, method: string, path: string, body?: unknown, head?: string): Promise<T> {
  const response = await system.kernel.handle(
    new Request(`https://content.test${path}`, {
      method,
      headers: {
        authorization: `Bearer ${person.bearer}`,
        ...(method === 'GET' ? {} : { 'idempotency-key': JSON.stringify(crypto.randomUUID()) }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(head ? { 'if-match': JSON.stringify(head) } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} returned ${response.status}: ${text}`);
  return (text ? JSON.parse(text) : undefined) as T;
}

async function grant(account: Person, resourceId: string, actions: string[]) {
  const route = routeOf(resourceId)!;
  await seedGovernanceAuthority(system.database.pool, route, resourceId, system.actors.other.actor.accountId, [
    'access:grant',
  ]);
  await request(fixed(), 'POST', '/v1/grants', {
    resource: { route, id: resourceId },
    subject: { kind: 'account', id: account.accountId },
    actions,
    valid: '(,)',
  });
}

async function createThread(person: Person, title: string): Promise<Thread> {
  if (!threadCreatorsGranted.has(person.accountId)) {
    await grant(person, boardId, ['thread:create', 'board:read']);
    threadCreatorsGranted.add(person.accountId);
  }
  return (
    await request<{ thread: Thread }>(person, 'POST', '/v1/threads', {
      boardId,
      title,
      body: fromPlainText(`${title} body`),
      licence: 'CC0-1.0',
      subjectIds: [],
      visibility: 'published',
    })
  ).thread;
}

async function createPerson(): Promise<Person> {
  const runtime = accountDeletionRuntime(system);
  return runtime.person();
}

async function erase(person: Person) {
  const runtime = accountDeletionRuntime(system);
  return deletePersona({ version: 1, pool: system.database.pool, auth: runtime.auth }, person);
}

async function closeFence(accountId: string): Promise<string> {
  const home = routeOf(accountId)!;
  const result = await runCommand(system.database.pool, { partition: partitionOf(home) }, async (tx) =>
    noEffect(await closeErasureFence(tx, accountId)),
  );
  return result.value;
}

async function events(accountId: string, threadId: string): Promise<CloudEvent[]> {
  const { rows } = await system.database.pool.query<OutboxRow>(
    `SELECT partition_no,position::text,event_seq,epoch,id::text,type,subject,data,recorded_at
     FROM core.outbox WHERE type=ANY($1::text[]) AND data->>'actorId'=$2 AND data->>'threadId'=$3
     ORDER BY position,event_seq`,
    [['com.rezics.content.thread.created.v1', 'com.rezics.content.post.created.v1'], accountId, threadId],
  );
  return rows.map((row) => ({
    specversion: '1.0',
    id: row.id,
    source: `urn:rezics:log:${row.partition_no}.${row.epoch}`,
    type: row.type,
    ...(row.subject ? { subject: row.subject } : {}),
    time: row.recorded_at.toISOString(),
    datacontenttype: 'application/json',
    sequence: row.position.padStart(19, '0'),
    data: row.data,
  }));
}

async function reportEvent(reportId: string): Promise<CloudEvent> {
  const { rows } = await system.database.pool.query<OutboxRow>(
    `SELECT partition_no,position::text,event_seq,epoch,id::text,type,subject,data,recorded_at
     FROM core.outbox WHERE type='com.rezics.content.report.created.v1' AND data->>'reportId'=$1
     ORDER BY position DESC,event_seq LIMIT 1`,
    [reportId],
  );
  const row = rows[0];
  if (!row) throw new Error('Native report route did not write its locator event');
  return {
    specversion: '1.0',
    id: row.id,
    source: `urn:rezics:log:${row.partition_no}.${row.epoch}`,
    type: row.type,
    ...(row.subject ? { subject: row.subject } : {}),
    time: row.recorded_at.toISOString(),
    datacontenttype: 'application/json',
    sequence: row.position.padStart(19, '0'),
    data: row.data,
  };
}

async function applyAuthorEvents(person: Person, threadId: string) {
  const effect = createAuthorItemEffect(system.database.pool);
  const list = await events(person.accountId, threadId);
  expect(list).toHaveLength(1);
  for (const event of list) await effect.run(event);
}

async function waitForLockedStatement(pattern: string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const { rows } = await system.database.pool.query<{ pid: number }>(
      `SELECT pid FROM pg_stat_activity
       WHERE pid <> pg_backend_pid() AND state='active' AND wait_event_type='Lock' AND query LIKE $1 LIMIT 1`,
      [pattern],
    );
    if (rows.length) return;
    await Bun.sleep(10);
  }
  throw new Error(`Erasure fence close did not wait on its expected lock: ${pattern}`);
}

beforeAll(async () => {
  system = await createNativeContentSystemWithWriteRateOverrides(
    { databaseUrl: process.env.DATABASE_URL! },
    HIGH_RATE_OVERRIDES,
  );
  await bootstrapRelease(system.database.pool, bundledRelease);
  const setup = fixed();
  const { space } = await request<{ space: { spaceId: string } }>(setup, 'POST', '/v1/spaces', {
    title: 'Locator fence space',
    summary: '',
  });
  const { realm } = await request<{ realm: { realmId: string; headRevisionId: string } }>(setup, 'POST', '/v1/realms', {
    spaceId: space.spaceId,
    title: 'Locator fence realm',
    visibility: 'public',
    contextId: GLOBAL_CONTEXT,
  });
  const { subject: scheme } = await request<{ subject: { id: string } }>(setup, 'POST', '/v1/subjects', {
    type: 'skos:ConceptScheme',
    labels: { en: 'Locator fence scheme' },
  });
  const { subject: concept } = await request<{ subject: { id: string } }>(setup, 'POST', '/v1/subjects', {
    type: 'skos:Concept',
    labels: { en: 'Locator fence board' },
    statements: {
      'skos:inScheme': [{ property: { id: 'skos:inScheme' }, value: { type: 'value', content: scheme.id } }],
    },
  });
  const assigned = await request<{ realm: { headRevisionId: string } }>(
    setup,
    'PUT',
    `/v1/realms/${realm.realmId}/boardScheme`,
    { schemeId: scheme.id },
    realm.headRevisionId,
  );
  void assigned;
  const { board } = await request<{ board: { id: string } }>(setup, 'POST', `/v1/realms/${realm.realmId}/boards`, {
    conceptId: concept.id,
    title: 'Locator fence board',
    visibility: 'published',
  });
  boardId = board.id;
});

afterAll(async () => {
  await system?.close();
});

test('a content locator effect that runs after the account fence closes writes no locator and erases or minimizes its item', async () => {
  const person = await createPerson();
  const thread = await createThread(person, 'Late locator');
  await request(
    person,
    'POST',
    `/v1/posts/${thread.firstPost.id}/revisions`,
    {
      body: fromPlainText('Second revision'),
      licence: 'CC0-1.0',
      subjectIds: [],
    },
    thread.firstPost.revisionId,
  );
  const target = (
    await request<{ thread: Thread }>(fixed(), 'POST', '/v1/threads', {
      boardId,
      title: 'Late report target',
      body: fromPlainText('Late report target body'),
      licence: 'CC0-1.0',
      subjectIds: [],
      visibility: 'published',
    })
  ).thread;
  await grant(person, target.firstPost.id, ['report:create']);
  const { reportId } = await request<{ reportId: string }>(person, 'POST', '/v1/reports', {
    target: { kind: 'post', id: target.firstPost.id },
    reason: 'other',
    evidence: 'Private evidence erased after the fence closes',
  });
  const report = await reportEvent(reportId);
  await erase(person);
  await closeFence(person.accountId);

  expect(await eraseAccountAuthoredPage({ pool: system.database.pool }, person.accountId, null)).toEqual({
    next: null,
    found: 0,
  });
  const reactions = await eraseAccountReactionsPage({ pool: system.database.pool }, person.accountId, null);
  expect(reactions).toEqual({ next: { phase: 'reports', after: null }, found: 0 });
  expect(await eraseAccountReactionsPage({ pool: system.database.pool }, person.accountId, reactions.next)).toEqual({
    next: null,
    found: 0,
  });

  const effect = createAuthorItemEffect(system.database.pool);
  for (const event of await events(person.accountId, thread.id)) await effect.run(event);
  await createReportLocatorEffect(system.database.pool).run(report);

  expect(
    (
      await system.database.pool.query('SELECT 1 FROM content.author_item WHERE route=$1 AND author_account_id=$2', [
        routeOf(person.accountId),
        person.accountId,
      ])
    ).rows,
  ).toEqual([]);
  const post = (
    await system.database.pool.query(
      `SELECT p.author_erased,r.availability,r.body,r.search_text
       FROM content.post p JOIN content.revision r ON r.route=p.route AND r.post_id=p.post_id
       WHERE p.post_id=$1 ORDER BY r.recorded_at`,
      [thread.firstPost.id],
    )
  ).rows;
  expect(post).toHaveLength(2);
  expect(post.filter((row) => row.author_erased)).toHaveLength(2);
  expect(post.filter((row) => row.availability === 'available')).toHaveLength(1);
  expect(
    post.filter((row) => row.availability === 'erased' && row.body === null && row.search_text === null),
  ).toHaveLength(1);
  const lateItems = await system.database.pool.query<{ locator: string; resolved: boolean }>(
    `SELECT locator,resolved_at IS NOT NULL AS resolved FROM access.erasure_late_item
     WHERE route=$1 AND account_id=$2 AND participant='content'`,
    [routeOf(person.accountId), person.accountId],
  );
  expect(lateItems.rows.sort((a, b) => a.locator.localeCompare(b.locator))).toEqual([
    { locator: `author_item:post:${routeOf(person.accountId)}:${thread.firstPost.id}`, resolved: true },
    { locator: `author_item:thread:${routeOf(person.accountId)}:${thread.id}`, resolved: true },
    { locator: `report:${routeOf(reportId)}:${reportId}`, resolved: true },
  ]);
  expect(
    (
      await system.database.pool.query(
        'SELECT reporter_account_id,evidence,reporter_erased FROM content.report WHERE route=$1 AND report_id=$2',
        [routeOf(reportId), reportId],
      )
    ).rows,
  ).toEqual([{ reporter_account_id: null, evidence: null, reporter_erased: true }]);
  expect(
    (
      await system.database.pool.query(
        'SELECT 1 FROM content.report_reporter WHERE route=$1 AND reporter_account_id=$2 AND report_id=$3',
        [routeOf(person.accountId), person.accountId, reportId],
      )
    ).rows,
  ).toEqual([]);
});

test('a content locator committed before the fence closes is found by its erasure page, and closing waits for a locator transaction in progress', async () => {
  const person = await createPerson();
  const thread = await createThread(person, 'Committed locator');
  await applyAuthorEvents(person, thread.id);
  const inFlightThread = await createThread(person, 'In-flight locator');
  const inFlightEvent = (await events(person.accountId, inFlightThread.id)).find(
    (event) => event.type === 'com.rezics.content.thread.created.v1',
  );
  if (!inFlightEvent) throw new Error('Native thread route did not write its author locator event');
  const creation = inFlightEvent.data as {
    actorId: string;
    threadId: string;
    kind: 'discussion' | 'review';
    activityAt: string;
  };
  const source = /^urn:rezics:log:(\d+)\.(\d+)$/.exec(inFlightEvent.source);
  const sourceEpoch = Number(source?.[2]);
  const home = routeOf(person.accountId)!;
  if (!source || Number(source[1]) !== partitionOf(routeOf(inFlightThread.id)!) || !Number.isInteger(sourceEpoch))
    throw new Error('Author locator event source is invalid');
  const sourcePosition = BigInt(inFlightEvent.sequence).toString();
  await erase(person);

  const inFlight = await system.database.pool.connect();
  const closer = await system.database.pool.connect();
  try {
    await inFlight.query('BEGIN');
    await lockErasureFence(inFlight, person.accountId);
    await inFlight.query(
      `INSERT INTO content.author_item
         (route,author_account_id,item_kind,item_id,thread_id,thread_kind,created_at,source_epoch,source_position)
       VALUES ($1,$2,'thread',$3,$3,$4,$5::timestamptz,$6,$7::bigint)`,
      [home, creation.actorId, creation.threadId, creation.kind, creation.activityAt, sourceEpoch, sourcePosition],
    );
    let closed = false;
    await closer.query('BEGIN');
    const closing = closeErasureFence(closer, person.accountId).then((value) => {
      closed = true;
      return value;
    });
    await waitForLockedStatement('%content.erasure_fence%');
    expect(closed).toBe(false);
    await inFlight.query('COMMIT');
    await closing;
    await closer.query('COMMIT');
  } catch (error) {
    await inFlight.query('ROLLBACK').catch(() => {});
    await closer.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    inFlight.release();
    closer.release();
  }
  const page = await eraseAccountAuthoredPage({ pool: system.database.pool }, person.accountId, null);
  expect(page.found).toBeGreaterThan(0);
  expect(page.next).toBeNull();
  expect(
    (
      await system.database.pool.query('SELECT 1 FROM content.author_item WHERE route=$1 AND author_account_id=$2', [
        home,
        person.accountId,
      ])
    ).rows,
  ).toEqual([]);
});
