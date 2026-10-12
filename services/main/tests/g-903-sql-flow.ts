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
  const parameterTokens = new Map<ts.Node, string[]>();
  const parameterArguments = new Map<string, ts.Expression[]>();
  const nodes: ts.Node[] = [];
  const returnExpressions = new Map<ts.FunctionLikeDeclaration, ts.Expression[]>();
  const objectReturns = new Map<ts.FunctionLikeDeclaration, ts.Expression[]>();
  const location = (node: ts.Node) => {
    const file = node.getSourceFile();
    return `${file.fileName}:${file.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
  };
  const symbols = new Map<ts.Node, TypeSymbol | undefined>();
  const initializers = new Map<TypeSymbol, ts.Expression>();
  const symbol = (node: ts.Node) => {
    if (symbols.has(node)) return symbols.get(node);
    let value = ts.isShorthandPropertyAssignment(node) ? checker.getShorthandAssignmentValueSymbol(node)
      : checker.getSymbolAtLocation(node);
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
  const isFunction = (node: ts.Node): node is ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration | ts.MethodDeclaration =>
    ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node);
  const nameOf = (node: ts.Expression) => ts.isPropertyAccessExpression(node) ? node.name.text
    : ts.isIdentifier(node) ? node.text : '';
  const isTransform = (node: ts.CallExpression) => /^(String|Number|Boolean|stringify|parse|from|concat|toString|toISOString|encodeURIComponent|createHash|update|digest|replace|split|match|exec|trim|toLowerCase|toUpperCase|map|flatMap|filter|slice|at|join|sort|find)$/.test(nameOf(node.expression));
  const isRequestPrimitive = (node: ts.CallExpression) => {
    const declaration = declarationOf(node);
    const name = symbol(node.expression)?.name ?? nameOf(node.expression);
    const file = declaration?.getSourceFile().fileName ?? '';
    return (name === 'fetch' && /(?:lib\.dom\.d\.ts|\/web-globals\/fetch\.d\.ts)$/.test(file))
      || (/^(get|request)$/.test(name) && /\/@types\/node\/https?\.d\.ts$/.test(file))
      || (/^(get|post|put|patch|delete|head|options|send)$/.test(name)
        && /\/node_modules\/(?:@types\/)?(?:supertest|superagent)\//.test(file))
      || (/^(handle|fetch)$/.test(name) && /\/node_modules\/(?:elysia|hono)\//.test(file));
  };
  const httpCalls = new Map<ts.CallExpression, boolean>();
  const scannedFiles = new Set(files.map(file => file.fileName));
  const externalClients = new Map<ts.Node, boolean>();
  const isHttp = (node: ts.CallExpression) => {
    if (httpCalls.has(node)) return httpCalls.get(node)!;
    // Request sinks are capabilities of the resolved client, not method names.
    // Router registration, storage and local get/read methods are not clients.
    let request = isRequestPrimitive(node);
    const declaration = declarationOf(node);
    // In-scope helpers propagate inputs to their real request sites. A fixture
    // client outside the scan is opaque, so resolve its implementation instead
    // of silently dropping requests made through imported test harnesses.
    if (!request && declaration && !scannedFiles.has(declaration.getSourceFile().fileName)
      && /^(fetch|call|request|post|read|get|put|patch|delete|head|options|handle|send)$/.test(nameOf(node.expression))
      && isFunction(declaration) && declaration.body) {
      if (!externalClients.has(declaration)) {
        let client = false;
        const visit = (child: ts.Node) => {
          if (client || isFunction(child)) return;
          if ((ts.isNewExpression(child) && child.expression.getText() === 'Request')
            || (ts.isCallExpression(child) && isRequestPrimitive(child))) client = true;
          else child.forEachChild(visit);
        };
        visit(declaration.body);
        externalClients.set(declaration, client);
      }
      request = externalClients.get(declaration)!;
    }
    httpCalls.set(node, request);
    return request;
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
      if (ts.isVariableDeclaration(node) || ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)
        || ts.isBindingElement(node) || ts.isBinaryExpression(node) || isFunction(node)
        || ts.isCallExpression(node)) nodes.push(node);
      if (isFunction(node)) {
        parameterTokens.set(node, node.parameters.map((parameter, index) => {
          const token = `parameter:${location(node)}:${node.pos}:${index}`;
          if (ts.isIdentifier(parameter.name)) {
            const target = symbol(parameter.name);
            if (target) origins.set(target, new Set([token]));
          }
          return token;
        }));
        const expressions: ts.Expression[] = [];
        const objects: ts.Expression[] = [];
        const returned = (expression: ts.Expression) => {
          while (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression)
            || ts.isSatisfiesExpression(expression)) expression = expression.expression;
          (ts.isObjectLiteralExpression(expression) ? objects : expressions).push(expression);
        };
        const returns = (child: ts.Node) => {
          if (child !== node && isFunction(child)) return;
          if (ts.isReturnStatement(child) && child.expression)
            returned(child.expression);
          child.forEachChild(returns);
        };
        if (ts.isArrowFunction(node) && !ts.isBlock(node.body)) {
          returned(node.body);
        } else returns(node);
        // The return sites cannot change while origins converge. Walk function
        // bodies once, rather than once for every propagation round.
        returnExpressions.set(node, expressions);
        objectReturns.set(node, objects);
      }
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
  for (const node of nodes) if (ts.isCallExpression(node)) {
    const tokens = parameterTokens.get(declarationOf(node)!);
    node.arguments.forEach((argument, index) => {
      const token = tokens?.[index];
      if (token) parameterArguments.set(token, [...parameterArguments.get(token) ?? [], argument]);
    });
  }

  const properties = new Map<ts.Node, readonly TypeSymbol[]>();
  const propertyOrigins = (property: TypeSymbol | undefined, seen = new Set<ts.Node>()): Set<string> => {
    if (!property) return new Set();
    const sources = union(origins.get(property));
    const declaration = property.valueDeclaration?.resolve(project);
    if (!declaration || seen.has(declaration)) return sources;
    seen.add(declaration);
    if (ts.isPropertyAssignment(declaration) || ts.isPropertyDeclaration(declaration))
      return union(sources, value(declaration.initializer, seen));
    if (ts.isShorthandPropertyAssignment(declaration)) return union(sources, value(declaration, new Set()));
    return sources;
  };
  const callResult = (node: ts.CallExpression, sources: ReadonlySet<string>, seen: Set<ts.Node>) => {
    const tokens = parameterTokens.get(declarationOf(node)!);
    return union(...[...sources].map(source => {
      const [token, ...path] = source.split('\0');
      const index = tokens?.indexOf(token!) ?? -1;
      return index < 0 ? new Set([source]) : selectedOrigins(node.arguments[index], path, new Set(seen));
    }));
  };
  const accessOrigins = (sources: ReadonlySet<string>, path: readonly string[]) =>
    // Track the parameter's selected field. Descendants retain that field's
    // origins; recursive helper calls cannot manufacture unbounded new paths.
    new Set([...sources].map(source => source.startsWith('parameter:') && path.length && !source.includes('\0')
      ? `${source}\0${path[0]}` : source));
  const selectedOrigins = (node: ts.Node | undefined, path: readonly string[], seen = new Set<ts.Node>()): Set<string> =>
    // Presence checks use the argument itself, rather than every field of an
    // otherwise untainted fixture object. Scalar SELECT predicates still flow.
    union(accessOrigins(value(node, seen), path), path.length && path[0] !== '$condition' ? fieldOrigins(node, path[0]) : undefined);
  const fieldOrigins = (node: ts.Node | undefined, name?: string): Set<string> => {
    if (!node) return new Set<string>();
    if (!properties.has(node)) {
      const type = checker.getTypeAtLocation(node);
      properties.set(node, type ? checker.getPropertiesOfType(type) : []);
    }
    const sources = union(...properties.get(node)!.filter(property => name === undefined || property.name === name)
      .map(property => propertyOrigins(property)));
    let expression = node;
    while (ts.isAwaitExpression(expression) || ts.isParenthesizedExpression(expression)) expression = expression.expression;
    return ts.isCallExpression(expression) ? callResult(expression, sources, new Set()) : sources;
  };
  const value = (node: ts.Node | undefined, seen = new Set<ts.Node>()): Set<string> => {
    if (!node || seen.has(node)) return new Set();
    seen.add(node);
    const source = sourceCalls.get(node);
    if (source) return new Set([source]);
    if (isFunction(node)) return union(functions.get(node));
    if (ts.isShorthandPropertyAssignment(node))
      return union(origins.get(symbol(node)!), value(node.objectAssignmentInitializer, seen));
    if (ts.isIdentifier(node)) return union(origins.get(symbol(node)!));
    if (ts.isConditionalExpression(node)) return union(accessOrigins(value(node.condition, seen), ['$condition']),
      value(node.whenTrue, seen), value(node.whenFalse, seen));
    if (ts.isPropertyAccessExpression(node)) return union(propertyOrigins(symbol(node.name), seen),
      accessOrigins(value(node.expression, seen), [node.name.text]));
    if (ts.isCallExpression(node)) {
      // Sink classification never changes return propagation. A fixture client
      // may return a retained ID even when it also sends a request.
      if (isSql(node) || nameOf(node.expression) === 'expect') return new Set();
      const declaration = declarationOf(node);
      const transforms = isTransform(node);
      const sources = union(declaration ? functions.get(declaration) : undefined,
        transforms ? value(node.expression, seen) : origins.get(symbol(
          ts.isPropertyAccessExpression(node.expression) ? node.expression.name : node.expression)!),
        ...transforms ? node.arguments.map(argument => value(argument, seen)) : []);
      // A helper's parameter origins are substituted at this invocation. They
      // never become shared return origins from another call to the same helper.
      return callResult(node, sources, seen);
    }
    if (ts.isNewExpression(node) && node.expression.getText() === 'Request') {
      return union(...node.arguments?.map(argument => value(argument, seen)) ?? []);
    }
    if (ts.isSpreadAssignment(node) || ts.isSpreadElement(node))
      return union(value(node.expression, seen), fieldOrigins(node.expression));
    const children: Set<string>[] = [];
    node.forEachChild(child => { children.push(value(child, seen)); });
    return union(...children);
  };
  let changed = true;
  let rounds = 0;
  const add = (target: TypeSymbol | undefined, sources: Set<string>) => {
    if (!target || !sources.size) return;
    const prior = origins.get(target) ?? new Set();
    for (const source of sources) if (!prior.has(source)) { prior.add(source); changed = true; }
    origins.set(target, prior);
  };
  // Each iteration only adds a SELECT or parameter/field origin to finite
  // symbol summaries. Bounded field paths keep recursive helpers finite.
  while (changed) {
    rounds++;
    changed = false;
    for (const node of nodes) {
      if (ts.isVariableDeclaration(node) && node.initializer && ts.isIdentifier(node.name)) {
        // Object properties retain their own symbols instead of contaminating
        // every method of a harness that also exposes a storage assertion.
        if (!ts.isObjectLiteralExpression(node.initializer)) add(symbol(node.name), value(node.initializer));
      } else if (ts.isVariableDeclaration(node) && node.initializer
        && (ts.isObjectBindingPattern(node.name) || ts.isArrayBindingPattern(node.name))) {
        for (const element of node.name.elements) if (ts.isBindingElement(element) && element.name
          && ts.isIdentifier(element.name)) add(symbol(element.name), union(value(node.initializer), fieldOrigins(node.initializer,
            ts.isObjectBindingPattern(node.name) && !element.dotDotDotToken ? (element.propertyName ?? element.name).getText() : undefined)));
      } else if (ts.isPropertyAssignment(node)) {
        add(symbol(node.name), value(node.initializer));
      } else if (ts.isShorthandPropertyAssignment(node)) {
        add(symbol(node.name), value(node));
      } else if (ts.isBindingElement(node)) {
        const pattern = node.parent;
        const declaration = pattern.parent;
        if (ts.isVariableDeclaration(declaration) && node.name && ts.isIdentifier(node.name)) {
          add(symbol(node.name), union(value(declaration.initializer), fieldOrigins(declaration.initializer,
            ts.isObjectBindingPattern(pattern) && !node.dotDotDotToken ? (node.propertyName ?? node.name).getText() : undefined)));
        }
      } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        add(symbol(node.left), value(node.right));
      }
      if (isFunction(node)) {
        const sources = new Set<string>();
        for (const expression of returnExpressions.get(node) ?? [])
          for (const source of value(expression)) sources.add(source);
        const prior = functions.get(node) ?? new Set();
        for (const source of sources) if (!prior.has(source)) { prior.add(source); changed = true; }
        functions.set(node, prior);
        if ('name' in node && node.name) add(symbol(node.name), prior);
      }
    }
  }
  const argumentValue = (node: ts.Node): Set<string> => {
    const sources = value(node);
    if (ts.isConditionalExpression(node)) return union(sources, argumentValue(node.whenTrue), argumentValue(node.whenFalse));
    // Calls contribute their returned value, never their callee or unrelated
    // inputs. Encoders consume whole objects, so inspect only their arguments.
    if (ts.isCallExpression(node)) {
      if (isTransform(node)) for (const argument of node.arguments)
        for (const source of argumentValue(argument)) sources.add(source);
      const declaration = declarationOf(node);
      const objects = declaration && isFunction(declaration) ? objectReturns.get(declaration) : undefined;
      for (const source of callResult(node, union(...objects?.map(expression => value(expression)) ?? []), new Set())) sources.add(source);
      return sources;
    }
    if (ts.isPropertyAccessExpression(node)) return sources;
    // Whole object arguments carry their tainted fields; object receivers remain
    // field-specific so an assertion helper cannot contaminate its sibling APIs.
    if (ts.isIdentifier(node)) {
      for (const source of fieldOrigins(node)) sources.add(source);
      const initializer = initializers.get(symbol(node)!);
      if (initializer && ts.isObjectLiteralExpression(initializer)) {
        for (const property of initializer.properties) for (const source of value(property)) sources.add(source);
      }
    } else node.forEachChild(child => { for (const source of argumentValue(child)) sources.add(source); });
    return sources;
  };
  const sourceNames = new Set(sourceCalls.values());
  const requestOrigins = (sources: ReadonlySet<string>, seen = new Set<string>()): Set<string> => {
    const result = new Set<string>();
    for (const source of sources) {
      if (seen.has(source)) continue;
      seen.add(source);
      if (sourceNames.has(source)) result.add(source);
      else {
        const [token, ...path] = source.split('\0');
        const inputs = union(...parameterArguments.get(token!)?.map(argument => path.length
          ? selectedOrigins(argument, path) : argumentValue(argument)) ?? []);
        for (const origin of requestOrigins(inputs, seen)) result.add(origin);
      }
    }
    return result;
  };
  const flows = requests.flatMap(request => [...requestOrigins(union(...request.arguments?.map(argumentValue) ?? []))]
    .map(source => ({ source, request: location(request) })));
  if (process.env.SQL_REQUEST_FLOW_PROFILE === '1')
    process.stderr.write(`SQL flow propagation: ${files.length} files, ${nodes.length} nodes, ${rounds} rounds\n`);
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
    const started = performance.now();
    const project = api.updateSnapshot({ openProjects: [config] }).getProject(config)!;
    const files = input.paths.map(path => project.program.getSourceFile(path)!);
    const compiled = performance.now();
    const result = sqlRequestFlows(project, files);
    if (process.env.SQL_REQUEST_FLOW_PROFILE === '1') process.stderr.write(`SQL flow timing (ms): compile=${Math.round(compiled - started)}, scan=${Math.round(performance.now() - compiled)}\n`);
    process.stdout.write(JSON.stringify(result));
  } finally { api.close(); }
}
