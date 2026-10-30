import { afterAll, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const repository = join(root, '..', '..');
const shadcn = join(root, 'src', 'shadcn');

type Tokens = Record<string, string>;
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

function block(css: string, open: number): string {
  let depth = 0;
  for (let index = css.indexOf('{', open); index < css.length; index++) {
    if (css[index] === '{') depth++;
    else if (css[index] === '}' && --depth === 0) return css.slice(open, index + 1);
  }
  throw new Error('unbalanced stylesheet');
}

function hexTokens(source: string): Tokens {
  return Object.fromEntries(
    [...source.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)].map((match) => [
      match[1]!,
      match[2]!.toLowerCase(),
    ]),
  );
}

// The light palette is the rule that first defines --background; dark overrides it in a nested `@variant dark` block.
async function themes(): Promise<{ light: Tokens; dark: Tokens }> {
  const css = text(join(root, 'src', 'styles.css'));
  const definition = css.search(/--background:\s*#/);
  expect(definition).toBeGreaterThan(-1);
  const rule = block(css, css.lastIndexOf('}', definition) + 1);
  const variant = rule.indexOf('@variant dark');
  expect(variant).toBeGreaterThan(-1);
  const dark = block(rule, variant);
  const light = hexTokens(rule.replace(dark, ''));
  return { light, dark: { ...light, ...hexTokens(dark) } };
}

function mix(foreground: string, background: string, share: number): string {
  const channel = (hex: string, index: number) => parseInt(hex.slice(index, index + 2), 16);
  return `#${[1, 3, 5]
    .map((index) =>
      Math.round(channel(foreground, index) * share + channel(background, index) * (1 - share))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
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

test('packages/ui and apps/web share one shadcn configuration: the Rhea style on the Base UI base, with one icon library and base color', async () => {
  const ui = await readJson<Components>(join(root, 'components.json'));
  const web = await readJson<Components>(join(repository, 'apps', 'web', 'components.json'));

  expect(ui.style).toBe('base-rhea');
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
  expect(registry.style).toBe('base-rhea');
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

test('the shadcn color variables resolve to the Aura tokens with AA text contrast in both themes, and the logo red colors no text', async () => {
  const css = text(join(root, 'src', 'styles.css'));
  // Rhea's defaults come first and the Aura tokens are layered after them.
  const rhea = css.indexOf("shadcn/tailwind.css'");
  expect(rhea, 'styles.css imports shadcn/tailwind.css').toBeGreaterThan(-1);
  expect(css.indexOf('--background:'), 'the Aura tokens follow the Rhea import').toBeGreaterThan(rhea);

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

  // Text pairs the Rhea components draw: text on its own surface, links and muted text on every surface, and the
  // destructive tone on the page, on cards and on the tint Rhea's destructive button and alert fill with.
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
  for (const [name, tokens] of Object.entries(await themes())) {
    for (const variable of variables) expect(tokens[variable], `${name} --${variable}`).toMatch(/^#[0-9a-f]{6}$/);
    for (const [ink, surface] of pairs)
      expect(contrast(tokens[ink]!, tokens[surface]!), `${name} ${ink} on ${surface}`).toBeGreaterThanOrEqual(4.5);
    for (const surface of ['background', 'card'])
      expect(
        contrast(tokens.destructive!, mix(tokens.destructive!, tokens[surface]!, 0.1)),
        `${name} destructive on its 10% tint over ${surface}`,
      ).toBeGreaterThanOrEqual(4.5);
    // The logo red is a mark, never a text-bearing variable.
    for (const variable of variables.filter((variable) =>
      /foreground$|^(?:primary|destructive|ring)$|^sidebar-primary$/.test(variable),
    ))
      expect(tokens[variable], `${name} --${variable} is not the logo red`).not.toBe(tokens.brand);
    expect(contrast(tokens.brand!, tokens.background!), `${name} brand mark`).toBeGreaterThanOrEqual(3);
  }
  expect(css).not.toMatch(/--(?:primary|destructive|ring|[\w-]+-foreground):\s*var\(--brand\)/);

  // No cloned file or story colors text with the logo red.
  const offending = [
    /(?<![\w-])text-brand\b/,
    /text-\[(?:color:)?var\(--(?:color-)?brand\)\]/,
    /text-\(--(?:color-)?brand\)/,
    /(?<![\w-])color:\s*var\(--(?:color-)?brand\)/,
  ];
  const found: string[] = [];
  for (const file of sources(join(root, 'src'), ['.ts', '.tsx', '.css']))
    for (const pattern of offending) if (pattern.test(text(file))) found.push(`${file}: ${pattern}`);
  expect(found).toEqual([]);

  // Theme selection stays on <html> with no script.
  expect(css).toContain('@custom-variant dark');
  expect(css).toContain('prefers-color-scheme: dark');
  expect(css).not.toMatch(/@custom-variant dark\s*\(&:is\(\.dark \*\)\)/);
});

test('destructive ink meets AA over Rhea action states and in error descriptions', async () => {
  for (const [name, tokens] of Object.entries(await themes())) {
    for (const surface of ['background', 'card', 'popover']) {
      // Generated buttons use 10%/20% fills in light and 20%/30% in dark; menus use the first tint on focus.
      for (const share of name === 'light' ? [0.1, 0.2] : [0.2, 0.3])
        expect(
          contrast(tokens.destructive!, mix(tokens['destructive-solid']!, tokens[surface]!, share)),
          `${name} destructive ink on ${share * 100}% danger tint over ${surface}`,
        ).toBeGreaterThanOrEqual(4.5);
      // Rhea's destructive alert description draws the same ink at 90% opacity.
      expect(
        contrast(mix(tokens.destructive!, tokens[surface]!, 0.9), tokens[surface]!),
        `${name} error description over ${surface}`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  }
});

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

const probe = mkdtempSync(join(tmpdir(), 'rezics-ui-shadcn-stories-'));
afterAll(() => rmSync(probe, { recursive: true, force: true }));

test('the first shadcn components have stories that pass as accessible browser tests', async () => {
  const first = ['button', 'input', 'field', 'select', 'dialog', 'dropdown-menu'];
  for (const name of first) {
    const file = join(root, 'src', 'components', `shadcn-${name}.stories.tsx`);
    expect(existsSync(file), `shadcn-${name}.stories.tsx`).toBe(true);
    const story = text(file);
    expect(story, name).toMatch(/title:\s*'shadcn\//);
    expect(story, name).toContain(`@rezics/ui/shadcn/${name}`);
    expect(story, name).toMatch(/\bplay\b/);
  }
  // Accessibility violations fail a story.
  expect(text(join(root, '.storybook', 'preview.tsx'))).toMatch(/a11y:\s*\{\s*test:\s*'error'\s*\}/);

  const report = join(probe, 'stories.json');
  const run = Bun.spawn(['bun', 'x', 'vitest', 'run', 'shadcn-', '--reporter=json', `--outputFile=${report}`], {
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
      .filter((assertion) => assertion.status === 'failed')
      .map((assertion) => `${file.name}: ${assertion.title}: ${assertion.failureMessages[0]?.split('\n')[0] ?? ''}`),
  );
  expect(failures).toEqual([]);
  const byFile = new Map(
    result.testResults.map((file) => [file.name.slice(file.name.lastIndexOf('/') + 1), file.assertionResults]),
  );
  for (const name of first) {
    const assertions = byFile.get(`shadcn-${name}.stories.tsx`) ?? [];
    expect(assertions.filter((assertion) => assertion.status === 'passed').length, `${name} stories`).toBeGreaterThan(
      0,
    );
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
