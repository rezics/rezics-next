import { expect, test } from 'bun:test';
import { readWorkerConfig } from '../../src/worker.ts';
import { createWorkClient } from '../../src/work/client.ts';
import { WORK_QUEUES } from '../../src/work/queues.ts';
import { commerceWorkModule } from '../../src/commerce/work-module.ts';
import { KERNEL_WORK_MODULES } from '../../src/work/modules.ts';
import { fixture } from './support/process.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const routeKey = Buffer.alloc(32, 41).toString('base64url');
const workerEnvironment = {
  KERNEL_ROUTE_KEY: routeKey,
  KERNEL_RATING_COUNTER_SECRET: Buffer.alloc(32, 43).toString('base64url'),
  KERNEL_SESSION_KEYS: `1:${Buffer.alloc(32, 42).toString('base64url')}`,
  AUTH_ISSUER: 'https://auth.worker.test',
  AUTH_AUDIENCE: 'https://kernel.worker.test',
  AUTH_JWKS_URL: 'https://auth.worker.test/.well-known/jwks.json',
};

test('worker configuration names invalid variables without revealing values', () => {
  expect(KERNEL_WORK_MODULES.filter((module) => module === commerceWorkModule)).toHaveLength(1);
  expect(KERNEL_WORK_MODULES.map((module) => module.name)).toEqual([
    'accounts',
    'account_erasure',
    'rating',
    'commerce',
    'library',
    'community',
    'semantic',
    'search',
    'content',
    'retention',
  ]);
  expect(Object.keys(WORK_QUEUES)).toEqual([
    'governance',
    'effects',
    'locator-effects',
    'workflows',
    'delivery',
    'import',
    'maintenance',
  ]);
  expect(readWorkerConfig({ DATABASE_URL: databaseUrl })).toMatchObject({ databaseUrl, poolSize: 10 });
  expect(
    readWorkerConfig({ DATABASE_URL: databaseUrl, NOMAD_JOB_NAME: 'kernel', NOMAD_ALLOC_INDEX: '3' }),
  ).toMatchObject({ executorId: 'kernel-3' });
  expect(
    readWorkerConfig({
      DATABASE_URL: databaseUrl,
      KERNEL_EXECUTOR_ID: 'dedicated',
      NOMAD_JOB_NAME: 'kernel',
      NOMAD_ALLOC_INDEX: '3',
      KERNEL_WORKER_POOL_SIZE: '4',
    }),
  ).toMatchObject({ executorId: 'dedicated', poolSize: 4 });
  for (const [variable, value] of [
    ['DATABASE_URL', undefined],
    ['DATABASE_URL', 'https://secret.invalid'],
    ['KERNEL_EXECUTOR_ID', ''],
    ['NOMAD_JOB_NAME', ''],
    ['NOMAD_ALLOC_INDEX', 'private-invalid-index'],
    ['KERNEL_WORKER_POOL_SIZE', '0'],
    ['KERNEL_WORKER_POOL_SIZE', '101'],
    ['KERNEL_WORKER_POOL_SIZE', '2.5'],
  ] as const) {
    let error: unknown;
    try {
      readWorkerConfig({ DATABASE_URL: databaseUrl, [variable]: value });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(variable);
    if (value) expect((error as Error).message).not.toContain(value);
  }
  expect(() => readWorkerConfig({ DATABASE_URL: databaseUrl, NOMAD_JOB_NAME: 'kernel' })).toThrow('NOMAD_ALLOC_INDEX');
});

const valid: Record<string, string> = {
  ...workerEnvironment,
  DATABASE_URL: databaseUrl,
  STRIPE_SECRET_KEY: 'sk_test_worker_configuration_secret',
  STRIPE_MANAGED_PAYMENTS: 'false',
  CHECKOUT_SUCCESS_URL: 'https://web.example.test/success',
  CHECKOUT_CANCEL_URL: 'https://web.example.test/cancel',
  // The check's one analysis database; without it each child re-describes every statement against the file's own.
  ...(process.env.REYLO_CONFIG ? { REYLO_CONFIG: process.env.REYLO_CONFIG } : {}),
};

test("worker configuration children read Reylo analyses from the check's analysis database", async () => {
  const reyloConfig = process.env.REYLO_CONFIG;
  if (!reyloConfig) return;
  const child = Bun.spawn([process.execPath, '-e', 'console.log(process.env.REYLO_CONFIG ?? "")'], {
    env: { ...valid },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exitCode, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  expect(exitCode).toBe(0);
  expect(stdout.trim()).toBe(reyloConfig);
});

test('a worker missing or rejecting commerce configuration names the variable and hides secret values', async () => {
  const cases = [
    ['STRIPE_SECRET_KEY', undefined, 'STRIPE_SECRET_KEY'],
    ['STRIPE_SECRET_KEY', 'sk_test_do_not_print_secret!', 'STRIPE_SECRET_KEY'],
    ['STRIPE_MANAGED_PAYMENTS', undefined, 'STRIPE_MANAGED_PAYMENTS'],
    ['STRIPE_MANAGED_PAYMENTS', 'sometimes', 'STRIPE_MANAGED_PAYMENTS'],
    ['CHECKOUT_SUCCESS_URL', undefined, 'CHECKOUT_SUCCESS_URL'],
    ['CHECKOUT_SUCCESS_URL', 'http://web.example.test/success', 'CHECKOUT_SUCCESS_URL'],
    ['CHECKOUT_CANCEL_URL', undefined, 'CHECKOUT_CANCEL_URL'],
    ['CHECKOUT_CANCEL_URL', 'javascript:secret-value', 'CHECKOUT_CANCEL_URL'],
    ['STRIPE_API_HOST', 'ftp://secret-host.invalid', 'STRIPE_API_HOST'],
  ] as const;
  const program = `
    import { ConfigError } from './src/commerce/config.ts';
    import { readWorkerConfig, startWorker } from './src/worker.ts';
    import { KERNEL_WORK_MODULES } from './src/work/modules.ts';

    const env = { ...process.env };
    const { variable, value } = JSON.parse(process.env.WORKER_CONFIG_CASE);
    if (value === undefined) delete env[variable];
    else env[variable] = value;
    try {
      const worker = await startWorker(readWorkerConfig(env), KERNEL_WORK_MODULES, env);
      await worker.stop();
      console.log('Worker ready');
    } catch (error) {
      console.error(error instanceof ConfigError ? error.message : 'Worker startup failed');
      process.exitCode = 1;
    }
  `;
  for (const [variable, value, expected] of cases) {
    const env: Record<string, string> = { ...valid };
    env.WORKER_CONFIG_CASE = JSON.stringify({ variable, ...(value === undefined ? {} : { value }) });
    const child = Bun.spawn([process.execPath, '-e', program], {
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 30_000);
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    clearTimeout(timeout);
    const output = `${stdout}${stderr}`;
    expect(exitCode, `${variable}: ${output}`).not.toBe(0);
    expect(output, variable).toContain(expected);
    expect(output).not.toContain('do_not_print_secret');
    expect(output).not.toContain('secret-value');
    expect(output).not.toContain('secret-host.invalid');
  }
}, 300_000);

test('API enqueue before startup survives, duplicate IDs execute once, and SIGTERM drains in-flight work', async () => {
  const client = await createWorkClient(databaseUrl);
  const workflowID = crypto.randomUUID();
  const options = { workflowID, workflowName: 'fixture.work', queueName: 'workflows' };
  let runtime: ReturnType<typeof fixture> | undefined;
  try {
    const handle = await client.enqueue(options, workflowID);
    await client.enqueue(options, workflowID);
    expect((await handle.getStatus())?.status).toBe('ENQUEUED');
    runtime = fixture('worker');
    await runtime.until('worker-ready');
    await runtime.until(`started:${workflowID}`);
    runtime.child.kill('SIGTERM');
    const output = await runtime.finish();
    expect(output.match(/started:/g)).toHaveLength(1);
    expect(output).toContain(`finished:${workflowID}`);
    expect(await handle.getResult()).toBe(workflowID);
    expect((await handle.getStatus())?.status).toBe('SUCCESS');
  } finally {
    runtime?.child.kill();
    await client.close();
    await client.close();
  }
}, 30_000);

test('stop is idempotent and releases module pools, and the direct entrypoint handles SIGINT', async () => {
  const runtime = fixture('stop');
  try {
    expect(await runtime.finish()).toContain('stop-ok');
  } finally {
    runtime.child.kill();
  }
  const direct = Bun.spawn([process.execPath, `${import.meta.dir}/../../src/worker.ts`], {
    env: {
      ...process.env,
      ...workerEnvironment,
      STRIPE_SECRET_KEY: 'sk_test_worker_entrypoint',
      STRIPE_MANAGED_PAYMENTS: 'false',
      CHECKOUT_SUCCESS_URL: 'https://web.example.test/success',
      CHECKOUT_CANCEL_URL: 'https://web.example.test/cancel',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  try {
    const reader = direct.stdout.getReader();
    let output = '';
    while (!output.includes('Worker ready')) {
      const next = await reader.read();
      if (next.done) break;
      output += new TextDecoder().decode(next.value);
    }
    expect(output).toContain('Worker ready');
    direct.kill('SIGINT');
    expect(await direct.exited).toBe(0);
  } finally {
    direct.kill();
  }
}, 30_000);
