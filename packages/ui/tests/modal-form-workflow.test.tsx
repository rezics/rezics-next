import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';

const storiesByFile = {
  'shadcn-dialog.stories.tsx': [
    'Long Form Workflow',
    'Nested Scroll Compatibility',
    'Full Screen Cover Compatibility',
    'Without Close Icon',
  ],
  'shadcn-sheet.stories.tsx': ['Default', 'Sides', 'Top', 'Bottom', 'Long Form Scroll', 'Sidebar Compatibility'],
  'shadcn-alert-dialog.stories.tsx': ['Default', 'Confirm With Media', 'Long And Cjk Text'],
};

test('mounted Base UI modal workflows keep long forms, confirmations and every sheet side reachable', async () => {
  const root = join(import.meta.dir, '..');
  const temporary = join(root, '../../.temp');
  mkdirSync(temporary, { recursive: true });
  const output = mkdtempSync(join(temporary, 'modal-form-workflow-'));
  const report = join(output, 'stories.json');
  try {
    const run = Bun.spawn(
      [
        'bun',
        'x',
        'vitest',
        'run',
        ...Object.keys(storiesByFile).map((file) => `src/components/${file}`),
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
      testResults: {
        name: string;
        assertionResults: { status: string; title: string; failureMessages: string[] }[];
      }[];
    };
    const failures = result.testResults.flatMap(({ name, assertionResults }) =>
      assertionResults
        .filter(({ status }) => status !== 'passed')
        .map(
          ({ title, status, failureMessages }) =>
            `${basename(name)} / ${title}: ${failureMessages[0]?.split('\n')[0] ?? status}`,
        ),
    );
    expect(failures).toEqual([]);
    expect(code, `${stdout}\n${stderr}`).toBe(0);
    const outcomesByFile = new Map(result.testResults.map((file) => [basename(file.name), file.assertionResults]));
    for (const [file, titles] of Object.entries(storiesByFile)) {
      const outcomes = outcomesByFile.get(file) ?? [];
      for (const title of titles) {
        expect(outcomes.find((outcome) => outcome.title === title)?.status, `${file} / ${title}`).toBe('passed');
      }
    }
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
}, 300_000);
