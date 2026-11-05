import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { semanticRetention } from '../../src/semantic/retention.ts';
import { createBody, day, resourceFixture, type ResourceFixture } from './resource-fixture.ts';

let f: ResourceFixture;
beforeAll(async () => {
  f = await resourceFixture();
}, 120_000);
afterAll(async () => {
  await f?.close();
});

test('deleted Zone retains its body until the exclusive deadline then minimizes by its real native key', async () => {
  await f.available();
  const body = createBody();
  body.configuration.scope = [];
  body.configuration.labels.en = `Private Zone body ${randomUUID()}`;
  const zone = await f.create(body);
  const path = `/v1/zones/${zone.id}`;
  const deleted = await f.call('owner', 'DELETE', path, undefined, f.conditional(zone.revision));
  expect(deleted.status).toBe(200);
  const partition = partitionOf(routeOf(zone.id)!);
  f.advance(30 * day - 1);
  await semanticRetention(f.db.pool, { clock: f.clock }).step({ partition, limit: 2, key: randomUUID() });
  expect((await f.raw(zone.id))!.configuration).toEqual(body.configuration);
  f.advance(1);
  const restore = await f.call('owner', 'POST', `${path}:restore`, {}, f.conditional(deleted.body.zone.revision));
  expect(restore.status).toBe(409);
  const input = { partition, limit: 2, key: randomUUID() };
  const first = await semanticRetention(f.db.pool, { clock: f.clock }).step(input);
  expect(first.examined).toBeLessThanOrEqual(2);
  expect(first.purged).toBeLessThanOrEqual(first.examined);
  const raw = (await f.raw(zone.id))!;
  expect(raw.zone_id).toBe(zone.id);
  expect(raw.configuration).toBeNull();
  expect(raw.mounts).toEqual([]);
  expect(raw.owner_id).toBeNull();
  expect(await semanticRetention(f.db.pool, { clock: f.clock }).step(input)).toEqual(first);
  expect((await f.call('anonymous', 'GET', path)).status).toBe(404);
});

test('Zone native issuer and restarted receiving custody retain the source hold until real completion', async () => {
  const { prepareRecordPurgeAuthority } = await import('../../src/semantic/record-purge-authority.ts');
  const {
    prepareRecordPurgeReceivingHold,
    readRecordPurgeReceivingHold,
    lockRecordPurgeReceivingHold,
    releaseRecordPurgeReceivingHold,
  } = await import('../../src/semantic/record-purge-custody.ts');
  const { runCommand, noEffect } = await import('../../src/command/command.ts');
  await f.available();
  const zone = await f.create(createBody()),
    route = routeOf(zone.id)!,
    partition = partitionOf(route);
  expect(
    (await f.call('owner', 'DELETE', `/v1/zones/${zone.id}`, undefined, f.conditional(zone.revision))).status,
  ).toBe(200);
  const native = (
    await f.db.pool.query(
      'SELECT deletion_generation,revision::text AS version FROM zones.zone WHERE route=$1 AND zone_id=$2',
      [route, zone.id],
    )
  ).rows[0]!;
  const ref = { kind: 'zone' as const, zoneId: zone.id, deletionGeneration: native.deletion_generation as string };
  const deps = { pool: f.db.pool, clock: f.clock },
    context = { deadline: Date.now() + 10_000 };
  expect(await prepareRecordPurgeAuthority(deps, ref, context)).toBeNull();
  f.advance(30 * day);
  const authority = await prepareRecordPurgeAuthority(deps, ref, context);
  expect(authority).not.toBeNull();
  const target = { partition, receivingId: randomUUID() };
  expect(await prepareRecordPurgeReceivingHold(deps, authority!, target, context)).not.toBeNull();
  const resumed = await readRecordPurgeReceivingHold(deps, ref, target, context);
  expect(resumed).not.toBeNull();
  const source = (
    await runCommand(f.db.pool, { partition, clock: f.clock, deadline: context.deadline }, async (tx) =>
      noEffect(await lockRecordPurgeReceivingHold(tx, resumed!)),
    )
  ).value;
  expect(source?.reference).toEqual(ref);
  expect(source?.sourceVersion).toBe(native.version);
  expect(await releaseRecordPurgeReceivingHold(deps, ref, target, context)).toEqual({ state: 'pending' });
  await expect(
    f.db.pool.query('UPDATE zones.zone SET held=true WHERE route=$1 AND zone_id=$2', [route, zone.id]),
  ).rejects.toThrow('record_purge_receiving_hold_outstanding');
});
