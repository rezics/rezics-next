import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { resourceAuthorization } from '../../src/access/resource-authorization.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { openApiDocument } from '../../src/http/openapi.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { GLOBAL_CONTEXT, bootstrapRelease } from '../../src/semantic/definitions.ts';
import { globalContextAnchor } from '../../src/semantic/context.ts';
import { createSubject } from '../../src/semantic/subject.ts';
import { moderateSubject } from '../../src/semantic/moderation.ts';
import { contentEffects } from '../../src/content/relays.ts';
import { createReportLocatorEffect } from '../../src/content/report-locator.ts';
import { eraseAccountReportItem } from '../../src/content/account-erasure-reactions.ts';
import type { WorkClient } from '../../src/work/client.ts';
import type { CloudEvent } from '../../src/events/log.ts';
import { standingFixture } from '../access/standing-fixture.ts';
import { openGrowthDatabase } from '../support/growth.ts';

let db: Awaited<ReturnType<typeof openGrowthDatabase>>;
let fixture: Awaited<ReturnType<typeof standingFixture>>;
let app: ReturnType<typeof createKernel>;
const credentials = new Map<string, string>();
const routeKey = new Uint8Array(32).fill(82);
beforeAll(async () => {
  db = await openGrowthDatabase();
  fixture = await standingFixture(['account:read', 'moderation:read_reports', 'moderation:hide'], db.pool);
  await fixture.reset();
  await bootstrapRelease(db.pool, bundledRelease);
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
    access: fixture.access,
    writeRate: createWriteRateLimiter({ secret: 'subject-report-test-secret-at-least-32-bytes' }),
  });
  await fixture.grant(fixture.actor, 'account:read', { route: routeOf(fixture.actor)!, id: fixture.actor });
  await fixture.grant(fixture.actor, 'report:create', globalContextAnchor.resource);
  for (const action of ['moderation:read_reports', 'moderation:hide', 'moderation:takedown'])
    await fixture.grant(fixture.principal, action, globalContextAnchor.resource);
}, 120_000);
afterAll(async () => {
  await fixture?.close();
  await db?.close();
});

