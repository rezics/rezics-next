import assert from 'node:assert/strict';
import { decodeJwt } from 'jose';
import { Pool } from 'pg';
import { createKernel, type KernelDependencies } from '../../../src/http/kernel.ts';
import { readMembershipWorkConfig } from '../../../src/access/membership-work-config.ts';
import { closeOwnedSemanticAuth } from '../outcome-auth.ts';
import { createSemanticDriver, type SemanticOutcomeDriver } from '../outcome-driver.ts';

type OwnedResource = { kind: 'kernel_database' | 'auth_database'; name: string };
type Runtime = SemanticOutcomeDriver['fixtures']['runtime'];
type Captured = Pick<Runtime, 'databaseUrl' | 'routeKey' | 'sessionKeys'>;
const sensitiveValues = Object.entries(process.env)
  .filter(([name]) => /DATABASE_URL|KEY|SECRET|TOKEN|PASSWORD/.test(name))
  .map(([, value]) => value)
  .filter((value): value is string => Boolean(value));
const adminPools = new Set<Pool>();
const openDrivers = new Set<SemanticOutcomeDriver>();

function adminUrl(source: string): string {
  const value = new URL(source);
  value.pathname = '/postgres';
  return value.href;
}

async function adminPool(): Promise<Pool> {
  const source = process.env.DATABASE_URL;
  assert.ok(source, 'DATABASE_URL is required');
  const pool = new Pool({ connectionString: adminUrl(source), max: 1 });
  adminPools.add(pool);
  return pool;
}

async function endAdmin(pool: Pool): Promise<void> {
  adminPools.delete(pool);
  await pool.end();
}

async function closeDriver(driver: SemanticOutcomeDriver): Promise<void> {
  try {
    await driver.close();
  } finally {
    openDrivers.delete(driver);
  }
}

async function hasDatabase(admin: Pool, name: string): Promise<boolean> {
  const result = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
  return result.rowCount === 1;
}

async function makeCompose(captured: { value?: Captured }): Promise<typeof createKernel> {
  return (dependencies: KernelDependencies) => {
    const runtime: Captured = {
      databaseUrl: dependencies.pool.options.connectionString!,
      routeKey: Buffer.from(dependencies.routeKey).toString('base64url'),
      sessionKeys: [...dependencies.tokens!.keys]
        .map(([id, key]) => `${id}:${Buffer.from(key).toString('base64url')}`)
        .join(','),
    };
    captured.value = runtime;
    return createKernel(dependencies);
  };
}

async function waitForLine(lines: string[], expected: string, child: ReturnType<typeof Bun.spawn>): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!lines.includes(expected)) {
    assert.ok(!lines.some((line) => line.startsWith('FAIL:')), 'External runtime rejected its configuration');
    assert.equal(child.exitCode, null, 'External runtime exited before readiness');
    assert.ok(Date.now() < deadline, `External runtime did not report ${expected}`);
    await Bun.sleep(10);
  }
}

