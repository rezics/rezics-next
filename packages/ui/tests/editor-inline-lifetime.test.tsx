import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const stories = ['src/components/editor-link.stories.tsx', 'src/components/editor-touch-bar.stories.tsx'];

test('mounted rich-text authoring, keyboard and native input history stay owned by their editable document visit', async () => {
  for (const story of stories) expect(existsSync(join(root, story)), story).toBe(true);
  const temp = join(root, '../../.temp');
  mkdirSync(temp, { recursive: true });
  const output = mkdtempSync(join(temp, 'editor-inline-lifetime-'));
  const report = join(output, 'stories.json');
  try {
    const run = Bun.spawn(
      [
        'bun',
        'x',
        'vitest',
        'run',
        ...stories,
        '-t',
        'Inline Lifetime Journey|Undo Redo',
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
    const [stdout, stderr, code] = await Promise.all([
      new Response(run.stdout).text(),
      new Response(run.stderr).text(),
      run.exited,
    ]);
    expect(code, `${stdout.slice(-2000)}\n${stderr.slice(-4000)}`).toBe(0);
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
    expect(outcomes).toEqual(['Inline Lifetime Journey: passed', 'Undo Redo: passed']);
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
}, 300_000);
