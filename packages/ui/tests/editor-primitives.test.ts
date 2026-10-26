import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const root = join(import.meta.dir, '..');
const components = join(root, 'src', 'components');
const text = (path: string) => readFileSync(path, 'utf8');

const importSpecifier = /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"]/g;

function specifiers(source: string): string[] {
  return [...source.matchAll(importSpecifier)].map((match) => (match[1] ?? match[2])!);
}

/** The source file a local or `@rezics/ui` specifier names, or null for a package. */
function resolveLocal(from: string, specifier: string): string | null {
  if (specifier.startsWith('.')) return resolve(dirname(from), specifier);
  if (specifier.startsWith('@rezics/ui/shadcn/')) return join(root, 'src', 'shadcn', `${specifier.slice(18)}.tsx`);
  if (specifier.startsWith('@rezics/ui/')) return join(root, 'src', 'components', `${specifier.slice(11)}.tsx`);
  return null;
}

/** Every package a file reaches through local imports, so a wrapper around Ark UI counts as Ark UI. */
function reach(entry: string): { files: Set<string>; packages: Set<string> } {
  const files = new Set<string>();
  const packages = new Set<string>();
  const queue = [entry];
  while (queue.length) {
    const file = queue.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    expect(existsSync(file), file).toBe(true);
    for (const specifier of specifiers(text(file))) {
      const local = resolveLocal(file, specifier);
      if (local) queue.push(local);
      else packages.add(specifier);
    }
  }
  return { files, packages };
}

function shadcnImports(file: string): string[] {
  return specifiers(text(join(components, file)))
    .filter((specifier) => specifier.startsWith('@rezics/ui/shadcn/'))
    .map((specifier) => specifier.slice(18))
    .sort();
}

function arkFree(file: string) {
  const { files, packages } = reach(join(components, file));
  const ark = [...packages].filter((name) => name.startsWith('@ark-ui/'));
  expect(
    ark,
    `${file} reaches Ark UI through ${[...files].map((path) => path.slice(root.length + 1)).join(', ')}`,
  ).toEqual([]);
}

test('the rich-text editor, its selection menu, slash menu, link editor, image controls and touch bar are built from shadcn primitives and import no Ark UI', () => {
  const pieces = {
    'rich-text-editor.tsx': ['button'],
    'editor-selection-menu.tsx': ['button', 'dropdown-menu', 'toggle'],
    'editor-slash-menu.tsx': ['command'],
    'editor-link.tsx': ['button', 'field', 'input'],
    'editor-image.tsx': ['button', 'field', 'input'],
    'editor-touch-bar.tsx': ['button', 'sheet', 'toggle', 'tooltip'],
  } as const;
  for (const [file, expected] of Object.entries(pieces)) {
    arkFree(file);
    expect(shadcnImports(file), file).toEqual([...expected]);
    // The shadcn directory is the only place a primitive comes from; the earlier Ark wrappers are not imported.
    const wrappers = specifiers(text(join(components, file))).filter((specifier) =>
      /^\.\/(?:button|input|toggle|toggle-group|tooltip|popover|menu|sheet|dialog|field|command|hover-card)\.tsx$/.test(
        specifier,
      ),
    );
    expect(wrappers, file).toEqual([]);
  }

  // The editor's own pieces and their stories do not reach Ark UI either.
  for (const file of ['editor-commands.ts', 'editor-surface.ts', 'editor-uploads.ts', 'editor-labels.ts'])
    arkFree(file);
  for (const story of [
    'rich-text-editor.stories.tsx',
    'editor-selection-menu.stories.tsx',
    'editor-slash-menu.stories.tsx',
    'editor-link.stories.tsx',
    'editor-image.stories.tsx',
    'editor-touch-bar.stories.tsx',
  ])
    arkFree(story);
});

test('the document body and spoilers render from the same primitives, with prose styles that keep the serif face for Work titles only', () => {
  arkFree('prose.tsx');
  arkFree('document-body.tsx');
  arkFree('document-spoiler.tsx');
  expect(shadcnImports('document-spoiler.tsx')).toEqual(['button']);

  // The body and the editor draw one Prose surface, with a readable measure.
  const prose = text(join(components, 'prose.tsx'));
  expect(prose).toMatch(/export (?:function|const) Prose\b/);
  expect(prose).toContain('data-slot="prose"');
  expect(prose).toMatch(/max-w-/);
  expect(specifiers(text(join(components, 'document-body.tsx')))).toContain('./prose.tsx');
  expect(specifiers(text(join(components, 'editor-surface.ts')))).toContain('./prose.tsx');
  expect(existsSync(join(components, 'prose.stories.tsx'))).toBe(true);

  // Interface face for body text; the serif face is named only under the Work title selector.
  for (const file of ['prose.tsx', 'document-body.tsx', 'document-spoiler.tsx', 'editor-surface.ts'])
    expect(text(join(components, file)), file).not.toMatch(/font-serif|font-work-title|--font-work-serif|Source Serif/);
  const css = text(join(root, 'src', 'prose.css'));
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, '').split('}');
  const serif = rules.filter((rule) => /--font-work-serif|font-work-title|Source Serif|\bserif\b/.test(rule));
  expect(serif.length).toBeGreaterThan(0);
  for (const rule of serif) expect(rule.slice(0, rule.indexOf('{')), rule).toMatch(/\.work-title\b/);
  expect(css).toMatch(/\.rezics-document\s*\{[^}]*font-family:\s*var\(--font-interface\)/);
  // CJK text gets a longer line height and a measure counted in characters, not in the width of a zero.
  expect(css).toMatch(/:lang\((?:zh|ja|ko)[^)]*\)[^{]*\{[^}]*line-height/);
  expect(css).toMatch(/:lang\((?:zh|ja|ko)[^)]*\)[^{]*\{[^}]*max-width:\s*\d+(?:\.\d+)?em/);
  // The styles ship once: the global stylesheet only imports them.
  expect(text(join(root, 'src', 'styles.css'))).not.toMatch(/^\.rezics-document\b/m);
});
