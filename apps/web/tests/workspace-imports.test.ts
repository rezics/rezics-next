import { describe, expect, test } from 'bun:test';
import { join, relative } from 'node:path';

// Node resolution walks up to the repository root, whose devDependencies name some workspace packages for root specs.
// A workspace that imports one of them without declaring it still resolves locally, then breaks wherever the root
// does not happen to declare it. Every workspace declares what it imports.
const root = join(import.meta.dir, '../../..');
const workspaces = ['apps/web', 'apps/auth', 'packages/ui', 'packages/document'];
const skipped = /(^|\/)(node_modules|dist|\.output|\.wrangler|storybook-static|\.tanstack|\.cloudflare)\//;
const specifier = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"](@rezics\/[a-z0-9-]+)(?:\/[^'"]*)?['"]/g;

type Manifest = {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

async function undeclared(workspace: string): Promise<string[]> {
  const directory = join(root, workspace);
  const manifest = (await Bun.file(join(directory, 'package.json')).json()) as Manifest;
  const declared = new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
  ]);
  const missing = new Set<string>();
  for (const file of new Bun.Glob('**/*.{ts,tsx,mts,cts}').scanSync({ cwd: directory, dot: true })) {
    if (skipped.test(file)) continue;
    const source = await Bun.file(join(directory, file)).text();
    for (const match of source.matchAll(specifier)) {
      const name = match[1]!;
      if (name !== manifest.name && !declared.has(name))
        missing.add(`${name} (${relative(root, join(directory, file))})`);
    }
  }
  return [...missing].sort();
}

describe('workspace imports', () => {
  for (const workspace of workspaces)
    test(`${workspace} declares every @rezics package it imports`, async () => {
      expect(await undeclared(workspace)).toEqual([]);
    });

  test('the scan sees static, dynamic and side-effect imports and re-exports', () => {
    // Built at run time, so this file's own source names no package.
    const scope = ['@', 'rezics'].join('');
    const source = [
      `import { a } from '${scope}/one';`,
      `import type { B } from '${scope}/two/sub';`,
      `export * from '${scope}/three';`,
      `const c = await import('${scope}/four/bundled');`,
      `import '${scope}/five/styles.css';`,
      `const d = '${scope}/not-an-import';`,
    ].join('\n');
    expect([...source.matchAll(specifier)].map((match) => match[1])).toEqual(
      ['one', 'two', 'three', 'four', 'five'].map((name) => `${scope}/${name}`),
    );
  });
});
