import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

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
        'src/components/shadcn-dialog.stories.tsx',
        'src/components/shadcn-sheet.stories.tsx',
        'src/components/shadcn-alert-dialog.stories.tsx',
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
    for (const title of [
      'LongFormWorkflow',
      'LongFormScroll',
      'NestedScrollCompatibility',
      'FullScreenCoverCompatibility',
      'MobileSidebarCompatibility',
      'Default',
      'Sides',
      'Top',
      'Bottom',
      'WithoutCloseIcon',
      'ConfirmWithMedia',
      'LongAndCjkText',
    ])
      expect(
        outcomes.some((outcome) => outcome.title.includes(title) && outcome.status === 'passed'),
        `${title}: ${outcomes.find((outcome) => outcome.title.includes(title))?.failureMessages[0] ?? 'missing story result'}`,
      ).toBe(true);
    expect(outcomes.filter((outcome) => outcome.status !== 'passed')).toEqual([]);
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
}, 300_000);
