import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const stories = ['editor-product', 'editor-preferences', 'editor-domain', 'editor-structural'].map(
  (name) => `src/components/${name}.stories.tsx`,
);

test('authoring presets, settings, form-host safety, domain text and structural editing complete their accessible browser journeys', async () => {
  const temporaryRoot = join(root, '../../.temp');
  mkdirSync(temporaryRoot, { recursive: true });
  const directory = mkdtempSync(join(temporaryRoot, 'editor-product-'));
  const report = join(directory, 'stories.json');
  try {
    const child = Bun.spawn(['bun', 'x', 'vitest', 'run', ...stories, '--reporter=json', `--outputFile=${report}`], {
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, CI: '1' },
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    const details = `${stdout.slice(-3000)}\n${stderr.slice(-5000)}`;
    expect(code, details).toBe(0);
    expect(existsSync(report), details).toBe(true);
    const result = JSON.parse(readFileSync(report, 'utf8')) as {
      testResults: { name: string; assertionResults: { status: string; title: string; failureMessages: string[] }[] }[];
    };
    for (const story of stories) {
      const file = result.testResults.find((entry) => entry.name.endsWith(story));
      expect(file, story).toBeDefined();
      expect(file!.assertionResults.length, story).toBeGreaterThan(0);
      for (const outcome of file!.assertionResults)
        expect(outcome.status, `${outcome.title}: ${outcome.failureMessages.join('\n')}`).toBe('passed');
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 300_000);
