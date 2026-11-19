import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { loadCsf } from 'storybook/internal/csf-tools';
import { buttonVariants } from '../src/shadcn/button.tsx';
import { inspectThemeColors } from './theme-contrast.ts';

const root = join(import.meta.dir, '..');
const repository = join(root, '..', '..');
const shadcn = join(root, 'src', 'shadcn');

type Components = {
  style: string;
  iconLibrary: string;
  rtl: boolean;
  menuColor: string;
  menuAccent: string;
  tailwind: { css: string; baseColor: string; cssVariables: boolean; config: string; prefix: string };
  aliases: Record<string, string>;
};
type Manifest = {
  scripts?: Record<string, string>;
  exports?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};
type RegistryItem = { name: string; type: string; files?: string[] };
type Snapshot = { style: string; items: RegistryItem[] };

const readJson = async <T>(path: string) => (await Bun.file(path).json()) as T;
const text = (path: string) => readFileSync(path, 'utf8');

function sources(directory: string, extensions: string[]): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sources(join(directory, entry.name), extensions)
      : extensions.some((extension) => entry.name.endsWith(extension))
        ? [join(directory, entry.name)]
        : [],
  );
}

// The components the shadcn CLI writes for `add --all`: every UI item with files. `sonner` is the deprecated toast
// library the CLI leaves out (the Base UI `toast` replaces it).
const notCloned = new Set(['sonner']);

async function snapshot(): Promise<Snapshot> {
  return readJson<Snapshot>(join(root, 'shadcn-registry.json'));
}

test('packages/ui and apps/web share one shadcn configuration: Mira Neutral on Base UI with one icon library', async () => {
  const ui = await readJson<Components>(join(root, 'components.json'));
  const web = await readJson<Components>(join(repository, 'apps', 'web', 'components.json'));

  expect(ui.style).toBe('base-mira');
  expect(ui.tailwind.baseColor).toBe('neutral');
  for (const key of ['style', 'iconLibrary', 'rtl', 'menuColor', 'menuAccent'] as const)
    expect(web[key], key).toEqual(ui[key]);
  expect(web.tailwind.baseColor).toBe(ui.tailwind.baseColor);
  expect(ui.iconLibrary).toBe('lucide');
  expect(ui.tailwind.cssVariables).toBe(true);
  expect(web.tailwind.cssVariables).toBe(true);
  expect(ui.tailwind.config).toBe('');
  expect(web.tailwind.config).toBe('');
  expect(ui.tailwind.prefix).toBe(web.tailwind.prefix);

  // Both write shadcn components into the one package directory, so `shadcn add` from either lands in the same place.
  expect(ui.aliases.ui).toBe('@rezics/ui/shadcn');
  expect(web.aliases.ui).toBe(ui.aliases.ui);
  expect(web.aliases.utils).toBe(ui.aliases.utils);
  expect(ui.tailwind.css).toBe('src/styles.css');
  expect(web.tailwind.css).toBe('../../packages/ui/src/styles.css');
  expect(existsSync(join(root, ui.tailwind.css))).toBe(true);
  expect(existsSync(join(repository, 'apps', 'web', web.tailwind.css))).toBe(true);

  // The Base UI primitives, one icon library, and no second primitive family.
  const manifest = await readJson<Manifest>(join(root, 'package.json'));
  const dependencies = { ...manifest.dependencies, ...manifest.devDependencies };
  expect(dependencies['@base-ui/react']).toBeDefined();
  expect(dependencies['lucide-react']).toBeDefined();
  expect(Object.keys(dependencies).filter((name) => name.startsWith('@radix-ui') || name === 'radix-ui')).toEqual([]);
  const webManifest = await readJson<Manifest>(join(repository, 'apps', 'web', 'package.json'));
  expect(webManifest.dependencies?.['lucide-react']).toBe(dependencies['lucide-react']);
});

