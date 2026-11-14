import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const stories = 'src/components/rich-text-editor.stories.tsx';

test('the rich-text editor writes valid snapshots in each profile, with Markdown shortcuts, safe paste and accessible names', async () => {
  expect(existsSync(join(root, stories)), stories).toBe(true);
  const output = mkdtempSync(join(tmpdir(), 'rezics-ui-rich-text-editor-'));
  const report = join(output, 'stories.json');
  try {
    const run = Bun.spawn(['bun', 'x', 'vitest', 'run', '--reporter=json', `--outputFile=${report}`, stories], {
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
        `${assertion.title}: ${assertion.status} ${assertion.failureMessages[0]?.split('\n').slice(0, 5).join(' ') ?? ''}`.trim(),
      )
      .sort();
    expect(outcomes, `${stdout.slice(-2000)}\n${stderr.slice(-4000)}`).toEqual([
      'Blocks Profile: passed',
      'Labelled Field: passed',
      'Markdown Shortcuts: passed',
      'Paste Sanitized: passed',
      'Read Only: passed',
      'Reordered Blocks: passed',
      'Text Profile Limits: passed',
      'Text Profile: passed',
    ]);
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
}, 300_000);
