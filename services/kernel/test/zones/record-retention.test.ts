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
