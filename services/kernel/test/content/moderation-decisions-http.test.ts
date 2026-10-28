import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { normalizeDocument } from '@rezics/document';
import { randomUUID } from 'node:crypto';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { openApiDocument } from '../../src/http/openapi.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import resourceRoles from '../../src/access/resource-roles.json';
import { resourceRoleCatalogue } from '../../src/access/resource-roles.ts';
import { standingFixture } from '../access/standing-fixture.ts';
import { checkGrowth, openGrowthDatabase } from '../support/growth.ts';
import { contentEffects } from '../../src/content/relays.ts';
import type { WorkClient } from '../../src/work/client.ts';
import type { CloudEvent } from '../../src/events/log.ts';

const routeKey = new Uint8Array(32).fill(17);
const tokens = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(18)]]) };
const snapshot = (text: string) =>
  normalizeDocument({
    version: 'rezics-document-v1',
    profile: 'text',
    doc: {
      type: 'doc',
      content: [{ type: 'paragraph', attrs: { id: 'decision-paragraph' }, content: [{ type: 'text', text }] }],
    },
  });

describe('moderation decisions through HTTP and committed effects', () => {
  let db: Awaited<ReturnType<typeof openGrowthDatabase>>;
  let fixture: Awaited<ReturnType<typeof standingFixture>>;
  let app: ReturnType<typeof createKernel>;
  const credentials = new Map<string, string>();
  const boardId = newId(0x4321);
  const reason = { reason: 'Policy violation' };

  beforeAll(async () => {
    db = await openGrowthDatabase();
    fixture = await standingFixture([
      'realm:read',
      'realm:manage',
      'realm:ban',
      'realm:publish',
      'realm:participate',
      'realm:join',
      'board:create',
      'account:read',
    ]);
    const catalogue = resourceRoleCatalogue(fixture.access);
    if (!catalogue) throw new Error('Fixture Access has no resource role catalogue');
    const roles = catalogue.roles as Map<string, readonly string[]>;
    for (const [role, actions] of Object.entries(resourceRoles.roles))
      if (role.startsWith('community.realm.')) roles.set(role, actions);
    (catalogue.types as Map<string, Readonly<{ owner?: string; standing: readonly string[] }>>).set(
      'community.realm',
      resourceRoles.types['community.realm'],
    );
    await fixture.reset();
    const authenticate = fixture.access.authenticate;
    let issued = '';
    fixture.access.authenticate = (token, boundary) => {
      issued = token;
      return authenticate(token, { ...boundary, pool: db.pool });
    };
    try {
      for (const id of [fixture.actor, fixture.principal, fixture.recipient]) {
        await fixture.context(id);
        credentials.set(id, issued);
      }
    } finally {
      fixture.access.authenticate = authenticate;
    }
    app = createKernel({
      pool: db.pool,
      routeKey,
      tokens,
      access: fixture.access,
      writeRate: createWriteRateLimiter({ secret: 'moderation-http-fixture-secret-at-least-32-bytes' }),
    });
    await db.admin.query(
      `INSERT INTO content.board
       (route,board_id,subject_id,title,visibility,security_revision,recorded_transaction_id)
       VALUES ($1,$2,$3,'Moderation board','published',1,$4)`,
      [routeOf(boardId), boardId, newId(0x6789), randomUUID()],
    );
    await fixture.grant(fixture.actor, 'thread:create', { route: routeOf(boardId)!, id: boardId });
    await fixture.grant(fixture.actor, 'board:read', { route: routeOf(boardId)!, id: boardId });
    // Author erasure initiation requires the initiator's own account read as well as post:erase.
    await fixture.grant(fixture.actor, 'account:read', { route: routeOf(fixture.actor)!, id: fixture.actor });
  });
  afterAll(async () => {
    await fixture?.close();
    await db?.close();
  });

  async function call(
    method: string,
    path: string,
    body?: unknown,
    key: string = randomUUID(),
    account: string | null = fixture.actor,
  ) {
    const response = await app.handle(
      new Request(`http://kernel.test${path}`, {
        method,
        headers: {
          ...(account === null ? {} : { authorization: `Bearer ${credentials.get(account)}` }),
          ...(method === 'POST' ? { 'idempotency-key': JSON.stringify(key) } : {}),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
    return { response, body: await response.json() };
  }
  async function create(text = 'Authored erasure sentinel', targetBoard = boardId) {
    const result = await call('POST', '/v1/threads', {
      title: 'Erasure title sentinel',
      body: snapshot(text),
      licence: 'MIT',
      subjectIds: [],
      boardId: targetBoard,
      visibility: 'published',
    });
    expect(result.response.status).toBe(201);
    return result.body.thread;
  }

  async function decide(kind: 'thread' | 'post' = 'thread') {
    const thread = await create();
    const id = kind === 'thread' ? thread.id : thread.firstPost.id;
    await fixture.grant(fixture.principal, 'moderation:takedown', { route: routeOf(id)!, id });
    const key = randomUUID();
    const path = `/v1/${kind === 'thread' ? 'threads' : 'posts'}/${id}:takeDown`;
    const result = await call('POST', path, reason, key, fixture.principal);
    expect(result.response.status).toBe(200);
    return { thread, id, key, path, result };
  }
  async function deliver(id: string) {
    const effect = contentEffects(db.pool, {} as WorkClient).find(
      (effect) => effect.name === 'content_moderation_decision',
    );
    expect(effect).toBeDefined();
    const { rows } = await db.admin.query(
      "SELECT * FROM core.outbox WHERE type='com.rezics.content.moderation.takedown.v1' AND data->>'targetId'=$1 ORDER BY position,event_seq",
      [id],
    );
    for (const row of rows) {
      const event: CloudEvent = {
        specversion: '1.0',
        id: row.id,
        source: `urn:rezics:log:${row.partition_no}.${row.epoch}`,
        type: row.type,
        time: new Date(row.recorded_at).toISOString(),
        datacontenttype: 'application/json',
        sequence: String(row.position).padStart(19, '0'),
        data: row.data,
      };
      await effect!.run(event);
      await effect!.run(event);
    }
  }
  test('each thread or post takedown stores one decision with its statement, decider and time, and a replay stores no second', async () => {
    for (const kind of ['thread', 'post'] as const) {
      const { id, key, path, result } = await decide(kind);
      const replay = await call('POST', path, reason, key, fixture.principal);
      expect(replay.response.status).toBe(200);
      expect(replay.body).toEqual(result.body);
      const { rows } = await db.admin.query(
        'SELECT * FROM content.moderation_decision WHERE route=$1 AND target_id=$2',
        [routeOf(id), id],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        target_kind: kind,
        target_id: id,
        action: 'takedown',
        statement: reason.reason,
        decider_account_id: fixture.principal,
        security_revision: result.body.securityRevision,
      });
      expect(Number.isFinite(new Date(rows[0].decided_at).getTime())).toBe(true);
      expect(routeOf(rows[0].decision_id)).toBe(routeOf(id));
    }
  });
  test("the target's author is sent the decision whatever their preferences and reads it with its appeal deadline, and anyone else gets 404", async () => {
    await db.admin.query(
      `INSERT INTO access.account_preferences (route,account_id,spoiler_level,suitability,version,notifications)
      VALUES ($1,$2,0,'show',1,'{"reply":false,"mention":false,"moderation_decision":false}') ON CONFLICT (route,account_id) DO UPDATE SET notifications=EXCLUDED.notifications`,
      [routeOf(fixture.actor), fixture.actor],
    );
    for (const kind of ['thread', 'post'] as const) {
      const { id, thread } = await decide(kind);
      await deliver(id);
      const { rows } = await db.admin.query(
        `SELECT n.*, d.decided_at FROM content.notice n JOIN content.moderation_decision d ON d.decision_id=n.decision_id
        WHERE d.target_id=$1 AND n.recipient_id=$2`,
        [id, fixture.actor],
      );
      expect(rows).toHaveLength(1);
      const notice = rows[0];
      expect(notice).toMatchObject({
        kind: 'moderation_decision',
        actor_id: null,
        source_id: notice.decision_id,
        thread_id: thread.id,
        post_id: kind === 'post' ? id : null,
      });
      const path = `/v1/moderation-decisions/${notice.decision_id}`;
      const author = await call('GET', path);
      expect(author.response.status).toBe(200);
      expect(author.response.headers.get('cache-control')).toBe('private, no-store');
      expect(author.body).toEqual({
        id: notice.decision_id,
        targetKind: kind,
        targetId: id,
        action: 'takedown',
        statement: reason.reason,
        decidedAt: new Date(notice.decided_at).toISOString(),
        appealDeadline: new Date(new Date(notice.decided_at).getTime() + 183 * 86400000).toISOString(),
      });
      expect((await call('GET', path, undefined, undefined, fixture.principal)).body).toEqual(author.body);
      const stranger = await call('GET', path, undefined, undefined, fixture.recipient);
      const unknown = await call(
        'GET',
        `/v1/moderation-decisions/${newId(routeOf(id)!)}`,
        undefined,
        undefined,
        fixture.recipient,
      );
      expect(stranger.response.status).toBe(404);
      expect(unknown.response.status).toBe(404);
      expect(stranger.body.code).toBe(unknown.body.code);
      await db.admin.query(
        "DELETE FROM access.resource_grant WHERE route=$1 AND resource_id=$2 AND subject_id=$3 AND action='moderation:takedown'",
        [routeOf(id), id, fixture.principal],
      );
      expect((await call('GET', path, undefined, undefined, fixture.principal)).response.status).toBe(404);
    }
    const operation = openApiDocument(app).paths?.['/v1/moderation-decisions/{id}']?.get;
    expect(operation?.operationId).toBe('moderation_decision.get');
  });
  test('a deleted author is sent nothing', async () => {
    const { id } = await decide();
    await db.admin.query("UPDATE access.account SET state='deleted' WHERE route=$1 AND account_id=$2", [
      routeOf(fixture.actor),
      fixture.actor,
    ]);
    try {
      await deliver(id);
      const { rows } = await db.admin.query('SELECT * FROM content.notice WHERE thread_id=$1', [id]);
      expect(rows).toHaveLength(0);
    } finally {
      await db.admin.query("UPDATE access.account SET state='active' WHERE route=$1 AND account_id=$2", [
        routeOf(fixture.actor),
        fixture.actor,
      ]);
    }
  });
  test('moderation decision writes and reads stay constant as decisions per target grow', async () => {
    for (const operation of ['takedown', 'read'] as const) {
      const { id } = await decide();
      const route = routeOf(id)!;
      let readId = '';
      await checkGrowth(db, {
        name: `moderation decision ${operation}`,
        scales: [16, 64, 256],
        bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
        async grow(database, scale, previous) {
          const {
            rows: [current],
          } = await database.admin.query(
            `SELECT count(*)::integer AS count FROM content.moderation_decision WHERE route=$1 AND target_kind='thread' AND target_id=$2`,
            [route, id],
          );
          const ids = Array.from({ length: scale - current.count }, () => newId(route));
          readId ||= ids[0]!;
          await database.admin.query(
            `INSERT INTO content.moderation_decision
            (route,decision_id,target_kind,target_id,action,statement,decider_account_id,security_revision)
            SELECT $1,decision_id,'thread',$3,'takedown','Historical statement',$4,10000+$5+ordinality
            FROM unnest($2::uuid[]) WITH ORDINALITY AS decisions(decision_id,ordinality)`,
            [route, ids, id, fixture.principal, previous],
          );
        },
        async operation(_database, scale, repetition) {
          const result =
            operation === 'takedown'
              ? await call(
                  'POST',
                  `/v1/threads/${id}:takeDown`,
                  reason,
                  `decision-growth-${operation}-${scale}-${repetition}`,
                  fixture.principal,
                )
              : await call('GET', `/v1/moderation-decisions/${readId}`);
          expect(result.response.status).toBe(200);
        },
      });
    }
  }, 180_000);
});
