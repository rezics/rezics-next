import { afterAll, beforeAll, expect, test } from 'bun:test';
import { realmBoardWorld } from './realm-board-create-support.ts';

let world: Awaited<ReturnType<typeof realmBoardWorld>>;
beforeAll(async () => { world = await realmBoardWorld(); }, 120_000);
afterAll(async () => { await world?.close(); });

test.serial('Realm board creation proves compact membership while native link projection remains behind', async () => {
  const lag = await world.lag();
  expect(BigInt(lag.position)).toBeGreaterThan(BigInt(lag.checkpoint ?? '0'));
  expect(Number(lag.links)).toBe(0);
  const key = crypto.randomUUID();
  const created = await world.board(world.conceptId, key);
  expect(created.response.status).toBe(201);
  expect(created.value.board).toMatchObject({ realmId: world.realm.realmId, conceptId: world.conceptId });
  const effects = await world.effects();
  const replay = await world.board(world.conceptId, key);
  expect(replay.response.status).toBe(201);
  expect(replay.value.board).toEqual(created.value.board);
  expect(await world.effects()).toEqual(effects);
  expect(await world.lag()).toEqual(lag);
  const conflict = await world.board();
  expect(conflict.response.status).toBe(409);
  expect(await world.effects()).toEqual(effects);
});
