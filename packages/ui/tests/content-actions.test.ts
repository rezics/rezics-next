import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const stories = ['src/components/content-actions.stories.tsx', 'src/components/report-dialog.stories.tsx'];

test('the content actions menu opens a report dialog with reasons, required details and a verification slot', async () => {
  for (const file of stories) expect(existsSync(join(root, file)), file).toBe(true);
  const output = mkdtempSync(join(tmpdir(), 'rezics-ui-content-actions-'));
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
      .map((assertion) =>
        `${assertion.title}: ${assertion.status} ${assertion.failureMessages[0]?.split('\n')[0] ?? ''}`.trim(),
      )
      .sort();
    expect(outcomes).toEqual([
      'Details Required: passed',
      'Menu Keyboard: passed',
      'Owner Actions: passed',
      'Report Reasons: passed',
      'Submit States: passed',
      'Verification Slot: passed',
    ]);
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
}, 300_000);
