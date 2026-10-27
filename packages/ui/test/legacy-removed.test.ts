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
const renamed = ['password-input', 'skip-nav', 'menu', 'segment-group', 'circular-progress', 'autocomplete'];

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

function importsOf(file: string): string[] {
  const code = readFileSync(join(repository, file), 'utf8');
  try {
    return new Bun.Transpiler({ loader: file.endsWith('x') ? 'tsx' : 'ts' }).scanImports(code).map((item) => item.path);
  } catch {
    return [...code.matchAll(/(?:from|import\()\s*['"]([^'"]+)['"]/g)].map((match) => match[1]!);
  }
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
  for (const file of workspaceSources()) {
    for (const path of importsOf(file)) {
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
  for (const name of [
    'cover',
    'reactions',
    'content-actions',
    'document-body',
    'report-dialog',
    'rating',
    'media-image',
  ])
    expect(existsSync(join(components, `${name}.tsx`)), name).toBe(true);
});

const probe = mkdtempSync(join(tmpdir(), 'rezics-ui-legacy-removed-'));
afterAll(() => rmSync(probe, { recursive: true, force: true }));

test('every component packages/ui still exports has a story and passes the story test', async () => {
  // Modules that render nothing themselves, so they have no story of their own.
  const helpers = ['avatar-initials'];
  const names = moduleNames(components)
    .filter((name) => existsSync(join(components, `${name}.tsx`)) && !helpers.includes(name))
    .sort();
  expect(names.length).toBeGreaterThan(15);
  const missing = names.filter((name) => !existsSync(join(components, `${name}.stories.tsx`)));
  expect(missing).toEqual([]);

  const files = names.map((name) => `src/components/${name}.stories.tsx`);
  const report = join(probe, 'stories.json');
  const run = Bun.spawn(['bun', 'x', 'vitest', 'run', ...files, '--reporter=json', `--outputFile=${report}`], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, CI: '1' },
  });
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
  for (const name of names)
    expect(
      (byFile.get(`${name}.stories.tsx`) ?? []).filter((assertion) => assertion.status === 'passed').length,
      `${name} stories`,
    ).toBeGreaterThan(0);
}, 1_800_000);

test('packages/ui does not depend on @ark-ui/react and no source file in the workspace imports it', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as Record<string, unknown>;
  const declared = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'].filter((field) =>
    Object.keys((manifest[field] ?? {}) as Record<string, string>).some((name) => name.startsWith('@ark-ui/')),
  );
  expect(declared).toEqual([]);
  expect(workspaceSources().filter((file) => importsOf(file).some((path) => path.startsWith('@ark-ui/')))).toEqual([]);
});
