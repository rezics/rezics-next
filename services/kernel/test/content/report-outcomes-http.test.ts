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

import { seedReportGrowth, type ReportGrowthRow } from './support/report-growth.ts';

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

describe('report outcomes through HTTP and committed effects', () => {
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
    await fixture.grant(fixture.actor, 'account:read', {
      route: routeOf(fixture.actor)!,
      id: fixture.actor,
    });
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

  async function report(target: { kind: 'board' | 'thread' | 'post'; id: string }, account = fixture.actor) {
    await fixture.grant(account, 'report:create', { route: routeOf(target.id)!, id: target.id });
    const result = await call('POST', '/v1/reports', { target, reason: 'spam' }, undefined, account);
    expect(result.response.status).toBe(201);
    await deliver('content_report_target', result.body.reportId);
    return result.body.reportId as string;
  }
  async function deliver(name: string, id: string) {
    const effect = contentEffects(db.pool, {} as WorkClient).find((effect) => effect.name === name);
    expect(effect).toBeDefined();
    const { rows } = await db.admin.query(
      "SELECT * FROM core.outbox WHERE data->>'targetId'=$1 OR data->>'reportId'=$1 ORDER BY position,event_seq",
      [id],
    );
    for (const row of rows.filter((row) => effect!.types.includes(row.type))) {
      const event: CloudEvent = {
        specversion: '1.0',
        id: row.id,
        source: `urn:rezics:log:${row.partition_no}.${row.epoch}`,
        type: row.type,
        time: new Date(row.recorded_at).toISOString(),
        datacontenttype: 'application/json',
        sequence: String(row.position).padStart(19, '0'),
        subject: row.subject,
        data: row.data,
      };
      await effect!.run(event);
      await effect!.run(event);
    }
  }
  test('a takedown marks every open report of its target actioned in bounded pages and sends each signed-in reporter the outcome once', async () => {
    const thread = await create();
    const target = { kind: 'thread' as const, id: thread.id };
    await fixture.grant(fixture.principal, 'moderation:takedown', { route: routeOf(thread.id)!, id: thread.id });
    await fixture.grant(fixture.principal, 'moderation:read_reports', { route: routeOf(thread.id)!, id: thread.id });
    const id = await report(target);
    const open = await call('GET', `/v1/reports/${id}`, undefined, undefined, fixture.principal);
    expect(open.body.report).toMatchObject({ outcome: null, resolvedAt: null });
    const taken = await call('POST', `/v1/threads/${thread.id}:takeDown`, reason, undefined, fixture.principal);
    expect(taken.response.status).toBe(200);
    await deliver('content_report_outcome', thread.id);
    const resolved = await call('GET', `/v1/reports/${id}`, undefined, undefined, fixture.principal);
    expect(resolved.body.report.outcome).toBe('actioned');
    expect(Number.isFinite(Date.parse(resolved.body.report.resolvedAt))).toBe(true);
    const { rows } = await db.admin.query('SELECT * FROM content.notice WHERE report_id=$1', [id]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ recipient_id: fixture.actor, kind: 'moderation_decision', source_id: id });
    expect(rows[0].decision_id).toBeTruthy();
  });
  test('a moderator dismisses one open report, its reporter is sent dismissed, and a resolved report cannot be resolved again', async () => {
    const thread = await create();
    const id = await report({ kind: 'thread', id: thread.id });
    await fixture.grant(fixture.principal, 'moderation:takedown', { route: routeOf(thread.id)!, id: thread.id });
    const path = `/v1/reports/${id}:dismiss`;
    const key = randomUUID();
    const dismissed = await call('POST', path, undefined, key, fixture.principal);
    expect(dismissed.response.status).toBe(200);
    expect(dismissed.body).toMatchObject({ reportId: id, outcome: 'dismissed' });
    const replay = await call('POST', path, undefined, key, fixture.principal);
    expect(replay.response.status).toBe(200);
    expect(replay.body).toEqual(dismissed.body);
    expect((await call('POST', path, undefined, undefined, fixture.principal)).response.status).toBe(409);
    await deliver('content_report_outcome', id);
    const { rows } = await db.admin.query('SELECT * FROM content.notice WHERE report_id=$1', [id]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      recipient_id: fixture.actor,
      kind: 'moderation_decision',
      source_id: id,
      decision_id: null,
    });
    await expect(
      db.admin.query("UPDATE content.report SET outcome='actioned' WHERE route=$1 AND report_id=$2", [routeOf(id), id]),
    ).rejects.toThrow();
    const operation = openApiDocument(app).paths?.['/v1/reports/{id}:dismiss']?.post;
    expect(operation?.operationId).toBe('report.dismiss');
  });
  test("report lists show each report's outcome and only moderators of the target can dismiss", async () => {
    for (const kind of ['board', 'thread'] as const) {
      const thread = await create();
      const target = { kind, id: kind === 'board' ? boardId : thread.id };
      const id = await report(target);
      await fixture.grant(fixture.principal, 'moderation:read_reports', { route: routeOf(target.id)!, id: target.id });
      const listPath = `/v1/${kind === 'board' ? 'boards' : 'threads'}/${target.id}/reports`;
      const listed = await call('GET', listPath, undefined, undefined, fixture.principal);
      expect(listed.response.status).toBe(200);
      expect(listed.body.reports.find((row: { id: string }) => row.id === id)).toMatchObject({
        outcome: null,
        resolvedAt: null,
      });
      const denied = await call('POST', `/v1/reports/${id}:dismiss`, undefined, undefined, fixture.principal);
      const unknown = await call(
        'POST',
        `/v1/reports/${newId(0x7654)}:dismiss`,
        undefined,
        undefined,
        fixture.principal,
      );
      expect(denied.response.status).toBe(404);
      expect(denied.body.code).toBe(unknown.body.code);
      await fixture.grant(fixture.principal, 'moderation:takedown', { route: routeOf(target.id)!, id: target.id });
      expect(
        (await call('POST', `/v1/reports/${id}:dismiss`, undefined, undefined, fixture.principal)).response.status,
      ).toBe(200);
      const final = await call('GET', listPath, undefined, undefined, fixture.principal);
      expect(final.body.reports.find((row: { id: string }) => row.id === id)).toMatchObject({
        outcome: 'dismissed',
        resolvedAt: expect.any(String),
      });
    }
  });
  test('report outcome pages stay constant at 64, 256 and 1024 reports, resume after a page failure, and include late projections', async () => {
    const { reportOutcomePage } = await import('../../src/content/report-outcomes.ts');
    const target = { kind: 'board' as const, id: newId(0x4321) };
    const rows: ReportGrowthRow[] = [];
    await seedReportGrowth(
      db.admin,
      [],
      [{ id: target.id, route: routeOf(target.id)!, subjectId: newId(0x6789), transactionId: randomUUID() }],
    );
    await fixture.grant(fixture.principal, 'moderation:takedown', { route: routeOf(target.id)!, id: target.id });
    await checkGrowth(db, {
      name: 'report outcome target page',
      scales: [64, 256, 1024],
      bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
      async grow(database, scale, previous) {
        const added: ReportGrowthRow[] = Array.from({ length: scale - previous }, (_, offset) => {
          const index = previous + offset;
          const reportRoute = (index * 31) % 65536;
          return {
            reportId: newId(reportRoute),
            reportRoute,
            targetKind: 'board',
            targetId: target.id,
            targetRoute: routeOf(target.id)!,
            createdAt: '2026-01-01T00:00:00.000Z',
            transactionId: randomUUID(),
            idempotencyKey: randomUUID(),
            reporterAccountId: index % 3 === 0 ? null : index % 3 === 1 ? fixture.actor : fixture.recipient,
          };
        });
        rows.push(...added);
        await seedReportGrowth(database.admin, added);
      },
      async operation() {
        const page = await reportOutcomePage(db.pool, target, undefined, 64);
        expect(page).toHaveLength(64);
      },
    });
    await db.admin.query(
      `INSERT INTO access.account_preferences (route,account_id,spoiler_level,suitability,version,notifications)
       VALUES ($1,$2,0,'show',1,'{"moderation_decision":false}') ON CONFLICT (route,account_id) DO UPDATE SET notifications=EXCLUDED.notifications`,
      [routeOf(fixture.actor), fixture.actor],
    );
    const dismissed = rows.find((row) => row.reporterAccountId === fixture.actor)!;
    expect(
      (await call('POST', `/v1/reports/${dismissed.reportId}:dismiss`, undefined, undefined, fixture.principal))
        .response.status,
    ).toBe(200);
    const taken = await call('POST', `/v1/boards/${target.id}:takeDown`, reason, undefined, fixture.principal);
    expect(taken.response.status).toBe(200);
    const effect = contentEffects(db.pool, {} as WorkClient).find(
      (effect) => effect.name === 'content_report_outcome',
    )!;
    const {
      rows: [source],
    } = await db.admin.query(
      "SELECT * FROM core.outbox WHERE type='com.rezics.content.moderation.takedown.v1' AND data->>'targetId'=$1",
      [target.id],
    );
    const event: CloudEvent = {
      specversion: '1.0',
      id: source.id,
      source: `urn:rezics:log:${source.partition_no}.${source.epoch}`,
      type: source.type,
      sequence: String(source.position).padStart(19, '0'),
      time: new Date(source.recorded_at).toISOString(),
      datacontenttype: 'application/json',
      data: source.data,
    };
    const {
      rows: [fail],
    } = await db.admin.query(
      'SELECT report_id FROM content.report_target WHERE route=$1 AND target_kind=$2 AND target_id=$3 AND report_id<>$4 ORDER BY created_at DESC,report_id DESC OFFSET 120 LIMIT 1',
      [routeOf(target.id), 'board', target.id, dismissed.reportId],
    );
    // Fail a report transaction on the second page, after the first cursor committed.
    await db.admin.query(`CREATE FUNCTION content.test_report_outcome_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.report_id='${fail.report_id}'::uuid THEN RAISE EXCEPTION 'Injected report resolution failure'; END IF; RETURN NEW; END $$`);
    await db.admin.query(
      'CREATE TRIGGER test_report_outcome_failure BEFORE UPDATE ON content.report FOR EACH ROW EXECUTE FUNCTION content.test_report_outcome_failure()',
    );
    try {
      await expect(effect.run(event)).rejects.toThrow('Injected report resolution failure');
      const { rows: work } = await db.admin.query('SELECT * FROM content.report_outcome_work WHERE route=$1', [
        routeOf(target.id),
      ]);
      expect(work.some((row) => !row.done)).toBe(true);
    } finally {
      await db.admin.query('DROP TRIGGER test_report_outcome_failure ON content.report');
      await db.admin.query('DROP FUNCTION content.test_report_outcome_failure()');
    }
    await effect.run(event);
    await effect.run(event);
    const { rows: outcomes } = await db.admin.query(
      'SELECT outcome,count(*)::integer AS count FROM content.report WHERE target_id=$1 GROUP BY outcome',
      [target.id],
    );
    expect(outcomes).toEqual(
      expect.arrayContaining([
        { outcome: 'actioned', count: 1023 },
        { outcome: 'dismissed', count: 1 },
      ]),
    );
    expect(outcomes).toHaveLength(2);
    const { rows: notices } = await db.admin.query('SELECT * FROM content.notice WHERE report_id=ANY($1::uuid[])', [
      rows.map((row) => row.reportId),
    ]);
    expect(notices).toHaveLength(rows.filter((row) => row.reporterAccountId).length);
    expect(new Set(notices.map((row) => row.report_id)).size).toBe(notices.length);
    expect(notices.find((row) => row.report_id === dismissed.reportId).decision_id).toBeNull();
    expect(notices.filter((row) => row.report_id !== dismissed.reportId).every((row) => row.decision_id)).toBe(true);
    // A projection committed after the completed takedown remains covered.
    const late = {
      ...rows[0]!,
      reportId: newId(0x7654),
      reportRoute: 0x7654,
      transactionId: randomUUID(),
      idempotencyKey: randomUUID(),
      reporterAccountId: fixture.actor,
    };
    await seedReportGrowth(db.admin, [late], [], {
      projectTargets: false,
      commandEvents: { principalId: fixture.actor, principalKind: 'account', clientId: 'web' },
    });
    await deliver('content_report_target', late.reportId);
    await deliver('content_report_outcome', late.reportId);
    const { rows: lateResult } = await db.admin.query(
      'SELECT outcome FROM content.report WHERE route=$1 AND report_id=$2',
      [late.reportRoute, late.reportId],
    );
    expect(lateResult[0].outcome).toBe('actioned');
  }, 600_000);
  test('a deleted reporter is suppressed permanently and resolution fields cannot change after actioning', async () => {
    const thread = await create();
    const target = { kind: 'thread' as const, id: thread.id };
    const id = await report(target);
    await fixture.grant(fixture.principal, 'moderation:takedown', { route: routeOf(thread.id)!, id: thread.id });
    expect(
      (await call('POST', `/v1/threads/${thread.id}:takeDown`, reason, undefined, fixture.principal)).response.status,
    ).toBe(200);
    await db.admin.query("UPDATE access.account SET state='deleted' WHERE route=$1 AND account_id=$2", [
      routeOf(fixture.actor),
      fixture.actor,
    ]);
    try {
      await deliver('content_report_outcome', thread.id);
    } finally {
      await db.admin.query("UPDATE access.account SET state='active' WHERE route=$1 AND account_id=$2", [
        routeOf(fixture.actor),
        fixture.actor,
      ]);
    }
    await deliver('content_report_outcome', id);
    expect((await db.admin.query('SELECT * FROM content.notice WHERE report_id=$1', [id])).rows).toHaveLength(0);
    for (const update of [
      "outcome='dismissed'",
      'resolved_at=now()',
      `resolved_by='${fixture.actor}'`,
      `decision_id='${newId(0x4321)}'`,
      "evidence='changed'",
    ]) {
      await expect(
        db.admin.query(`UPDATE content.report SET ${update} WHERE route=$1 AND report_id=$2`, [routeOf(id), id]),
      ).rejects.toThrow();
    }
    expect(
      (await call('POST', `/v1/reports/${id}:dismiss`, undefined, undefined, fixture.principal)).response.status,
    ).toBe(409);
  });
  test('post takedowns resolve that post and preserve reports of other targets', async () => {
    const thread = await create();
    const post = { kind: 'post' as const, id: thread.firstPost.id as string };
    const postReport = await report(post);
    const threadReport = await report({ kind: 'thread', id: thread.id });
    await fixture.grant(fixture.principal, 'moderation:takedown', { route: routeOf(post.id)!, id: post.id });
    expect(
      (await call('POST', `/v1/posts/${post.id}:takeDown`, reason, undefined, fixture.principal)).response.status,
    ).toBe(200);
    await deliver('content_report_outcome', post.id);
    const { rows } = await db.admin.query(
      'SELECT report_id,outcome FROM content.report WHERE report_id=ANY($1::uuid[])',
      [[postReport, threadReport]],
    );
    expect(rows).toEqual(
      expect.arrayContaining([
        { report_id: postReport, outcome: 'actioned' },
        { report_id: threadReport, outcome: null },
      ]),
    );
    expect((await db.admin.query('SELECT * FROM content.notice WHERE report_id=$1', [postReport])).rows).toHaveLength(
      1,
    );
  });
});
