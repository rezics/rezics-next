import { afterAll, beforeAll, expect, test } from 'bun:test';
import { DBOS } from '@dbos-inc/dbos-sdk';
import { AccessUnavailableError } from '../../src/request/unavailable.ts';
import { CommandUnavailableError, IdempotencyConflictError } from '../../src/command/command.ts';
import { COMMAND_STEP_RETRIES } from '../../src/work/retries.ts';

const failures = new Map<string, Error>();
for (const reason of ['deadline', 'contention', 'overloaded'] as const) {
  failures.set(`Access ${reason}`, new AccessUnavailableError(reason));
}
for (const reason of ['deadline', 'contention', 'overloaded', 'fenced'] as const) {
  failures.set(`Command ${reason}`, new CommandUnavailableError(reason, 0));
}
for (const code of ['57014', '40001', '40P01', '55P03', '53300', '08006', '53100', '57P01', '57P02', '57P03']) {
  failures.set(code, Object.assign(new Error(`database failure ${code}`), { code }));
}
for (const message of [
  'timeout exceeded when trying to connect',
  'Connection acquisition timeout',
  'Query read timeout',
]) {
  failures.set(message, new Error(message));
}
const attempts = new Map<string, number>();
const workflow = DBOS.registerWorkflow(
  async (name: string) =>
    DBOS.runStep(
      async () => {
        const count = (attempts.get(name) ?? 0) + 1;
        attempts.set(name, count);
        if (count === 1) throw failures.get(name);
        return count;
      },
      { ...COMMAND_STEP_RETRIES, name: 'unavailability.step', intervalSeconds: 0.001, maxAttempts: 2 },
    ),
  { name: 'unavailability.workflow' },
);

beforeAll(async () => {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
  DBOS.setConfig({
    name: 'unavailability-test',
    systemDatabaseUrl: databaseUrl,
    systemDatabaseSchemaName: 'dbos',
    runMigrations: false,
    logLevel: 'error',
  });
  await DBOS.launch();
});
afterAll(async () => {
  await DBOS.shutdown();
});

for (const name of failures.keys()) {
  test(`a durable step retries ${name}`, async () => {
    const handle = await DBOS.startWorkflow(workflow)(name);
    expect(await handle.getResult()).toBe(2);
    expect(attempts.get(name)).toBe(2);
  });
}

for (const [name, error] of [
  ['moved partition', new CommandUnavailableError('moved', 0, 'node-b')],
  ['idempotency conflict', new IdempotencyConflictError(0)],
  ['ordinary error', new Error('application failure')],
  ['unclassified SQLSTATE', Object.assign(new Error('missing relation'), { code: '42P01' })],
] as const) {
  failures.set(name, error);
  test(`a durable step does not retry ${name}`, async () => {
    const handle = await DBOS.startWorkflow(workflow)(name);
    await expect(handle.getResult()).rejects.toThrow(error.message);
    expect(attempts.get(name)).toBe(1);
  });
}
