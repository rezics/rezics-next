import { join, relative } from 'node:path';
import ts from 'typescript-6';
import type { NonReplayEntry, AnyReplayEntry } from './authority-classes.ts';

export interface ReplayArea {
  moduleOwners: string[];
  replayEntries: AnyReplayEntry[];
  coveredOperations: string[];
  uncoveredOperations: string[];
  nonReplayEntries?: NonReplayEntry[];
}

export interface PublicCommand {
  operation: string;
  caller: string;
  paths: string[][];
  reachableOwners: string[];
  idempotencyKey: boolean;
}

export function discoverPublicCommands(root: string) {
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
  const inventory: PublicCommand[] = [];
  for (const source of program.getSourceFiles().filter(file => file.fileName.startsWith(join(root, 'services/main/src/routes/')))) {
    // Contract declarations supply exposure independently of route traversal.
    const contracts = new Map<string, { exposure: string; idempotencyKey: boolean }>();
    const normalize = (path: string) => path.replace(/:[^/]+|\{[^}]+\}/g, '{}');
    const inspect = (node: ts.Node) => {
      if (ts.isPropertyAssignment(node) && ts.isStringLiteral(node.name) && node.name.text.startsWith('/v1/')
        && ts.isObjectLiteralExpression(node.initializer)) {
        for (const method of node.initializer.properties) if (ts.isPropertyAssignment(method)
          && ts.isObjectLiteralExpression(method.initializer)) {
          const exposure = method.initializer.properties.find(prop => ts.isPropertyAssignment(prop)
            && prop.name.getText() === 'exposure');
          if (exposure && ts.isPropertyAssignment(exposure) && ts.isStringLiteral(exposure.initializer)) {
            const key = method.initializer.properties.find(prop => ts.isPropertyAssignment(prop)
              && prop.name.getText() === 'idempotencyKey');
            contracts.set(`${method.name.getText().toUpperCase()} ${normalize(node.name.text)}`, {
              exposure: exposure.initializer.text,
              idempotencyKey: !!key && ts.isPropertyAssignment(key) && key.initializer.kind !== ts.SyntaxKind.FalseKeyword,
            });
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
        const contract = contracts.get(operation);
        if (contract?.exposure === 'public') {
          const handler = node.arguments.find(arg => functionLike(arg));
          const factory = node.arguments.at(-1);
          const callbacks = factory && ts.isCallExpression(factory)
            ? factory.arguments.flatMap(arg => functionLike(arg) ? [arg] : []) : [];
          if (handler && functionLike(handler) || callbacks.length) {
            const paths: string[][] = [];
            const reachableOwners: string[] = [];
            const visited = new Set<ts.Node>();
            const walk = (current: ts.FunctionLikeDeclaration, path: string[]) => {
              if (visited.has(current)) return;
              visited.add(current);
              const next = [...path, label(current)];
              reachableOwners.push(label(current));
              if (savedResult(current)) paths.push(next);
              for (const target of edges(current)) walk(target, next);
            };
            if (handler && functionLike(handler)) walk(handler, []);
            else {
              // Factory callbacks establish owner reachability; the tracer cannot
              // prove that the returned handler invokes each saved-result branch.
              for (const callback of callbacks) walk(callback, []);
              paths.length = 0;
            }
            inventory.push({ operation, caller: relative(root, source.fileName), paths, reachableOwners,
              idempotencyKey: contract.idempotencyKey });
          } else inventory.push({ operation, caller: relative(root, source.fileName), paths: [], reachableOwners: [],
            idempotencyKey: contract.idempotencyKey });
        }
      }
      ts.forEachChild(node, routes);
    };
    routes(source);
  }
  return inventory;
}

export const discoverPublicSavedResults = (root: string) => discoverPublicCommands(root).filter(command => command.paths.length);

export function commandCoverage(commands: PublicCommand[], areas: ReplayArea[], uncoveredLimit: number) {
  const covered = areas.flatMap(area => area.coveredOperations);
  const uncovered = areas.flatMap(area => area.uncoveredOperations);
  const replay = areas.flatMap(area => area.replayEntries);
  const nonReplayEntries = areas.flatMap(area => area.nonReplayEntries ?? []);
  const nonReplay = nonReplayEntries.map(entry => entry.operation);
  const classified = [...covered, ...nonReplay, ...uncovered];
  const require = (condition: boolean, message: string) => { if (!condition) throw new Error(message); };
  require(new Set(classified).size === classified.length, 'A command must have exactly one coverage classification');
  require(uncovered.length <= uncoveredLimit, `Uncovered command count ${uncovered.length} exceeds baseline ${uncoveredLimit}`);
  // Partial witnesses remain uncovered until every applicable owner path executes.
  for (const entry of replay) require(covered.includes(entry.operation) || uncovered.includes(entry.operation), `Replay entry outside covered operations: ${entry.operation}`);
  for (const operation of covered) require(replay.some(entry => entry.operation === operation), `Covered command has no replay entry: ${operation}`);
  // Executed entries also cover owners whose receipt helper the static tracer cannot follow.
  const inventory = commands.filter(command => command.paths.length || covered.includes(command.operation) || nonReplay.includes(command.operation));
  for (const command of inventory) {
    require(classified.includes(command.operation), `Unclassified command: ${command.operation}`);
    if (covered.includes(command.operation)) {
      const owners = replay.filter(entry => entry.operation === command.operation).flatMap(entry => entry.owners);
      require(command.paths.every(path => path.some(owner => owners.includes(owner))), `Missing replay owner: ${command.operation}`);
    }
  }
  // Executed replay witnesses predate discovery and may use opaque route adapters.
  for (const operation of [...uncovered, ...nonReplay]) require(inventory.some(command => command.operation === operation), `Undiscovered command: ${operation}`);
  for (const entry of nonReplayEntries) {
    const command = commands.find(command => command.operation === entry.operation)!;
    require(entry.reason.trim().length > 0 && entry.subcases.length > 0, `Non-replay entry needs a reason and executable cases: ${entry.operation}`);
    require(!command.idempotencyKey, `Non-replay contract declares an idempotency key: ${entry.operation}`);
    require(command.paths.length === 0, `Non-replay command has a saved-result path: ${entry.operation}`);
    require(entry.owners.length > 0 && entry.owners.every(owner => command.reachableOwners.includes(owner)), `Missing non-replay owner: ${entry.operation}`);
  }
  return { covered, nonReplay, uncovered, inventory };
}