async function call(method: string, path: string, body?: unknown, account = fixture.actor, key = randomUUID()) {
  const response = await app.handle(
    new Request(`http://kernel.test${path}`, {
      method,
      headers: {
        authorization: `Bearer ${credentials.get(account)}`,
        ...(method === 'POST' ? { 'idempotency-key': JSON.stringify(key) } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  return { response, body: await response.json() };
}
async function subject() {
  const id = newId(0x4231);
  const actor = (await fixture.context()).actor;
  if (actor.kind !== 'account') throw new Error('Expected fixture account');
  await createSubject(db.pool, {
    actor,
    target: { route: routeOf(id)!, id },
    item: { type: 'schema:Book', labels: { en: 'Reported catalogue Subject' } },
    release: { digest: bundledDigest, release: bundledRelease },
    idempotencyKey: randomUUID(),
    digest: createHash('sha256').update(id).digest(),
    authorize: async () => true,
  });
  await fixture.grant(fixture.actor, 'subject:read', { route: routeOf(id)!, id });
  return id;
}
async function deliver(name: string, id: string) {
  const effects = [...contentEffects(db.pool, {} as WorkClient), createReportLocatorEffect(db.pool)];
  const effect = effects.find((candidate) => candidate.name === name)!;
  const { rows } = await db.admin.query(
    `SELECT * FROM core.outbox WHERE subject=$1 OR data->>'targetId'=$1 OR data->>'reportId'=$1
     ORDER BY position,event_seq`,
    [id],
  );
  for (const row of rows.filter((row) => effect.types.includes(row.type))) {
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
    await effect.run(event);
    await effect.run(event);
  }
}
async function submit(id: string, key = randomUUID()) {
  const result = await call(
    'POST',
    '/v1/reports',
    { target: { kind: 'subject', id }, reason: 'spam', evidence: 'Submitted evidence' },
    fixture.actor,
    key,
  );
  expect(result.response.status).toBe(201);
  return result.body.reportId as string;
}
async function moderate(id: string, action: 'hide' | 'restore') {
  const actor = (await fixture.context(fixture.principal)).actor;
  if (actor.kind !== 'account') throw new Error('Expected moderator');
  const deadline = Date.now() + 30_000;
  await moderateSubject(db.pool, {
    actor,
    subject: id,
    action,
    body: { reason: 'Catalogue policy' },
    idempotencyKey: randomUUID(),
    digest: createHash('sha256').update(randomUUID()).digest(),
    deadline,
    authorization: resourceAuthorization({
      access: fixture.access,
      actor,
      action: action === 'hide' ? 'moderation:hide' : 'moderation:takedown',
      anchor: globalContextAnchor,
      context: { pool: db.pool, deadline, partition: partitionOf(routeOf(id)!) },
    }),
  });
  await deliver('content_report_outcome', id);
}

test('readable Subject submission preserves receipt/status, Global inspection, dismissal, notice and minimization', async () => {
  const id = await subject();
  const key = randomUUID();
  const reportId = await submit(id, key);
  expect(await submit(id, key)).toBe(reportId);
  const path = `/v1/reports/${reportId}`;
  const status = await call('GET', path);
  expect(status.response.status).toBe(200);
  expect(status.body.report).toMatchObject({
    target: { kind: 'subject', id },
    evidence: 'Submitted evidence',
    targetAvailability: 'available',
    outcome: null,
  });
  expect(status.body.report).not.toHaveProperty('partition');
  expect(status.response.headers.get('cache-control')).toBe('private, no-store');
  expect((await call('GET', path, undefined, fixture.recipient)).response.status).toBe(404);
  await deliver('content_report_target', reportId);
  await deliver('content_report_reporter', reportId);
  expect(
    (
      await db.admin.query(
        'SELECT 1 FROM content.report_reporter WHERE route=$1 AND reporter_account_id=$2 AND report_id=$3',
        [routeOf(fixture.actor), fixture.actor, reportId],
      )
    ).rowCount,
  ).toBe(1);
  const queue = await call('GET', `/v1/subjects/${id}/reports`, undefined, fixture.principal);
  expect(queue.response.status).toBe(200);
  expect(queue.body.reports.map((row: { id: string }) => row.id)).toContain(reportId);
  expect((await call('GET', `/v1/subjects/${id}/reports`)).response.status).toBe(404);
  expect((await call('POST', `${path}:dismiss`, undefined, fixture.principal)).response.status).toBe(200);
  expect((await call('GET', path)).body.report.outcome).toBe('dismissed');
  expect((await db.admin.query('SELECT 1 FROM content.notice WHERE report_id=$1', [reportId])).rowCount).toBe(1);
  const conflict = await call(
    'POST',
    '/v1/reports',
    { target: { kind: 'subject', id }, reason: 'other', evidence: 'Changed' },
    fixture.actor,
    key,
  );
  expect(conflict.response.status).toBe(422);
  await eraseAccountReportItem({ pool: db.pool }, fixture.actor, routeOf(reportId)!, reportId);
  expect(
    (
      await db.admin.query(
        'SELECT reason,evidence,reporter_account_id FROM content.report WHERE route=$1 AND report_id=$2',
        [routeOf(reportId), reportId],
      )
    ).rows[0],
  ).toEqual({ reason: 'spam', evidence: null, reporter_account_id: null });
});

test('catalogue keysets are bounded, credential/scope bound and require current Global inspection', async () => {
  const id = await subject();
  const ids = [await submit(id), await submit(id), await submit(id)];
  for (const reportId of ids) await deliver('content_report_target', reportId);
  const first = await call(
    'GET',
    '/v1/catalogue/reports?limit=1&status=pending&order=oldest',
    undefined,
    fixture.principal,
  );
  expect(first.response.status).toBe(200);
  expect(first.body.reports).toHaveLength(1);
  expect(first.body.next).toBeString();
  const next = encodeURIComponent(first.body.next);
  await fixture.grant(fixture.recipient, 'moderation:read_reports', globalContextAnchor.resource);
  expect(
    (
      await call(
        'GET',
        `/v1/catalogue/reports?limit=1&status=pending&order=oldest&cursor=${next}`,
        undefined,
        fixture.recipient,
      )
    ).response.status,
  ).toBe(400);
  await db.admin.query(
    'DELETE FROM access.resource_grant WHERE route=0 AND resource_id=$1 AND subject_id=$2 AND action=$3',
    [GLOBAL_CONTEXT, fixture.recipient, 'moderation:read_reports'],
  );
  const second = await call(
    'GET',
    `/v1/catalogue/reports?limit=1&status=pending&order=oldest&cursor=${next}`,
    undefined,
    fixture.principal,
  );
  expect(second.response.status).toBe(200);
  expect(second.body.reports[0].id).not.toBe(first.body.reports[0].id);
  expect(
    (
      await call(
        'GET',
        `/v1/subjects/${id}/reports?limit=1&status=pending&order=oldest&cursor=${next}`,
        undefined,
        fixture.principal,
      )
    ).response.status,
  ).toBe(400);
  expect((await call('GET', '/v1/catalogue/reports?limit=51', undefined, fixture.principal)).response.status).toBe(400);
  await fixture.grant(fixture.recipient, 'moderation:read_reports', { route: routeOf(id)!, id });
  expect((await call('GET', '/v1/catalogue/reports', undefined, fixture.recipient)).response.status).toBe(404);
  await db.admin.query(
    'DELETE FROM access.resource_grant WHERE route=0 AND resource_id=$1 AND subject_id=$2 AND action=$3',
    [GLOBAL_CONTEXT, fixture.principal, 'moderation:read_reports'],
  );
  expect(
    (
      await call(
        'GET',
        `/v1/catalogue/reports?limit=1&status=pending&order=oldest&cursor=${next}`,
        undefined,
        fixture.principal,
      )
    ).response.status,
  ).toBe(404);
  await fixture.grant(fixture.principal, 'moderation:read_reports', globalContextAnchor.resource);
  const paths = (openApiDocument(app) as any).paths;
  expect(paths['/v1/reports'].post['x-resource-types']).toContain('semantic.subject');
  expect(paths['/v1/subjects/{id}/reports'].get.operationId).toBe('subject_report.list');
  expect(paths['/v1/subjects/{id}/reports'].get['x-resource-types']).toEqual(['semantic.subject']);
  expect(paths['/v1/catalogue/reports'].get.operationId).toBe('catalogue_report.list');
});

test('visibility reductions action pending reports, repair late projection after restore and conceal unreadable targets', async () => {
  const id = await subject();
  const reportId = await submit(id);
  const late = await submit(id);
  await deliver('content_report_target', reportId);
  const extra = Array.from({ length: 100 }, () => newId(0x4561));
  await db.admin.query(
    `INSERT INTO content.report
    (route,report_id,target_kind,target_id,reason,created_at,recorded_transaction_id)
    SELECT 17761, id, 'subject', $1, 'spam', now(), $3 FROM unnest($2::uuid[]) AS reports(id)`,
    [id, extra, randomUUID()],
  );
  await db.admin.query(
    `INSERT INTO content.report_target
    (route,target_kind,target_id,report_route,report_id,created_at)
    SELECT $1,'subject',$2,route,report_id,created_at FROM content.report WHERE route=17761 AND report_id=ANY($3::uuid[])`,
    [routeOf(id), id, extra],
  );
  await moderate(id, 'hide');
  expect(
    (
      await db.admin.query(
        `SELECT count(*)::int AS count FROM content.report
    WHERE route=17761 AND report_id=ANY($1::uuid[]) AND outcome='actioned'`,
        [extra],
      )
    ).rows[0].count,
  ).toBe(100);
  const outcome = await call('GET', `/v1/reports/${reportId}`);
  expect(outcome.body.report).toMatchObject({ outcome: 'actioned', targetAvailability: 'unavailable' });
  expect((await call('GET', `/v1/subjects/${id}/reports`, undefined, fixture.principal)).response.status).toBe(200);
  const hidden = await call('POST', '/v1/reports', { target: { kind: 'subject', id }, reason: 'spam' });
  const unknown = await call('POST', '/v1/reports', { target: { kind: 'subject', id: newId(0x4231) }, reason: 'spam' });
  expect(hidden.response.status).toBe(404);
  expect(hidden.body.type).toBe(unknown.body.type);
  expect(unknown.response.status).toBe(404);
  await moderate(id, 'restore');
  await deliver('content_report_target', late);
  await deliver('content_report_outcome', id);
  expect((await call('GET', `/v1/reports/${late}`)).body.report.outcome).toBe('actioned');
  expect((await call('GET', `/v1/reports/${reportId}`)).body.report.outcome).toBe('actioned');
  expect(
    (await db.admin.query('SELECT 1 FROM content.notice WHERE report_id=ANY($1::uuid[])', [[reportId, late]])).rowCount,
  ).toBe(2);
  const fresh = await submit(id);
  await deliver('content_report_target', fresh);
  await deliver('content_report_outcome', id);
  expect((await call('GET', `/v1/reports/${fresh}`)).body.report.outcome).toBeNull();
});
