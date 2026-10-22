import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript-6';
import { selectRepositoryGuards } from '../../../scripts/qa/repository-guards.ts';
import { addressFailureResponse } from '../features/address/edge.ts';
import { resourceHref } from '../features/address/path.ts';
import { getTranslation } from '../i18n/server.ts';
import { uiLocales } from '../i18n/define.ts';
import { localizedPath } from '../i18n/locale.ts';

interface Reference { file: string; name: string }
interface Module {
  source: ts.SourceFile;
  client: boolean;
  imports: Map<string, Reference>;
}

/** RSC routes and Worker entries may render client JSX, but cannot call it or run a DOM renderer. */
function serverBoundaryViolations(entries: string[], read: (file: string) => string | undefined, visited = new Set<string>()): string[] {
  const modules = new Map<string, Module>();
  const target = (from: string, specifier: string): string | undefined => {
    const base = specifier.startsWith('.') ? resolve(dirname(from), specifier)
      : specifier.startsWith('@/') ? resolve('apps/web', specifier.slice(2))
      : specifier.startsWith('@rezics/ui/') ? resolve('packages/ui/src', specifier === '@rezics/ui/utils'
        ? 'utils.ts' : `components/${specifier.slice('@rezics/ui/'.length)}.tsx`) : undefined;
    return base && [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]
      .find(file => read(file) !== undefined);
  };
  function load(file: string): Module {
    const cached = modules.get(file);
    if (cached) return cached;
    const source = ts.createSourceFile(file, read(file) ?? '', ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const first = source.statements[0];
    const module: Module = { source, client: !!first && ts.isExpressionStatement(first)
      && ts.isStringLiteral(first.expression) && first.expression.text === 'use client', imports: new Map() };
    modules.set(file, module);
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)
        || statement.importClause?.isTypeOnly) continue;
      const file = target(source.fileName, statement.moduleSpecifier.text);
      if (!file) continue;
      const clause = statement.importClause;
      if (clause?.name) module.imports.set(clause.name.text, { file, name: 'default' });
      if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
        module.imports.set(clause.namedBindings.name.text, { file, name: '*' });
      } else if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const binding of clause.namedBindings.elements) {
          if (!binding.isTypeOnly) module.imports.set(binding.name.text, { file, name: binding.propertyName?.text ?? binding.name.text });
        }
      }
    }
    return module;
  }
  function boundary(reference: Reference, seen = new Set<string>()): string | undefined {
    const key = `${reference.file}#${reference.name}`;
    if (seen.has(key)) return;
    seen.add(key);
    const module = load(reference.file);
    if (module.client) return key;
    for (const statement of module.source.statements) {
      if (ts.isExportDeclaration(statement) && !statement.isTypeOnly) {
        const file = statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)
          ? target(reference.file, statement.moduleSpecifier.text) : undefined;
        if (!statement.exportClause && file) {
          const found = boundary({ file, name: reference.name }, seen);
          if (found) return found;
        } else if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
          const binding = statement.exportClause.elements.find(item => !item.isTypeOnly && item.name.text === reference.name);
          if (!binding) continue;
          const name = binding.propertyName?.text ?? binding.name.text;
          const exported = file ? { file, name } : module.imports.get(name);
          if (exported) return boundary(exported, seen);
        }
      }
      if (reference.name === 'default' && ts.isExportAssignment(statement) && ts.isIdentifier(statement.expression)) {
        const exported = module.imports.get(statement.expression.text);
        if (exported) return boundary(exported, seen);
      }
    }
  }
  const violations: string[] = [];
  function visit(file: string) {
    if (visited.has(file)) return;
    visited.add(file);
    const module = load(file);
    if (module.client) return;
    const aliases = new Map(module.imports);
    function reference(expression: ts.Expression): Reference | undefined {
      if (ts.isIdentifier(expression)) return aliases.get(expression.text);
      if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression)
        || ts.isNonNullExpression(expression) || ts.isSatisfiesExpression(expression)) return reference(expression.expression);
      if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
        const object = reference(expression.expression);
        const name = ts.isPropertyAccessExpression(expression) ? expression.name.text
          : ts.isStringLiteralLike(expression.argumentExpression) ? expression.argumentExpression.text : '*';
        return object && { file: object.file, name: object.name === '*' ? name : object.name };
      }
    }
    function walk(node: ts.Node) {
      const specifier = ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly ? node.moduleSpecifier
        : ts.isExportDeclaration(node) && !node.isTypeOnly ? node.moduleSpecifier
        : ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
          || ts.isIdentifier(node.expression) && node.expression.text === 'require') ? node.arguments[0] : undefined;
      if (specifier && ts.isStringLiteralLike(specifier)) {
        if (/^react-dom\/(server|static)([./]|$)/.test(specifier.text)) {
          const { line } = module.source.getLineAndCharacterOfPosition(node.getStart(module.source));
          violations.push(`${relative(process.cwd(), file)}:${line + 1} imports DOM renderer ${specifier.text}`);
        }
        const dependency = target(file, specifier.text);
        if (dependency) visit(dependency);
      }
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        const imported = reference(node.initializer);
        if (imported) aliases.set(node.name.text, imported);
      }
      if (ts.isCallExpression(node) || ts.isNewExpression(node) || ts.isTaggedTemplateExpression(node)) {
        const imported = reference(ts.isTaggedTemplateExpression(node) ? node.tag : node.expression);
        const client = imported && boundary(imported);
        if (client) {
          const { line } = module.source.getLineAndCharacterOfPosition(node.getStart(module.source));
          violations.push(`${relative(process.cwd(), file)}:${line + 1} invokes ${relative(process.cwd(), client)}`);
        }
      }
      ts.forEachChild(node, walk);
    }
    walk(module.source);
  }
  entries.forEach(visit);
  return violations;
}

