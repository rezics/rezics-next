import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { createKernel } from '../../src/http/kernel.ts';
import type { Access } from '../../src/request/access.ts';
import { anchorRoute, newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { itemFacts } from '../../src/semantic/item.ts';
import { openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import { workerTestEnv } from '../support/worker-env.ts';
import { createRealAccess } from './real-access.ts';
import type { PublicationRunner, PublicationStore } from './subject-page-local-publication.test.ts';

let db: GrowthDatabase;
let app: ReturnType<typeof createKernel>;
let access: Access;
let real: Awaited<ReturnType<typeof createRealAccess<{ editor: string }>>>;
const editor = '019a1b2c-3d4e-7f00-8a00-ed170e000195';
const routeKey = new Uint8Array(32).fill(95);
const tokens = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(96)]]) };
let now = new Date();
const clock = () => now;
const actions = ['subject:create', 'subject:read', 'moderation:hide'];
const statement = (property: string, content: string) => ({
  property: { id: property },
  value: { type: 'value', content },
});
function options() {
  return {
    pool: db.pool,
    routeKey,
    tokens,
    clock,
    writeRate: real.writeRate,
    access(config: Parameters<typeof real.access>[0]) {
      access = real.access(config);
      return access;
    },
  };
}
beforeAll(async () => {
  db = await openGrowthDatabase();
  await bootstrapRelease(db.pool, bundledRelease);
  real = await createRealAccess(db.admin, { editor }, actions, { clock });
  await db.admin.query("UPDATE access.account SET rate_tier='trusted' WHERE route=$1 AND account_id=$2", [
    routeOf(editor),
    editor,
  ]);
  for (const action of actions) await real.grant({ route: 0, id: GLOBAL_CONTEXT }, 'editor', action);
  app = createKernel(options());
}, 60_000);
afterAll(async () => {
  if (db) await db.close();
});
async function nativeSubject() {
  let receipt: string;
  do {
    receipt = randomUUID();
  } while (partitionOf(anchorRoute(routeKey, `${editor}\nsubject.create\n${receipt}`)) !== 0);
  const send = () =>
    app.handle(
      new Request('http://kernel.test/v1/subjects', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${real.bearer('editor')}`,
          'content-type': 'application/json',
          'idempotency-key': `"${receipt}"`,
        },
        body: JSON.stringify({
          type: 'schema:Book',
          labels: { en: 'Mounted runtime' },
          statements: { 'schema:inLanguage': [statement('schema:inLanguage', 'ja')] },
        }),
      }),
    );
  let response = await send();
  let value = (await response.json()) as any;
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
    value = await response.json();
  }
  expect([response.status, response.status === 201 ? null : value]).toEqual([201, null]);
  return value.subject;
}
async function feed(kernel = app) {
  const response = await kernel.handle(new Request('http://kernel.test/v1/subject-pages?limit=1000'));
  expect(response.status, 'actual mounted public transport precedes runtime discovery').toBe(200);
  const body = (await response.json()) as {
    subjectPages: { id: string; lastModified?: string }[];
    next: string | null;
  };
  expect(Object.keys(body).sort()).toEqual(['next', 'subjectPages']);
  return body;
}
async function coldSource() {
  const id = newId(0);
  const tx = randomUUID();
  const facts = itemFacts(
    id,
    {
      labels: { en: 'Historical source' },
      statements: { 'schema:inLanguage': [statement('schema:inLanguage', 'ja')] },
    },
    'schema:Book',
    bundledRelease,
  );
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
    const columns = Object.keys(row);
    await db.admin.query(
      `INSERT INTO semantic.fact (${columns.join(',')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(',')})`,
      Object.values(row),
    );
  }
  return { route: 0, id };
}
async function settle(runtime: PublicationRunner) {
  for (let page = 0; page < 16384; page++) {
    const result = await runtime.step({ limit: 32 });
    expect(result.processed).toBeGreaterThanOrEqual(0);
    expect(result.processed).toBeLessThanOrEqual(32);
    expect(result.next === null).toBe(result.done);
    if (result.done) return;
  }
  throw new Error('Mounted production runtime did not converge');
}

test('actual mounted publication runtime is production composition rather than a dormant accessor', async () => {
  const native = await nativeSubject();
  await feed();
  const path = '../../src/semantic/subject-page-publication.ts';
  const module = await import(path).catch(() => ({}));
  expect(typeof (module as any).createSubjectPagePublication).toBe('function');
  expect(typeof (module as any).subjectPagePublicationFor).toBe('function');
  const production = (module as any).createSubjectPagePublication;
  const made: { input: any; runtime: PublicationRunner }[] = [];
  // Delegates every call to production; captures construction before any accessor is invoked.
  const factory = spyOn(module as any, 'createSubjectPagePublication').mockImplementation((input: any) => {
    const runtime = production(input);
    made.push({ input, runtime });
    return runtime;
  });
  try {
    app = createKernel(options());
    expect(made).toHaveLength(1);
    expect(made[0]!.input).toEqual({ pool: db.pool, access, clock, routeKey });
    const runtime = (module as any).subjectPagePublicationFor(app) as PublicationRunner;
    expect(runtime).toBe(made[0]!.runtime);
    expect((module as any).subjectPagePublicationFor(app)).toBe(runtime);
    expect(made).toHaveLength(1);
    expect((await feed()).subjectPages.map((s) => s.id)).toContain(native.id);
    const subject = await coldSource();
    const request = spyOn(runtime, 'requestRebuild'); // spy keeps the actual durable enqueue implementation.
    try {
      const first = await feed();
      expect(first.subjectPages.map((s) => s.id)).not.toContain(subject.id);
      expect(request).toHaveBeenCalledWith(subject);
      expect(
        (
          await db.admin.query(`SELECT subject_id FROM semantic.subject_page_repair WHERE route=0 AND subject_id=$1`, [
            subject.id,
          ])
        ).rows,
      ).toHaveLength(1);
      const step = await runtime.step({ limit: 1 });
      expect(step.processed).toBeLessThanOrEqual(1);
      expect(step.done).toBe(false);
    } finally {
      request.mockRestore();
    }
    const storePath = '../../src/semantic/subject-page-publication-store.ts';
    const stores = await import(storePath).catch(() => ({}));
    expect(typeof (stores as any).createSubjectPagePublicationStore).toBe('function');
    const store: PublicationStore = (stores as any).createSubjectPagePublicationStore({
      pool: db.pool,
      access,
      clock,
      routeKey,
    });
    // New kernel, new mounted runtime, same durable job/checkpoint. Accessor never drives construction.
    app = createKernel(options());
    expect(made).toHaveLength(2);
    const restarted = (module as any).subjectPagePublicationFor(app) as PublicationRunner;
    expect(restarted).toBe(made[1]!.runtime);
    expect(restarted).not.toBe(runtime);
    now = new Date(now.getTime() + 60_000);
    await settle(restarted);
    expect(await store.readCurrent(subject)).toEqual({
      id: subject.id,
      labels: [{ language: 'en', value: 'Historical source' }],
    });
    const restored = (await feed()).subjectPages.find((s) => s.id === subject.id);
    expect(restored).toEqual({ id: subject.id, labels: [{ language: 'en', value: 'Historical source' }] });
    expect(Object.hasOwn(restored!, 'lastModified')).toBe(false);
    for (let repeat = 0; repeat < 3; repeat++) {
      expect(await restarted.step({ limit: 32 })).toEqual({ processed: 0, next: null, done: true });
      expect((await feed()).subjectPages.find((s) => s.id === subject.id)).toEqual(restored);
    }
  } finally {
    factory.mockRestore();
  }
}, 240_000);

test('default worker registers semantic publication and Relay once and shuts down its real services', async () => {
  // This is a native/default composition test, never a manually supplied WorkModule list.
  await nativeSubject();
  const subject = await coldSource();
  const program = `
    import assert from 'node:assert/strict';
    import { spyOn } from 'bun:test';
    import { DBOS } from '@dbos-inc/dbos-sdk';
    import * as publication from './src/semantic/subject-page-publication.ts';
    import * as relay from './src/semantic/subject-page-publication-relay.ts';
    import { KERNEL_WORK_MODULES } from './src/work/modules.ts';
    import { startWorker, readWorkerConfig } from './src/worker.ts';
    import pg from 'pg';
    const modules = KERNEL_WORK_MODULES.filter(m => m.name === 'semantic');
    assert.equal(modules.length, 1, 'one existing semantic WorkModule owns publication');
    const runtimes = [], relays = [], starts = [], stops = [];
    const actualPublication = publication.createSubjectPagePublication;
    const actualRelay = relay.createSubjectPagePublicationRelay;
    spyOn(publication, 'createSubjectPagePublication').mockImplementation(input => {
      const runtime = actualPublication(input); runtimes.push({ input, runtime }); return runtime;
    });
    spyOn(relay, 'createSubjectPagePublicationRelay').mockImplementation(input => {
      const runtime = actualRelay(input); relays.push({ input, runtime }); return runtime;
    });
    let registrations = 0, launches = 0, shutdowns = 0;
    const register = modules[0].register;
    modules[0].register = async function(context) {
      registrations++;
      await register.call(this, { ...context, addService(start) {
        context.addService(async () => {
          const service = await start(); starts.push(service);
          return { async stop() { await service.stop(); stops.push(service); } };
        });
      }});
    };
    const launch = DBOS.launch.bind(DBOS), shutdown = DBOS.shutdown.bind(DBOS);
    spyOn(DBOS, 'launch').mockImplementation(async (...args) => { launches++; return launch(...args); });
    spyOn(DBOS, 'shutdown').mockImplementation(async (...args) => { shutdowns++; return shutdown(...args); });
    const clock = () => new Date(process.env.PUBLICATION_CLOCK);
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    let worker;
    try {
      worker = await startWorker({ ...readWorkerConfig(process.env), clock });
      assert.equal(registrations, 1);
      assert.equal(launches, 1);
      assert.equal(runtimes.length, 1);
      assert.equal(relays.length, 1);
      const input = runtimes[0].input, foreign = relays[0].input;
      assert.equal(input.pool, foreign.pool);
      assert.equal(input.access, foreign.access);
      assert.equal(input.clock, clock);
      assert.equal(foreign.clock, clock);
      assert.deepEqual([...input.routeKey], [...Buffer.from(process.env.KERNEL_ROUTE_KEY, 'base64url')]);
      assert.deepEqual([...foreign.routeKey], [...input.routeKey]);
      assert.ok(starts.length > 0, 'production semantic services actually start');
      const subject = JSON.parse(process.env.PUBLICATION_SUBJECT);
      const deadline = Date.now() + 120000;
      let ready = false;
      while (Date.now() < deadline) {
        const result = await pool.query('SELECT readiness,evidence,public_effective_at FROM semantic.subject_page_publication WHERE route=$1 AND subject_id=$2', [subject.route, subject.id]);
        if (result.rows[0]?.readiness === 'ready') {
          assert.equal(result.rows[0].evidence, 'missing');
          assert.equal(result.rows[0].public_effective_at, null);
          ready = true; break;
        }
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      assert.ok(ready, 'default worker actually bootstraps and repairs native data');
      await worker.stop(); await worker.stop();
      assert.equal(shutdowns, 1);
      assert.deepEqual(stops, [...starts].reverse());
      assert.equal(input.pool.ended, true);
      console.log('publication-default-composition-ok');
    } finally { await worker?.stop(); await pool.end(); }
  `;
  // Resolve missing factories after genuine native setup, as behavior assertions, before spawning the default worker.
  const path = '../../src/semantic/subject-page-publication.ts';
  const module = await import(path).catch(() => ({}));
  expect(typeof (module as any).createSubjectPagePublication).toBe('function');
  const relayPath = '../../src/semantic/subject-page-publication-relay.ts';
  const relay = await import(relayPath).catch(() => ({}));
  expect(typeof (relay as any).createSubjectPagePublicationRelay).toBe('function');
  const child = Bun.spawn([process.execPath, '-e', program], {
    cwd: `${import.meta.dir}/../..`,
    env: {
      ...process.env,
      ...workerTestEnv({
        KERNEL_ROUTE_KEY: Buffer.from(routeKey).toString('base64url'),
        STRIPE_SECRET_KEY: 'sk_test_publication_composition',
        STRIPE_MANAGED_PAYMENTS: 'false',
        CHECKOUT_SUCCESS_URL: 'https://web.example.test/success',
        CHECKOUT_CANCEL_URL: 'https://web.example.test/cancel',
      }),
      DATABASE_URL: db.url,
      PUBLICATION_SUBJECT: JSON.stringify(subject),
      PUBLICATION_CLOCK: now.toISOString(),
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 180_000);
  try {
    const [exit, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect({ exit, diagnostics: exit === 0 ? null : stdout + stderr }).toEqual({ exit: 0, diagnostics: null });
    expect(stdout).toContain('publication-default-composition-ok');
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null) {
      child.kill();
      await child.exited;
    }
  }
}, 240_000);
