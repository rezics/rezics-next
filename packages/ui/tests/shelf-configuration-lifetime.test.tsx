import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

test('one connected shelf journey keeps navigation, display controls, and picker gestures current for their lifetime', async () => {
  const root = join(import.meta.dir, '..');
  const story = 'src/components/shelf-table.stories.tsx';
  const temporary = join(root, '../../.temp');
  mkdirSync(temporary, { recursive: true });
  const output = mkdtempSync(join(temporary, 'shelf-configuration-lifetime-'));
  const report = join(output, 'stories.json');
  try {
    expect(existsSync(join(root, story)), story).toBe(true);
    const run = Bun.spawn(
      [
        'bun',
        'x',
        'vitest',
        'run',
        story,
        '-t',
        'Connected Shelf Configuration Journey',
        '--reporter=json',
        `--outputFile=${report}`,
      ],
      { cwd: root, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, CI: '1' } },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(run.stdout).text(),
      new Response(run.stderr).text(),
      run.exited,
    ]);
    expect(existsSync(report), `${stdout}\n${stderr}`).toBe(true);
    const result = JSON.parse(readFileSync(report, 'utf8')) as {
      testResults: { assertionResults: { status: string; title: string; failureMessages: string[] }[] }[];
    };
    const outcomes = result.testResults.flatMap((file) => file.assertionResults);
    expect(code, `${stdout}\n${stderr}`).toBe(0);
    expect(outcomes.map((outcome) => `${outcome.title}: ${outcome.status}`)).toEqual([
      'Connected Shelf Configuration Journey: passed',
    ]);
    expect(outcomes.flatMap((outcome) => outcome.failureMessages)).toEqual([]);
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
}, 300_000);
