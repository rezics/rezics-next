import { expect, test } from 'bun:test';
import { kernelGroups, runKernelGroups } from './kernel-check-groups.ts';
import { runKernelCheckStages, planCheck } from '../services/kernel/scripts/check.ts';
import type { RemoteCheckSettlement } from './remote-check.ts';

function settlement(run: string): RemoteCheckSettlement {
  const identity = { schema: 1, host: 'a', run } as const;
  return {
    ...identity,
    native: { ...identity, exitCode: 0, resources: null, lifetimeFailure: null },
    preparedInputs: { schema: 1, sourceSha256: 'source', manifestSha256: 'manifest', fileCount: 33, totalBytes: 100 },
    cleanup: {
      ...identity,
      status: 'verified',
      supervisorStopped: true,
      commandGroupTerminal: true,
      containersRemoved: true,
      runDirectoryRemoved: true,
      failures: [],
    },
    transportChildReaped: true,
    returns: { schema: 1, status: 'empty', entries: [], failures: [] },
  };
}

test('one full-quality group plus the exact remainder, including root and nested tests', async () => {
  const files = Array.from({ length: 33 }, (_, i) => `test/${i % 2 ? 'nested/' : ''}${i}.test.ts`).sort();
  const entries = files.map((file) => ({
    path: 'services/kernel/' + file,
    mode: 420,
    kind: 'file' as const,
    sha256: 'digest',
    target: null,
  }));
  const manifest = { sourceSha256: 'source', head: 'head', indexTree: 'tree', deleted: [], entries };
  const groups = kernelGroups(files, manifest);
  expect(groups.map((group) => group.length)).toEqual([32, 1]);
  expect(() => kernelGroups(files.slice(1), manifest)).toThrow('inventory');
  const commands: string[][] = [];
  await runKernelGroups(groups, 'source', 'a', async (command, i) => {
    commands.push(command);
    return { code: 0, settlement: settlement(String(i)) };
  });
  expect(commands.map((command) => command.slice(0, 5))).toEqual(
    ['--full-quality', '--tests-only'].map((flag) => [
      'env',
      'KERNEL_CHECK_CONCURRENCY=1',
      'bun',
      'scripts/check.ts',
      flag,
    ]),
  );
  expect(commands.flatMap((command) => command.slice(5))).toEqual(files);
});

test('a partial, mixed-source, repeated or unsettled physical run cannot complete the full set', async () => {
  for (const change of [
    () => undefined,
    (value: RemoteCheckSettlement) => ({ ...value, preparedInputs: null }),
    (value: RemoteCheckSettlement) => ({
      ...value,
      preparedInputs: { ...value.preparedInputs!, sourceSha256: 'other' },
    }),
    (value: RemoteCheckSettlement) => ({ ...value, transportChildReaped: false }),
    (value: RemoteCheckSettlement) => ({ ...value, native: { ...value.native!, exitCode: 137 } }),
    () => settlement('0'),
  ]) {
    await expect(
      runKernelGroups([['first'], ['last']], 'source', 'a', async (_, i) => {
        const receipt = i === 0 ? settlement('0') : change(settlement('1'));
        return { code: 0, ...(receipt ? { settlement: receipt } : {}) };
      }),
    ).rejects.toThrow('group 2/2');
  }
});

test('full-quality group runs global tools and retains diagnostics outside the selected file', async () => {
  const file = 'test/check-file-mode.test.ts';
  const { plan } = planCheck(['--full-quality', file], 'services/kernel');
  const calls: string[][] = [];
  await expect(
    runKernelCheckStages({
      plan,
      ownedFiles: [file],
      environment: {},
      reyloConfig: 'fixture',
      programs: { tsc: 'tsc', lintProgram: 'lint', formatProgram: 'fmt' },
      captureCommand(program, args) {
        calls.push([program, ...args]);
        return program === 'tsc'
          ? { status: 2, output: 'src/other.ts(1,1): error TS2322: unrelated file' }
          : { status: 0, output: '' };
      },
      runTests: async (files) => {
        calls.push(files);
        return [];
      },
    }),
  ).rejects.toThrow('src/other.ts(1,1)');
  expect(calls[1]?.at(-1)).toBe('.');
  expect(calls[2]).toEqual(['fmt', '--check', '.']);
  expect(calls[3]).toEqual([file]);
});
