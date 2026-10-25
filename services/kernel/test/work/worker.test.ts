import { expect, test } from 'bun:test';
import { readWorkerConfig } from '../../src/worker.ts';
import { createWorkClient } from '../../src/work/client.ts';
import { KERNEL_WORK_MODULES } from '../../src/work/modules.ts';
import { fixture } from './support/process.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');

test('worker configuration names invalid variables without revealing values', () => {
  expect(KERNEL_WORK_MODULES).toEqual([]);
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
    env: process.env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  try {
    const reader = direct.stdout.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain('Worker ready');
    direct.kill('SIGINT');
    expect(await direct.exited).toBe(0);
  } finally {
    direct.kill();
  }
}, 30_000);
