import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript-6';

interface Reference { file: string; name: string }
interface Module {
  source: ts.SourceFile;
  client: boolean;
  imports: Map<string, Reference>;
}

/** Follow authored imports and barrels, stopping at a client boundary. JSX is allowed; invocation is not. */
function clientCalls(entries: string[], read: (file: string) => string | undefined): string[] {
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
  const visited = new Set<string>();
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
    for (const imported of module.imports.values()) visit(imported.file);
    for (const statement of module.source.statements) {
      if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
        const file = target(module.source.fileName, statement.moduleSpecifier.text);
        if (file) visit(file);
      }
    }
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
  const violations = clientCalls([resolve('server.tsx')], file => sources[file]);
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
  expect(clientCalls([resolve('server.tsx')], file => sources[file])).toEqual([]);
});

test('server routes and their server imports never invoke ordinary client references', () => {
  const cache = new Map<string, string | undefined>();
  const read = (file: string) => {
    if (!cache.has(file)) cache.set(file, existsSync(file) && /\.[cm]?[jt]sx?$/.test(file) ? readFileSync(file, 'utf8') : undefined);
    return cache.get(file);
  };
  const routes = [...new Bun.Glob('**/*.{ts,tsx}').scanSync({ cwd: resolve('apps/web/app'), absolute: true })];
  expect(routes.length).toBeGreaterThan(100);
  expect(clientCalls(routes, read)).toEqual([]);
});
