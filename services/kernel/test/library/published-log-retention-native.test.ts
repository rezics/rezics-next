import { afterAll, beforeAll, expect, test } from 'bun:test';
import pg from 'pg';
import { createPublishedLogRetentionRuntime } from './support/published-log-retention-runtime.ts';
import { compileSessionProfile, sessionScopes } from './support/session-profile-fixture.ts';
import { entryKey } from './support/profile-entry-fixture.ts';
import {
  PUBLISHED_LOG_RETENTION_SCHEDULE,
  PUBLISHED_LOG_RETENTION_SWEEP_WORKFLOW,
} from '../../src/library/published-log-retention.ts';
import { routeOf } from '../../src/route/route.ts';
import { createLifecycleCommands } from '../../src/access/lifecycle.ts';
import { deadlineFor } from '../../src/request/deadline.ts';
import { purgeAccountFactsPage } from '../../src/library/account-fact-purge.ts';

const origin = Date.parse('2026-10-29T12:00:00.000Z');
let time = origin;
let runtime: Awaited<ReturnType<typeof createPublishedLogRetentionRuntime>> | undefined;
let reader: pg.Pool | undefined;

beforeAll(async () => {
  runtime = await createPublishedLogRetentionRuntime(() => new Date(time));
  reader = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
    options: '-c default_transaction_read_only=on',
  });
  const { fixture: f } = runtime;
  await f.activate(await f.publish(await compileSessionProfile()));
  expect((await f.send('steward', 'POST', '/v1/platform/exposure/reading_progress:open')).status).toBe(200);
}, 120000);

afterAll(async () => {
  await runtime?.close();
  await reader?.end();
});

async function row(logId: string) {
  const result = await reader!.query(
    `SELECT route, log_id, deleted, revision, deletion_id, restore_until, account_id, session_id,
            subject_id, session_state, started_at, completed_at, note, published_at, transaction_id
     FROM library.published_log WHERE route=$1 AND log_id=$2`,
    [routeOf(logId), logId],
  );
  return result.rows[0] ?? null;
}