test('every shadcn component is cloned into the one directory the shadcn CLI writes, with exact version pins', async () => {
  const registry = await snapshot();
  const config = await readJson<Components>(join(root, 'components.json'));
  expect(registry.style).toBe(config.style);
  const components = registry.items
    .filter((item) => item.type === 'registry:ui' && (item.files?.length ?? 0) > 0 && !notCloned.has(item.name))
    .map((item) => item.name);
  expect(components.length).toBeGreaterThanOrEqual(60);
  for (const name of ['table', 'chart', 'empty', 'field', 'item', 'sidebar', 'combobox', 'command', 'drawer'])
    expect(components, name).toContain(name);

  const written = readdirSync(shadcn).filter((file) => file.endsWith('.tsx'));
  expect(written.sort()).toEqual(components.map((name) => `${name}.tsx`).sort());
  // Nothing else lives in the directory: no stories, tests, styles or local additions.
  expect(readdirSync(shadcn).filter((file) => !file.endsWith('.tsx'))).toEqual([]);
  expect(written.filter((file) => /\.(stories|test)\./.test(file))).toEqual([]);

  // Components are reachable as @rezics/ui/shadcn/<name> and never re-exported from the index.
  const manifest = await readJson<Manifest>(join(root, 'package.json'));
  expect(manifest.exports?.['./shadcn/*']).toBe('./src/shadcn/*.tsx');
  expect(text(join(root, 'src', 'index.ts'))).not.toMatch(/shadcn/);
  for (const name of components) expect(text(join(shadcn, `${name}.tsx`)), name).not.toMatch(/from ['"]\.{1,2}\//);

  // Exact pins, and every package the cloned files import is declared.
  const declared = {
    ...manifest.dependencies,
    ...manifest.devDependencies,
    ...manifest.peerDependencies,
  };
  for (const [name, version] of Object.entries(declared))
    expect(version, name).toMatch(/^(?:\d+\.\d+\.\d+(?:-[\w.]+)?|workspace:\*)$/);
  const cloned = [
    ...sources(shadcn, ['.tsx']),
    ...sources(join(root, 'src', 'lib'), ['.ts', '.tsx']),
    join(root, 'src', 'hooks', 'use-mobile.ts'),
    join(root, 'src', 'hooks', 'use-highlighted-code.ts'),
  ];
  const imported = new Set<string>();
  for (const file of cloned)
    for (const match of text(file).matchAll(/from ['"]([^'"./][^'"]*)['"]/g)) {
      const specifier = match[1]!;
      if (specifier.startsWith('@rezics/ui/')) continue;
      const parts = specifier.split('/');
      imported.add(specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!);
    }
  expect(imported.size).toBeGreaterThan(10);
  for (const name of imported) expect(declared[name], `${name} is imported by a cloned file`).toBeDefined();
  // The theme stylesheet imports shadcn's Tailwind layer from the shadcn package.
  expect(declared.shadcn).toBeDefined();
  expect(declared['class-variance-authority']).toBeDefined();

  const notices = text(join(root, 'THIRD_PARTY_NOTICES.md'));
  for (const name of ['shadcn/ui', 'Base UI']) expect(notices, name).toContain(name);

  const readme = text(join(root, 'README.md'));
  expect(readme).toContain('SHADCN.md');
  expect(readme).toContain('src/shadcn');
});

test('the shadcn color variables resolve to Mira Neutral with AA text contrast in both themes', async () => {
  const css = text(join(root, 'src', 'styles.css'));
  const shadcnImport = css.indexOf("shadcn/tailwind.css'");
  expect(shadcnImport, 'styles.css imports shadcn/tailwind.css').toBeGreaterThan(-1);
  expect(css.indexOf('--background:'), 'the Neutral tokens follow the shadcn import').toBeGreaterThan(shadcnImport);

  const variables = [
    'background',
    'foreground',
    'card',
    'card-foreground',
    'popover',
    'popover-foreground',
    'primary',
    'primary-foreground',
    'secondary',
    'secondary-foreground',
    'muted',
    'muted-foreground',
    'accent',
    'accent-foreground',
    'destructive',
    'border',
    'input',
    'ring',
    'chart-1',
    'chart-2',
    'chart-3',
    'chart-4',
    'chart-5',
    'sidebar',
    'sidebar-foreground',
    'sidebar-primary',
    'sidebar-primary-foreground',
    'sidebar-accent',
    'sidebar-accent-foreground',
    'sidebar-border',
    'sidebar-ring',
  ];
  for (const name of variables) expect(css, `--color-${name}`).toContain(`--color-${name}: var(--${name})`);

  // Text on its own surface, and shared ink on each surface the Mira components use.
  const pairs: [string, string][] = [
    ['foreground', 'background'],
    ['card-foreground', 'card'],
    ['popover-foreground', 'popover'],
    ['primary-foreground', 'primary'],
    ['secondary-foreground', 'secondary'],
    ['accent-foreground', 'accent'],
    ['muted-foreground', 'background'],
    ['muted-foreground', 'card'],
    ['muted-foreground', 'popover'],
    ['muted-foreground', 'muted'],
    ['muted-foreground', 'secondary'],
    ['muted-foreground', 'accent'],
    ['primary', 'background'],
    ['primary', 'card'],
    ['primary', 'popover'],
    ['destructive', 'background'],
    ['destructive', 'card'],
    ['destructive', 'popover'],
    ['sidebar-foreground', 'sidebar'],
    ['sidebar-primary-foreground', 'sidebar-primary'],
    ['sidebar-accent-foreground', 'sidebar-accent'],
  ];
  const samples = pairs.map(([ink, surface]) => ({ label: `${ink} on ${surface}`, ink, surface }));
  for (const { theme, tokens, contrast } of await inspectThemeColors(samples, [...variables, 'brand'])) {
    for (const [index, { foreground, background, ratio }] of contrast.entries()) {
      expect(ratio, `${theme} ${samples[index]!.label} (${foreground} on ${background})`).toBeGreaterThanOrEqual(4.5);
    }
    for (const variable of variables.filter((variable) =>
      /foreground$|^(?:primary|destructive|ring|sidebar-primary)$/.test(variable),
    )) {
      expect(tokens[variable], `${theme} --${variable} uses --brand`).not.toBe(tokens.brand);
    }
  }
  // Theme selection stays on <html> with no script.
  expect(css).toContain('@custom-variant dark');
  expect(css).toContain('prefers-color-scheme: dark');
  expect(css).not.toMatch(/@custom-variant dark\s*\(&:is\(\.dark \*\)\)/);
}, 30_000);

test('destructive ink meets AA over Mira action states and in error descriptions', async () => {
  const button = buttonVariants({ variant: 'destructive' });
  const samples = ['background', 'card', 'popover'].flatMap((surface) => [
    { label: 'destructive button at rest', surface, className: button },
    { label: 'destructive button on hover', surface, className: button, hover: true },
    { label: 'error description', surface, className: 'text-destructive/90' },
  ]);
  const failures = [];
  for (const { theme, contrast } of await inspectThemeColors(samples)) {
    for (const [index, { foreground, background, ratio }] of contrast.entries()) {
      const { label, surface } = samples[index]!;
      if (ratio < 4.5) {
        failures.push(`${theme} ${label} over --${surface}: ${foreground} on ${background}, ${ratio.toFixed(2)}:1`);
      }
    }
  }
  expect(failures, 'destructive text requires at least 4.5:1').toEqual([]);
}, 30_000);

test('interface text is set in Manrope and only Work titles in the serif face, both self-hosted', async () => {
  const css = text(join(root, 'src', 'styles.css'));
  expect(css).toMatch(/--font-interface:\s*'Manrope Variable'/);
  expect(css).toMatch(/--font-sans:\s*var\(--font-interface\)/);
  expect(css).toMatch(/--font-heading:\s*var\(--font-interface\)/);
  expect(css).toMatch(/--font-work-title:\s*var\(--font-work-serif\)/);
  expect(css).toMatch(/--font-work-serif:[^;]*Source Serif 4 Variable/);
  expect(css).not.toMatch(/Inter Variable|@fontsource-variable\/inter/);

  // Only the Work title utility and the document surface name the serif face; no cloned file does.
  for (const file of sources(shadcn, ['.tsx']))
    expect(text(file), file).not.toMatch(/font-work-title|font-serif|--font-work-serif|Source Serif/);
  const preview = text(join(root, '.storybook', 'preview.css'));
  expect(preview).toContain("@import '@fontsource-variable/manrope'");
  expect(preview).toContain("@import '@fontsource-variable/source-serif-4'");

  const manifest = await readJson<Manifest>(join(root, 'package.json'));
  expect(manifest.dependencies?.['@fontsource-variable/manrope']).toMatch(/^\d+\.\d+\.\d+$/);
  expect(manifest.dependencies?.['@fontsource-variable/source-serif-4']).toMatch(/^\d+\.\d+\.\d+$/);
  expect(Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })).not.toContain(
    '@fontsource-variable/inter',
  );
  // Self-hosted: no stylesheet or script pulls a font from a third-party host.
  for (const file of [...sources(join(root, 'src'), ['.css', '.ts', '.tsx']), join(root, '.storybook', 'preview.css')])
    expect(text(file), file).not.toMatch(/fonts\.(?:googleapis|gstatic)\.com|use\.typekit|fonts\.bunny/);
});

const firstStories = {
  button: 'actions-button--variants',
  input: 'forms-input--invalid',
  field: 'forms-field--invalid',
  select: 'forms-select--keyboard',
  dialog: 'overlays-dialog--close-button',
  'dropdown-menu': 'overlays-dropdown-menu--selecting',
};

test('the first shadcn components have stories that pass as accessible browser tests', async () => {
  const expected = Object.entries(firstStories).map(([component, id]) => {
    const file = join(root, 'src', 'components', `shadcn-${component}.stories.tsx`);
    const source = text(file);
    const csf = loadCsf(source, { fileName: file, makeTitle: (title) => title }).parse();
    const story = Object.values(csf._stories).find((story) => story.id === id);
    expect(story, id).toBeDefined();
    expect(source, component).toMatch(
      new RegExp(`from ['"](?:@rezics/ui/shadcn/${component}|\\.\\./shadcn/${component}\\.tsx)['"]`),
    );
    expect(source, component).toMatch(/\bplay\b/);
    return { file, name: story!.name };
  });
  expect(text(join(root, '.storybook', 'preview.tsx'))).toMatch(/a11y:\s*\{\s*test:\s*'error'\s*\}/);

  const temporary = join(root, '.temp');
  mkdirSync(temporary, { recursive: true });
  const output = mkdtempSync(join(temporary, 'shadcn-base-stories-'));
  try {
    const report = join(output, 'stories.json');
    const run = Bun.spawn(
      [
        'bun',
        'x',
        'vitest',
        'run',
        ...expected.map(({ file }) => file),
        '--testNamePattern',
        `(?:${expected.map(({ name }) => name).join('|')})$`,
        '--reporter=json',
        `--outputFile=${report}`,
      ],
      { cwd: root, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, CI: '1' } },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(run.stdout).text(),
      new Response(run.stderr).text(),
      run.exited,
    ]);
    expect(existsSync(report), `${stdout.slice(-2000)}\n${stderr.slice(-4000)}`).toBe(true);
    const result = JSON.parse(text(report)) as {
      testResults: { name: string; assertionResults: { status: string; title: string; failureMessages: string[] }[] }[];
    };
    const byFile = new Map(result.testResults.map((file) => [basename(file.name), file.assertionResults]));
    for (const { file, name } of expected) {
      const outcome = byFile.get(basename(file))?.find((assertion) => assertion.title === name);
      expect(outcome?.status, `${file}: ${name} ${outcome?.failureMessages[0] ?? ''}`).toBe('passed');
    }
    expect(exitCode, `${stdout.slice(-2000)}\n${stderr.slice(-4000)}`).toBe(0);
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
}, 900_000);

