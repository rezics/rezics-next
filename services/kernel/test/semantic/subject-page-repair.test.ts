import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { createKernel } from '../../src/http/kernel.ts';
import type { Access } from '../../src/request/access.ts';
import { anchorRoute, newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { itemFacts } from '../../src/semantic/item.ts';
import { capture, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import { createRealAccess } from './real-access.ts';
import type { PublicationRunner, PublicationStore } from './subject-page-local-publication.test.ts';

let db: GrowthDatabase;
let app: ReturnType<typeof createKernel>;
let real: Awaited<ReturnType<typeof createRealAccess<{ editor: string }>>>;
let access: Access;
let now = new Date();
const clock = () => now;
const actions = [
  'subject:create',
  'subject:read',
  'statement:propose',
  'context:accept',
  'context:adopt',
  'moderation:hide',
];
const editor = '019a1b2c-3d4e-7f00-8a00-ed170e000183';
const routeKey = new Uint8Array(32).fill(83);
beforeAll(async () => {
  db = await openGrowthDatabase();
  await bootstrapRelease(db.pool, bundledRelease);
  real = await createRealAccess(db.admin, { editor }, actions, { clock });
  await db.admin.query("UPDATE access.account SET rate_tier='trusted' WHERE route=$1 AND account_id=$2", [
    routeOf(editor),
    editor,
  ]);
  for (const action of actions) await real.grant({ route: 0, id: GLOBAL_CONTEXT }, 'editor', action);
  app = createKernel({
    pool: db.pool,
    routeKey,
    clock,
    writeRate: real.writeRate,
    tokens: { current: 1, keys: new Map([[1, new Uint8Array(32).fill(84)]]) },
    access(config) {
      access = real.access(config);
      return access;
    },
  });
}, 60_000);
afterAll(async () => {
  if (db) await db.close();
});
async function post(path: string, body: unknown, status = 200, key = randomUUID()) {
  const send = () =>
    app.handle(
      new Request(`http://kernel.test${path}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${real.bearer('editor')}`,
          'content-type': 'application/json',
          'idempotency-key': `"${key}"`,
        },
        body: JSON.stringify(body),
      }),
    );
  let response = await send();
  let value = (await response.json()) as Record<string, any>;
  for (
    let retry = 0;
    retry < 2 &&
    response.status === 503 &&
    value.code === 'overloaded' &&
    value.retryable === true &&
    value.effect_status === 'not_applied';
    retry++
  ) {
    response = await send();
    value = (await response.json()) as Record<string, any>;
  }
  expect([path, response.status, response.status === status ? null : value]).toEqual([path, status, null]);
  return value;
}
const statement = (property: string, content: string) => ({
  property: { id: property },
  value: { type: 'value', content },
});

// Inspect real EXPLAIN ANALYZE source-window producers, before current-owner filtering.
// The handoff names these materialized CTEs so a fabricated processed counter cannot prove a bound.
function examined(plans: readonly unknown[]): { total: number; descriptive: number } {
  let rows = 0;
  let descriptive = 0;
  let windows = 0;
  function visit(value: unknown) {
    if (Array.isArray(value)) {
      for (const child of value) visit(child);
      return;
    }
    if (!value || typeof value !== 'object') return;
    const node = value as Record<string, unknown>;
    // The existing candidate primitive is already a key-only LIMIT with no owner join.
    if (
      typeof node['Query Text'] === 'string' &&
      /FROM semantic\.subject AS s\b/.test(node['Query Text']) &&
      node.Plan
    ) {
      const plan = node.Plan as Record<string, unknown>;
      rows += Number(plan['Actual Rows']) * Number(plan['Actual Loops']);
      windows++;
    }
    if (
      typeof node['Subplan Name'] === 'string' &&
      /^CTE subject_page_source_window(?:_|$)/.test(node['Subplan Name'])
    ) {
      const count = Number(node['Actual Rows']) * Number(node['Actual Loops']);
      rows += count;
      if (/^CTE subject_page_source_window_descriptive\b/.test(node['Subplan Name'])) descriptive += count;
      expect(Array.isArray(node.Output), 'source materialization exposes key columns only').toBe(true);
      expect((node.Output as string[]).join(' ')).not.toMatch(
        /\b(body|statement|digest|before_state|after_state|effective_at)\b/,
      );
      windows++;
    }
    for (const child of Object.values(node)) if (typeof child === 'object') visit(child);
  }
  visit(plans);
  expect(Number.isFinite(rows)).toBe(true);
  if (rows) expect(windows).toBeGreaterThan(0);
  return { total: rows, descriptive };
}

