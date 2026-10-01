import * as ts from 'typescript/unstable/ast';
import { API, SymbolFlags, type Project, type Symbol as TypeSymbol } from 'typescript/unstable/sync';
import { createVirtualFileSystem } from 'typescript/unstable/fs';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface SqlRequestFlow { source: string; request: string }

/** Conservative, symbol-based flow analysis for integration fixtures. Assertions,
 * fixture writes and EXPLAIN do not produce client inputs. Aliases, helper returns,
 * object properties, callback results and imported helpers preserve SELECT origins. */
export function sqlRequestFlows(project: Project, files: readonly ts.SourceFile[]): SqlRequestFlow[] {
  const checker = project.checker;
  const origins = new Map<TypeSymbol, Set<string>>();
  const functions = new Map<ts.Node, Set<string>>();
  const sourceCalls = new Map<ts.Node, string>();
  const requests: (ts.CallExpression | ts.NewExpression)[] = [];
  const nodes: ts.Node[] = [];
  const location = (node: ts.Node) => {
    const file = node.getSourceFile();
    return `${file.fileName}:${file.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
  };
  const symbols = new Map<ts.Node, TypeSymbol | undefined>();
  const initializers = new Map<TypeSymbol, ts.Expression>();
  const symbol = (node: ts.Node) => {
    if (symbols.has(node)) return symbols.get(node);
    let value = checker.getSymbolAtLocation(node);
    if (value && value.flags & SymbolFlags.Alias) value = checker.getAliasedSymbol(value);
    symbols.set(node, value);
    return value;
  };
  const declarations = new Map<ts.CallExpression, ts.Node | undefined>();
  const declarationOf = (node: ts.CallExpression) => {
    if (!declarations.has(node)) declarations.set(node, checker.getResolvedSignature(node)?.declaration?.resolve(project));
    return declarations.get(node);
  };
  const union = (...sets: (ReadonlySet<string> | undefined)[]) => new Set(sets.flatMap(set => [...set ?? []]));
  const isFunction = (node: ts.Node): node is ts.FunctionLikeDeclaration =>
    ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node);
  const nameOf = (node: ts.Expression) => ts.isPropertyAccessExpression(node) ? node.name.text
    : ts.isIdentifier(node) ? node.text : '';
  const isHttp = (node: ts.CallExpression) => {
    if (!/^(fetch|call|request|post|read|get|put|patch|move|revoke|handle)$/.test(nameOf(node.expression))) return false;
    // Collection lookups (including nested provider.accepted Maps) are storage
    // inspection, not requests. Resolve the declaration rather than its spelling.
    if (nameOf(node.expression) === 'get'
      && /(?:lib\..*\.d\.ts|\/infrastructure\/immutable-objects\.ts)$/.test(
        declarationOf(node)?.getSourceFile().fileName ?? '')) return false;
    return !/(Pool|pool|client|fuseki|store|owner|content|access|registry|library|roles|groups|Map|map)$/.test(
      ts.isPropertyAccessExpression(node.expression) ? node.expression.expression.getText() : '');
  };
  const isSql = (node: ts.CallExpression) => /^(query|q)$/.test(nameOf(node.expression));
  const sqlText = (node: ts.Node | undefined, seen = new Set<ts.Node>()): string => {
    if (!node || seen.has(node)) return '';
    seen.add(node);
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (ts.isTemplateExpression(node)) return node.head.text + node.templateSpans.map(span => span.literal.text).join('');
    if (ts.isIdentifier(node)) {
      const initializer = initializers.get(symbol(node)!);
      if (initializer) return sqlText(initializer, seen);
      const declaration = symbol(node)?.valueDeclaration?.resolve(project);
      return declaration && ts.isVariableDeclaration(declaration) ? sqlText(declaration.initializer, seen) : '';
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      return sqlText(node.left, seen) + sqlText(node.right, seen);
    }
    return '';
  };

  for (const file of files) {
    const visit = (node: ts.Node) => {
      nodes.push(node);
      if (ts.isVariableDeclaration(node) && node.initializer && ts.isIdentifier(node.name)) {
        const target = symbol(node.name);
        if (target) initializers.set(target, node.initializer);
      }
      if (ts.isCallExpression(node)) {
        if (isHttp(node)) requests.push(node);
        if (isSql(node)) {
          const sql = sqlText(node.arguments[0]).replace(/\/\*[\s\S]*?\*\/|--[^\n]*/g, '').trim();
          if (/^(?:SELECT|WITH)\b/i.test(sql) && !/\b(?:INSERT|UPDATE|DELETE)\b/i.test(sql)
            && /\b(?:FROM|JOIN)\s+"?(?:access|content|reader|source|pkg|structure|media|rights|verification|semantic|export|hub|connected_app|wiki|reading_position|relay|site|quota|commerce)"?\s*\./i.test(sql)) {
            sourceCalls.set(node, location(node));
          }
        }
      } else if (ts.isNewExpression(node) && node.expression.getText() === 'Request') {
        requests.push(node);
      }
      node.forEachChild(visit);
    };
    visit(file);
  }

  const value = (node: ts.Node | undefined, seen = new Set<ts.Node>()): Set<string> => {
    if (!node || seen.has(node)) return new Set();
    seen.add(node);
    const source = sourceCalls.get(node);
    if (source) return new Set([source]);
    if (isFunction(node)) return union(functions.get(node));
    if (ts.isIdentifier(node)) return union(origins.get(symbol(node)!));
    if (ts.isPropertyAccessExpression(node)) return union(origins.get(symbol(node.name)!), value(node.expression, seen));
    if (ts.isCallExpression(node)) {
      if (isSql(node) || isHttp(node) || nameOf(node.expression) === 'expect') return new Set();
      const declaration = declarationOf(node);
      const transforms = /^(String|Number|Boolean|stringify|parse|from|concat|toString|toISOString|encodeURIComponent|createHash|update|digest|replace|split|match|exec|trim|toLowerCase|toUpperCase|map|flatMap|filter|slice|at|join|sort|find)$/.test(nameOf(node.expression));
      return union(declaration ? functions.get(declaration) : undefined,
        transforms ? value(node.expression, seen) : origins.get(symbol(
          ts.isPropertyAccessExpression(node.expression) ? node.expression.name : node.expression)!),
        ...transforms ? node.arguments.map(argument => value(argument, seen)) : []);
    }
    if (ts.isNewExpression(node) && node.expression.getText() === 'Request') {
      return union(...node.arguments?.map(argument => value(argument, seen)) ?? []);
    }
    const children: Set<string>[] = [];
    node.forEachChild(child => { children.push(value(child, seen)); });
    return union(...children);
  };
  let changed = true;
  const add = (target: TypeSymbol | undefined, sources: Set<string>) => {
    if (!target || !sources.size) return;
    const prior = origins.get(target) ?? new Set();
    for (const source of sources) if (!prior.has(source)) { prior.add(source); changed = true; }
    origins.set(target, prior);
  };
  // Each iteration can only add one of the finite SELECT origins to a finite
  // symbol set; convergence is independent of fixture runtime data size.
  while (changed) {
    changed = false;
    for (const node of nodes) {
      if (ts.isVariableDeclaration(node) && node.initializer && ts.isIdentifier(node.name)) {
        // Object properties retain their own symbols instead of contaminating
        // every method of a harness that also exposes a storage assertion.
        if (!ts.isObjectLiteralExpression(node.initializer)) add(symbol(node.name), value(node.initializer));
      } else if (ts.isVariableDeclaration(node) && node.initializer
        && (ts.isObjectBindingPattern(node.name) || ts.isArrayBindingPattern(node.name))) {
        for (const element of node.name.elements) if (ts.isBindingElement(element) && element.name
          && ts.isIdentifier(element.name)) add(symbol(element.name), value(node.initializer));
      } else if (ts.isPropertyAssignment(node)) {
        add(symbol(node.name), value(node.initializer));
      } else if (ts.isBindingElement(node)) {
        const pattern = node.parent;
        const declaration = pattern.parent;
        if (ts.isVariableDeclaration(declaration) && node.name && ts.isIdentifier(node.name)) {
          add(symbol(node.name), value(declaration.initializer));
        }
      } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        add(symbol(node.left), value(node.right));
      }
      if (isFunction(node)) {
        const sources = new Set<string>();
        const returns = (child: ts.Node) => {
          if (child !== node && isFunction(child)) return;
          if (ts.isReturnStatement(child) && child.expression && !ts.isObjectLiteralExpression(child.expression)) {
            for (const source of value(child.expression)) sources.add(source);
          }
          child.forEachChild(returns);
        };
        if (ts.isArrowFunction(node) && !ts.isBlock(node.body)) {
          if (!ts.isObjectLiteralExpression(node.body)) for (const source of value(node.body)) sources.add(source);
        } else returns(node);
        const prior = functions.get(node) ?? new Set();
        for (const source of sources) if (!prior.has(source)) { prior.add(source); changed = true; }
        functions.set(node, prior);
        if ('name' in node && node.name) add(symbol(node.name), prior);
      }
      if (ts.isCallExpression(node) && !isSql(node) && !isHttp(node)) {
        const declaration = declarationOf(node);
        if (declaration && isFunction(declaration)) {
          node.arguments.forEach((argument, index) => {
            const parameter = declaration.parameters[index];
            if (parameter && ts.isIdentifier(parameter.name)) add(symbol(parameter.name), value(argument));
          });
        }
      }
    }
  }
  const properties = new Map<ts.Node, readonly TypeSymbol[]>();
  const argumentValue = (node: ts.Node): Set<string> => {
    const sources = value(node);
    // Whole object arguments carry their tainted fields; object receivers remain
    // field-specific so an assertion helper cannot contaminate its sibling APIs.
    if (ts.isIdentifier(node)) {
      const initializer = initializers.get(symbol(node)!);
      if (initializer && ts.isObjectLiteralExpression(initializer)) {
        for (const property of initializer.properties) for (const source of value(property)) sources.add(source);
      }
      if (!properties.has(node)) {
        const type = checker.getTypeAtLocation(node);
        properties.set(node, type ? checker.getPropertiesOfType(type) : []);
      }
      for (const property of properties.get(node)!) for (const source of origins.get(property) ?? []) sources.add(source);
    } else node.forEachChild(child => { for (const source of argumentValue(child)) sources.add(source); });
    return sources;
  };
  const flows = requests.flatMap(request => [...union(...request.arguments?.map(argumentValue) ?? [])]
    .map(source => ({ source, request: location(request) })));
  return [...new Map(flows.map(flow => [`${flow.source}\0${flow.request}`, flow])).values()];
}

// The pinned TypeScript 7 synchronous compiler API uses Node's pipe handles.
// Keep it in a short-lived Node child; Bun runs the surrounding test suite.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const input = JSON.parse(readFileSync(0, 'utf8')) as { root: string; paths: string[]; files?: Record<string, string> };
  const config = resolve(input.root, '.temp/g-903-guard/tsconfig.json');
  const virtual = createVirtualFileSystem({ ...input.files,
    [config]: JSON.stringify({ compilerOptions: { target: 'ESNext', module: 'Preserve', moduleResolution: 'Bundler',
      allowImportingTsExtensions: true, skipLibCheck: true, noEmit: true }, files: input.paths }) });
  const api = new API({ cwd: input.root, fs: {
    readFile: virtual.readFile,
    // The overlay contains the config and synthetic regression files only.
    // Undefined preserves real dependency/module resolution outside the overlay.
    fileExists: path => virtual.fileExists?.(path) ? true : undefined,
    directoryExists: path => virtual.directoryExists?.(path) ? true : undefined,
  } });
  try {
    const project = api.updateSnapshot({ openProjects: [config] }).getProject(config)!;
    const files = input.paths.map(path => project.program.getSourceFile(path)!);
    process.stdout.write(JSON.stringify(sqlRequestFlows(project, files)));
  } finally { api.close(); }
}
