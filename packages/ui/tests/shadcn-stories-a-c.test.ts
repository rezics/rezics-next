import { afterAll, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const components = join(root, 'src', 'components');

// Every cloned shadcn component whose file name starts with a to c. The story file for each is
// `shadcn-<name>.stories.tsx`, next to the base's first stories.
const names = readdirSync(join(root, 'src', 'shadcn'))
  .filter((file) => file.endsWith('.tsx') && /^[a-c]/.test(file))
  .map((file) => file.slice(0, -'.tsx'.length))
  .sort();

const probe = mkdtempSync(join(tmpdir(), 'rezics-ui-shadcn-stories-a-c-'));
afterAll(() => rmSync(probe, { recursive: true, force: true }));

test('every shadcn component whose name starts with a to c has stories that pass as accessible browser tests', async () => {
  expect(names.length).toBeGreaterThanOrEqual(20);
  for (const name of ['accordion', 'alert-dialog', 'avatar', 'button', 'calendar', 'chart', 'combobox', 'context-menu'])
    expect(names, name).toContain(name);

  for (const name of names) {
    const file = join(components, `shadcn-${name}.stories.tsx`);
    expect(existsSync(file), `shadcn-${name}.stories.tsx`).toBe(true);
    const story = readFileSync(file, 'utf8');
    expect(story, name).toMatch(/title:\s*'shadcn\//);
    expect(story, name).toContain(`@rezics/ui/shadcn/${name}'`);
    expect(story, name).toMatch(/\bplay\b/);
    // Waits use findBy/waitFor, never fixed sleeps.
    expect(story, name).not.toMatch(/setTimeout|new Promise|\bsleep\(/);
    // The component's real states: more than one story, so it is not only the default.
    expect(story.match(/^export const \w+: Story/gm)?.length ?? 0, `${name} story count`).toBeGreaterThanOrEqual(2);
  }

  // Accessibility violations fail a story.
  expect(readFileSync(join(root, '.storybook', 'preview.tsx'), 'utf8')).toMatch(/a11y:\s*\{\s*test:\s*'error'\s*\}/);

  const report = join(probe, 'stories.json');
  const run = Bun.spawn(
    [
      'bun',
      'x',
      'vitest',
      'run',
      ...names.map((name) => `src/components/shadcn-${name}.stories.tsx`),
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
      .filter((assertion) => assertion.status !== 'passed')
      .map((assertion) => `${file.name}: ${assertion.title}: ${assertion.failureMessages[0]?.split('\n')[0] ?? ''}`),
  );
  expect(failures).toEqual([]);
  const byFile = new Map(
    result.testResults.map((file) => [file.name.slice(file.name.lastIndexOf('/') + 1), file.assertionResults]),
  );
  for (const name of names) {
    const assertions = byFile.get(`shadcn-${name}.stories.tsx`) ?? [];
    expect(assertions.filter((assertion) => assertion.status === 'passed').length, `${name} stories`).toBeGreaterThan(
      1,
    );
  }
}, 1_800_000);
