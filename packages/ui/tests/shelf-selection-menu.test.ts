import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const stories = ['src/components/selection-bar.stories.tsx', 'src/components/item-menu.stories.tsx'];

test('selection and item menu interactions work in the browser', async () => {
  for (const file of stories) expect(existsSync(join(root, file)), file).toBe(true);
  const temp = join(root, '../../.temp');
  mkdirSync(temp, { recursive: true });
  const output = mkdtempSync(join(temp, 'shelf-selection-menu-'));
  const report = join(output, 'stories.json');
  try {
    const run = Bun.spawn(['bun', 'x', 'vitest', 'run', '--reporter=json', `--outputFile=${report}`, ...stories], {
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, CI: '1' },
    });
    const [stdout, stderr] = await Promise.all([
      new Response(run.stdout).text(),
      new Response(run.stderr).text(),
      run.exited,
    ]);
    expect(existsSync(report), `${stdout.slice(-2000)}\n${stderr.slice(-4000)}`).toBe(true);
    const result = JSON.parse(readFileSync(report, 'utf8')) as {
      testResults: { assertionResults: { status: string; title: string; failureMessages: string[] }[] }[];
    };
    const outcomes = result.testResults
      .flatMap((file) => file.assertionResults)
      .map((a) => `${a.title}: ${a.status} ${a.failureMessages[0]?.split('\n')[0] ?? ''}`.trim())
      .sort();
    expect(outcomes).toEqual(['Item Menu: passed', 'Selection: passed']);
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
}, 300_000);
