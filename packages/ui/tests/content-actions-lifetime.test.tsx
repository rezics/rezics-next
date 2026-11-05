import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const story = 'src/components/content-actions.stories.tsx';

test('mounted ContentActions report and delete operations keep their original lifetime', async () => {
  expect(existsSync(join(root, story)), story).toBe(true);
  const temp = join(root, '../../.temp');
  mkdirSync(temp, { recursive: true });
  const output = mkdtempSync(join(temp, 'content-actions-lifetime-'));
  const report = join(output, 'stories.json');
  try {
    const run = Bun.spawn(
      [
        'bun',
        'x',
        'vitest',
        'run',
        story,
        '-t',
        'Menu Keyboard|Menu Open Phone|Owner Actions',
        '--reporter=json',
        `--outputFile=${report}`,
      ],
      {
        cwd: root,
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, CI: '1' },
      },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(run.stdout).text(),
      new Response(run.stderr).text(),
      run.exited,
    ]);
    expect(existsSync(report), `${stdout.slice(-2000)}\n${stderr.slice(-4000)}`).toBe(true);
    expect(exitCode, `${stdout.slice(-2000)}\n${stderr.slice(-4000)}`).toBe(0);
    const result = JSON.parse(readFileSync(report, 'utf8')) as {
      testResults: { assertionResults: { status: string; title: string; failureMessages: string[] }[] }[];
    };
    const outcomes = result.testResults
      .flatMap((file) => file.assertionResults)
      .map((assertion) =>
        `${assertion.title}: ${assertion.status} ${assertion.failureMessages[0]?.split('\n')[0] ?? ''}`.trim(),
      )
      .sort();
    expect(outcomes).toEqual(['Menu Keyboard: passed', 'Menu Open Phone: passed', 'Owner Actions: passed']);
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
}, 300_000);
