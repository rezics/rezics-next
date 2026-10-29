import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createAuthService } from '@rezics/auth';
import { bundledRelease } from '@rezics/definitions/bundled';
import { exportJWK, generateKeyPair } from 'jose';
import { Pool } from 'pg';
import { Value } from 'typebox/value';
import { readAccount } from '../../src/access/account-data.ts';
import { createAccess, INTERNAL_ACTIONS } from '../../src/access/index.ts';
import { createGrantCommands } from '../../src/access/grant-commands.ts';
import { CONTENT_EVENTS } from '../../src/content/events.ts';
import { setupContent } from '../../src/content/setup.ts';
import { bootstrapRelease } from '../../src/semantic/definitions.ts';
import type { Actor } from '../../src/request/access.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { openGrowthDatabase } from '../support/growth.ts';
import { observeSql } from './support/sql-observer.ts';
import { trustedAccessPorts } from '../support/trusted-access.ts';
import { dropTestDatabase } from '../support/drop-test-database.ts';

export const request = () => ({
  idempotencyKey: crypto.randomUUID(),
  requestId: crypto.randomUUID(),
  deadline: Date.now() + 30_000,
});
export const kinds = ['upvote', 'downvote', 'like', 'love', 'laugh', 'insightful', 'sad'] as const;
export async function reactionFixture() {
  const db = await openGrowthDatabase();
  db.pool.options.max = 1;
  await bootstrapRelease(db.pool, bundledRelease);
  await setupContent(db.pool);
  const home = 0x7131,
    targetRoute = 0x4231,
    boardRoute = 0x5231;
  const accountId = newId(home),
    managerId = newId(0x8131);
  const authName = `reactions_auth_${process.pid}`;
  const authUrl = new URL(db.url);
  authUrl.pathname = `/${authName}`;
  await db.admin.query(`CREATE DATABASE ${authName}`);
  const { migrate } = await import(new URL('../../../auth/scripts/database.ts', import.meta.url).href);
  migrate(authUrl.href);
  const authPool = new Pool({ connectionString: authUrl.href });
  const key = {
    ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)),
    kid: 'reactions-fixture',
  };
  const issuer = 'https://reactions.auth.test';
  const actions = [
    'reaction:set',
    'access:grant',
    'account:read',
    'account:delete',
    'board:read',
    'thread:read',
    'post:read',
    'subject:read',
  ];
  const approvals = new Set([accountId, managerId]);
  const auth = await createAuthService({
    database: authPool,
    issuer,
    audience: 'https://api.rezics.test',
    secret: 'reactions-fixture-secret-with-at-least-32-bytes',
    signing: { activeKid: key.kid, privateKeys: [key] },
    trustedAccess: trustedAccessPorts({
      async readAccount(id) {
        const row = await readAccount(db.admin, routeOf(id)!, id);
        return (
          row && {
            accountId: id,
            kind: row.kind,
            state: row.state,
            authnEpoch: Number(row.minimumAuthnEpoch),
            automated: false,
          }
        );
      },
      async authorizeProvisioning(reference) {
        if (!approvals.delete(reference)) throw new Error('Missing fixture approval');
        return { accountId: reference };
      },
    }),
  });
  await auth.internal.registerClient({ clientId: 'web', firstParty: true, scopes: actions });
  const access = createAccess({
    actions: new Map(
      actions.map((action) => [action, INTERNAL_ACTIONS.get(action) ?? { anonymous: action.endsWith(':read') }]),
    ),
    auth: {
      issuer,
      audience: 'https://api.rezics.test',
      jwksUrl: `${issuer}/.well-known/jwks.json`,
      fetch: (url, init) => auth.handler(new Request(url, init)),
    },
  });
  const tokens = new Map<string, string>();
  for (const id of [accountId, managerId]) {
    await db.admin.query(
      `INSERT INTO access.account(route,account_id,kind,state,transaction_id) VALUES ($1,$2,'actor','pending',$2)`,
      [routeOf(id), id],
    );
    await auth.internal.provisionPassword({
      authorization: id,
      email: `${id}@example.test`,
      password: 'reactions-password',
    });
    await db.admin.query(`UPDATE access.account SET state='active' WHERE route=$1 AND account_id=$2`, [
      routeOf(id),
      id,
    ]);
    const post = (path: string, body: unknown, cookie = '') =>
      auth.handler(
        new Request(`${issuer}${path}`, {
          method: 'POST',
          headers: { origin: issuer, 'content-type': 'application/json', cookie },
          body: JSON.stringify(body),
        }),
      );
    const login = await post('/signin', {
      email: `${id}@example.test`,
      password: 'reactions-password',
      client_id: 'web',
      scope: actions,
    });
    expect(login.status).toBe(200);
    const issued = await post(
      '/token',
      {},
      login.headers
        .getSetCookie()
        .map((v) => v.split(';')[0])
        .join('; '),
    );
    expect(issued.status).toBe(200);
    tokens.set(id, ((await issued.json()) as { access_token: string }).access_token);
  }
  const verified = (id = accountId) =>
    access.authenticate(tokens.get(id)!, { pool: db.pool, deadline: Date.now() + 180_000 });
  const manager = await verified(managerId);
  const grants = createGrantCommands({ pool: db.pool, access, managementAction: 'access:grant' });
  async function grant(resourceId: string, actionsToGrant: string[]) {
    // Subject reactions use the Global standing installed above; keep target grants for threads and posts.
    if (actionsToGrant.includes('reaction:set')) {
      const subject = await db.admin.query('SELECT 1 FROM semantic.subject WHERE route=$1 AND subject_id=$2', [
        routeOf(resourceId),
        resourceId,
      ]);
      if (subject.rowCount) actionsToGrant = actionsToGrant.filter((action) => action !== 'reaction:set');
    }
    if (actionsToGrant.length === 0) return;
    // Only bootstrap the fixture administrator; the reacting account receives real grant commands.
    for (const action of ['access:grant', ...actionsToGrant])
      await db.admin.query(
        `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id) VALUES ($1,$2,$3,$4,'(,)',$3) ON CONFLICT DO NOTHING`,
        [routeOf(resourceId), resourceId, managerId, action],
      );
    await grants.create(
      { pool: db.pool, actor: manager, deadline: Date.now() + 30_000 },
      {
        resource: { route: routeOf(resourceId)!, id: resourceId },
        subject: { kind: 'account', id: accountId },
        actions: actionsToGrant,
        valid: '(,)',
        key: crypto.randomUUID(),
      },
    );
  }
  async function target() {
    const board = newId(boardRoute),
      thread = newId(targetRoute),
      post = newId(targetRoute),
      revision = newId(targetRoute);
    const client = await db.admin.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO content.board(route,board_id,subject_id,title,visibility,security_revision,recorded_transaction_id) VALUES ($1,$2,$3,'Reactions','published',1,$3)`,
        [boardRoute, board, managerId],
      );
      await client.query(
        `INSERT INTO content.thread(route,thread_id,author_account_id,board_id,title,visibility,security_revision,recorded_transaction_id,first_post_id) VALUES ($1,$2,$3,$4,'Reactions','published',1,$3,$5)`,
        [targetRoute, thread, managerId, board, post],
      );
      await client.query(
        `INSERT INTO content.post(route,thread_id,post_id,author_account_id,head_revision_id,visibility,security_revision,recorded_transaction_id) VALUES ($1,$2,$3,$4,$5,'published',1,$4)`,
        [targetRoute, thread, post, managerId, revision],
      );
      await client.query(
        `INSERT INTO content.revision(route,thread_id,post_id,revision_id,body,body_sha256,search_text,licence,subject_ids,board_id,availability,recorded_transaction_id) VALUES ($1,$2,$3,$4,$5,sha256($5),'body','CC0-1.0','{}',$6,'available',$7)`,
        [targetRoute, thread, post, revision, Buffer.from('body'), board, managerId],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    for (const id of [thread, post]) await grant(id, ['reaction:set']);
    return { board, thread, post, revision };
  }
  async function effects() {
    return (
      await db.admin.query(
        `SELECT (SELECT count(*)::int FROM content.reaction) AS slots, (SELECT count(*)::int FROM core.outbox) AS events, (SELECT count(*)::int FROM core.receipt) AS receipts`,
      )
    ).rows[0];
  }
  return {
    db,
    access,
    verified,
    bearer(id = accountId) {
      const token = tokens.get(id);
      if (!token) throw new Error(`No bearer token for ${id}`);
      return token;
    },
    accountId,
    managerId,
    home,
    targetRoute,
    target,
    grant,
    effects,
    async close() {
      await authPool.end();
      await dropTestDatabase(db.admin, authName);
      await db.close();
    },
  };
}

if (Bun.main === import.meta.path) {
  let f: Awaited<ReturnType<typeof reactionFixture>>;
  let commands: typeof import('../../src/content/reactions.ts');
  beforeAll(async () => {
    f = await reactionFixture();
    commands = await import('../../src/content/reactions.ts');
  }, 120_000);
  afterAll(async () => {
    await f?.close();
  });
  const deps = () => ({ pool: f.db.pool, access: f.access });
  test('one actor slot sets, changes and clears on readable thread and post, emitting exact actor-partition changes', async () => {
    const target = await f.target();
    const actor = await f.verified();
    for (const targetKind of ['thread', 'post'] as const) {
      const targetId = target[targetKind];
      let previousKind: string | null = null;
      for (const kind of [...kinds, null]) {
        const trace = observeSql(f.db.pool);
        const before = await f.effects();
        const result =
          kind === null
            ? await commands.clearReaction(deps(), actor, { targetKind, targetId }, request())
            : await commands.setReaction(deps(), actor, { targetKind, targetId, kind }, request());
        await trace.close();
        expect(result?.partition).toBe(partitionOf(f.home));
        const writes = trace.records.filter((r) => /(?:INSERT INTO|DELETE FROM) content\.reaction/i.test(r.statement));
        expect(writes).toHaveLength(1);
        expect(writes[0]!.parameters).toContain(f.home);
        expect(
          trace.records.filter((r) => r.statement.includes('minimum_authn_epoch::text AS "minimumAuthnEpoch"')),
        ).toHaveLength(1);
        const after = await f.effects();
        expect(after.events - before.events).toBe(1);
        const event = (
          await f.db.admin.query(
            `SELECT partition_no, type, data FROM core.outbox WHERE partition_no=$1 AND position=$2`,
            [result!.partition, result!.position.toString()],
          )
        ).rows[0];
        expect(event.partition_no).toBe(partitionOf(f.home));
        expect(event.type).toBe('com.rezics.content.reaction.changed.v1');
        expect(event.data).toEqual({ actorId: f.accountId, targetKind, targetId, previousKind, kind });
        expect(Value.Check(CONTENT_EVENTS['com.rezics.content.reaction.changed.v1'], event.data)).toBe(true);
        const rows = (
          await f.db.admin.query(
            `SELECT * FROM content.reaction WHERE route=$1 AND actor_account_id=$2 AND target_id=$3`,
            [f.home, f.accountId, targetId],
          )
        ).rows;
        expect(rows).toHaveLength(kind === null ? 0 : 1);
        if (kind !== null)
          expect(rows[0]).toMatchObject({ kind, target_kind: targetKind, target_route: f.targetRoute });
        const unchanged = await f.effects();
        if (kind === null) await commands.clearReaction(deps(), actor, { targetKind, targetId }, request());
        else await commands.setReaction(deps(), actor, { targetKind, targetId, kind }, request());
        expect(await f.effects()).toEqual(unchanged);
        previousKind = kind;
      }
    }
  });
  test('validation precedes all reads; non-account actors, suspension and inaccessible targets have no effects', async () => {
    const target = await f.target();
    const actor = await f.verified();
    const input = { targetKind: 'post' as const, targetId: target.post, kind: 'like' as const };
    const trace = observeSql(f.db.pool);
    await expect(
      commands.setReaction(deps(), actor, { ...input, kind: 'unknown' as 'like' }, request()),
    ).rejects.toThrow(TypeError);
    expect(trace.records).toHaveLength(0);
    await trace.close();
    async function denied(who: Actor = actor, value = input) {
      const before = await f.effects();
      await expect(commands.setReaction(deps(), who, value, request())).rejects.toThrow();
      await expect(commands.clearReaction(deps(), who, value, request())).rejects.toThrow();
      expect(await f.effects()).toEqual(before);
    }
    await denied({ kind: 'anonymous' });
    await f.db.admin.query(`UPDATE access.account SET state='suspended' WHERE route=$1 AND account_id=$2`, [
      f.home,
      f.accountId,
    ]);
    await denied();
    await f.db.admin.query(`UPDATE access.account SET state='active' WHERE route=$1 AND account_id=$2`, [
      f.home,
      f.accountId,
    ]);
    await denied(actor, { ...input, targetId: newId(f.targetRoute) });
    for (const [table, idColumn, id] of [
      ['board', 'board_id', target.board],
      ['thread', 'thread_id', target.thread],
      ['post', 'post_id', target.post],
    ]) {
      for (const visibility of ['protected', 'draft', 'taken_down']) {
        await f.db.admin.query(
          `UPDATE content.${table} SET visibility=$1, security_revision=security_revision+1 WHERE ${idColumn}=$2`,
          [visibility, id],
        );
        await denied();
      }
      await f.db.admin.query(
        `UPDATE content.${table} SET visibility='published', security_revision=security_revision+1 WHERE ${idColumn}=$1`,
        [id],
      );
    }
    await f.db.admin.query(
      `UPDATE content.post SET availability='erased',security_revision=security_revision+1 WHERE route=$1 AND post_id=$2`,
      [f.targetRoute, target.post],
    );
    await denied();
    await denied(actor, { ...input, targetKind: 'thread' as 'post', targetId: target.thread });
  });
  test('private read grants use production Access; receipts and concurrent writes preserve one slot and ordered previous kinds', async () => {
    const target = await f.target();
    const actor = await f.verified();
    await f.db.admin.query(
      `UPDATE content.thread SET visibility='protected',security_revision=security_revision+1 WHERE thread_id=$1`,
      [target.thread],
    );
    await f.grant(target.thread, ['thread:read']);
    const input = { targetKind: 'thread' as const, targetId: target.thread, kind: 'love' as const };
    const context = request();
    const first = await commands.setReaction(deps(), actor, input, context);
    const before = await f.effects();
    expect((await commands.setReaction(deps(), actor, input, context))?.transactionId).toBe(first!.transactionId);
    expect(await f.effects()).toEqual(before);
    await Promise.all(
      ['like', 'sad'].map((kind) =>
        commands.setReaction(deps(), actor, { ...input, kind: kind as 'like' | 'sad' }, request()),
      ),
    );
    const rows = (
      await f.db.admin.query(
        `SELECT kind FROM content.reaction WHERE route=$1 AND actor_account_id=$2 AND target_id=$3`,
        [f.home, f.accountId, target.thread],
      )
    ).rows;
    expect(rows).toHaveLength(1);
    expect(['like', 'sad']).toContain(rows[0].kind);
  });
}
