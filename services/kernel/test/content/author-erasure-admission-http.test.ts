import { expect, test } from 'bun:test';
import { AccessUnavailableError } from '../../src/access/unavailable.ts';
import readEndpoints from '../../src/content/read-first-erasure-post.sql';
import { createKernel } from '../../src/http/kernel.ts';
import { newId } from '../../src/route/route.ts';
import { checkGrowth, openGrowthDatabase } from '../support/growth.ts';
import { createAuthorErasureFixture, type AuthorErasureFixture } from './author-erasure-native-operation-fixture.ts';
import { observeSql } from './support/sql-observer.ts';

async function revokeOwner(f: AuthorErasureFixture, route: number, id: string, accountId: string) {
  const { rows } = await f.pool.query<{ valid: string }>(
    `SELECT valid::text FROM access.resource_role_grant WHERE route=$1 AND resource_id=$2 AND subject_id=$3
     AND grant_role='content.post.owner' AND upper_inf(valid)`,
    [route, id, accountId],
  );
  expect(rows).toHaveLength(1);
  await f.command(
    '/v1/roleGrants:revoke',
    {
      resource: { route, id },
      subject: { kind: 'account', id: accountId },
      role: 'content.post.owner',
      valid: rows[0]!.valid,
    },
    f.governance,
    200,
  );
}

function privateAdmission(value: Record<string, unknown> | null, authorId: string, mayErase: boolean) {
  expect(value?.authorErasure).toEqual({ authorId, mayErase });
  expect(Object.keys(value?.authorErasure as object).sort()).toEqual(['authorId', 'mayErase']);
}

test('A currently readable thread supplies native acting-author erasure admission from the actual first authored post with bounded seeks and final disclosure, and the existing consumer uses it without inferred or stale authority', async () => {
  const f = await createAuthorErasureFixture();
  try {
    const scope = await f.scope(2, 1);
    const path = `/v1/threads/${scope.threadId}`;
    const otherFirst = scope.otherPosts[0]!;
    await f.reply(scope, f.other, 'A later displayed own post cannot supply first-post authority');
    const observer = observeSql(f.pool);
    try {
      const anonymous = await f.call('GET', path);
      expect(anonymous.response.status).toBe(200);
      expect(anonymous.value).not.toHaveProperty('authorErasure');
      expect(observer.records.filter(({ statement }) => statement === readEndpoints.sql)).toHaveLength(0);
      for (const credential of [f.author, f.other]) {
        const result = await f.call('GET', path, { bearer: credential.bearer });
        expect(result.response.status).toBe(200);
        expect(result.response.headers.get('cache-control')).toBe('private, no-store');
        privateAdmission(result.value, credential.actor.accountId, true);
      }
      const seeks = observer.records.filter(({ statement }) => statement === readEndpoints.sql);
      expect(seeks).toHaveLength(2);
      expect(seeks.map(({ parameters }) => parameters[readEndpoints.params.indexOf('author_id')])).toEqual([
        f.author.actor.accountId,
        f.other.actor.accountId,
      ]);
      const noPosts = await f.call('GET', path, { bearer: f.system.actors.moderator.bearer });
      expect(noPosts.response.status).toBe(200);
      privateAdmission(noPosts.value, f.system.actors.moderator.actor.accountId, false);
      // The opening belongs to the author; the other actor's actual first post is
      // a reply. Revoking only that reply must deny despite their later own post.
      await revokeOwner(f, scope.route, otherFirst.id, f.other.actor.accountId);
      const denied = await f.call('GET', path, { bearer: f.other.bearer });
      expect(denied.response.status).toBe(200);
      privateAdmission(denied.value, f.other.actor.accountId, false);
      privateAdmission((await f.call('GET', path, { bearer: f.author.bearer })).value, f.author.actor.accountId, true);
      // A genuine unavailable seek cannot masquerade as an empty/denied selection.
      observer.armFault({
        match: { statement: readEndpoints.sql },
        boundary: 'before',
        error: new AccessUnavailableError('overloaded'),
      });
      const unavailable = await f.call('GET', path, { bearer: f.author.bearer });
      expect(unavailable.response.status).toBe(503);
      expect(unavailable.value).not.toHaveProperty('authorErasure');
      expect(unavailable.value).not.toHaveProperty('thread');
      expect((await f.call('GET', path)).response.status).toBe(200);
      // Pause admission after its actual prefix seek, then revoke the containing
      // board through the native command before final disclosure.
      const barrier = observer.hold({ statement: readEndpoints.sql }, 'after');
      const reading = f.call('GET', path, { bearer: f.author.bearer });
      try {
        await barrier.entered;
        const boardId = anonymous.value!.thread.boardId as string;
        await f.command(
          `/v1/boards/${boardId}:takeDown`,
          { reason: 'Current containing board is hidden' },
          f.governance,
          200,
        );
      } finally {
        barrier.release();
      }
      const revoked = await reading;
      const missing = await f.call('GET', `/v1/threads/${newId(scope.route)}`, { bearer: f.author.bearer });
      const hidden = await f.call('GET', path, { bearer: f.author.bearer });
      for (const result of [revoked, hidden, missing]) {
        expect(result.response.status).toBe(404);
        expect(result.value).not.toHaveProperty('authorErasure');
        expect(result.value).not.toHaveProperty('thread');
        expect(result.text).not.toContain('Private author opening sentinel');
      }
      const problem = (value: Record<string, unknown> | null) => {
        const { request_id, ...rest } = value!;
        expect(request_id).toBeString();
        return rest;
      };
      expect(problem(revoked.value)).toEqual(problem(missing.value));
      expect(problem(hidden.value)).toEqual(problem(missing.value));
      expect(observer.records.filter(({ statement }) => statement === readEndpoints.sql)).toHaveLength(7);
    } finally {
      await observer.close();
    }
  } finally {
    await f.close();
  }
}, 120_000);

