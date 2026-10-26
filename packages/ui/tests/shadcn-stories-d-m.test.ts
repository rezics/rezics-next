import { afterAll, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const text = (path: string) => readFileSync(path, 'utf8');

// Every cloned shadcn component whose file name starts with d to m.
const names = readdirSync(join(root, 'src', 'shadcn'))
  .filter((file) => file.endsWith('.tsx') && /^[d-m]/.test(file))
  .map((file) => file.slice(0, -'.tsx'.length))
  .sort();

const probe = mkdtempSync(join(tmpdir(), 'rezics-ui-shadcn-stories-d-m-'));
afterAll(() => rmSync(probe, { recursive: true, force: true }));

test('every shadcn component whose name starts with d to m has stories that pass as accessible browser tests', async () => {
  for (const name of ['dialog', 'drawer', 'empty', 'kbd', 'marker', 'menubar', 'message-scroller'])
    expect(names, name).toContain(name);

  for (const name of names) {
    const file = join(root, 'src', 'components', `shadcn-${name}.stories.tsx`);
    expect(existsSync(file), `shadcn-${name}.stories.tsx`).toBe(true);
    const story = text(file);
    expect(story, name).toMatch(/title:\s*'shadcn\//);
    expect(story, name).toContain(`@rezics/ui/shadcn/${name}`);
    expect(story, name).toMatch(/\bplay\b/);
    // Real states beyond the default one: more than one story per component.
    expect(story.match(/^export const \w+: Story\b/gm)?.length ?? 0, `${name} story count`).toBeGreaterThanOrEqual(2);
    // Waits use findBy/waitFor, never fixed sleeps.
    expect(story, name).not.toMatch(/setTimeout|\bsleep\(|waitForTimeout/);
  }
  // Accessibility violations fail a story.
  expect(text(join(root, '.storybook', 'preview.tsx'))).toMatch(/a11y:\s*\{\s*test:\s*'error'\s*\}/);

  const report = join(probe, 'stories.json');
  const run = Bun.spawn(
    [
      'bun',
      'x',
      'vitest',
      'run',
      ...names.map((name) => `shadcn-${name}.stories`),
      '--reporter=json',
      `--outputFile=${report}`,
    ],
    { cwd: root, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, CI: '1' } },
  );
  const [stdout, stderr] = await Promise.all([
    new Response(run.stdout).text(),
    new Response(run.stderr).text(),
    run.exited,
  ]);
  expect(existsSync(report), `${stdout.slice(-2000)}\n${stderr.slice(-4000)}`).toBe(true);
  const result = JSON.parse(readFileSync(report, 'utf8')) as {
    testResults: { name: string; assertionResults: { status: string; title: string; failureMessages: string[] }[] }[];
  };
  const failures = result.testResults.flatMap((file) =>
    file.assertionResults
      .filter((assertion) => assertion.status === 'failed')
      .map((assertion) => `${file.name}: ${assertion.title}: ${assertion.failureMessages[0]?.split('\n')[0] ?? ''}`),
  );
  expect(failures).toEqual([]);
  const byFile = new Map(
    result.testResults.map((file) => [file.name.slice(file.name.lastIndexOf('/') + 1), file.assertionResults]),
  );
  for (const name of names) {
    const assertions = byFile.get(`shadcn-${name}.stories.tsx`) ?? [];
    expect(assertions.filter((assertion) => assertion.status === 'passed').length, `${name} stories`).toBeGreaterThan(
      0,
    );
  }
}, 900_000);
