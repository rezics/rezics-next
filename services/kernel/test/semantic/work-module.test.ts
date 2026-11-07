import { afterAll, expect, test } from 'bun:test';
import pg from 'pg';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { createPool } from '../../src/database/pool.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { createSemanticWorkModule } from '../../src/semantic/work-module.ts';
import { createWorkerAuthorization } from '../../src/work/authorization.ts';
import { composeSemanticIdentityParticipants } from '../../src/composition/semantic.ts';
import { composeSearchNativePorts } from '../../src/composition/search-native.ts';
import { KERNEL_WORK_MODULES } from '../support/default-work-modules.ts';
import { testReceiptKeys } from '../support/receipt-keys.ts';
import { workerTestEnv } from '../support/worker-env.ts';
import { createRealAccess } from './real-access.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(databaseUrl);
const admin = new pg.Pool({ connectionString: databaseUrl, max: 4 });
afterAll(async () => {
  await pool.end();
  await admin.end();
});

// Each child owns the SDK singleton. Decorations observe the real default services and retain their handles.
const program = `
  const phase = name => console.error('semantic-work-phase: ' + name);
  phase('entry');
  const { default: assert } = await import('node:assert/strict');
  const { DBOS } = await import('@dbos-inc/dbos-sdk');
  const { spyOn } = await import('bun:test');
  phase('sdk-loaded');
  const authorizationModule = await import('./src/work/authorization.ts');
  phase('authorization-module-loaded');
  const createWorkerAuthorization = authorizationModule.createWorkerAuthorization;
  spyOn(authorizationModule, 'createWorkerAuthorization').mockImplementation((...args) => {
    phase('authorization-factory');
    const authorization = createWorkerAuthorization(...args);
    phase('authorization-created');
    return authorization;
  });
  const relayModule = await import('./src/events/relays.ts');
  let identityRegistrations = 0;
  let launches = 0;
  const registerWorkflow = DBOS.registerWorkflow;
  spyOn(DBOS, 'registerWorkflow').mockImplementation((workflow, config) => {
    phase('workflow-register:' + config?.name);
    if (config?.name === 'semantic.identityEpoch') identityRegistrations++;
    const registered = registerWorkflow.call(DBOS, workflow, config);
    phase('workflow-registered:' + config?.name);
    return registered;
  });
  const launch = DBOS.launch;
  spyOn(DBOS, 'launch').mockImplementation(async (...args) => {
    phase('sdk-launch');
    launches++;
    const result = await launch.apply(DBOS, args);
    phase('sdk-launched');
    return result;
  });
  const startRelays = relayModule.startRelays;
  let projectors = 0;
  spyOn(relayModule, 'startRelays').mockImplementation((nativePool, relays, ...rest) => {
    if (relays.some(relay => relay.consumer === 'semantic_links')) {
      assert.equal(nativePool, pool);
      assert.equal(DBOS.isInitialized(), true);
      projectors++;
    }
    return startRelays(nativePool, relays, ...rest);
  });
  phase('worker-import');
  const { readWorkerConfig, startWorker } = await import('./src/worker.ts');
  phase('worker-imported');
  const workClient = await import('./src/work/client.ts');
  const createWorkClient = workClient.createWorkClient;
  spyOn(workClient, 'createWorkClient').mockImplementation(async (...args) => {
    phase('client-create');
    const client = await createWorkClient(...args);
    phase('client-created');
    return client;
  });
  let pool;
  let starts = 0;
  let stops = 0;
  let registrations = 0;
  const fail = process.env.SEMANTIC_START_FAILURE === 'true';
  const decorate = nativeModules => {
    phase('bindings-installed');
    assert.equal(nativeModules.filter(m => m.name === 'semantic').length, 1);
    const modules = nativeModules.map(module => ({
      name: module.name,
      async register(context) {
        phase('register:' + module.name);
        const nativeContext = context;
        context = { ...context, getAuthorization() {
          phase('authorization:' + module.name);
          try {
            const authorization = nativeContext.getAuthorization();
            phase('authorized:' + module.name);
            return authorization;
          } catch (error) {
            console.error('semantic-work-authorization-error:', error);
            throw error;
          }
        }, addService(start) {
          nativeContext.addService(async () => {
            phase('service-start:' + module.name);
            const service = await start();
            phase('service-started:' + module.name);
            return service;
          });
        }};
        if (module.name !== 'semantic') {
          try {
            await module.register(context);
          } catch (error) {
            console.error('semantic-work-registration-error:' + module.name, error);
            throw error;
          }
          phase('registered:' + module.name);
          return;
        }
        registrations++;
        pool = context.pool;
        assert.equal(DBOS.isInitialized(), false);
        const registeredEffects = [];
        await module.register({ ...context, addEffects(effects) {
          registeredEffects.push(...effects);
          context.addEffects(effects);
        }, addService(start) {
          context.addService(async () => {
            assert.equal(DBOS.isInitialized(), true);
            const service = await start();
            starts++;
            return { async stop() {
              assert.equal(pool.ended, false);
              assert.equal(DBOS.isInitialized(), true);
              await service.stop();
              stops++;
            }};
          });
        }});
        const erasure = registeredEffects.find(effect => effect.name === 'semantic_erasure');
        assert.ok(erasure, 'Semantic registers its account tombstone effect even when no local data applies');
        assert.deepEqual(erasure.types, ['com.rezics.access.account-tombstoned.v1']);
        const identity = registeredEffects.find(effect => effect.name === 'identity_epoch_admission');
        assert.ok(identity, 'Semantic registers durable resumption of the saved identity job');
        assert.deepEqual(identity.types, ['com.rezics.semantic.identity-epoch.admitted.v1']);
        phase('registered:' + module.name);
      }
    }));
    if (fail) modules.push({ name: 'startup-failure', register(context) {
      context.addService(() => { throw new Error('later starter failed'); });
    }});
    return modules;
  };
  try {
    phase('worker-start');
    const worker = await startWorker(readWorkerConfig(process.env), decorate);
    assert.equal(fail, false);
    assert.equal(registrations, 1);
    assert.equal(identityRegistrations, 1);
    assert.equal(launches, 1);
    assert.equal(starts, 1);
    assert.equal(projectors, 1);
    console.log('semantic-ready');
    process.stdin.once('data', async () => {
      const stop = worker.stop();
      assert.equal(worker.stop(), stop);
      console.log('semantic-stopping');
      await stop;
      assert.equal(stops, 1);
      assert.equal(pool.ended, true);
      assert.equal(DBOS.isInitialized(), false);
      console.log('semantic-stopped');
      process.stdin.destroy();
    });
  } catch (error) {
    assert.equal(fail, true);
    assert.match(error.message, /later starter failed/);
    assert.equal(identityRegistrations, 1);
    assert.equal(launches, 1);
    assert.equal(starts, 1);
    assert.equal(projectors, 1);
    assert.equal(stops, 1);
    assert.equal(pool.ended, true);
    assert.equal(DBOS.isInitialized(), false);
    console.log('semantic-failure-cleaned');
  }
`;

