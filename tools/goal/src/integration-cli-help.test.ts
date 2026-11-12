import { expect, test } from 'bun:test';
import { runIntegration, type IntegrationRuntime } from './integration-cli.ts';

test('verify and promote help and invalid arguments never call runtime hooks', async () => {
  const calls: string[] = [];
  const printed: string[] = [];
  const originalLog = console.log;
  console.log = (...values: unknown[]) => {
    printed.push(values.join(' '));
  };
  const runtime = {
    queue: {},
    managerServices: {},
    promote: async () => calls.push('promote'),
    verify: async () => calls.push('verify'),
  } as unknown as IntegrationRuntime;
  try {
    for (const command of ['verify', 'promote'] as const) {
      const usage = `usage: ${command}`;
      for (const flag of ['--help', '-h']) {
        expect(await runIntegration([command, flag], runtime)).toBe(0);
        expect(printed.pop()).toBe(usage);
        expect(calls).toEqual([]);
      }
      for (const args of [
        [command, 'unexpected'],
        [command, '--help', 'unexpected'],
      ]) {
        await expect(runIntegration(args, runtime)).rejects.toThrow(usage);
        expect(calls).toEqual([]);
      }
      expect(await runIntegration([command], runtime)).toBe(0);
      expect(calls).toEqual([command]);
      calls.length = 0;
    }
  } finally {
    console.log = originalLog;
  }
});
