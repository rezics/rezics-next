import { afterAll, beforeAll, expect, test } from 'bun:test';
import { DBOS } from '@dbos-inc/dbos-sdk';
import { CommandUnavailableError } from '../../src/command/command.ts';
import { contentStepRetryOptions } from '../../src/content/work.ts';

const retry = contentStepRetryOptions(0.05);
const attempts = new Map<string, number[]>();

const workflow = DBOS.registerWorkflow(
  async (name: string, failCount: number, errorMessage: string) =>
    DBOS.runStep(
      async () => {
        const times = attempts.get(name) ?? [];
        times.push(performance.now());
        attempts.set(name, times);
        if (times.length <= failCount) {
          if (errorMessage === 'overloaded') throw new CommandUnavailableError('overloaded', 0);
          throw new Error(`${errorMessage} ${times.length}`);
        }
        return times.length;
      },
      { ...retry, name: `content.retry.${name}` },
    ),
  { name: 'content.retry.workflow' },
);

beforeAll(async () => {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
  DBOS.setConfig({
    name: 'content-retry-test',
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

test('a content step refused as overloaded is retried at growing intervals and completes once the partition has capacity', async () => {
  const name = crypto.randomUUID();
  const handle = await DBOS.startWorkflow(workflow)(name, 3, 'overloaded');
  expect(await handle.getResult()).toBe(4);
  const times = attempts.get(name)!;
  expect(times).toHaveLength(4);
  const gaps = times.slice(1).map((time, index) => time - times[index]!);
  expect(gaps[1]!).toBeGreaterThan(gaps[0]! * 1.5);
  expect(gaps[2]!).toBeGreaterThan(gaps[1]! * 1.5);
});

test('a content step that keeps failing stops after its bounded attempts and reports the last error', async () => {
  const name = crypto.randomUUID();
  const handle = await DBOS.startWorkflow(workflow)(name, 100, 'dependency unavailable');
  await expect(handle.getResult()).rejects.toThrow('dependency unavailable 11');
  expect(attempts.get(name)).toHaveLength(11);
});
