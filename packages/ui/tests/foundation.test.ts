import { afterAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const components = join(root, 'src', 'components');

// Components that must exist, each with a sibling story that runs as a browser test.
const storied = ['locale', 'localized-text', 'show'];

type Tokens = Record<string, string>;

function block(css: string, open: number): string {
  let depth = 0;
  for (let index = css.indexOf('{', open); index < css.length; index++) {
    if (css[index] === '{') depth++;
    else if (css[index] === '}' && --depth === 0) return css.slice(open, index + 1);
  }
  throw new Error('unbalanced stylesheet');
}

function hexTokens(text: string): Tokens {
  return Object.fromEntries(
    [...text.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)].map((match) => [match[1]!, match[2]!.toLowerCase()]),
  );
}

// The light palette is the rule that first defines --background; dark overrides it in a nested `@variant dark` block.
async function themes(): Promise<{ light: Tokens; dark: Tokens }> {
  const css = await Bun.file(join(root, 'src', 'styles.css')).text();
  const definition = css.search(/--background:\s*#/);
  expect(definition).toBeGreaterThan(-1);
  const start = css.lastIndexOf('}', definition) + 1;
  const rule = block(css, start);
  const variant = rule.indexOf('@variant dark');
  expect(variant).toBeGreaterThan(-1);
  const dark = block(rule, variant);
  const light = hexTokens(rule.replace(dark, ''));
  return { light, dark: { ...light, ...hexTokens(dark) } };
}

function contrast(a: string, b: string): number {
  const luminance = (hex: string) => {
    const [r, g, bl] = [1, 3, 5]
      .map((index) => parseInt(hex.slice(index, index + 2), 16) / 255)
      .map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * bl!;
  };
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

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
    ['destructive-foreground', 'background'],
    ['info-foreground', 'background'],
    ['success-foreground', 'background'],
    ['warning-foreground', 'background'],
  ];
  for (const [name, tokens] of Object.entries(await themes())) {
    for (const [ink, surface] of [...text, ['brand', 'background'], ['brand', 'card']]) {
      expect(tokens[ink!], `${name} --${ink}`).toMatch(/^#/);
      expect(tokens[surface!], `${name} --${surface}`).toMatch(/^#/);
    }
    for (const [ink, surface] of text)
      expect(contrast(tokens[ink]!, tokens[surface]!), `${name} ${ink} on ${surface}`).toBeGreaterThanOrEqual(4.5);
    for (const surface of ['background', 'card'])
      expect(contrast(tokens.brand!, tokens[surface]!), `${name} brand mark on ${surface}`).toBeGreaterThanOrEqual(3);
  }
});

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
const output = mkdtempSync(join(tmpdir(), 'rezics-ui-stories-'));
afterAll(() => {
  rmSync(output, { recursive: true, force: true });
});

test('the accessibility probe is an opt-in test fixture', async () => {
  expect(existsSync(fixture)).toBe(true);
  expect(existsSync(probe)).toBe(false);
  const config = await Bun.file(join(root, '.storybook', 'main.ts')).text();
  expect(config).toContain('REZICS_UI_ACCESSIBILITY_PROBE');
  expect(config).toContain('../tests/fixtures/accessibility-probe.stories.tsx');
});

test('every ported component has stories that pass as accessible browser tests', async () => {
  for (const name of storied) {
    expect(existsSync(join(components, `${name}.tsx`)), `${name}.tsx`).toBe(true);
    expect(existsSync(join(components, `${name}.stories.tsx`)), `${name}.stories.tsx`).toBe(true);
  }

  // A control without an accessible name must fail its story: accessibility violations are errors.
  const report = join(output, 'stories.json');
  const status = () =>
    execFileSync('git', ['status', '--porcelain'], { cwd: join(root, '..', '..'), encoding: 'utf8' });
  const statusBefore = status();
  const run = Bun.spawn(['bun', 'x', 'vitest', 'run', '--reporter=json', `--outputFile=${report}`], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, CI: '1', REZICS_UI_ACCESSIBILITY_PROBE: '1' },
  });
  const [stdout, stderr] = await Promise.all([
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
  expect(probed.map((assertion) => assertion.status)).toEqual(['failed']);
  for (const name of storied) {
    const assertions = byFile.get(`${name}.stories.tsx`) ?? [];
    expect(assertions.filter((assertion) => assertion.status === 'passed').length, `${name} stories`).toBeGreaterThan(
      0,
    );
  }
}, 900_000);
