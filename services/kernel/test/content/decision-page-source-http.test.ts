import { afterAll, beforeAll, expect, test } from 'bun:test';
import { CommandUnavailableError } from '../../src/command/command.ts';
import source from '../../src/content/decision-page-source.sql';
import { SESSION_HEADER } from '../../src/http/request.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { createNativePointFixture, type NativePointFixture } from './moderation-native-point-fixture.ts';
import { observeSql } from './support/sql-observer.ts';

let fixture: NativePointFixture;
beforeAll(async () => {
  fixture = await createNativePointFixture();
}, 120_000);
afterAll(async () => {
  await fixture?.close();
});

async function decide(title: string) {
  const target = await fixture.createThread(fixture.mainBoardId, title);
  const grant = await fixture.grant(target.postId, ['moderation:takedown']);
  const result = await fixture.command<{ securityRevision: string }>(
    'POST',
    `/v1/posts/${target.postId}:takeDown`,
    { reason: 'Retained private statement' },
    { bearer: fixture.moderator.bearer, expectedStatus: 200 },
  );
  const { rows } = await fixture.system.database.pool.query<{
    decision_id: string;
  }>(
    `SELECT decision_id FROM content.moderation_decision
     WHERE route=$1 AND target_id=$2 AND security_revision=$3`,
    [target.postRoute, target.postId, result.securityRevision],
  );
  expect(rows).toHaveLength(1);
  return {
    target,
    grant,
    path: `/v1/moderation-decisions/${rows[0]!.decision_id}`,
  };
}

/** Pause the actual initial selection; the competing outcome uses a mounted command. */
async function changeDuringRead(path: string, bearer: string, change: () => Promise<unknown>) {
  const observer = observeSql(fixture.system.database.pool);
  const barrier = observer.hold({ statement: source.sql }, 'after');
  const reading = fixture.call('GET', path, { bearer });
  try {
    await barrier.entered;
    await change();
    barrier.release();
    const result = await reading;
    expect(result.response.status).toBe(404);
    expect(result.value?.code).toBe('not_found');
    expect(result.response.headers.get(SESSION_HEADER)).toBeNull();
    expect(result.text).not.toContain('Retained private statement');
  } finally {
    barrier.release();
    await reading;
    await observer.close();
  }
}

test('an exact private read retires across appeal creation and resolution, then reopens the actual outcome', async () => {
  const { target, path } = await decide('Exact appeal source');
  const open = () => fixture.call('GET', path, { bearer: fixture.author.bearer });
  expect(
    (
      await fixture.call('GET', `/v1/posts/${target.postId}`, {
        bearer: fixture.author.bearer,
      })
    ).response.status,
  ).toBe(404);
  const first = await open();
  expect(first.response.status).toBe(200);
  expect(first.value).toMatchObject({
    targetId: target.postId,
    statement: 'Retained private statement',
    appeal: null,
  });
  expect(first.value).not.toHaveProperty('witness');
  expect(first.value).not.toHaveProperty('decider_account_id');
  expect(first.response.headers.get(SESSION_HEADER)).not.toBeNull();
  expect((await fixture.call('GET', path, { bearer: fixture.other.bearer })).response.status).toBe(404);
  let appealId = '';
  await changeDuringRead(path, fixture.moderator.bearer, async () => {
    const appeal = await fixture.command<{ id: string }>('POST', `${path}:appeal`, {
      statement: 'Please reconsider',
    });
    appealId = appeal.id;
  });
  const pending = await open();
  expect(pending.value?.appeal).toMatchObject({
    id: appealId,
    outcome: null,
    resolvedAt: null,
  });
  expect(
    (
      await fixture.call('POST', `${path}:appeal`, {
        bearer: fixture.author.bearer,
        key: crypto.randomUUID(),
        body: { statement: 'Another appeal' },
      })
    ).response.status,
  ).toBe(409);
  const resolution = `/v1/moderation-appeals/${appealId}:resolve`;
  expect(
    (
      await fixture.call('POST', resolution, {
        bearer: fixture.moderator.bearer,
        key: crypto.randomUUID(),
        body: { outcome: 'uphold', statement: 'Original decider' },
      })
    ).response.status,
  ).toBe(403);
  await fixture.grant(target.postId, ['moderation:takedown'], fixture.other.accountId);
  await changeDuringRead(path, fixture.author.bearer, () =>
    fixture.command(
      'POST',
      resolution,
      { outcome: 'uphold', statement: 'Independent resolution' },
      { bearer: fixture.other.bearer, expectedStatus: 200 },
    ),
  );
  const head = () =>
    fixture.system.database.pool
      .query('SELECT epoch,position FROM core.partition WHERE partition_no=$1', [partitionOf(routeOf(target.postId)!)])
      .then(({ rows }) => rows);
  const before = await head();
  const resolved = await open();
  expect(resolved.response.status).toBe(200);
  expect(resolved.value?.appeal).toMatchObject({
    id: appealId,
    outcome: 'upheld',
    statement: 'Independent resolution',
  });
  expect(resolved.value?.appeal.resolvedAt).toBeString();
  expect(await head()).toEqual(before);
}, 120_000);

test('a current moderator loses exact disclosure when their native grant is revoked during selection', async () => {
  const { path, grant } = await decide('Revoked exact reader');
  await changeDuringRead(path, fixture.moderator.bearer, () =>
    fixture.command('POST', '/v1/grants:revoke', grant, {
      bearer: fixture.governance.bearer,
      expectedStatus: 200,
    }),
  );
  expect((await fixture.call('GET', path, { bearer: fixture.author.bearer })).response.status).toBe(200);
}, 120_000);

test('failure of the final exact source withholds the retained response and its session provenance', async () => {
  const { path } = await decide('Unavailable exact reader');
  const observer = observeSql(fixture.system.database.pool);
  try {
    observer.armFault({
      match: { statement: source.sql, occurrence: 2 },
      boundary: 'before',
      error: new CommandUnavailableError('deadline', 0),
    });
    const result = await fixture.call('GET', path, {
      bearer: fixture.author.bearer,
    });
    expect(result.response.status).toBe(503);
    expect(result.value?.code).toBe('deadline_exceeded');
    expect(result.response.headers.get(SESSION_HEADER)).toBeNull();
    expect(result.text).not.toContain('Retained private statement');
  } finally {
    await observer.close();
  }
}, 120_000);