function runtime(fail = false) {
  const application = `semantic-work-${crypto.randomUUID()}`;
  const url = new URL(databaseUrl!);
  url.searchParams.set('application_name', application);
  const child = Bun.spawn([process.execPath, '-e', program], {
    cwd: `${import.meta.dir}/../..`,
    env: {
      ...process.env,
      ...workerTestEnv(),
      DATABASE_URL: url.href,
      STRIPE_SECRET_KEY: 'sk_test_semantic_work',
      STRIPE_MANAGED_PAYMENTS: 'false',
      CHECKOUT_SUCCESS_URL: 'https://web.example.test/success',
      CHECKOUT_CANCEL_URL: 'https://web.example.test/cancel',
      SEMANTIC_START_FAILURE: String(fail),
    },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 45_000);
  void child.exited.then(() => clearTimeout(timeout));
  let output = '';
  const read = (async () => {
    for await (const chunk of child.stdout) output += new TextDecoder().decode(chunk);
  })();
  let errors = '';
  const readErrors = (async () => {
    for await (const chunk of child.stderr) errors += new TextDecoder().decode(chunk);
  })();
  return {
    application,
    child,
    output: () => output,
    async until(marker: string) {
      try {
        await until(async () => {
          if (output.includes(marker)) return true;
          if (child.exitCode !== null) throw new Error(`Semantic child exited before ${marker}`);
          return false;
        });
      } catch (error) {
        throw new Error(`${error instanceof Error ? error.message : error}\n${output}\n${errors}`);
      }
    },
    async finish() {
      const status = await child.exited;
      await read;
      await readErrors;
      expect(status, `${output}\n${errors}`).toBe(0);
    },
    async dispose() {
      if (child.exitCode === null) child.kill('SIGKILL');
      await child.exited;
      await Promise.all([read, readErrors]);
    },
  };
}

async function until(condition: () => Promise<boolean>, timeout = 15_000) {
  const end = Date.now() + timeout;
  while (!(await condition())) {
    if (Date.now() > end) throw new Error('Native Semantic work did not converge');
    await Bun.sleep(20);
  }
}

async function checkpoint(partition: number) {
  const { rows } = await admin.query(
    "SELECT epoch, position::text FROM core.consumer_checkpoint WHERE consumer = 'semantic_links' AND partition_no = $1",
    [partition],
  );
  return rows[0];
}

const accounts = {
  editor: '019a1b2c-3d4e-7f00-8a00-ed170e000051',
  acceptor: '019a1b2c-3d4e-7f00-8a00-acce97000052',
};

test('default semantic WorkModule registers and starts the existing native semantic_links projector exactly once and drains it on shutdown', async () => {
  expect(KERNEL_WORK_MODULES.filter(({ name }) => name === 'semantic')).toHaveLength(1);
  const child = runtime(true);
  try {
    await child.until('semantic-failure-cleaned');
    await child.finish();
    const { rows } = await admin.query('SELECT pid FROM pg_stat_activity WHERE application_name = $1', [
      child.application,
    ]);
    expect(rows).toEqual([]);
  } finally {
    await child.dispose();
  }
}, 30_000);

test('actual native subject relation events converge through registered Semantic work without a manually started projector', async () => {
  const access = await createRealAccess(admin, accounts, [
    'subject:create',
    'subject:read',
    'statement:propose',
    'context:accept',
    'context:adopt',
  ]);
  for (const action of ['subject:create', 'statement:propose']) {
    await access.grant({ route: 0, id: GLOBAL_CONTEXT }, 'editor', action);
  }
  for (const action of ['context:accept', 'context:adopt']) {
    await access.grant({ route: 0, id: GLOBAL_CONTEXT }, 'acceptor', action);
  }
  expect(await bootstrapRelease(pool, bundledRelease)).toBe(bundledDigest);
  const kernel = createKernel({
    pool,
    access: access.access,
    writeRate: access.writeRate,
    tokens: { current: 1, keys: new Map([[1, new Uint8Array(32).fill(3)]]) },
    receiptKeys: testReceiptKeys(),
    routeKey: new Uint8Array(32).fill(4),
  });
  const call = async (method: string, path: string, as: keyof typeof accounts, body?: unknown) => {
    const response = await kernel.handle(
      new Request(`http://kernel.test${path}`, {
        method,
        headers: {
          authorization: `Bearer ${access.bearer(as)}`,
          'content-type': 'application/json',
          'idempotency-key': `"${crypto.randomUUID()}"`,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
    expect(response.status, `${method} ${path}: ${await response.clone().text()}`).toBe(
      method === 'POST' && !path.endsWith(':accept') && !path.endsWith(':adopt') ? 201 : 200,
    );
    return (await response.json()) as Record<string, any>;
  };
  const statement = (target: string) => ({
    property: { id: 'schema:exampleOfWork' },
    value: { type: 'value', content: target },
  });
  const create = async (title: string, target?: string) =>
    (
      await call('POST', '/v1/subjects', 'editor', {
        type: target ? 'bf:Instance' : 'schema:Book',
        labels: { en: title },
        ...(target ? { statements: { 'schema:exampleOfWork': [statement(target)] } } : {}),
      })
    ).subject;
  const original = await create('Original work');
  const other = await create('Adopted work');
  const edition = await create('Native edition', original.id);
  const sourcePartition = partitionOf(routeOf(edition.id)!);
  const child = runtime();
  const lock = await admin.connect();
  const gate = Math.floor(Math.random() * 2 ** 30);
  try {
    await child.until('semantic-ready');
    await until(async () => {
      const result = await admin.query(
        'SELECT 1 FROM semantic.inbound_link WHERE subject_id = $1 AND source_subject_id = $2 AND present',
        [original.id, edition.id],
      );
      return result.rowCount === 1;
    });
    const inbound = await call('GET', `/v1/subjects/${original.id}/links`, 'editor');
    expect(inbound.freshness).toEqual({ consistency: 'eventual', target_seconds: 10, caught_up: true });
    expect(inbound.links).toEqual([expect.objectContaining({ subject: edition.id, property: 'schema:exampleOfWork' })]);
    const proposed = await call('POST', `/v1/subjects/${edition.id}/candidates`, 'editor', {
      statement: {
        ...statement(other.id),
        references: [
          {
            parts: [
              { property: { id: 'schema:url' }, value: { type: 'value', content: 'https://example.test/source' } },
            ],
          },
        ],
      },
    });
    await call('POST', `/v1/subjects/${edition.id}/candidates/${proposed.candidate}:accept`, 'acceptor', {
      context: GLOBAL_CONTEXT,
      expected_head: null,
    });
    await until(async () => {
      const head = (
        await admin.query('SELECT position::text FROM core.partition WHERE partition_no = $1', [sourcePartition])
      ).rows[0];
      return (await checkpoint(sourcePartition))?.position === head.position;
    });
    // Gate the actual checkpoint UPDATE after native application, without changing projector timeouts or ACKs.
    await lock.query('SELECT pg_advisory_lock($1)', [gate]);
    await admin.query(`CREATE FUNCTION public.hold_semantic_checkpoint() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_advisory_xact_lock(${gate}::bigint); RETURN NEW; END $$`);
    await admin.query(`CREATE TRIGGER hold_semantic_checkpoint BEFORE UPDATE ON core.consumer_checkpoint
      FOR EACH ROW WHEN (NEW.consumer = 'semantic_links' AND NEW.partition_no = ${sourcePartition})
      EXECUTE FUNCTION public.hold_semantic_checkpoint()`);
    await call('POST', `/v1/subjects/${edition.id}:adopt`, 'acceptor', {
      context: GLOBAL_CONTEXT,
      property: 'schema:exampleOfWork',
      target: other.id,
      mode: 'replace',
      selection: [{ candidate: proposed.candidate, rank: 'normal' }],
      expected_head: null,
    });
    const head = (
      await admin.query('SELECT epoch, position::text FROM core.partition WHERE partition_no = $1', [sourcePartition])
    ).rows[0];
    const blocked = async () =>
      (
        await admin.query(`SELECT pid FROM pg_stat_activity WHERE application_name = $1 AND wait_event_type = 'Lock'`, [
          child.application,
        ])
      ).rows;
    await until(async () => (await blocked()).length > 0);
    await Bun.sleep(250);
    expect(await blocked()).toHaveLength(1); // A duplicate projector would also wait on the native checkpoint update.
    // The worker's signal handler starts shutdown; explicit repeated stops must join the same drain.
    child.child.kill('SIGTERM');
    child.child.stdin.write('stop\n');
    await child.until('semantic-stopping');
    await Bun.sleep(200);
    expect(child.output()).not.toContain('semantic-stopped');
    expect(child.child.exitCode).toBeNull();
    await lock.query('SELECT pg_advisory_unlock($1)', [gate]);
    await child.until('semantic-stopped');
    await child.finish();
    const drained = await checkpoint(sourcePartition);
    expect(drained.epoch).toBe(head.epoch);
    expect(BigInt(drained.position)).toBeGreaterThanOrEqual(BigInt(head.position));
    const adopted = await call('GET', `/v1/subjects/${other.id}/links`, 'acceptor');
    expect(adopted.freshness).toEqual({ consistency: 'eventual', target_seconds: 10, caught_up: true });
    expect(adopted.links).toEqual([expect.objectContaining({ subject: edition.id, statement: proposed.candidate })]);
    const before = await checkpoint(sourcePartition);
    const later = await create('After shutdown', other.id);
    const laterPartition = partitionOf(routeOf(later.id)!);
    const laterCheckpoint = await checkpoint(laterPartition);
    await Bun.sleep(300);
    expect(await checkpoint(laterPartition)).toEqual(laterCheckpoint);
    expect(await checkpoint(sourcePartition)).toEqual(before);
    expect(
      (await admin.query('SELECT 1 FROM semantic.inbound_link WHERE source_subject_id = $1', [later.id])).rows,
    ).toEqual([]);
    expect(
      (await admin.query('SELECT pid FROM pg_stat_activity WHERE application_name = $1', [child.application])).rows,
    ).toEqual([]);
  } finally {
    await lock.query('SELECT pg_advisory_unlock_all()');
    await admin.query('DROP TRIGGER IF EXISTS hold_semantic_checkpoint ON core.consumer_checkpoint');
    await admin.query('DROP FUNCTION IF EXISTS public.hold_semantic_checkpoint()');
    lock.release();
    await child.dispose();
  }
}, 60_000);

test('default Semantic composition registers its real locator and bounded local continuation', async () => {
  const effects: import('../../src/events/effects.ts').Effect[] = [];
  const { createWorkClient } = await import('../../src/work/client.ts');
  const { WORK_QUEUES } = await import('../../src/work/queues.ts');
  const client = await createWorkClient(databaseUrl!, pool);
  const env = { ...process.env, ...workerTestEnv() };
  const clock = () => new Date();
  try {
    const authorization = createWorkerAuthorization({ pool, client, env, clock, receiptKeys: testReceiptKeys() });
    await createSemanticWorkModule(composeSemanticIdentityParticipants, composeSearchNativePorts).register({
      pool,
      env,
      clock,
      queues: WORK_QUEUES,
      client,
      getAuthorization() {
        return authorization;
      },
      addEffects(registered) {
        effects.push(...registered);
      },
      addService() {},
    });
  } finally {
    await client.close();
  }
  const locator = effects.find((effect) => effect.name === 'semantic_erasure_locator');
  const local = effects.find((effect) => effect.name === 'semantic_erasure_local');
  expect(locator?.types).toContain('com.rezics.zone.configured.v1');
  expect(locator?.types).toContain('com.rezics.semantic.erasure.locator-scheduled.v1');
  expect(local?.types).toEqual(['com.rezics.semantic.erasure.scheduled.v1']);
  const { ERASURE_LOCATOR_EFFECTS } = await import('../../src/access/erasure.ts');
  expect(ERASURE_LOCATOR_EFFECTS.has(locator!.name)).toBe(true);
  const tombstone = effects.find((effect) => effect.name === 'semantic_erasure');
  expect(tombstone?.types).toEqual(['com.rezics.access.account-tombstoned.v1']);
  expect(ERASURE_LOCATOR_EFFECTS.has(tombstone!.name)).toBe(true);
  const bootstrap = effects.find((effect) => effect.name === 'identity_epoch_bootstrap');
  expect(bootstrap?.types).toContain('com.rezics.semantic.identity-epoch.bootstrap.v1');
  expect(bootstrap?.types).toContain('com.rezics.semantic.identity-epoch.bootstrap-scheduled.v1');
});
