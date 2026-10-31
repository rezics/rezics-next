import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const stories = ['src/components/entity-picker.stories.tsx'];

const typing = [
  'Search As You Type: passed',
  'Select Several: passed',
  'Select With Keyboard: passed',
  'Stale Search Is Cancelled: passed',
];
const states = [
  'Empty: passed',
  'Never Shows An Id: passed',
  'Nothing Matches: passed',
  'Search Failed: passed',
  'Slow Search: passed',
];
const layouts = ['Long Titles And Missing Data: passed', 'Phone Width: passed', 'Selected: passed'];

/** Runs the stories once for both tests. */
const outcomes = (() => {
  let run: Promise<string[]> | undefined;
  return () => (run ??= runStories());
})();

async function runStories(): Promise<string[]> {
  for (const file of stories) expect(existsSync(join(root, file)), file).toBe(true);
  const output = mkdtempSync(join(tmpdir(), 'rezics-ui-entity-picker-'));
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
    return result.testResults
      .flatMap((file) => file.assertionResults)
      .map((assertion) =>
        `${assertion.title}: ${assertion.status} ${assertion.failureMessages[0]?.split('\n')[0] ?? ''}`.trim(),
      )
      .sort();
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
}

test('the entity picker searches as the person types, shows each subject with its cover, type and year, and selects with the keyboard', async () => {
  expect(await outcomes()).toEqual([...states, ...layouts, ...typing].sort());
}, 300_000);

test('the entity picker says when nothing matches and when the search failed, and never shows an id', async () => {
  expect((await outcomes()).filter((outcome) => states.includes(outcome))).toEqual(states);
}, 300_000);
