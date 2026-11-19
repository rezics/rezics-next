import { afterAll, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

const root = join(import.meta.dir, '..');
const repository = join(root, '..', '..');
const components = join(root, 'src', 'components');
const shadcn = join(root, 'src', 'shadcn');

const moduleNames = (directory: string) =>
  readdirSync(directory)
    .filter((file) => /\.tsx?$/.test(file) && !file.endsWith('.stories.tsx'))
    .map((file) => file.replace(/\.tsx?$/, ''));

/** Components the site still builds on, so they stay although they are not shadcn. */
const keptLegacy = ['avatar-initials', 'locale'];

/** Components built on Ark UI that nothing imports, so they are gone with the library. */
const arkOnly = [
  'announcement',
  'bottom-navigation',
  'client-only',
  'data-list',
  'environment',
  'float',
  'format',
  'frame',
  'highlight',
  'hint',
  'image-cropper',
  'json-tree-view',
  'link-overlay',
  'marquee',
  'presence',
  'qr-code',
  'status',
  'steps',
  'swap',
  'timer',
];

/** Legacy components whose control shadcn provides under another name. */
const renamed = ['password-input', 'skip-nav', 'segment-group', 'circular-progress', 'autocomplete'];

const legacy = [
  ...new Set([
    ...moduleNames(shadcn),
    ...renamed,
    ...arkOnly,
    'button',
    'field',
    'input',
    'combobox',
    'checkbox',
    'badge',
    'alert',
    'item',
    'select',
    'dialog',
    'tabs',
  ]),
].sort();

const workspaceSources = () =>
  Bun.spawnSync(['git', 'ls-files', 'apps', 'packages', 'services', 'specs'], { cwd: repository })
    .stdout.toString()
    .split('\n')
    .filter((file) => /\.(tsx?|mts|jsx?|mjs)$/.test(file) && existsSync(join(repository, file)));

const scanners = { ts: new Bun.Transpiler({ loader: 'ts' }), tsx: new Bun.Transpiler({ loader: 'tsx' }) };

function importsOf(file: string): string[] {
  const code = readFileSync(join(repository, file), 'utf8');
  try {
    return scanners[file.endsWith('x') ? 'tsx' : 'ts'].scanImports(code).map((item) => item.path);
  } catch {
    return [...code.matchAll(/(?:from|import\()\s*['"]([^'"]+)['"]/g)].map((match) => match[1]!);
  }
}

let scanned: Map<string, string[]> | undefined;
function workspaceImports(): ReadonlyMap<string, string[]> {
  return (scanned ??= new Map(workspaceSources().map((file) => [file, importsOf(file)])));
}

test('packages/ui exports no legacy component that has a shadcn counterpart, and no workspace imports one', () => {
  expect(legacy.length).toBeGreaterThan(40);
  const exported = Object.keys(
    (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { exports: Record<string, string> }).exports,
  );
  const indexed = readFileSync(join(root, 'src', 'index.ts'), 'utf8');

  // The `./*` export maps to a file in src/components, so a file that is gone is an export that is gone.
  const present = legacy.filter((name) => moduleNames(components).includes(name));
  expect(present).toEqual([]);
  expect(
    legacy.filter((name) => exported.includes(`./${name}`) || new RegExp(`/${name}\\.tsx?'`).test(indexed)),
  ).toEqual([]);
  // Their stories and tests go with them.
  expect(legacy.filter((name) => existsSync(join(components, `${name}.stories.tsx`)))).toEqual([]);

  const importers: string[] = [];
  for (const [file, imports] of workspaceImports()) {
    for (const path of imports) {
      let name: string | undefined;
      const alias = path.match(/^@rezics\/ui\/([^/]+)$/);
      if (alias) name = alias[1];
      else if (path.startsWith('.')) {
        const target = resolve(dirname(join(repository, file)), path);
        if (dirname(target) === components) name = basename(target).replace(/\.tsx?$/, '');
      }
      if (name && legacy.includes(name)) importers.push(`${file}: ${path}`);
    }
  }
  expect(importers).toEqual([]);

  // What the site still imports stays, with its story where it renders something.
  for (const name of keptLegacy) expect(existsSync(join(components, `${name}.tsx`)), name).toBe(true);
  for (const name of ['cover', 'reactions', 'content-actions', 'menu', 'report-dialog', 'rating', 'media-image'])
    expect(existsSync(join(components, `${name}.tsx`)), name).toBe(true);
  expect(existsSync(join(repository, 'packages/editor/src/components/document-body.tsx'))).toBe(true);
});

const probe = mkdtempSync(join(tmpdir(), 'rezics-ui-legacy-removed-'));
afterAll(() => rmSync(probe, { recursive: true, force: true }));

const uiCompositions: Record<string, { file: string; title?: string }> = {
  'content-section': { file: 'shadcn-card.stories.tsx', title: 'Default' },
  'cover-viewer': { file: 'cover.stories.tsx', title: 'Credit Viewer' },
  'layout-select': { file: 'shelf-page.stories.tsx', title: 'Overview' },
};
// EmptyState is mounted by FeedEmptyState in the Web catalogue.
const emptyStateStory = 'apps/web/src/stories/14-feed-empty-recovery.stories.tsx';
const storyOwners = moduleNames(components)
  .filter((name) => existsSync(join(components, `${name}.tsx`)) && name !== 'avatar-initials' && name !== 'empty-state')
  .sort()
  .map((name) => ({ name, ...(uiCompositions[name] ?? { file: `${name}.stories.tsx` }) }));

test('UI story inventory includes the canonical component compositions', () => {
  expect(storyOwners.length).toBeGreaterThan(15);
  expect(storyOwners.filter(({ file }) => !existsSync(join(components, file))).map(({ name }) => name)).toEqual([]);
  const recovery = readFileSync(join(repository, emptyStateStory), 'utf8');
  expect(recovery, emptyStateStory).toMatch(/^export const RecoveryJourney: Story = \{ play: journey \};/m);
  expect(recovery, emptyStateStory).toMatch(/^export const LongKeyboard: Story = \{/m);
  expect(recovery, emptyStateStory).toContain('[data-slot=empty-state]');
});

test('UI catalogue component stories pass their browser tests', async () => {
  const files = [...new Set(storyOwners.map(({ file }) => `src/components/${file}`))];
  const report = join(probe, 'stories.json');
  const run = Bun.spawn(['bun', 'x', 'vitest', 'run', ...files, '--reporter=json', `--outputFile=${report}`], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, CI: '1' },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
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
      .map((assertion) => `${file.name}: ${assertion.title}: ${assertion.failureMessages[0]?.slice(0, 850) ?? ''}`),
  );
  expect(failures).toEqual([]);
  expect(exitCode, stderr.slice(-4000)).toBe(0);
  const byFile = new Map(
    result.testResults.map((file) => [file.name.slice(file.name.lastIndexOf('/') + 1), file.assertionResults]),
  );
  for (const { name, file, title } of storyOwners)
    expect(
      (byFile.get(file) ?? []).filter(
        (assertion) => assertion.status === 'passed' && (title === undefined || assertion.title === title),
      ).length,
      `${name} stories`,
    ).toBeGreaterThan(0);
}, 1_800_000);

test('packages/ui does not depend on @ark-ui/react and no source file in the workspace imports it', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as Record<string, unknown>;
  const declared = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'].filter((field) =>
    Object.keys((manifest[field] ?? {}) as Record<string, string>).some((name) => name.startsWith('@ark-ui/')),
  );
  expect(declared).toEqual([]);
  const arkImporters = [...workspaceImports()]
    .filter(([, imports]) => imports.some((path) => path.startsWith('@ark-ui/')))
    .map(([file]) => file);
  expect(arkImporters).toEqual([]);
});
