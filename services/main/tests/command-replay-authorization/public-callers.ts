import { join, relative } from 'node:path';
import ts from 'typescript-6';

export function discoverPublicSavedResults(root: string) {
  const files = [...new Bun.Glob('services/main/src/**/*.ts').scanSync({ cwd: root, absolute: true })];
  const program = ts.createProgram(files, { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.Preserve,
    moduleResolution: ts.ModuleResolutionKind.Bundler, allowImportingTsExtensions: true, skipLibCheck: true });
  const checker = program.getTypeChecker();
  const functionLike = (node: ts.Node): node is ts.FunctionLikeDeclaration =>
    ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isArrowFunction(node)
      || ts.isFunctionExpression(node);
  const label = (node: ts.Node) => {
    const name = 'name' in node && node.name && ts.isIdentifier(node.name as ts.Node)
      ? (node.name as ts.Identifier).text : '<handler>';
    const owner = ts.isClassDeclaration(node.parent) ? `${node.parent.name?.text}.` : '';
    return `${relative(join(root, 'services/main/src'), node.getSourceFile().fileName)}#${owner}${name}`;
  };
  const descend = (node: ts.Node, visit: (node: ts.Node) => void) => {
    visit(node);
    ts.forEachChild(node, child => descend(child, visit));
  };
  const edgeCache = new Map<ts.FunctionLikeDeclaration, Set<ts.FunctionLikeDeclaration>>();
  const edges = (node: ts.FunctionLikeDeclaration) => {
    const cached = edgeCache.get(node);
    if (cached) return cached;
    const targets = new Set<ts.FunctionLikeDeclaration>();
    if (node.body) descend(node.body, child => {
      if (!ts.isCallExpression(child)) return;
      const declaration = checker.getResolvedSignature(child)?.declaration;
      if (declaration && functionLike(declaration) && declaration.body
        && declaration.getSourceFile().fileName.startsWith(join(root, 'services/main/src/'))) targets.add(declaration);
      let symbol = checker.getSymbolAtLocation(ts.isPropertyAccessExpression(child.expression)
        ? child.expression.name : child.expression);
      if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
      for (const declared of symbol?.declarations ?? []) {
        const candidate = ts.isVariableDeclaration(declared) ? declared.initializer : declared;
        if (candidate && functionLike(candidate) && candidate.body) targets.add(candidate);
      }
    });
    edgeCache.set(node, targets);
    return targets;
  };
  const savedCache = new Map<ts.FunctionLikeDeclaration, boolean>();
  const savedResult = (node: ts.FunctionLikeDeclaration) => {
    const cached = savedCache.get(node);
    if (cached !== undefined) return cached;
    let saved = false;
    if (node.body) descend(node.body, child => {
      if (ts.isPropertyAssignment(child) && child.name.getText() === 'replayed'
        && child.initializer.kind === ts.SyntaxKind.TrueKeyword) saved = true;
      if (ts.isCallExpression(child)) {
        const declaration = checker.getResolvedSignature(child)?.declaration;
        child.arguments.forEach((arg, index) => {
          if (arg.kind === ts.SyntaxKind.TrueKeyword
            && declaration?.parameters[index]?.name.getText() === 'replayed') saved = true;
        });
      }
    });
    savedCache.set(node, saved);
    return saved;
  };
  const inventory: { operation: string; caller: string; paths: string[][] }[] = [];
  for (const source of program.getSourceFiles().filter(file => file.fileName.startsWith(join(root, 'services/main/src/routes/')))) {
    // Contract declarations supply exposure independently of route traversal.
    const contracts = new Map<string, string>();
    const normalize = (path: string) => path.replace(/:[^/]+|\{[^}]+\}/g, '{}');
    const inspect = (node: ts.Node) => {
      if (ts.isPropertyAssignment(node) && ts.isStringLiteral(node.name) && node.name.text.startsWith('/v1/')
        && ts.isObjectLiteralExpression(node.initializer)) {
        for (const method of node.initializer.properties) if (ts.isPropertyAssignment(method)
          && ts.isObjectLiteralExpression(method.initializer)) {
          const exposure = method.initializer.properties.find(prop => ts.isPropertyAssignment(prop)
            && prop.name.getText() === 'exposure');
          if (exposure && ts.isPropertyAssignment(exposure) && ts.isStringLiteral(exposure.initializer)) {
            contracts.set(`${method.name.getText().toUpperCase()} ${normalize(node.name.text)}`, exposure.initializer.text);
          }
        }
      }
      ts.forEachChild(node, inspect);
    };
    inspect(source);
    const routes = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && ['post', 'put', 'patch', 'delete'].includes(node.expression.name.text)
        && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
        const operation = `${node.expression.name.text.toUpperCase()} ${normalize(node.arguments[0].text)}`;
        if (contracts.get(operation) === 'public') {
          const handler = node.arguments.find(arg => functionLike(arg));
          if (handler && functionLike(handler)) {
            const paths: string[][] = [];
            const visited = new Set<ts.Node>();
            const walk = (current: ts.FunctionLikeDeclaration, path: string[]) => {
              if (visited.has(current)) return;
              visited.add(current);
              const next = [...path, label(current)];
              if (savedResult(current)) paths.push(next);
              for (const target of edges(current)) walk(target, next);
            };
            walk(handler, []);
            if (paths.length) inventory.push({ operation, caller: relative(root, source.fileName), paths });
          }
        }
      }
      ts.forEachChild(node, routes);
    };
    routes(source);
  }
  return inventory;
}
