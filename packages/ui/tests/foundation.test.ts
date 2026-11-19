import { afterAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { loadCsf } from 'storybook/internal/csf-tools';
import { inspectThemeColors } from './theme-contrast.ts';

const root = join(import.meta.dir, '..');
const components = join(root, 'src', 'components');

const stories = {
  locale: 'forms-locale--english',
  'localized-text': 'data-display-localized-text--japanese-title-in-korean-interface',
  show: 'layout-show--empty',
};

test('the package is a workspace with exact versions whose check runs this suite', async () => {
  const manifest = (await Bun.file(join(root, 'package.json')).json()) as {
    name: string;
    scripts?: Record<string, string>;
    exports?: Record<string, string>;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  };
  expect(manifest.name).toBe('@rezics/ui');
  expect(manifest.scripts?.check).toContain('bun test');
  expect(manifest.exports?.['./styles.css']).toBeDefined();
  for (const version of Object.values({
    ...manifest.dependencies,
    ...manifest.devDependencies,
    ...manifest.peerDependencies,
  }))
    expect(version).toMatch(/^(?:\d+\.\d+\.\d+(?:-[\w.]+)?|workspace:\*)$/);
});

test('text tokens meet WCAG AA in both themes and the logo red stays a visible mark', async () => {
  const text: [string, string][] = [
    ['foreground', 'background'],
    ['card-foreground', 'card'],
    ['popover-foreground', 'popover'],
    ['secondary-foreground', 'secondary'],
    ['muted-foreground', 'background'],
    ['muted-foreground', 'card'],
    ['muted-foreground', 'muted'],
    ['primary', 'background'],
    ['primary', 'card'],
    ['primary-foreground', 'primary'],
    ['accent-foreground', 'accent'],
    ['sidebar-foreground', 'sidebar'],
    ['sidebar-primary-foreground', 'sidebar-primary'],
    ['sidebar-accent-foreground', 'sidebar-accent'],
    ['destructive', 'background'],
    ['info-foreground', 'background'],
    ['success-foreground', 'success'],
    ['warning-foreground', 'warning'],
  ];
  const samples = [...text, ['brand', 'background'] as const, ['brand', 'card'] as const].map(([ink, surface]) => ({
    label: `${ink} on ${surface}`,
    ink,
    surface,
  }));
  for (const { theme, contrast } of await inspectThemeColors(samples)) {
    for (const [index, { ratio, foreground, background }] of contrast.entries()) {
      const sample = samples[index]!;
      expect(ratio, `${theme} ${sample.label} (${foreground} on ${background})`).toBeGreaterThanOrEqual(
        sample.ink === 'brand' ? 3 : 4.5,
      );
    }
  }
}, 30_000);

test('the logo retains its identity colors and custom status aliases resolve to Neutral tokens', async () => {
  const aliases = {
    'destructive-solid': 'destructive',
    'info-foreground': 'foreground',
    success: 'foreground',
    'success-foreground': 'background',
    warning: 'foreground',
    'warning-foreground': 'background',
  };
  for (const { theme, tokens } of await inspectThemeColors(
    [],
    ['brand', ...Object.keys(aliases), ...Object.values(aliases)],
  )) {
    expect(tokens.brand, `${theme} logo red`).toBe(theme === 'light' ? '#df3d35' : '#f0524c');
    for (const [name, target] of Object.entries(aliases)) {
      expect(tokens[name], `${theme} --${name}`).toBe(tokens[target]);
    }
  }
}, 30_000);

test('the logo red never colors text', async () => {
  const offending = [
    /(?<![\w-])text-brand\b/,
    /text-\[(?:color:)?var\(--(?:color-)?brand\)\]/,
    /text-\(--(?:color-)?brand\)/,
    /(?<![\w-])color:\s*var\(--(?:color-)?brand\)/,
  ];
  const found: string[] = [];
  for (const file of new Bun.Glob('src/**/*.{ts,tsx,css}').scanSync({ cwd: root })) {
    const source = await Bun.file(join(root, file)).text();
    for (const pattern of offending) if (pattern.test(source)) found.push(`${file}: ${pattern}`);
  }
  expect(found).toEqual([]);
});

const probe = join(components, 'accessibility-probe.stories.tsx');
const fixture = join(root, 'tests', 'fixtures', 'accessibility-probe.stories.tsx');
const temporary = join(root, '.temp');
let output: string | undefined;
afterAll(() => {
  if (output) rmSync(output, { recursive: true, force: true });
});

test('the accessibility probe is an opt-in test fixture', async () => {
  expect(existsSync(fixture)).toBe(true);
  expect(existsSync(probe)).toBe(false);
  const config = await Bun.file(join(root, '.storybook', 'main.ts')).text();
  expect(config).toContain('REZICS_UI_ACCESSIBILITY_PROBE');
  expect(config).toContain('../tests/fixtures/accessibility-probe.stories.tsx');
});

test('every ported component has stories that pass as accessible browser tests', async () => {
  const expected = Object.entries(stories).map(([name, id]) => {
    const file = join(components, `${name}.stories.tsx`);
    expect(existsSync(join(components, `${name}.tsx`)), `${name}.tsx`).toBe(true);
    const csf = loadCsf(readFileSync(file, 'utf8'), { fileName: file, makeTitle: (title) => title }).parse();
    const story = Object.values(csf._stories).find((story) => story.id === id);
    expect(story, id).toBeDefined();
    return { file, name: story!.name };
  });

  // A control without an accessible name must fail its story: accessibility violations are errors.
  mkdirSync(temporary, { recursive: true });
  output = mkdtempSync(join(temporary, 'foundation-stories-'));
  const report = join(output, 'stories.json');
  const status = () =>
    execFileSync('git', ['status', '--porcelain'], { cwd: join(root, '..', '..'), encoding: 'utf8' });
  const statusBefore = status();
  const run = Bun.spawn(
    [
      'bun',
      'x',
      'vitest',
      'run',
      ...expected.map(({ file }) => file),
      fixture,
      '--testNamePattern',
      `(?:${expected.map(({ name }) => name).join('|')}|Unnamed Control)$`,
      '--reporter=json',
      `--outputFile=${report}`,
    ],
    {
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, CI: '1', REZICS_UI_ACCESSIBILITY_PROBE: '1' },
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(run.stdout).text(),
    new Response(run.stderr).text(),
    run.exited,
  ]);
  expect(status(), 'the story run must not change repository files').toBe(statusBefore);
  expect(existsSync(report), `${stdout.slice(-2000)}\n${stderr.slice(-4000)}`).toBe(true);

  const result = JSON.parse(readFileSync(report, 'utf8')) as {
    testResults: { name: string; assertionResults: { status: string; title: string; failureMessages: string[] }[] }[];
  };
  const byFile = new Map(
    result.testResults.map((file) => [file.name.slice(file.name.lastIndexOf('/') + 1), file.assertionResults]),
  );
  const failures = result.testResults.flatMap((file) =>
    file.assertionResults
      .filter((assertion) => assertion.status === 'failed')
      .map((assertion) => `${file.name}: ${assertion.title}: ${assertion.failureMessages[0]?.split('\n')[0] ?? ''}`),
  );
  expect(failures.filter((failure) => !failure.includes('accessibility-probe.stories.tsx'))).toEqual([]);
  const probed = byFile.get('accessibility-probe.stories.tsx') ?? [];
  expect(probed.map((assertion) => [assertion.title, assertion.status])).toEqual([['Unnamed Control', 'failed']]);
  expect(probed[0]?.failureMessages.join('\n')).toMatch(/button-name|Buttons must have discernible text/i);
  expect(exitCode).toBe(1);
  for (const { file, name } of expected) {
    const assertions = byFile.get(file.slice(file.lastIndexOf('/') + 1)) ?? [];
    expect(assertions.find((assertion) => assertion.title === name)?.status, `${file}: ${name}`).toBe('passed');
  }
}, 900_000);
