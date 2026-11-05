import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

test('one mounted RatingInput journey keeps queued saves and recovery within their visit', async () => {
  const root = join(import.meta.dir, '..');
  const story = 'src/components/rating.stories.tsx';
  const temporary = join(root, '../../.temp');
  mkdirSync(temporary, { recursive: true });
  const output = mkdtempSync(join(temporary, 'rating-input-lifetime-'));
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
        'Connected Save Lifetime',
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
      'Connected Save Lifetime: passed',
    ]);
    expect(outcomes.flatMap((outcome) => outcome.failureMessages)).toEqual([]);
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
}, 300_000);
