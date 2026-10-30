import { afterAll, beforeAll, expect, test } from 'bun:test';
import { openGrowthDatabase, measure, type GrowthDatabase } from '../support/growth.ts';
import { createProfileEntryFixture, entryKey, type NativeProfileFixture } from './support/profile-entry-fixture.ts';
import { compileSessionProfile, sessionScopes } from './support/session-profile-fixture.ts';

let db: GrowthDatabase | undefined;
let f: NativeProfileFixture | undefined;
let owner: Awaited<ReturnType<NativeProfileFixture['identity']>>;
let other: Awaited<ReturnType<NativeProfileFixture['identity']>>;
let subjectId: string;
let ownerSession: string;
let otherSession: string;
let selectedId: string;

beforeAll(async () => {
  db = await openGrowthDatabase();
  f = await createProfileEntryFixture({ pool: db.pool, projectLinks: false });
  const scopes = [...sessionScopes, 'published_log:create', 'published_log:read', 'published_log:delete'];
  owner = await f.identity(scopes);
  other = await f.identity(scopes);
  await f.activate(await f.publish(await compileSessionProfile()));
  expect((await f.send('steward', 'POST', '/v1/platform/exposure/reading_progress:open')).status).toBe(200);
  subjectId = await f.createSubject('game', 'Growth published log');

  async function session(bearer: string) {
    const response = await f!.send(bearer, 'POST', '/v1/progressSessions', {
      subjectId,
      mode: 'scalar_amount',
      unit: 'minute',
    });
    expect(response.status).toBe(201);
    return ((await response.json()).progressSession as { id: string }).id;
  }
  ownerSession = await session(owner.bearer);
  otherSession = await session(other.bearer);
  const selected = await f.send(owner.bearer, 'POST', '/v1/publishedLogs', {
    sessionId: ownerSession,
    note: 'fixed selected identity',
  });
  expect(selected.status).toBe(201);
  selectedId = (await selected.json()).publishedLog.id;
}, 120000);

afterAll(async () => {
  await f?.close();
  await db?.close();
});

async function publishAndRetract(bearer: string, sessionId: string, index: number) {
  const created = await f!.send(bearer, 'POST', '/v1/publishedLogs', { sessionId, note: `scale-${index}` });
  expect(created.status).toBe(201);
  const value = (await created.json()).publishedLog;
  const revision = Number(created.headers.get('Library-Published-Log-Revision'));
  const removed = await f!.send(
    bearer,
    'DELETE',
    `/v1/publishedLogs/${value.id}?revision=${revision}`,
    undefined,
    entryKey(),
  );
  expect(removed.status).toBe(200);
}

test('published log point reads stay bounded at 64, 512 and 4096 unrelated live and deleted episodes across owners', async () => {
  const costs: Array<{ rows: number; statements: number; blocks: number }> = [];
  let previous = 0;
  for (const scale of [64, 512, 4096]) {
    const population: Promise<void>[] = [];
    for (let n = previous; n < scale; n++) {
      const actor = n % 2 === 0 ? owner : other;
      population.push(publishAndRetract(actor.bearer, actor === owner ? ownerSession : otherSession, n));
      if (population.length === 32) {
        await Promise.all(population.splice(0));
      }
    }
    const outcomes = await Promise.allSettled(population);
    const failure = outcomes.find((outcome) => outcome.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
    const read = await measure(db!, () => f!.send('anonymous', 'GET', `/v1/publishedLogs/${selectedId}`));
    expect(read.value.status).toBe(200);
    expect((await read.value.json()).publishedLog.id).toBe(selectedId);
    costs.push({ rows: read.cost.rows, statements: read.cost.statements, blocks: read.cost.blocks });
    previous = scale;
  }
  expect(costs.every((cost) => cost.rows > 0 && cost.statements > 0)).toBe(true);
  expect(costs[1]!.statements).toBe(costs[0]!.statements);
  expect(costs[2]!.statements).toBe(costs[0]!.statements);
  expect(costs[1]!.rows).toBe(costs[0]!.rows);
  expect(costs[2]!.rows).toBe(costs[0]!.rows);
  expect(costs[2]!.blocks).toBeLessThanOrEqual(costs[0]!.blocks + 8);
}, 900000);
