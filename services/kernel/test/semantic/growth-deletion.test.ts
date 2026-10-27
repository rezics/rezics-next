import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { bundledRelease } from '@rezics/definitions/bundled';
import { createKernel } from '../../src/http/kernel.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import * as semantic from '../../src/semantic/index.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { checkGrowth, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import { createRealAccess, type RealAccessFixture } from './real-access.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must name the migrated test database');
let db: GrowthDatabase;
let real: RealAccessFixture<'owner'>;
let kernel: ReturnType<typeof createKernel>;
const account = newId(22000);
let now = new Date();
const clock = () => new Date(now);
const snak = (content: string) => ({
  property: { id: 'schema:url' },
  value: { type: 'value', content },
  references: [
    { parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: 'https://example.test/evidence' } }] },
  ],
});
async function call(method: string, path: string, body?: unknown) {
  const response = await kernel.handle(
    new Request(`http://kernel.test${path}`, {
      method,
      headers: {
        authorization: `Bearer ${real.bearer('owner')}`,
        'idempotency-key': `"${randomUUID()}"`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}
function status(result: { status: number; body: unknown }, expected: number) {
  expect(result.status, JSON.stringify(result.body)).toBe(expected);
}
async function person() {
  const result = await call('POST', '/v1/subjects', { type: 'schema:Person', labels: { en: 'Growth catalogue' } });
  status(result, 201);
  return result.body.subject.id as string;
}
async function proposal(subject: string) {
  const payload = `https://example.test/private/${randomUUID()}`;
  const result = await call('POST', `/v1/subjects/${subject}/candidates`, { statement: snak(payload) });
  status(result, 201);
  return { subject, candidate: result.body.candidate as string, payload };
}
const path = (record: { subject: string; candidate: string }) =>
  `/v1/subjects/${record.subject}/candidates/${record.candidate}`;
beforeAll(async () => {
  db = await openGrowthDatabase(url);
  await bootstrapRelease(db.pool, bundledRelease);
  real = await createRealAccess(db.admin, { owner: account }, [
    'subject:create',
    'subject:read',
    'statement:propose',
    'statement:delete',
    'statement:restore',
  ]);
  for (const action of ['subject:create', 'statement:propose'])
    await real.grant({ route: 0, id: GLOBAL_CONTEXT }, 'owner', action);
  kernel = createKernel({
    pool: db.pool,
    access: real.access,
    clock,
    routeKey: new Uint8Array(32).fill(81),
    tokens: { current: 1, keys: new Map([[1, new Uint8Array(32).fill(82)]]) },
    writeRate: real.writeRate,
  });
});
afterAll(async () => {
  await db.close();
});

test('owned semantic deletion and restore stay bounded across unrelated history and population', async () => {
  for (const axis of ['history', 'population'] as const) {
    const subject = await person();
    const unrelated = await person();
    const selected = await proposal(subject);
    const report = await checkGrowth(db, {
      name: `semantic deletion and restore: ${axis}`,
      scales: [64, 512, 4096],
      repetitions: 1,
      warmups: 1,
      bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
      async grow(_database, scale, previous) {
        // Native proposals grow the same subject's history; native creates grow other subjects.
        // Neither fixture installs SQL truth into a future lifecycle table.
        for (let i = previous; i < scale; i++) {
          if (axis === 'history') await proposal(subject);
          else await person();
        }
        await proposal(unrelated);
      },
      async operation() {
        status(await call('DELETE', path(selected)), 200);
        const deleted = await call('GET', `/v1/subjects/${subject}/candidates?property=schema%3Aurl&limit=1`);
        status(deleted, 200);
        expect(JSON.stringify(deleted.body)).not.toContain(selected.payload);
        status(await call('POST', `${path(selected)}:restore-deleted`, {}), 200);
      },
    });
    expect(report.samples.map((sample) => sample.scale)).toEqual([64, 512, 4096]);
  }
});

test('automatic semantic purge pages count examined keys and replay durably as history grows', async () => {
  const subject = await person();
  const unrelated = await person();
  let pending: Awaited<ReturnType<typeof proposal>>[] = [];
  // The required adapter executes real commands and checkpoints. It is deliberately
  // looked up only after native deletion succeeds; no missing module or fake job model.
  function adapter() {
    const factory = Reflect.get(semantic, 'semanticRetention');
    expect(typeof factory).toBe('function');
    return (
      factory as (
        pool: GrowthDatabase['pool'],
        options: { clock: () => Date },
      ) => {
        step(input: { partition: number; limit: number; key: string }): Promise<{
          examined: number;
          purged: number;
          checkpoint: string | null;
          done: boolean;
        }>;
      }
    )(db.pool, { clock });
  }
  const report = await checkGrowth(db, {
    name: 'semantic native minimal purge page',
    scales: [64, 512, 4096],
    repetitions: 1,
    warmups: 1,
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    async grow(_database, scale, previous) {
      for (let i = previous; i < scale; i++) await proposal(unrelated);
    },
    async warmup() {
      // Prepare separate eligible source keys for the warm-up and measured page.
      pending = [];
      for (let i = 0; i < 4; i++) {
        const record = await proposal(subject);
        status(await call('DELETE', path(record)), 200);
        pending.push(record);
      }
      now = new Date(clock().getTime() + 31 * 86_400_000);
      const page = await adapter().step({ partition: partitionOf(routeOf(subject)!), limit: 2, key: randomUUID() });
      expect(page.examined).toBeLessThanOrEqual(2);
      expect(page.purged).toBeLessThanOrEqual(page.examined);
    },
    async operation() {
      const input = { partition: partitionOf(routeOf(subject)!), limit: 2, key: randomUUID() };
      const first = await adapter().step(input);
      expect(first.examined).toBe(2);
      expect(first.purged).toBe(2);
      expect(await adapter().step(input)).toEqual(first);
      // Payload verification belongs to the same capture; the point reads stay fixed.
      const rows = await db.pool.query(
        'SELECT candidate_id, statement FROM semantic.candidate WHERE route=$1 AND subject_id=$2 AND candidate_id=ANY($3::uuid[])',
        [routeOf(subject), subject, pending.map((record) => record.candidate)],
      );
      for (const record of pending) expect(JSON.stringify(rows.rows)).not.toContain(record.payload);
    },
  });
  expect(report.samples.map((sample) => sample.scale)).toEqual([64, 512, 4096]);
});