test('native exact expiry purge keeps only permitted public structural identity while terminal account erasure removes personal log payload and stale work cannot restore it', async () => {
  const { fixture: f, client } = runtime!;
  const scopes = [
    ...sessionScopes,
    'published_log:create',
    'published_log:read',
    'published_log:delete',
    'account:delete',
  ];
  const owner = await f.identity(scopes);
  const other = await f.identity(scopes);
  const unscoped = await f.identity([...sessionScopes, 'published_log:read']);
  const subjectId = await f.createSubject('game', 'Retention book');

  async function publish(bearer: string) {
    const started = await f.send(bearer, 'POST', '/v1/progressSessions', {
      subjectId,
      mode: 'scalar_amount',
      unit: 'minute',
    });
    expect(started.status).toBe(201);
    const session = (await started.json()).progressSession;
    const created = await f.send(bearer, 'POST', '/v1/publishedLogs', {
      sessionId: session.id,
      note: 'private retained note',
    });
    expect(created.status).toBe(201);
    return (await created.json()).publishedLog as {
      id: string;
      note: string;
      sessionState: string;
      startedAt: string;
      publishedAt: string;
    };
  }

  const first = await publish(owner.bearer);
  const sibling = await publish(owner.bearer);
  const revision = Number(
    (await f.send(owner.bearer, 'GET', `/v1/publishedLogs/${first.id}`)).headers.get('Library-Published-Log-Revision'),
  );
  expect(revision).toBe(1);
  expect(
    (await f.send(other.bearer, 'DELETE', `/v1/publishedLogs/${first.id}?revision=${revision}`, undefined, entryKey()))
      .status,
  ).toBe(404);
  expect(
    (
      await f.send(
        unscoped.bearer,
        'DELETE',
        `/v1/publishedLogs/${first.id}?revision=${revision}`,
        undefined,
        entryKey(),
      )
    ).status,
  ).toBe(403);
  expect(
    (await f.send('anonymous', 'DELETE', `/v1/publishedLogs/${first.id}?revision=${revision}`, undefined, entryKey()))
      .status,
  ).toBe(401);
  expect((await f.send(owner.bearer, 'DELETE', `/v1/publishedLogs/${first.id}`, undefined, entryKey())).status).toBe(
    409,
  );

  const deleteKey = entryKey();
  const removed = await f.send(
    owner.bearer,
    'DELETE',
    `/v1/publishedLogs/${first.id}?revision=${revision}`,
    undefined,
    deleteKey,
  );
  expect(removed.status).toBe(200);
  const deletionId = removed.headers.get('Library-Published-Log-Deletion-Id')!;
  const deletedRevision = Number(removed.headers.get('Library-Published-Log-Deletion-Revision'));
  expect(await removed.json()).toMatchObject({ publishedLog: { id: first.id } });
  const publicView = await f.send('anonymous', 'GET', `/v1/publishedLogs/${first.id}`);
  expect(await publicView.json()).toEqual({ publishedLog: { id: first.id, deleted: true } });
  const publicList = await f.send('anonymous', 'GET', `/v1/publishedLogs?accountId=${owner.actor.accountId}`);
  expect(publicList.status).toBe(200);
  expect((await publicList.json()).publishedLogs.map((log: { id: string }) => log.id)).not.toContain(first.id);

  const restoreBody = { deletionId, revision: deletedRevision };
  const restored = await f.send(owner.bearer, 'POST', `/v1/publishedLogs/${first.id}:restore`, restoreBody, entryKey());
  expect(restored.status).toBe(200);
  expect((await restored.json()).publishedLog).toMatchObject({
    id: first.id,
    note: first.note,
    sessionState: first.sessionState,
    startedAt: first.startedAt,
    publishedAt: first.publishedAt,
  });
  const retracted = await f.send(
    owner.bearer,
    'DELETE',
    `/v1/publishedLogs/${first.id}?revision=${deletedRevision + 1}`,
    undefined,
    entryKey(),
  );
  expect(retracted.status).toBe(200);
  const d3 = retracted.headers.get('Library-Published-Log-Deletion-Id')!;
  const d3Revision = Number(retracted.headers.get('Library-Published-Log-Deletion-Revision'));
  expect(d3).not.toBe(deletionId);

  const scheduled = await client.getSchedule(PUBLISHED_LOG_RETENTION_SCHEDULE);
  expect(scheduled).toMatchObject({
    workflowName: PUBLISHED_LOG_RETENTION_SWEEP_WORKFLOW,
    schedule: '*/10 * * * *',
    cronTimezone: 'UTC',
  });
  const located = await reader!.query(
    'SELECT restore_until::text FROM library.published_log WHERE route=$1 AND log_id=$2',
    [routeOf(first.id), first.id],
  );
  const deadline = new Date(located.rows[0]!.restore_until).toISOString();
  time = Date.parse(deadline);
  const atBoundary = await client.triggerSchedule(PUBLISHED_LOG_RETENTION_SCHEDULE);
  await atBoundary.getResult({ pollingIntervalMs: 20 });
  const minimized = await row(first.id);
  expect(minimized).toMatchObject({
    log_id: first.id,
    deleted: true,
    account_id: null,
    session_id: null,
    subject_id: null,
    session_state: null,
    started_at: null,
    completed_at: null,
    note: null,
    published_at: null,
    transaction_id: null,
    deletion_id: null,
    restore_until: null,
  });
  expect(minimized.revision).toBe(d3Revision);
  expect((await row(sibling.id))?.account_id).toBe(owner.actor.accountId);
  expect(await (await f.send('anonymous', 'GET', `/v1/publishedLogs/${first.id}`)).json()).toEqual({
    publishedLog: { id: first.id, deleted: true },
  });
  const staleRestore = await f.send(
    owner.bearer,
    'POST',
    `/v1/publishedLogs/${first.id}:restore`,
    { deletionId: d3, revision: d3Revision },
    entryKey(),
  );
  expect(staleRestore.status).toBe(409);
  expect(await staleRestore.json()).toMatchObject({ code: 'published_log_restore_expired' });

  await f.suspend(other.actor.accountId);
  expect((await f.send(other.bearer, 'GET', `/v1/publishedLogs/${sibling.id}`)).status).toBe(401);
  await f.revokeIdentity(unscoped.actor.accountId);
  expect((await f.send(unscoped.bearer, 'GET', `/v1/publishedLogs/${sibling.id}`)).status).toBe(401);

  const erasure = createLifecycleCommands({ pool: f.pool, access: f.access, clock: () => new Date(time) });
  const tombstoned = await erasure.tombstone(
    { actor: owner.actor, deadline: deadlineFor(30_000) },
    { accountId: owner.actor.accountId, key: entryKey() },
  );
  expect(tombstoned.value.accountId).toBe(owner.actor.accountId);
  const erased = await purgeAccountFactsPage(
    { pool: f.pool, clock: () => new Date(time) },
    { accountId: owner.actor.accountId, kind: 'published_log', after: null, limit: 100, stepKey: entryKey() },
  );
  expect(erased.value.removed).toBe(1);
  expect(
    (
      await reader!.query('SELECT log_id FROM library.published_log WHERE route=$1 AND account_id=$2', [
        routeOf(owner.actor.accountId),
        owner.actor.accountId,
      ])
    ).rows,
  ).toEqual([]);
  expect(await row(sibling.id)).toBeNull();
}, 600000);