test('the boundary guard rejects named, default, namespace, aliased and barrel function calls', () => {
  const sources: Record<string, string> = Object.fromEntries(Object.entries({
    'client.tsx': "'use client'; export function parse() {} export default function Client() {}",
    'barrel.ts': "export { parse as forwarded } from './client.tsx';",
    'server.tsx': `import Client, { parse as view } from './client.tsx';
      import * as helpers from './client.tsx';
      import { forwarded } from './barrel.ts';
      const alias = helpers.parse;
      view(); Client(); helpers.parse(); helpers['parse'](); alias(); forwarded();`,
  }).map(([file, source]) => [resolve(file), source]));
  const violations = serverBoundaryViolations([resolve('server.tsx')], file => sources[file]);
  expect(violations).toHaveLength(6);
});

test('client components in JSX, type imports, server actions and shared pure functions remain legal', () => {
  const sources: Record<string, string> = Object.fromEntries(Object.entries({
    'client.tsx': "'use client'; export interface Props {} export default function Client() {}",
    'pure.ts': 'export function parse() { return "mine"; }',
    'actions.ts': "'use server'; export async function save() {}",
    'server.tsx': `import Client, { type Props } from './client.tsx';
      import { parse } from './pure.ts'; import { save } from './actions.ts';
      export default async function Page() { await save(); return <Client view={parse()} />; }`,
  }).map(([file, source]) => [resolve(file), source]));
  expect(serverBoundaryViolations([resolve('server.tsx')], file => sources[file])).toEqual([]);
});

test('the boundary guard catches eager, lazy, re-exported and side-effect DOM renderer imports', () => {
  const sources: Record<string, string> = Object.fromEntries(Object.entries({
    'worker.ts': `import './admission.ts'; export * from './barrel.ts';
      const lazy = () => import('./lazy.ts'); const legacy = require('./legacy.ts');`,
    'admission.ts': "import { renderToReadableStream } from 'react-dom/server.browser';",
    'barrel.ts': "export { renderToString } from 'react-dom/server';",
    'lazy.ts': "export const render = () => import('react-dom/server.edge');",
    'legacy.ts': "const render = require('react-dom/static');",
  }).map(([file, source]) => [resolve(file), source]));
  const violations = serverBoundaryViolations([resolve('worker.ts')], file => sources[file]);
  expect(violations).toHaveLength(4);
  expect(violations.every(violation => violation.includes('imports DOM renderer'))).toBe(true);
});

