import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

test('Specialized creators recover from an accidentally added language without losing the entered subject', async () => {
  const app = resolve(import.meta.dir, '..');
  const temporary = resolve(app, '../../.temp');
  mkdirSync(temporary, { recursive: true });
  const output = mkdtempSync(resolve(temporary, 'catalogue-language-row-recovery-'));
  const report = resolve(output, 'stories.json');
  try {
    // Existing Storybook browser support supplies the DOM; select only these three bounded plays.
    const run = Bun.spawn(
      [
        'bun',
        'x',
        'vitest',
        'run',
        '--project=storybook-desktop',
        '--testNamePattern=Language Row Recovery',
        '--reporter=json',
        `--outputFile=${report}`,
        'src/stories/catalogue-album-profile.stories.tsx',
        'src/stories/catalogue-character-profile.stories.tsx',
        'src/stories/recipe-editor.stories.tsx',
      ],
      { cwd: app, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, CI: '1' } },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(run.stdout).text(),
      new Response(run.stderr).text(),
      run.exited,
    ]);
    expect(code, stdout.slice(-4000) + stderr.slice(-4000)).toBe(0);
    const result = JSON.parse(readFileSync(report, 'utf8')) as {
      testResults: { name: string; assertionResults: { title: string; status: string; failureMessages: string[] }[] }[];
    };
    const completed = result.testResults.flatMap((file) =>
      file.assertionResults
        .filter((assertion) => assertion.status !== 'pending' && assertion.status !== 'skipped')
        .map((assertion) => ({ ...assertion, file: file.name })),
    );
    expect(completed).toHaveLength(3);
    for (const file of ['catalogue-album-profile', 'catalogue-character-profile', 'recipe-editor']) {
      const assertion = completed.find((entry) => entry.file.endsWith(`/${file}.stories.tsx`));
      expect(assertion).toBeDefined();
      expect(assertion!.title).toBe('Language Row Recovery');
      expect(assertion!.status, assertion!.failureMessages.join('\n')).toBe('passed');
    }
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
}, 300_000);
