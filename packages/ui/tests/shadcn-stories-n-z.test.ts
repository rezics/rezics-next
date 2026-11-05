import { afterAll, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const shadcn = join(root, 'src', 'shadcn');
const components = join(root, 'src', 'components');

// `select` already had stories when this group began (the shadcn base wrote them).
const alreadyCovered = new Set(['select']);

const group = readdirSync(shadcn)
  .filter((file) => file.endsWith('.tsx') && file[0]! >= 'n' && file[0]! <= 'z')
  .map((file) => file.slice(0, -'.tsx'.length))
  .filter((name) => !alreadyCovered.has(name))
  .sort();

const probe = mkdtempSync(join(tmpdir(), 'rezics-ui-shadcn-stories-n-z-'));
afterAll(() => rmSync(probe, { recursive: true, force: true }));

test('every shadcn component whose name starts with n to z has stories that pass as accessible browser tests', async () => {
  expect(group.length).toBeGreaterThanOrEqual(20);
  for (const name of ['native-select', 'navigation-menu', 'sheet', 'sidebar', 'table', 'tabs', 'toast', 'tooltip'])
    expect(group, name).toContain(name);

  // The stories live beside the first ones, are titled under shadcn/, import the cloned component and drive it.
  for (const name of group) {
    const file = join(components, `shadcn-${name}.stories.tsx`);
    expect(existsSync(file), `shadcn-${name}.stories.tsx`).toBe(true);
    const story = readFileSync(file, 'utf8');
    expect(story, name).toMatch(/title:\s*'shadcn\//);
    expect(story, name).toContain(`@rezics/ui/shadcn/${name}`);
    expect(story, name).toMatch(/\bplay\b/);
    // Long and CJK text are shown, not only English labels.
    expect(story, `${name} shows CJK text`).toMatch(/[\u3040-\u30ff\u3400-\u9fff]/);
    // Waits use findBy/waitFor, never fixed sleeps.
    expect(story, `${name} sleeps`).not.toMatch(/setTimeout|\bsleep\(|waitForTimeout/);
    // Storybook's own accessibility switch stays on for every story.
    expect(story, `${name} keeps accessibility checks on`).not.toMatch(
      /a11y:\s*\{[^}]*(?:test:\s*'(?:off|todo)'|disable)/,
    );
  }
  expect(readFileSync(join(root, '.storybook', 'preview.tsx'), 'utf8')).toMatch(/a11y:\s*\{\s*test:\s*'error'\s*\}/);

  const report = join(probe, 'stories.json');
  const run = Bun.spawn(
    [
      'bun',
      'x',
      'vitest',
      'run',
      ...group.map((name) => `src/components/shadcn-${name}.stories.tsx`),
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
  for (const name of group) {
    const assertions = byFile.get(`shadcn-${name}.stories.tsx`) ?? [];
    // Default, plus at least the disabled/invalid/open or long-text states the component has.
    expect(assertions.filter((assertion) => assertion.status === 'passed').length, `${name} stories`).toBeGreaterThan(
      1,
    );
  }
}, 900_000);