test('author erasure read admission keeps actual statements and rows constant at three author-history scales', async () => {
  const f = await createAuthorErasureFixture();
  let db: Awaited<ReturnType<typeof openGrowthDatabase>> | undefined;
  try {
    const scope = await f.scope(2, 1);
    const unrelated = await f.scope(1, 1);
    const endpoints = await f.pool.query<{ post_id: string; at: string }>(
      'SELECT post_id,created_at::text AS at FROM content.post WHERE route=$1 AND post_id=ANY($2::uuid[]) ORDER BY created_at,post_id',
      [scope.route, scope.posts.map(({ id }) => id)],
    );
    expect(endpoints.rows).toHaveLength(2);
    db = await openGrowthDatabase(f.pool.options.connectionString!);
    const app = createKernel({
      pool: db.pool,
      access: () => f.system.access,
      routeKey: f.system.routeKey,
      tokens: f.system.tokenKeys,
    });
    const report = await checkGrowth(db, {
      name: 'current native author erasure admission',
      scales: [4, 16, 64],
      repetitions: 2,
      bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
      async grow(_db, scale, previous) {
        for (let index = previous; index < scale; index++) {
          const post = await f.reply(scope, f.author, `Same-thread author history ${index}`);
          await f.reply(unrelated, f.author, `Unrelated thread author history ${index}`);
          // Fixture ordering holds both actual selected endpoints fixed. No row
          // in the chain or Access membership/grant population changes.
          await f.pool.query(
            `UPDATE content.post SET created_at=($3::timestamptz + ($4::timestamptz-$3::timestamptz)/2)
            WHERE route=$1 AND post_id=$2`,
            [scope.route, post.id, endpoints.rows[0]!.at, endpoints.rows[1]!.at],
          );
        }
      },
      async operation() {
        const response = await app.handle(
          new Request(`https://content.test/v1/threads/${scope.threadId}`, {
            headers: { authorization: `Bearer ${f.author.bearer}` },
          }),
        );
        expect(response.status).toBe(200);
        privateAdmission(await response.json(), f.author.actor.accountId, true);
      },
    });
    expect(report.samples.map(({ scale }) => scale)).toEqual([4, 16, 64]);
    for (const sample of report.samples)
      for (const cost of sample.repetitions) {
        expect(cost.rows).toBeGreaterThan(0);
        expect(cost.statements).toBeGreaterThan(0);
        expect(cost.relations['content.post']).toBeDefined();
      }
    const current = await f.pool.query<{ post_id: string; upper_post_id: string }>(
      readEndpoints.sql,
      readEndpoints.params.map(
        (name) =>
          ({
            route: scope.route,
            thread_id: scope.threadId,
            author_id: f.author.actor.accountId,
            at: new Date().toISOString(),
          })[name],
      ),
    );
    expect(current.rows).toMatchObject([
      { post_id: endpoints.rows[0]!.post_id, upper_post_id: endpoints.rows[1]!.post_id },
    ]);
  } finally {
    await db?.close();
    await f.close();
  }
}, 120_000);