test('server routes, middleware and the Worker import graph respect React environment boundaries', () => {
  const cache = new Map<string, string | undefined>();
  const read = (file: string) => {
    if (!cache.has(file)) cache.set(file, existsSync(file) && /\.[cm]?[jt]sx?$/.test(file) ? readFileSync(file, 'utf8') : undefined);
    return cache.get(file);
  };
  const routes = [...new Bun.Glob('**/*.{ts,tsx}').scanSync({ cwd: resolve('apps/web/app'), absolute: true })];
  const visited = new Set<string>();
  expect(routes.length).toBeGreaterThan(100);
  expect(serverBoundaryViolations([...routes, resolve('apps/web/worker/index.ts'), resolve('apps/web/proxy.ts')], read, visited)).toEqual([]);
  const uncovered = [...visited].map(file => relative(process.cwd(), file)).sort()
    .filter(file => !selectRepositoryGuards([file]).some(guard => guard.file === 'apps/web/tests/server-client-boundary.test.ts'));
  expect(uncovered).toEqual([]);
});

test('server boundary selection covers its graph inputs without selecting unrelated backend or docs changes', () => {
  const selected = (file: string) => selectRepositoryGuards([file])
    .some(guard => guard.file === 'apps/web/tests/server-client-boundary.test.ts');
  for (const file of [
    'apps/web/app/[locale]/proposals/page.tsx',
    'apps/web/features/proposals/list-state.ts',
    'apps/web/features/proposals/proposal-list.tsx',
    'apps/web/i18n/server.ts',
    'packages/ui/src/utils.ts',
    'packages/ui/src/components/button.tsx',
    'apps/accounts/features/api/oauth-query.ts',
    'apps/web/worker/client-ip.ts',
    'apps/web/worker/index.ts',
    'apps/web/proxy.ts',
    'apps/web/zones/official/declared.ts',
    'apps/web/zones/official/index.ts',
    'generated/openapi/main/exposure.ts',
    'apps/web/tests/server-client-boundary.test.ts',
    'scripts/qa/repository-guards.ts',
  ]) expect(selected(file), file).toBe(true);
  for (const file of ['services/main/src/app.ts', 'services/account/src/app.ts', 'docs/README.md']) {
    expect(selected(file), file).toBe(false);
  }
});

test('pre-shell recovery documents retain localized tasks and HTTP failure semantics', async () => {
  for (const locale of uiLocales) {
    const { data: t } = await getTranslation('shell', [locale]);
    for (const status of [404, 410, 429, 503] as const) {
      const url = new URL(`${localizedPath(resourceHref('/e/', 'missing'), locale)}/?type=lists&after=opaque%2Bcursor&tag=a&tag=b`, 'https://web.test');
      const response = await addressFailureResponse(url, locale, status, '9');
      expect(response.status).toBe(status);
      expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('x-robots-tag')).toBe('noindex');
      expect(response.headers.get('referrer-policy')).toBe('no-referrer');
      const missing = status === 404 || status === 410;
      expect(response.headers.get('retry-after')).toBe(missing ? null : '9');
      const html = await response.text();
      expect(html).toContain(`<!DOCTYPE html><html lang="${locale}">`);
      expect(html).toContain(missing ? t.notFoundTitle : t.errorTitle);
      expect(html).toContain('<h1');
      expect(html.includes('role="alert"')).toBe(!missing);
      expect(html.includes(`href="${(url.pathname + url.search).replaceAll('&', '&amp;')}"`)).toBe(!missing);
      expect(html).toContain(`href="/${locale}/discover?type=lists"`);
      expect(html).toContain(`href="/${locale}"`);
      if (missing) expect(html).not.toContain('<script');
      else {
        expect(html).toContain('data-retry');
        expect(html).toContain(`role="status" hidden>${t.loading}</p>`);
        const nonce = html.match(/<script nonce="([^"]+)">/)?.[1];
        expect(nonce).toBeTruthy();
        expect(response.headers.get('content-security-policy')).toContain(`script-src 'nonce-${nonce}'`);
        expect(html).not.toMatch(/\son(?:click|load)=/i);
      }
    }
  }
});
