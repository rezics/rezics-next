import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const story = 'src/components/menu.stories.tsx';

test('custom ShelfToolbar forms stay bounded and live through their Menu lifetime', async () => {
  expect(existsSync(join(root, story)), story).toBe(true);
  const temp = join(root, '../../.temp');
  mkdirSync(temp, { recursive: true });
  const output = mkdtempSync(join(temp, 'menu-content-lifetime-'));
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
        'Shelf Toolbar Custom Forms Desktop',
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
      );
    expect(outcomes).toEqual(['Shelf Toolbar Custom Forms Desktop: passed']);
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
}, 300_000);
