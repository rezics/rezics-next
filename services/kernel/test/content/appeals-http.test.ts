import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { normalizeDocument } from '@rezics/document';
import { randomUUID } from 'node:crypto';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { createKernel } from '../../src/http/kernel.ts';
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

describe('minimal appeals through HTTP and committed effects', () => {
  let db: Awaited<ReturnType<typeof openGrowthDatabase>>;
  let fixture: Awaited<ReturnType<typeof standingFixture>>;
  let app: ReturnType<typeof createKernel>;
  const credentials = new Map<string, string>();
  const boardId = newId(0x4321);
  let now = new Date();
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
      'moderation:read_reports',
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
      clock: () => now,
      writeRate: createWriteRateLimiter({
        secret: 'moderation-http-fixture-secret-at-least-32-bytes',
        // Growth repeats real HTTP writes within one rate window.
        overrides: JSON.stringify({ 'new-account': { write: { maximum: 10000, seconds: 60 } } }),
      }),
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

  async function decide(kind: 'thread' | 'post' = 'thread', targetBoard = boardId) {
    const thread = await create('Appealable thread', targetBoard);
    const id = kind === 'thread' ? thread.id : thread.firstPost.id;
    await fixture.grant(fixture.principal, 'moderation:takedown', { route: routeOf(id)!, id });
    const key = randomUUID();
    const path = `/v1/${kind === 'thread' ? 'threads' : 'posts'}/${id}:takeDown`;
    const result = await call('POST', path, reason, key, fixture.principal);
    expect(result.response.status).toBe(200);
    const {
      rows: [decision],
    } = await db.admin.query('SELECT * FROM content.moderation_decision WHERE route=$1 AND target_id=$2', [
      routeOf(id),
      id,
    ]);
    return { thread, id, decision };
  }
  async function deliver() {
    const effects = contentEffects(db.pool, {} as WorkClient);
    const { rows } = await db.admin.query(
      "SELECT * FROM core.outbox WHERE type LIKE 'com.rezics.content.moderation.%' ORDER BY partition_no,position,event_seq",
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
      for (const effect of effects.filter((e) => e.types.includes(event.type))) {
        await effect.run(event);
        await effect.run(event);
      }
    }
  }
  const appealPath = (id: string) => `/v1/moderation-decisions/${id}:appeal`;
  const resolvePath = (id: string) => `/v1/moderation-appeals/${id}:resolve`;
  async function appeal(id: string) {
    const result = await call('POST', appealPath(id), { statement: 'Please reconsider' });
    expect(result.response.status).toBe(201);
    return result.body;
  }
  async function resolve(id: string, outcome: 'uphold' | 'reverse', account = fixture.recipient, key?: string) {
    return call('POST', resolvePath(id), { outcome, statement: 'Reviewed independently' }, key, account);
  }
  test('the author appeals once within six months and another moderator upholds or reverses, and a reversal makes the target readable and notifies the author', async () => {
    for (const kind of ['thread', 'post'] as const) {
      for (const outcome of ['uphold', 'reverse'] as const) {
        const { id, decision } = await decide(kind);
        expect((await call('GET', `/v1/${kind}s/${id}`)).response.status).toBe(404);
        const key = randomUUID();
        const body = { statement: 'Please reconsider' };
        const created = await call('POST', appealPath(decision.decision_id), body, key);
        expect(created.response.status).toBe(201);
        const replay = await call('POST', appealPath(decision.decision_id), body, key);
        expect(replay.response.status).toBe(201);
        expect(replay.body).toEqual(created.body);
        const pending = await call('GET', `/v1/moderation-decisions/${decision.decision_id}`);
        expect(pending.body.appeal).toEqual({ id: created.body.id, outcome: null, statement: null, resolvedAt: null });
        await fixture.grant(fixture.recipient, 'moderation:takedown', { route: routeOf(id)!, id });
        const resolutionKey = randomUUID();
        expect((await resolve(created.body.id, outcome, fixture.recipient, resolutionKey)).response.status).toBe(200);
        expect((await resolve(created.body.id, outcome, fixture.recipient, resolutionKey)).response.status).toBe(200);
        expect((await resolve(created.body.id, outcome)).response.status).toBe(409);
        expect((await call('GET', `/v1/${kind}s/${id}`)).response.status).toBe(outcome === 'reverse' ? 200 : 404);
        const read = await call('GET', `/v1/moderation-decisions/${decision.decision_id}`);
        expect(read.body.appeal).toEqual({
          id: created.body.id,
          outcome: outcome === 'reverse' ? 'reversed' : 'upheld',
          statement: 'Reviewed independently',
          resolvedAt: now.toISOString(),
        });
        await deliver();
        const { rows } = await db.admin.query('SELECT * FROM content.notice WHERE source_id=$1', [created.body.id]);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          recipient_id: fixture.actor,
          kind: 'moderation_decision',
          decision_id: decision.decision_id,
          actor_id: null,
        });
        const { rows: events } = await db.admin.query(
          "SELECT * FROM core.outbox WHERE type='com.rezics.content.moderation.restored.v1' AND data->>'targetId'=$1",
          [id],
        );
        expect(events).toHaveLength(outcome === 'reverse' ? 1 : 0);
      }
    }
  });
  test('the decider cannot resolve the appeal, a second appeal is refused, and an appeal after six months is refused', async () => {
    const { id, decision } = await decide();
    const path = appealPath(decision.decision_id);
    expect(
      (await call('POST', path, { statement: 'Not the author' }, undefined, fixture.recipient)).response.status,
    ).toBe(404);
    for (const statement of ['', 'x'.repeat(2001)])
      expect((await call('POST', path, { statement })).response.status).toBe(422);
    const originalNow = now;
    try {
      now = new Date(new Date(decision.decided_at).getTime() + 183 * 86400000);
      const created = await appeal(decision.decision_id);
      expect((await resolve(created.id, 'reverse', fixture.principal)).response.status).toBe(403);
      expect((await resolve(created.id, 'reverse')).response.status).toBe(404);
      expect((await call('POST', path, { statement: 'Again' })).response.status).toBe(409);
      await fixture.grant(fixture.recipient, 'moderation:takedown', { route: routeOf(id)!, id });
      expect((await resolve(created.id, 'uphold')).response.status).toBe(200);
      expect((await call('POST', path, { statement: 'Again after resolution' })).response.status).toBe(409);
      now = originalNow;
      const late = await decide('post');
      now = new Date(new Date(late.decision.decided_at).getTime() + 183 * 86400000 + 1);
      expect(
        (await call('POST', appealPath(late.decision.decision_id), { statement: 'Too late' })).response.status,
      ).toBe(422);
    } finally {
      now = originalNow;
    }
  });
  test('moderators page pending appeals for targets they can act on, and no one else sees them', async () => {
    const ids: string[] = [];
    let threadId = '';
    let visibleThread = '';
    let visibleAppeal = '';

    for (const kind of ['thread', 'post', 'thread'] as const) {
      const { id, thread, decision } = await decide(kind);
      threadId = thread.id;
      ids.push((await appeal(decision.decision_id)).id);
      if (ids.length < 3) {
        await fixture.grant(fixture.recipient, 'moderation:takedown', { route: routeOf(id)!, id });
        visibleThread = thread.id;
        visibleAppeal = ids.at(-1)!;
        await fixture.grant(fixture.recipient, 'moderation:read_reports', {
          route: routeOf(thread.id)!,
          id: thread.id,
        });
      }
    }
    await fixture.grant(fixture.recipient, 'moderation:read_reports', { route: routeOf(boardId)!, id: boardId });
    await fixture.grant(fixture.recipient, 'moderation:read_reports', { route: routeOf(threadId)!, id: threadId });
    await deliver();
    const path = `/v1/boards/${boardId}/appeals`;
    const seen: string[] = [];
    let next: string | null = null;
    do {
      const page = await call(
        'GET',
        `${path}?limit=1${next ? `&cursor=${encodeURIComponent(next)}` : ''}`,
        undefined,
        undefined,
        fixture.recipient,
      );
      expect(page.response.status).toBe(200);
      expect(page.response.headers.get('cache-control')).toBe('private, no-store');
      seen.push(...page.body.appeals.map((a: { id: string }) => a.id));
      next = page.body.next;
    } while (next);
    expect(seen.filter((id) => ids.includes(id))).toEqual(ids.slice(0, 2).reverse());
    for (const account of [fixture.actor, fixture.principal, null])
      expect((await call('GET', path, undefined, undefined, account)).response.status).toBe(
        account === null ? 401 : 404,
      );
    const hidden = await call('GET', `/v1/threads/${threadId}/appeals`, undefined, undefined, fixture.recipient);
    expect(hidden.response.status).toBe(200);
    expect(hidden.body.appeals).toEqual([]);
    const visible = await call('GET', `/v1/threads/${visibleThread}/appeals`, undefined, undefined, fixture.recipient);
    expect(visible.response.status).toBe(200);
    expect(visible.body.appeals.map((a: { id: string }) => a.id)).toEqual([visibleAppeal]);
    expect((await resolve(ids[0]!, 'uphold')).response.status).toBe(200);
    await deliver();
    const page = await call('GET', path, undefined, undefined, fixture.recipient);
    expect(page.body.appeals.map((a: { id: string }) => a.id)).not.toContain(ids[0]);
    const badCursor = await call('GET', `${path}?cursor=invalid`, undefined, undefined, fixture.recipient);
    expect(badCursor.response.status).toBe(400);
  });
  test('appeals per board', async () => {
    for (const operation of ['list', 'appeal', 'resolve'] as const) {
      const growthBoard = newId(0x5432);
      await db.admin.query(
        `INSERT INTO content.board
      (route,board_id,subject_id,title,visibility,security_revision,recorded_transaction_id)
      VALUES ($1,$2,$3,'Appeal growth','published',1,$4)`,
        [routeOf(growthBoard), growthBoard, newId(0x6789), randomUUID()],
      );
      await fixture.grant(fixture.actor, 'thread:create', { route: routeOf(growthBoard)!, id: growthBoard });
      await fixture.grant(fixture.actor, 'board:read', { route: routeOf(growthBoard)!, id: growthBoard });
      const { id, thread } = await decide('thread', growthBoard);
      const route = routeOf(id)!;
      await fixture.grant(fixture.recipient, 'moderation:read_reports', {
        route: routeOf(growthBoard)!,
        id: growthBoard,
      });
      await fixture.grant(fixture.recipient, 'moderation:takedown', { route, id });
      const appealIds: string[] = [];
      let consumed = 0;
      const spareDecisions: string[] = [];
      let appealed = 0;
      await checkGrowth(db, {
        name: `appeals per board ${operation}`,
        scales: [64, 256, 1024],
        bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
        async grow(database, scale) {
          const {
            rows: [maximum],
          } = await database.admin.query(
            'SELECT max(security_revision)::integer AS revision FROM content.moderation_decision WHERE route=$1 AND target_id=$2',
            [route, id],
          );
          const {
            rows: [current],
          } = await database.admin.query(
            'SELECT count(*)::integer AS count FROM content.moderation_appeal WHERE route=$1 AND board_id=$2',
            [route, growthBoard],
          );
          const ids = Array.from({ length: Math.max(0, scale - current.count) }, () => newId(route));
          await database.admin.query(
            `INSERT INTO content.moderation_decision
            (route,decision_id,target_kind,target_id,action,statement,decider_account_id,security_revision,decided_at)
            SELECT $1,decision_id,'thread',$3,'takedown','Growth decision',$4,ordinality+$5,$6
            FROM unnest($2::uuid[]) WITH ORDINALITY AS d(decision_id,ordinality)`,
            [route, ids, id, fixture.principal, maximum.revision, now],
          );
          if (operation === 'appeal') {
            const spares = Array.from({ length: 8 }, () => newId(route));
            await database.admin.query(
              `INSERT INTO content.moderation_decision
              (route,decision_id,target_kind,target_id,action,statement,decider_account_id,security_revision,decided_at)
              SELECT $1,decision_id,'thread',$3,'takedown','Appealable decision',$4,ordinality+$5,$6
              FROM unnest($2::uuid[]) WITH ORDINALITY AS d(decision_id,ordinality)`,
              [route, spares, id, fixture.principal, maximum.revision + ids.length, now],
            );
            spareDecisions.push(...spares);
          }
          for (const decisionId of ids) {
            const appealId = newId(route);
            appealIds.push(appealId);
            await database.admin.query(
              `INSERT INTO content.moderation_appeal
              (route,appeal_id,decision_id,appellant_account_id,statement,thread_id,board_id,created_at)
              VALUES ($1,$2,$3,$4,'Growth statement',$5,$6,$7)`,
              [route, appealId, decisionId, fixture.actor, thread.id, growthBoard, now],
            );
            await database.admin.query(
              `INSERT INTO content.moderation_appeal_board
              (route,board_id,appeal_id,created_at,pending) VALUES ($1,$2,$3,$4,true)`,
              [routeOf(growthBoard), growthBoard, appealId, now],
            );
          }
        },
        async operation() {
          if (operation === 'list') {
            const result = await call(
              'GET',
              `/v1/boards/${growthBoard}/appeals?limit=2`,
              undefined,
              undefined,
              fixture.recipient,
            );
            expect(result.response.status).toBe(200);
            expect(result.body.appeals).toHaveLength(2);
          } else if (operation === 'resolve') {
            expect((await resolve(appealIds[consumed++]!, 'uphold')).response.status).toBe(200);
          } else {
            const result = await call('POST', appealPath(spareDecisions[appealed++]!), { statement: 'Growth appeal' });
            expect(result.response.status).toBe(201);
          }
        },
      });
    }
  }, 180_000);
});
