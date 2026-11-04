import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { globalContextAnchor } from '../../src/semantic/context.ts';
import { createSubject } from '../../src/semantic/subject.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { createReportEffect } from '../../src/content/report-effect.ts';
import type { CloudEvent } from '../../src/events/log.ts';
import { createNativeContentSystemWithWriteRateOverrides, type NativeContentSystem } from './support/native-system.ts';
import { HIGH_RATE_OVERRIDES, seedGovernanceAuthority, seedResourceDenial } from './support/disclosure-fixtures.ts';
import type { ContentCredential } from './support/system.ts';

let system: NativeContentSystem;
beforeAll(async () => {
  system = await createNativeContentSystemWithWriteRateOverrides(
    { databaseUrl: process.env.DATABASE_URL! },
    HIGH_RATE_OVERRIDES,
  );
  await bootstrapRelease(system.database.pool, bundledRelease);
}, 120_000);
afterAll(async () => {
  await system?.close();
});

async function call(person: ContentCredential | null, method: string, path: string, body?: unknown) {
  const response = await system.kernel.handle(
    new Request(`https://content.test${path}`, {
      method,
      headers: {
        ...(person ? { authorization: `Bearer ${person.bearer}` } : {}),
        ...(method === 'GET' ? {} : { 'idempotency-key': JSON.stringify(crypto.randomUUID()) }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  return { status: response.status, body: await response.json() };
}

async function realm(): Promise<string> {
  const owner = system.actors.other;
  const space = await call(owner, 'POST', '/v1/spaces', { title: 'Inspection Realm' });
  expect(space.status).toBe(201);
  const result = await call(owner, 'POST', '/v1/realms', {
    spaceId: space.body.space.spaceId,
    title: 'Inspection Realm',
    visibility: 'public',
    contextId: GLOBAL_CONTEXT,
  });
  expect(result.status).toBe(201);
  return result.body.realm.realmId as string;
}

async function catalogueSubject(): Promise<string> {
  const id = newId(0x4231);
  const actor = system.actors.other.actor;
  await createSubject(system.database.pool, {
    actor,
    target: { route: routeOf(id)!, id },
    item: { type: 'schema:Book', labels: { en: 'Moderation inspection Subject' } },
    release: { digest: bundledDigest, release: bundledRelease },
    idempotencyKey: crypto.randomUUID(),
    digest: createHash('sha256').update(id).digest(),
    authorize: async () => true,
  });
  return id;
}

async function project(reportId: string) {
  const effect = createReportEffect(system.database.pool);
  const { rows } = await system.database.pool.query('SELECT * FROM core.outbox WHERE subject=$1 AND type=$2', [
    reportId,
    effect.types[0],
  ]);
  for (const row of rows) {
    const event: CloudEvent = {
      specversion: '1.0',
      id: row.id,
      type: row.type,
      source: `urn:rezics:log:${row.partition_no}.${row.epoch}`,
      time: new Date(row.recorded_at).toISOString(),
      datacontenttype: 'application/json',
      sequence: String(row.position).padStart(19, '0'),
      subject: row.subject,
      data: row.data,
    };
    await effect.run(event);
  }
}

test('a retained pending report opens by exact id beyond its captured queue page', async () => {
  const targetId = await realm();
  const reporter = system.actors.author;
  const moderator = system.actors.moderator;
  await seedGovernanceAuthority(system.database.pool, routeOf(targetId)!, targetId, reporter.actor.accountId, [
    'report:create',
  ]);
  await seedGovernanceAuthority(system.database.pool, routeOf(targetId)!, targetId, moderator.actor.accountId, [
    'moderation:read_reports',
    'moderation:takedown',
    'realm:read',
  ]);
  const created = [] as string[];
  for (const evidence of ['First exact evidence', 'Second exact evidence', 'Third exact evidence']) {
    const response = await call(reporter, 'POST', '/v1/reports', {
      target: { kind: 'realm', id: targetId },
      reason: 'spam',
      evidence,
    });
    expect(response.status).toBe(201);
    created.push(response.body.reportId as string);
  }
  for (const id of created) await project(id);
  const page = await call(moderator, 'GET', `/v1/realms/${targetId}/reports?limit=1`);
  expect(page.status).toBe(200);
  const pageIds = page.body.reports.map((entry: { id: string }) => entry.id);
  expect(page.body.nextCursor).toBeTruthy();
  const selectedId = created.find((id) => !pageIds.includes(id))!;

  const exact = await call(moderator, 'GET', `/v1/reports/${selectedId}`);
  expect(exact.status).toBe(200);
  expect(exact.body.report).toMatchObject({ id: selectedId, target: { kind: 'realm', id: targetId } });
  expect(exact.body.inspection).toMatchObject({
    currentTarget: { state: 'available', value: null },
    viewer: { canDismiss: true, canTakeDown: false },
  });
  expect(exact.body.inspection).toHaveProperty('reportedRevision.state', 'unavailable');
});

test('exact inspection conceals denied and unknown reports while reporter reads retain their contract', async () => {
  const targetId = await realm();
  const reporter = system.actors.author;
  const moderator = system.actors.moderator;
  await seedGovernanceAuthority(system.database.pool, routeOf(targetId)!, targetId, reporter.actor.accountId, [
    'report:create',
  ]);
  await seedGovernanceAuthority(system.database.pool, routeOf(targetId)!, targetId, moderator.actor.accountId, [
    'moderation:read_reports',
    'moderation:takedown',
  ]);
  const created = await call(reporter, 'POST', '/v1/reports', {
    target: { kind: 'realm', id: targetId },
    reason: 'spam',
    evidence: 'Retained exact evidence',
  });
  expect(created.status).toBe(201);
  const reportId = created.body.reportId as string;
  await project(reportId);

  const reporterRead = await call(reporter, 'GET', `/v1/reports/${reportId}`);
  expect(reporterRead.status).toBe(200);
  expect(reporterRead.body.report).toMatchObject({ evidence: 'Retained exact evidence', outcome: null });
  expect(reporterRead.body).not.toHaveProperty('inspection');
  expect(reporterRead.body.report).not.toHaveProperty('transactionId');

  const moderatorRead = await call(moderator, 'GET', `/v1/reports/${reportId}`);
  expect(moderatorRead.status).toBe(200);
  await seedResourceDenial(system.database.pool, routeOf(targetId)!, targetId, moderator.actor.accountId, [
    'moderation:read_reports',
  ]);
  expect((await call(moderator, 'GET', `/v1/reports/${reportId}`)).status).toBe(404);
  expect((await call(moderator, 'GET', `/v1/reports/${newId(routeOf(targetId)!)}`)).status).toBe(404);
});

test('a board-scoped moderator cannot inspect a catalogue report without current Global authority', async () => {
  const targetId = await catalogueSubject();
  const reporter = system.actors.author;
  const moderator = system.actors.moderator;
  const realmId = await realm();
  const board = await call(system.actors.other, 'POST', `/v1/realms/${realmId}/boards`, {
    conceptId: targetId,
    title: 'Catalogue authorization boundary',
    visibility: 'published',
  });
  expect(board.status).toBe(201);

  await seedGovernanceAuthority(
    system.database.pool,
    globalContextAnchor.resource.route,
    globalContextAnchor.resource.id,
    reporter.actor.accountId,
    ['report:create'],
  );
  await seedGovernanceAuthority(system.database.pool, routeOf(targetId)!, targetId, reporter.actor.accountId, [
    'subject:read',
  ]);
  await seedGovernanceAuthority(
    system.database.pool,
    routeOf(board.body.board.id)!,
    board.body.board.id,
    moderator.actor.accountId,
    ['moderation:read_reports'],
  );

  const created = await call(reporter, 'POST', '/v1/reports', {
    target: { kind: 'subject', id: targetId },
    reason: 'spam',
    evidence: 'Catalogue report evidence.',
  });
  expect(created.status).toBe(201);
  const reportId = created.body.reportId as string;
  expect((await call(moderator, 'GET', `/v1/reports/${reportId}`)).status).toBe(404);

  await seedGovernanceAuthority(
    system.database.pool,
    globalContextAnchor.resource.route,
    globalContextAnchor.resource.id,
    moderator.actor.accountId,
    ['moderation:read_reports'],
  );
  const inspected = await call(moderator, 'GET', `/v1/reports/${reportId}`);
  expect(inspected.status).toBe(200);
  expect(inspected.body.report).toMatchObject({ id: reportId, target: { kind: 'subject', id: targetId } });
  expect(inspected.body.inspection).toHaveProperty('currentTarget.state');

  await seedResourceDenial(
    system.database.pool,
    globalContextAnchor.resource.route,
    globalContextAnchor.resource.id,
    moderator.actor.accountId,
    ['moderation:read_reports'],
  );
  expect((await call(moderator, 'GET', `/v1/reports/${reportId}`)).status).toBe(404);
});
