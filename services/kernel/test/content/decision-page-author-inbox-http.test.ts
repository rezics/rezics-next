import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { accountDeletionRuntime, deletePersona } from '../support/account-deletion.ts';
import source from '../../src/content/decision-page-source.sql';
import { SESSION_HEADER } from '../../src/http/request.ts';
import {
  capturePointEvent,
  createNativePointFixture,
  type NativePointFixture,
} from './moderation-native-point-fixture.ts';
import { observeSql } from './support/sql-observer.ts';

let fixture: NativePointFixture;
beforeAll(async () => {
  fixture = await createNativePointFixture();
}, 120_000);
afterAll(async () => {
  await fixture?.close();
});

test('the mounted takedown notice opens its exact decision and the author Inbox retires on erasure', async () => {
  const target = await fixture.createThread(fixture.mainBoardId, 'Native decision Inbox opening');
  await fixture.grant(target.postId, ['moderation:takedown']);
  const nextEvent = await capturePointEvent(fixture.system.database.pool, target.postId);
  await fixture.command(
    'POST',
    `/v1/posts/${target.postId}:takeDown`,
    { reason: 'Retained private statement' },
    { bearer: fixture.moderator.bearer, expectedStatus: 200 },
  );
  const envelope = await nextEvent();
  const { rows } = await fixture.system.database.pool.query<{ decision_id: string }>(
    'SELECT decision_id FROM content.moderation_decision WHERE route=$1 AND target_id=$2',
    [target.postRoute, target.postId],
  );
  expect(rows).toHaveLength(1);
  const decisionId = rows[0]!.decision_id;
  const decisionPath = `/v1/moderation-decisions/${decisionId}`;

  const worker = await fixture.startWork();
  await worker.produce(envelope, ['content_moderation_decision']);

  const inboxPath = `/v1/accounts/${fixture.author.accountId}/notifications?limit=10`;
  const inbox = await fixture.call('GET', inboxPath, { bearer: fixture.author.bearer });
  expect(inbox.response.status).toBe(200);
  const item = (inbox.value?.items as Array<Record<string, any>> | undefined)?.find(
    (candidate) => candidate.decisionId === decisionId,
  );
  expect(item).toMatchObject({
    kind: 'moderation_decision',
    decisionId,
    actions: { open: { kind: 'moderation_decision', decisionId } },
  });
  const exact = await fixture.call('GET', decisionPath, { bearer: fixture.author.bearer });
  expect(exact.response.status).toBe(200);
  expect(exact.value).toMatchObject({
    id: decisionId,
    targetId: target.postId,
    statement: 'Retained private statement',
    viewer: { affectedAuthor: true },
  });
  expect((await fixture.call('GET', inboxPath, { bearer: fixture.reader.bearer })).response.status).toBe(404);

  const observer = observeSql(fixture.system.database.pool);
  const barrier = observer.hold({ statement: source.sql }, 'after');
  const reading = fixture.call('GET', inboxPath, { bearer: fixture.author.bearer });
  let result: Awaited<ReturnType<typeof fixture.call>> | undefined;
  try {
    await barrier.entered;
    const clientId = `decision_page_delete_${randomUUID().replaceAll('-', '')}`;
    const scopes = [...new Set([...fixture.system.auth.ordinaryScopes, 'account:delete'])];
    await fixture.system.nativeAuth.internal.registerClient({ clientId, firstParty: true, scopes });
    await fixture.system.auth.issue({ accountId: fixture.author.accountId, clientId, scopes });
    await deletePersona(
      { pool: fixture.system.database.pool, auth: accountDeletionRuntime(fixture.system).auth },
      fixture.author,
    );
  } finally {
    barrier.release();
    result = await reading;
    await observer.close();
    await fixture.stopWork();
  }

  expect(result?.response.status).toBe(404);
  expect(result?.value?.code).toBe('not_found');
  expect(result?.response.headers.get(SESSION_HEADER)).toBeNull();
  expect(result?.text).not.toContain(decisionId);
  expect(result?.text).not.toContain('Retained private statement');
}, 300_000);