async function externalRuntime(runtime: Runtime) {
  const child = Bun.spawn([process.execPath, `${import.meta.dir}/outcome-lifecycle-child.ts`, 'runtime'], {
    env: {
      ...process.env,
      DATABASE_URL: runtime.databaseUrl,
      KERNEL_ROUTE_KEY: runtime.routeKey,
      KERNEL_SESSION_KEYS: runtime.sessionKeys,
      AUTH_ISSUER: runtime.authIssuer,
      AUTH_AUDIENCE: runtime.authAudience,
      AUTH_JWKS_URL: runtime.authJwksUrl,
    },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = child.stdout;
  const stderr = child.stderr;
  if (!stdout || typeof stdout === 'number' || !stderr || typeof stderr === 'number')
    throw new Error('External runtime did not receive output pipes');
  const lines: string[] = [];
  const readOutput = (async () => {
    let pending = '';
    for await (const chunk of stdout) {
      pending += new TextDecoder().decode(chunk);
      const parts = pending.split('\n');
      pending = parts.pop() ?? '';
      lines.push(...parts);
    }
  })();
  const readErrors = new Response(stderr).text();
  await waitForLine(lines, 'runtime-ready', child);
  let stopping: Promise<void> | undefined;
  return {
    lines,
    async stop() {
      stopping ??= (async () => {
        const stdin = child.stdin;
        if (!stdin || typeof stdin === 'number') throw new Error('External runtime did not receive controllable stdin');
        await stdin.end();
        const exitCode = await child.exited;
        await readOutput;
        await readErrors;
        assert.equal(exitCode, 0);
        assert.ok(lines.includes('runtime-stopped'));
      })();
      await stopping;
    },
  };
}

async function externalRuntimeMode() {
  const admin = await adminPool();
  const acknowledgements: Array<OwnedResource & { existed: boolean }> = [];
  const events: string[] = [];
  const captured: { value?: Captured } = {};
  const compose = await makeCompose(captured);
  let driver!: SemanticOutcomeDriver;
  let runtimeProcess: Awaited<ReturnType<typeof externalRuntime>> | undefined;

  try {
    driver = await createSemanticDriver(compose, {
      linkProjection: 'external',
      strictCleanup: true,
      onOwnedResource: async (resource) => {
        acknowledgements.push({ ...resource, existed: await hasDatabase(admin, resource.name) });
      },
      beforeClose: async () => {
        events.push('before-close');
        await runtimeProcess?.stop();
        events.push('runtime-stopped');
        await driver.fixtures.pool.query('SELECT 1');
        const account = await driver.fixtures.person('closing-hook');
        sensitiveValues.push(account.bearer);
        const token = decodeJwt(account.bearer);
        assert.equal(token.iss, driver.fixtures.runtime.authIssuer);
        assert.equal(token.aud, driver.fixtures.runtime.authAudience);
        const response = await driver.fixtures.send(account, 'GET', '/v1/definitions/active');
        assert.equal(response.status, 200);
        events.push('auth-and-access-used');
        await closeOwnedSemanticAuth();
        events.push('auth-disposed');
      },
    });
    openDrivers.add(driver);

    const runtime = driver.fixtures.runtime;
    sensitiveValues.push(...Object.values(runtime));
    assert.equal(runtime.databaseUrl, captured.value?.databaseUrl);
    assert.equal(runtime.routeKey, captured.value?.routeKey);
    assert.equal(runtime.sessionKeys, captured.value?.sessionKeys);
    runtimeProcess = await externalRuntime(runtime);
    const unsupported = await driver.projection('paused').then(
      () => false,
      (error: unknown) => error instanceof Error && error.message.includes('external'),
    );
    assert.equal(unsupported, true);
    assert.equal(acknowledgements.length, 2);
    assert.ok(acknowledgements.every((resource) => !resource.existed));
    assert.ok(acknowledgements.some((resource) => resource.kind === 'kernel_database'));
    assert.ok(acknowledgements.some((resource) => resource.kind === 'auth_database'));

    const names = acknowledgements.map(({ name }) => name);
    const firstClose = driver.close();
    const secondClose = driver.close();
    assert.equal(firstClose, secondClose);
    await Promise.all([firstClose, secondClose]);
    openDrivers.delete(driver);
    assert.deepEqual(events, ['before-close', 'runtime-stopped', 'auth-and-access-used', 'auth-disposed']);
    assert.equal(
      await hasDatabase(
        admin,
        names.find((name) => name.startsWith('semantic_'))!,
      ),
      false,
    );
    assert.equal(
      await hasDatabase(
        admin,
        names.find((name) => name.startsWith('semantic_auth_'))!,
      ),
      false,
    );
    await endAdmin(admin);
    process.stdout.write(
      `RESULT:${JSON.stringify({
        runtimeValidated: true,
        runtimeStoppedBeforeKernelDrop: true,
        realAuthAndAccessUsedDuringClose: true,
        externalProjectionRejected: true,
        ownershipAcknowledgedBeforeAllocation: true,
        ownedDatabasesRemoved: true,
      })}`,
    );
  } catch (error) {
    await runtimeProcess?.stop().catch(() => {});
    if (driver) await closeDriver(driver).catch(() => {});
    await closeOwnedSemanticAuth().catch(() => {});
    await endAdmin(admin).catch(() => {});
    throw error;
  }
}

async function authCleanupMode() {
  const admin = await adminPool();
  const owned: OwnedResource[] = [];
  let driver!: SemanticOutcomeDriver;
  let issuer = '';
  driver = await createSemanticDriver(createKernel, {
    strictCleanup: true,
    onOwnedResource: (resource) => {
      owned.push(resource);
    },
    beforeClose: async () => {
      const first = closeOwnedSemanticAuth();
      const second = closeOwnedSemanticAuth();
      assert.equal(first, second);
      await first;
    },
  });
  openDrivers.add(driver);
  issuer = driver.fixtures.runtime.authIssuer;
  assert.equal((await fetch(issuer)).status, 404);
  const authClose = closeOwnedSemanticAuth();
  assert.equal(authClose, closeOwnedSemanticAuth());
  await authClose;
  const first = driver.close();
  const second = driver.close();
  assert.equal(first, second);
  await Promise.all([first, second]);
  openDrivers.delete(driver);
  const listenerClosed = await fetch(issuer).then(
    () => false,
    () => true,
  );
  assert.equal(listenerClosed, true);
  assert.equal(await hasDatabase(admin, owned.find((resource) => resource.kind === 'auth_database')!.name), false);
  assert.equal(await hasDatabase(admin, owned.find((resource) => resource.kind === 'kernel_database')!.name), false);
  await endAdmin(admin);

  process.stdout.write(
    `RESULT:${JSON.stringify({
      closeIsShared: true,
      authCloseIsShared: true,
      listenerClosed: true,
      watcherAndAuthDatabaseDrained: true,
    })}`,
  );
}

async function setupFailureMode() {
  const admin = await adminPool();
  const owned: OwnedResource[] = [];
  const setupError = new Error('intentional setup failure');
  const hookError = new Error('intentional before-close failure');
  let caught: unknown;
  try {
    await createSemanticDriver(
      (() => {
        throw setupError;
      }) as typeof createKernel,
      {
        strictCleanup: true,
        onOwnedResource: (resource) => {
          owned.push(resource);
        },
        beforeClose: async () => {
          await closeOwnedSemanticAuth();
          throw hookError;
        },
      },
    );
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof AggregateError);
  assert.equal(caught.errors[0], setupError);
  assert.ok(caught.errors.some((error) => error === setupError));
  assert.ok(caught.errors.some((error) => error instanceof AggregateError && error.errors.includes(hookError)));
  for (const resource of owned) assert.equal(await hasDatabase(admin, resource.name), false);
  assert.ok(owned.some((resource) => resource.kind === 'kernel_database'));
  assert.ok(owned.some((resource) => resource.kind === 'auth_database'));
  await endAdmin(admin);
  process.stdout.write(
    `RESULT:${JSON.stringify({
      setupErrorPreserved: true,
      cleanupFailureReported: true,
      laterCleanupAttempted: true,
    })}`,
  );
}

async function authConstructionFailureMode() {
  const admin = await adminPool();
  const owned: OwnedResource[] = [];
  const events: string[] = [];
  const originalEnd = Pool.prototype.end;
  const originalServe = Bun.serve;
  const originalSpawn = Bun.spawn;
  const retention = process.env.AUTH_WORKFLOW_RETENTION_DAYS;
  let authName: string | undefined;
  let listener: ReturnType<typeof Bun.serve> | undefined;
  let originalStop: ReturnType<typeof Bun.serve>['stop'] | undefined;
  let watcher: ReturnType<typeof Bun.spawn> | undefined;
  let issuer = '';
  let authPoolEndCompletions = 0;
  let endedBeforeListenerAndWatcher = false;
  let caught: unknown;

  try {
    // Observe only the acknowledged Auth pool, forwarding every call to the genuine end method.
    Pool.prototype.end = function (this: Pool, ...args: Parameters<typeof originalEnd>) {
      const target = authName && new URL(this.options.connectionString!).pathname === `/${authName}`;
      const ending = Reflect.apply(originalEnd, this, args) as Promise<void> | undefined;
      if (!target || !ending) return ending;
      return ending.then(async () => {
        authPoolEndCompletions++;
        endedBeforeListenerAndWatcher =
          this.ended && Boolean(listener?.port) && watcher?.exitCode === null && (await hasDatabase(admin, authName!));
        events.push('auth-pool-ended');
      });
    } as typeof originalEnd;
    Bun.serve = ((options: Parameters<typeof originalServe>[0]) => {
      const server = originalServe(options);
      listener = server;
      issuer = `http://127.0.0.1:${server.port}`;
      originalStop = server.stop;
      const stop = server.stop.bind(server);
      server.stop = async (closeActiveConnections) => {
        await stop(closeActiveConnections);
        events.push('listener-stopped');
      };
      return server;
    }) as typeof originalServe;
    Bun.spawn = ((...args: Parameters<typeof originalSpawn>) => {
      const child = Reflect.apply(originalSpawn, Bun, args) as ReturnType<typeof Bun.spawn>;
      const command = args[0];
      if (authName && Array.isArray(command) && command.includes(authName)) {
        watcher = child;
        void child.exited.then(() => events.push('watcher-exited'));
      }
      return child;
    }) as typeof originalSpawn;
    process.env.AUTH_WORKFLOW_RETENTION_DAYS = 'invalid';
    try {
      const driver = await createSemanticDriver(createKernel, {
        strictCleanup: true,
        onOwnedResource: (resource) => {
          owned.push(resource);
          if (resource.kind === 'auth_database') authName = resource.name;
        },
      });
      openDrivers.add(driver);
    } catch (error) {
      caught = error;
      events.push('setup-rejected');
    }
    assert.ok(caught instanceof Error && !(caught instanceof AggregateError));
    assert.equal(caught.name, 'WorkflowRetentionConfigurationError');
    assert.equal(caught.message, 'Invalid Auth host configuration: AUTH_WORKFLOW_RETENTION_DAYS');
    assert.equal(authPoolEndCompletions, 1, 'Allocated Auth Pool.end must complete exactly once');
    assert.equal(endedBeforeListenerAndWatcher, true);
    assert.deepEqual(events, ['auth-pool-ended', 'listener-stopped', 'watcher-exited', 'setup-rejected']);
    assert.ok(listener);
    assert.equal(
      await fetch(issuer).then(
        () => false,
        () => true,
      ),
      true,
    );
    assert.ok(watcher);
    assert.equal(watcher.exitCode, 0);
    assert.equal(owned.length, 2);
    assert.ok(owned.some((resource) => resource.kind === 'kernel_database'));
    assert.ok(owned.some((resource) => resource.kind === 'auth_database'));
    for (const resource of owned) assert.equal(await hasDatabase(admin, resource.name), false);
    process.stdout.write(
      `RESULT:${JSON.stringify({
        configurationErrorPreserved: true,
        authPoolEndCompletions,
        authPoolEndStage: 'before listener stop and watcher drain',
        listenerClosed: true,
        watcherDrained: true,
        ownedDatabasesRemoved: true,
      })}`,
    );
  } finally {
    Pool.prototype.end = originalEnd;
    Bun.serve = originalServe;
    Bun.spawn = originalSpawn;
    if (listener && originalStop) listener.stop = originalStop;
    if (retention === undefined) delete process.env.AUTH_WORKFLOW_RETENTION_DAYS;
    else process.env.AUTH_WORKFLOW_RETENTION_DAYS = retention;
    await endAdmin(admin);
  }
}

async function defaultProjectionMode() {
  const admin = await adminPool();
  const firstOwnership: Array<OwnedResource & { existed: boolean }> = [];
  const first = await createSemanticDriver(createKernel, {
    onOwnedResource: async (resource) => {
      firstOwnership.push({ ...resource, existed: await hasDatabase(admin, resource.name) });
    },
  });
  openDrivers.add(first);
  await first.projection('paused');
  await first.projection('running');
  await closeDriver(first);
  assert.ok(firstOwnership.every((resource) => !resource.existed));

  const cachedOwnership: Array<OwnedResource & { existed: boolean }> = [];
  const second = await createSemanticDriver(createKernel, {
    onOwnedResource: async (resource) => {
      cachedOwnership.push({ ...resource, existed: await hasDatabase(admin, resource.name) });
    },
  });
  openDrivers.add(second);
  await second.projection('paused');
  await second.projection('running');
  await closeDriver(second);
  await closeOwnedSemanticAuth();
  assert.ok(cachedOwnership.some((resource) => resource.kind === 'auth_database' && resource.existed));
  for (const resource of [...firstOwnership, ...cachedOwnership])
    assert.equal(await hasDatabase(admin, resource.name), false);
  await endAdmin(admin);
  process.stdout.write(
    `RESULT:${JSON.stringify({
      defaultProjectionPausedAndResumed: true,
      cachedAuthOwnershipReplayed: true,
      ownedDatabasesRemoved: true,
    })}`,
  );
}

async function externalRuntimeModeChild() {
  const config = readMembershipWorkConfig(process.env);
  const database = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  await database.query('SELECT 1');
  assert.equal(config.routeKey.byteLength, 32);
  assert.ok(config.referenceKeys.keys.size > 0);
  assert.ok(config.auth.issuer);
  assert.ok(config.auth.audience);
  assert.ok(config.auth.jwksUrl);
  const jwksResponse = await fetch(config.auth.jwksUrl);
  assert.equal(jwksResponse.status, 200);
  const jwks = (await jwksResponse.json()) as { keys?: unknown[] };
  assert.ok(jwks.keys && jwks.keys.length > 0);
  process.stdout.write('runtime-ready\n');
  for await (const _chunk of Bun.stdin.stream()) {
    // A clean EOF is the supervisor's stop signal.
  }
  await database.query('SELECT 1');
  await database.end();
  process.stdout.write('runtime-stopped\n');
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const nested = error instanceof AggregateError ? [...error.errors].map(safeError) : [];
  let safe = [message, ...nested].join(' | ');
  for (const value of sensitiveValues) safe = safe.replaceAll(value, '[redacted]');
  return safe.replace(/(?:postgres(?:ql)?|https?):\/\/\S+/g, '[redacted-url]');
}

async function run() {
  const mode = process.argv[2];
  if (mode === 'runtime') await externalRuntimeModeChild();
  else if (mode === 'external-runtime') await externalRuntimeMode();
  else if (mode === 'auth-cleanup') await authCleanupMode();
  else if (mode === 'cleanup-failure') await setupFailureMode();
  else if (mode === 'auth-construction-failure') await authConstructionFailureMode();
  else if (mode === 'default-projection') await defaultProjectionMode();
  else throw new Error('Unknown outcome lifecycle child mode');
}

await run().catch(async (error) => {
  const message = safeError(error);
  for (const driver of [...openDrivers]) await closeDriver(driver).catch(() => {});
  await closeOwnedSemanticAuth().catch(() => {});
  for (const pool of [...adminPools]) await endAdmin(pool).catch(() => {});
  process.stdout.write(`FAIL:${message}`);
  process.exitCode = 1;
});
