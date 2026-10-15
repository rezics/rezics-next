import { expect, test } from 'bun:test';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import ts from 'typescript-6';

const root = resolve(import.meta.dir, '../../..');

function runtimeImports(file: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const imports: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      const bindings = clause?.namedBindings;
      if (!clause?.isTypeOnly && (!bindings || !ts.isNamedImports(bindings)
        || clause?.name || bindings.elements.length === 0 || bindings.elements.some(element => !element.isTypeOnly))) {
        imports.push((node.moduleSpecifier as ts.StringLiteral).text);
      }
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && !node.isTypeOnly
      && (!node.exportClause || !ts.isNamedExports(node.exportClause)
        || node.exportClause.elements.length === 0 || node.exportClause.elements.some(element => !element.isTypeOnly))) {
      imports.push((node.moduleSpecifier as ts.StringLiteral).text);
    } else if (ts.isCallExpression(node)
      && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || ts.isIdentifier(node.expression) && node.expression.text === 'require')
      && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) {
      imports.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return imports;
}

test('the Main release image copies every transitive runtime import of its server', () => {
  const dockerfile = readFileSync(resolve(root, 'infra/release/Dockerfile'), 'utf8')
    .split(/FROM .* AS runtime\s*\n/)[1]!;
  const copies = [...dockerfile.matchAll(/^COPY\s+(?:--\S+\s+)*\/app\/(\S*)\s+\.\/(\S*)\s*$/gm)]
    .map(([, source, destination]) => ({ source: source!, destination: destination! }));
  expect(copies.length).toBeGreaterThan(0);
  // External package implementations reside in the production dependency tree.
  expect(copies.some(copy => ['', 'node_modules'].includes(copy.source)
    && copy.source === copy.destination)).toBe(true);
  const options: ts.CompilerOptions = { moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowImportingTsExtensions: true, resolveJsonModule: true };
  const queue = ['services/main/src/index.ts', 'services/main/src/telemetry.ts', 'infra/release/entrypoint.ts']
    .map(file => resolve(root, file));
  const visited = new Set<string>();
  const missing: string[] = [];
  while (queue.length) {
    const file = queue.pop()!;
    if (visited.has(file)) continue;
    visited.add(file);
    const path = relative(root, file);
    if (!copies.some(copy => (!copy.source || path === copy.source || path.startsWith(`${copy.source}/`))
      && resolve(root, copy.destination, relative(resolve(root, copy.source), file)) === file)) {
      missing.push(path);
    }
    if (!/\.[cm]?[jt]sx?$/.test(file)) continue;
    for (const specifier of runtimeImports(file)) {
      if (specifier.startsWith('node:') || specifier === 'bun') continue;
      const resolved = ts.resolveModuleName(specifier, file, options, ts.sys).resolvedModule;
      if (!resolved) {
        if (specifier.startsWith('.') || specifier.startsWith('@rezics/'))
          missing.push(`${path}: unresolved ${specifier} from ${dirname(file)}`);
        continue;
      }
      const dependency = realpathSync(resolved.resolvedFileName);
      const local = relative(root, dependency);
      if (local.startsWith('../') || local.startsWith('node_modules/') || /\.d\.[cm]?ts$/.test(local)) continue;
      expect(local).not.toMatch(/(?:^|\/)tests?\/|\.(?:test|spec)\./);
      queue.push(dependency);
    }
  }
  expect(visited.has(resolve(root, 'services/main/src/modules/governance/effects.ts'))).toBe(true);
  expect(missing.sort()).toEqual([]);
}, 30_000);
