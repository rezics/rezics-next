import { expect, mock, test } from 'bun:test';
import { join, resolve } from 'node:path';
import type { StackRun } from '../../../scripts/stack-run.ts';

const runs: StackRun[] = [];
mock.module('../../../scripts/stack-run.ts', () => ({
  stackRun: async (run: StackRun) => {
    runs.push(run);
    return 0;
  },
}));
const { runScreenshots } = await import('../scripts/screenshots.ts');

test('a remote screenshot run writes to the workspace-relative path it returns', async () => {
  const root = resolve(import.meta.dir, '../../..');
  const out = '.temp/subject-review';
  expect(await runScreenshots(['--story', 'pages-subjects-subject--*', '--out', join(root, out)])).toBe(0);
  expect(runs).toHaveLength(1);
  expect(runs[0]!.returns).toEqual([out]);
  // The capture parser resolves a relative --out from the workspace root, including on a check host.
  expect(runs[0]!.command).toEqual([
    'bun',
    'scripts/screenshots.ts',
    '--story',
    'pages-subjects-subject--*',
    '--out',
    out,
  ]);
});
