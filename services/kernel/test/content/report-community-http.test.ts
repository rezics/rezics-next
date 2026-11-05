import { afterAll, beforeAll, expect, test } from 'bun:test';
import { bundledRelease } from '@rezics/definitions/bundled';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
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

async function call(
  person: ContentCredential | null,
  method: string,
  path: string,
  body?: unknown,
  key = crypto.randomUUID(),
) {
  const response = await system.kernel.handle(
    new Request(`https://content.test${path}`, {
      method,
      headers: {
        ...(person ? { authorization: `Bearer ${person.bearer}` } : {}),
        ...(method === 'GET' ? {} : { 'idempotency-key': JSON.stringify(key) }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  return { status: response.status, body: await response.json() };
}
async function target(kind: 'space' | 'realm', visibility = 'public') {
  const owner = system.actors.other;
  const space = await call(owner, 'POST', '/v1/spaces', { title: 'Reportable Space' });
  expect(space.status).toBe(201);
  if (kind === 'space') return space.body.space.spaceId as string;
  const realm = await call(owner, 'POST', '/v1/realms', {
    spaceId: space.body.space.spaceId,
    title: 'Reportable Realm',
    visibility,
    contextId: GLOBAL_CONTEXT,
  });
  expect(realm.status).toBe(201);
  return realm.body.realm.realmId as string;
}
async function project(id: string) {
  const effect = createReportEffect(system.database.pool);
  const { rows } = await system.database.pool.query('SELECT * FROM core.outbox WHERE subject=$1 AND type=$2', [
    id,
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
    await effect.run(event);
  }
}

test('Space and Realm reports retain receipts and dismissed outcomes through the existing native queue', async () => {
  for (const kind of ['space', 'realm'] as const) {
    const id = await target(kind);
    const resource = { kind, id };
    const reporter = system.actors.author;
    const moderator = system.actors.moderator;
    await seedGovernanceAuthority(system.database.pool, routeOf(id)!, id, reporter.actor.accountId, ['report:create']);
    await seedGovernanceAuthority(system.database.pool, routeOf(id)!, id, moderator.actor.accountId, [
      'moderation:read_reports',
      'moderation:takedown',
    ]);
    const input = { target: resource, reason: 'spam', evidence: 'My submitted evidence' };
    const key = crypto.randomUUID();
    const created = await call(reporter, 'POST', '/v1/reports', input, key);
    expect(created.status).toBe(201);
    const reportId = created.body.reportId as string;
    expect((await call(reporter, 'POST', '/v1/reports', input, key)).body).toEqual(created.body);
    expect((await call(reporter, 'POST', '/v1/reports', { ...input, evidence: 'Changed' }, key)).status).toBe(422);
    await project(reportId);
    const path = `/v1/reports/${reportId}`;
    expect((await call(reporter, 'GET', path)).body.report).toMatchObject({
      target: resource,
      targetAvailability: 'available',
      outcome: null,
    });
    const queue = await call(moderator, 'GET', `/v1/${kind}s/${id}/reports?limit=1`);
    expect(queue.status).toBe(200);
    expect(queue.body.reports.map((row: { id: string }) => row.id)).toEqual([reportId]);
    const catalogue = await call(moderator, 'GET', `/v1/catalogue/reports?targetKind=${kind}`);
    expect(catalogue.status).toBe(200);
    expect(catalogue.body.reports.map((row: { id: string }) => row.id)).toContain(reportId);
    expect((await call(system.actors.other, 'GET', path)).status).toBe(404);
    const dismissKey = crypto.randomUUID();
    expect((await call(moderator, 'POST', `${path}/$dismiss`, undefined, dismissKey)).status).toBe(200);
    expect((await call(moderator, 'POST', `${path}/$dismiss`, undefined, dismissKey)).status).toBe(200);
    expect((await call(reporter, 'GET', path)).body.report).toMatchObject({
      target: resource,
      evidence: input.evidence,
      outcome: 'dismissed',
    });
    await seedResourceDenial(system.database.pool, routeOf(id)!, id, moderator.actor.accountId, [
      'moderation:takedown',
    ]);
    expect((await call(moderator, 'POST', `${path}/$dismiss`, undefined, dismissKey)).status).toBe(404);
    await seedResourceDenial(system.database.pool, routeOf(id)!, id, reporter.actor.accountId, [`${kind}:read`]);
    const retained = await call(reporter, 'GET', path);
    expect(retained.status).toBe(200);
    expect(retained.body.report).toMatchObject({
      targetAvailability: 'unavailable',
      outcome: 'dismissed',
      evidence: input.evidence,
    });
    expect(retained.body.report).not.toHaveProperty('transactionId');
  }
});

test('a protected Realm is indistinguishable from an unknown Realm to a non-member before receipt lookup', async () => {
  const id = await target('realm', 'protected');
  const reporter = system.actors.author;
  await seedGovernanceAuthority(system.database.pool, routeOf(id)!, id, reporter.actor.accountId, ['report:create']);
  const concealed = await call(reporter, 'POST', '/v1/reports', { target: { kind: 'realm', id }, reason: 'spam' });
  const missing = await call(reporter, 'POST', '/v1/reports', {
    target: { kind: 'realm', id: newId(routeOf(id)!) },
    reason: 'spam',
  });
  expect(concealed.status).toBe(404);
  expect(missing.status).toBe(404);
});
