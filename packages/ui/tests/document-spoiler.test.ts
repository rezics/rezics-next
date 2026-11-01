import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const stories = 'src/components/document-body.stories.tsx';

async function storyOutcomes(titlePattern: string): Promise<string[]> {
  expect(existsSync(join(root, stories)), stories).toBe(true);
  const output = mkdtempSync(join(tmpdir(), 'rezics-ui-document-spoiler-'));
  const report = join(output, 'stories.json');
  try {
    const run = Bun.spawn(
      ['bun', 'x', 'vitest', 'run', '--reporter=json', `--outputFile=${report}`, '-t', titlePattern, stories],
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
    return result.testResults
      .flatMap((file) => file.assertionResults)
      .filter((assertion) => assertion.status !== 'skipped')
      .map((assertion) =>
        `${assertion.title}: ${assertion.status} ${assertion.failureMessages[0]?.split('\n')[0] ?? ''}`.trim(),
      )
      .sort();
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
}

test('a concealed spoiler keeps its place in the line, hides its text from sight, selection and assistive technology, and reveals on click, Enter or Space', async () => {
  expect(await storyOutcomes('Inline Spoiler|Two Spoilers')).toEqual([
    'Inline Spoiler: passed',
    'Two Spoilers: passed',
  ]);
}, 300_000);

test("the reveal control's name comes from the page's locale", async () => {
  expect(await storyOutcomes('Localized Label')).toEqual(['Localized Label: passed']);
}, 300_000);

test('document replacement starts a fresh disclosure visit and retires its earlier interactions', async () => {
  expect(await storyOutcomes('Disclosure Replacement')).toEqual(['Disclosure Replacement: passed']);
}, 300_000);
