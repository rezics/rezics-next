import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const stories = 'src/components/document-body.stories.tsx';

test('document bodies render every profile node and mark, safe links, spoilers and media images as accessible stories', async () => {
  expect(existsSync(join(root, stories)), stories).toBe(true);
  const output = mkdtempSync(join(tmpdir(), 'rezics-ui-document-body-'));
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
        `${assertion.title}: ${assertion.status} ${assertion.failureMessages[0]?.split('\n')[0] ?? ''}`.trim(),
      )
      .sort();
    expect(outcomes).toEqual([
      'Blocks Profile: passed',
      'Inline Spoiler: passed',
      'Localized Label: passed',
      'Media Images: passed',
      'Safe Links: passed',
      'Spoilers: passed',
      'Text Profile: passed',
      'Two Spoilers: passed',
    ]);
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
}, 300_000);