test('durable publication repair advances a fixed combined key budget and settles', async () => {
  const person = (await post('/v1/subjects', { type: 'schema:Person', labels: { en: 'Resolve real Access' } }, 201))
    .subject;
  const path = '../../src/semantic/subject-page-publication.ts';
  const module = await import(path).catch(() => ({}));
  expect(typeof (module as any).createSubjectPagePublication, 'real production repair factory').toBe('function');
  const storePath = '../../src/semantic/subject-page-publication-store.ts';
  const stores = await import(storePath).catch(() => ({}));
  expect(typeof (stores as any).createSubjectPagePublicationStore).toBe('function');
  let workerPool = db.pool;
  const fresh = (): PublicationRunner =>
    (module as any).createSubjectPagePublication({ pool: workerPool, access, clock });
  const store: PublicationStore = (stores as any).createSubjectPagePublicationStore({ pool: db.pool, access, clock });
  let runner = fresh();
  const cursors = new Set<string>();
  let nonidle = 0;
  let descriptiveKeys = 0;
  async function step(limit = 32) {
    const result = await capture(db, () => runner.step({ limit }));
    const value = result.value;
    expect(value.processed).toBeGreaterThanOrEqual(0);
    expect(value.processed).toBeLessThanOrEqual(Math.min(limit, 32));
    const source = examined(result.capture.plans);
    const sourceKeys = source.total;
    descriptiveKeys += source.descriptive;
    expect(sourceKeys).toBeGreaterThanOrEqual(value.processed);
    expect(
      sourceKeys,
      'one combined budget, including filtered keys and a single key-only sentinel',
    ).toBeLessThanOrEqual(value.processed + 1);
    expect(sourceKeys).toBeLessThanOrEqual(Math.min(limit, 32) + 1);
    if (value.processed) nonidle++;
    expect(value.next === null).toBe(value.done);
    if (!value.done) {
      expect(typeof value.next).toBe('string');
      expect(cursors.has(value.next!), 'committed progress survives reconstruction').toBe(false);
      cursors.add(value.next!);
    }
    return value;
  }
  async function drain() {
    for (let page = 0; page < 16384; page++) if ((await step()).done) return;
    throw new Error('Finite quiescent repair did not settle');
  }

  // Bootstrap has no enqueue call and no retained original time. More than 32 legal components.
  const id = newId(0);
  const tx = randomUUID();
  const facts = itemFacts(
    id,
    {
      labels: { en: 'Bootstrap' },
      statements: {
        'schema:url': Array.from({ length: 24 }, (_, n) => statement('schema:url', `https://example.test/${n}`)),
        'schema:inLanguage': Array.from({ length: 24 }, (_, n) => statement('schema:inLanguage', `language-${n}`)),
      },
    },
    'schema:Book',
    bundledRelease,
  );
  expect(facts.length).toBeGreaterThan(32);
  await db.admin.query(
    `INSERT INTO semantic.subject(route,subject_id,type,recorded_transaction_id,current_facts,current_release)
    VALUES (0,$1,'schema:Book',$2,$3,$4)`,
    [id, tx, facts.length, bundledDigest],
  );
  await db.admin.query(
    `INSERT INTO semantic.revision(route,subject_id,revision,kind,release,recorded_transaction_id)
    VALUES (0,$1,1,'create',$2,$3)`,
    [id, bundledDigest, tx],
  );
  for (const fact of facts) {
    const row = {
      ...fact,
      route: 0,
      subject_id: id,
      recorded_transaction_id: tx,
      release: fact.kind === 'statement' ? bundledDigest : null,
    };
    const keys = Object.keys(row);
    await db.admin.query(
      `INSERT INTO semantic.fact (${keys.join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')})`,
      Object.values(row),
    );
  }
  await db.admin.query(`INSERT INTO semantic.partition_subjects(partition_no,visible) VALUES (0,1)
    ON CONFLICT(partition_no) DO UPDATE SET visible=semantic.partition_subjects.visible+1`);
  await drain();
  expect(await store.readCurrent({ route: 0, id })).toEqual({ id, labels: [{ language: 'en', value: 'Bootstrap' }] });
  expect((await store.read({ route: 0, id }))?.evidence).toBe('missing');
  for (let repeat = 0; repeat < 3; repeat++) {
    expect(await store.readCurrent({ route: 0, id })).toEqual({ id, labels: [{ language: 'en', value: 'Bootstrap' }] });
    expect(await runner.step({ limit: 32 })).toEqual({ processed: 0, next: null, done: true });
  }
  // Current hidden keys must consume budget too; keep enough native survivors to qualify.
  for (const fact of facts.filter((f) => f.property === 'schema:inLanguage').slice(0, 9))
    await post(`/v1/subjects/${id}/candidates/${fact.statement_id}:hide`, { reason: 'Filtered source key' });
  const key = { route: 0, id };
  const beforeFilteredPass = descriptiveKeys;
  await runner.requestRebuild(key);
  await drain();
  expect(
    descriptiveKeys - beforeFilteredPass,
    'all 49 source component keys count, including nine hidden keys',
  ).toBeGreaterThanOrEqual(facts.length);
  await runner.requestRebuild(key);
  await step(7);
  const checkpoints = await db.admin.query(
    'SELECT * FROM semantic.subject_page_repair WHERE route=0 AND subject_id=$1',
    [id],
  );
  expect(checkpoints.rows).toHaveLength(1);
  const checkpoint = checkpoints.rows[0];
  expect(checkpoint.phase).toBeString();
  expect(checkpoint.high_water).toBeDefined();
  await runner.requestRebuild(key);
  const coalesced = (
    await db.admin.query('SELECT * FROM semantic.subject_page_repair WHERE route=0 AND subject_id=$1', [id])
  ).rows[0];
  for (const field of ['generation', 'phase', 'source_key', 'high_water', 'replay_position'])
    expect(coalesced[field], `coalescing preserves active ${field}`).toEqual(checkpoint[field]);
  // Discard every runtime object. No truth or checkpoint is transferred to the next factory.
  workerPool = db.openPool();
  runner = fresh();
  await step(7);
  const changedAt = new Date(now.getTime() + 1000).toISOString();
  now = new Date(changedAt);
  const mutationPath = `/v1/subjects/${id}/candidates/${facts.find((f) => f.property === 'schema:url')!.statement_id}:hide`;
  const mutationBody = { reason: 'Public transition after captured high-water' };
  const receipt = randomUUID();
  await post(mutationPath, mutationBody, 200, receipt);
  expect(BigInt((await store.read(key))!.completedPosition)).toBeGreaterThan(BigInt(checkpoint.high_water));
  await drain();
  expect(nonidle).toBeGreaterThan(2);
  expect((await store.read(key))?.readiness).toBe('ready');
  expect((await store.readCurrent(key))?.lastModified).toBe(changedAt);
  const settled = await store.read(key);
  now = new Date(now.getTime() + 1000);
  await post(mutationPath, mutationBody, 200, receipt);
  expect(await store.read(key)).toEqual(settled);

  // Twelve independent foreign semantic target owners; no Content clock/event adapter needed here.
  const targets: string[] = [person.id];
  while (targets.length < 12) {
    const target = (
      await post('/v1/subjects', { type: 'schema:Person', labels: { en: `Owner ${targets.length}` } }, 201)
    ).subject;
    if (partitionOf(routeOf(target.id)!) !== 0) targets.push(target.id);
  }
  let creationKey: ReturnType<typeof randomUUID>;
  do {
    creationKey = randomUUID();
  } while (
    targets.some(
      (target) =>
        partitionOf(routeOf(target)!) ===
        partitionOf(anchorRoute(routeKey, `${editor}\nsubject.create\n${creationKey}`)),
    )
  );
  const relationSubject = (
    await post(
      '/v1/subjects',
      {
        type: 'schema:Book',
        labels: { en: 'Beyond eight' },
        statements: {
          'schema:author': targets.map((target) => ({
            ...statement('schema:author', target),
            references: [{ parts: [statement('schema:url', 'https://example.test/relation')] }],
          })),
        },
      },
      201,
      creationKey,
    )
  ).subject;
  const relationKey = { route: routeOf(relationSubject.id)!, id: relationSubject.id };
  expect(targets.every((target) => partitionOf(routeOf(target)!) !== partitionOf(relationKey.route))).toBe(true);
  await runner.requestRebuild(relationKey);
  await drain();
  const witnesses = (await store.read(relationKey))!.witnesses;
  expect(witnesses).toHaveLength(8);
  let removedAt = '';
  for (const witness of witnesses) {
    const selected = relationSubject.statements['schema:author'].find((s: any) => s.id === witness.key);
    expect(selected, 'stored witness identifies an authoritative selected relation').toBeDefined();
    now = new Date(now.getTime() + 1000);
    removedAt = now.toISOString();
    await post(`/v1/subjects/${selected.value.content}:hide`, { reason: 'Invalidate cached positive owner' });
  }
  expect(await store.readCurrent(relationKey), 'stale ready state confers no current proof').toBeNull();
  await runner.requestRebuild(relationKey);
  workerPool = db.openPool();
  runner = fresh();
  await drain();
  expect(await store.readCurrent(relationKey), 'survivor beyond the eight cached witnesses must return').not.toBeNull();
  expect(
    (await store.readCurrent(relationKey))?.lastModified,
    'repair retains original semantic owner-removal time',
  ).toBe(removedAt);
  for (const target of targets) {
    const current = await app.handle(new Request(`http://kernel.test/v1/subjects/${target}`));
    if (current.status === 200) await post(`/v1/subjects/${target}:hide`, { reason: 'Last witness removed' });
    else expect(current.status).toBe(404);
  }
  expect(await store.readCurrent(relationKey)).toBeNull();
  await runner.requestRebuild(relationKey);
  await drain();
  const stable = await store.read(relationKey);
  for (let repeat = 0; repeat < 3; repeat++) {
    expect(await store.readCurrent(relationKey)).toBeNull();
    expect(await runner.step({ limit: 32 })).toEqual({ processed: 0, next: null, done: true });
    expect(await store.read(relationKey)).toEqual(stable);
  }
}, 240_000);