test('SHADCN.md indexes every shadcn registry item with its purpose and add command, regenerated from the committed registry snapshot', async () => {
  const registry = await snapshot();
  expect(registry.items.length).toBeGreaterThan(150);
  const types = new Set(registry.items.map((item) => item.type));
  for (const type of ['registry:ui', 'registry:block', 'registry:hook', 'registry:lib'])
    expect(types, type).toContain(type);

  const script = await import(join(root, 'scripts', 'shadcn-index.ts'));
  const rendered = (script.renderIndex as (registry: Snapshot) => string)(registry);
  const committed = text(join(root, 'SHADCN.md'));
  expect(committed).toBe(rendered);

  // One line per item: its name, its purpose and the command that adds it.
  const lines = committed.split('\n');
  for (const item of registry.items) {
    const matching = lines.filter((line) => line.startsWith(`- \`${item.name}\``));
    expect(matching.length, item.name).toBe(1);
    expect(matching[0], item.name).toContain(`bunx shadcn@latest add ${item.name}`);
    const purpose = matching[0]!
      .slice(`- \`${item.name}\``.length)
      .split('`bunx')[0]!
      .replace(/[\s—–-]+/g, ' ')
      .trim();
    expect(purpose.length, `${item.name} purpose`).toBeGreaterThan(8);
  }
  // Regeneration is offline and stable.
  expect(script.renderIndex(JSON.parse(JSON.stringify(registry)))).toBe(rendered);
  expect(text(join(root, 'README.md'))).toMatch(/SHADCN\.md[\s\S]*not offer|not offer[\s\S]*SHADCN\.md/);
});
