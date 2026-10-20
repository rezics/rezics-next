import { expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import ts from 'typescript-6';
import { resolveConfig } from 'vite';

const config = await resolveConfig({ root: resolve('apps/web'), configFile: resolve('apps/web/vite.config.ts') }, 'serve');

test('browser prebundling does not force client packages into the RSC optimizer', () => {
  const client = config.environments.client!.optimizeDeps.include ?? [];
  const rsc = config.environments.rsc!.optimizeDeps.include ?? [];
  for (const dependency of ['@ark-ui/react/dialog', '@tanstack/react-query', 'lucide-react']) {
    expect(client).toContain(dependency);
    expect(rsc).not.toContain(dependency);
  }
});

test('both server environments prepare shared styling and localization dependencies before rendering', () => {
  for (const environment of ['rsc', 'ssr']) {
    const dependencies = config.environments[environment]!.optimizeDeps.include ?? [];
    expect(dependencies).toContain('tailwind-variants');
    expect(dependencies).toContain('native-i18n');
  }
});

test('SSR prepares runtime editor dependencies without sending them through the RSC optimizer', () => {
  const dependencies = new Set<string>();
  for (const file of ['document-extensions.tsx', 'editor-commands.tsx', 'editor-slash-menu.tsx']) {
    const path = resolve('packages/ui/src/components', file);
    const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const clause = statement.importClause;
      if (clause?.isTypeOnly || (clause && !clause.name && clause.namedBindings && ts.isNamedImports(clause.namedBindings)
        && clause.namedBindings.elements.every(binding => binding.isTypeOnly))) continue;
      const dependency = statement.moduleSpecifier.text;
      // React editor entry points retain their existing client boundary.
      if (dependency.startsWith('@tiptap/') && !dependency.startsWith('@tiptap/react')) dependencies.add(dependency);
    }
  }
  expect(dependencies.size).toBeGreaterThan(0);
  for (const dependency of dependencies) {
    expect(config.environments.ssr!.optimizeDeps.include).toContain(dependency);
    expect(config.environments.rsc!.optimizeDeps.include).not.toContain(dependency);
  }
});
