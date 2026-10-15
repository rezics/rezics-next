import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import ts from 'typescript-6';
import { buildMainOpenApi } from './generate.ts';
import { buildOperationIndex } from './operation-index.ts';
import { rateLimitFamily } from '../../services/main/src/modules/rate-limit/budgets.ts';

interface Evidence { status: number; code?: string; line: number }
export interface HandlerFacts {
  responses: Evidence[];
  rawConstructors: number;
  sharedRawHelpers: string[];
  dynamicStatuses: string[];
  calls: string[];
}

function walk(node: ts.Node, visit: (node: ts.Node) => void) {
  visit(node);
  ts.forEachChild(node, child => walk(child, visit));
}

function property(node: ts.Node | undefined, key: string): ts.Expression | undefined {
  if (!node || !ts.isObjectLiteralExpression(node)) return;
  for (const item of node.properties) {
    if (ts.isPropertyAssignment(item) && item.name.getText().replace(/['"]/g, '') === key) return item.initializer;
  }
}

function numbers(node: ts.Expression | undefined): number[] {
  if (!node) return [];
  if (ts.isNumericLiteral(node)) return [Number(node.text)];
  if (ts.isParenthesizedExpression(node)) return numbers(node.expression);
  if (ts.isConditionalExpression(node)) return [...numbers(node.whenTrue), ...numbers(node.whenFalse)];
  return [];
}

/** A syntactic lower bound, not a claim to solve domain reachability. Follows
 * same-file helper calls; imported domain calls and dynamic statuses stay explicit. */
export function inspectHandler(source: string, line: number, followLocal = true): HandlerFacts | undefined {
  const file = ts.createSourceFile('routes.ts', source, ts.ScriptTarget.Latest, true);
  const helpers = new Map<string, ts.Node>();
  const constants = new Map<string, ts.Expression>();
  let handler: ts.Node | undefined;
  walk(file, node => {
    if (ts.isFunctionDeclaration(node) && node.name) helpers.set(node.name.text, node);
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) constants.set(node.name.text, node.initializer);
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
      && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
      helpers.set(node.name.text, node.initializer);
    }
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return;
    if (!/^(get|post|put|patch|delete|head|options|all|ws|route)$/.test(node.expression.name.text)) return;
    if (file.getLineAndCharacterOfPosition(node.expression.name.getStart(file)).line + 1 !== line) return;
    handler = [...node.arguments].reverse().find(arg => ts.isArrowFunction(arg) || ts.isFunctionExpression(arg));
    if (!handler) {
      const candidate = node.arguments.at(-1);
      if (candidate && ts.isIdentifier(candidate)) handler = helpers.get(candidate.text);
      if (candidate && ts.isCallExpression(candidate)) handler = candidate;
    }
  });
  if (!handler) return;
  const result: HandlerFacts = { responses: [], rawConstructors: 0, sharedRawHelpers: [], dynamicStatuses: [], calls: [] };
  const seen = new Set<ts.Node>();
  const scan = (root: ts.Node) => {
    if (seen.has(root)) return;
    seen.add(root);
    walk(root, node => {
      const record = (expression: ts.Expression | undefined, code?: ts.Expression, fallback?: number) => {
        const values = expression ? numbers(expression) : fallback ? [fallback] : [];
        if (!values.length) result.dynamicStatuses.push(expression?.getText(file) ?? '(unknown)');
        for (const status of values) result.responses.push({ status,
          ...(code && ts.isStringLiteral(code) ? { code: code.text } : {}),
          line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1 });
      };
      const responseStatus = (init: ts.Expression | undefined) => {
        let value = init;
        const visited = new Set<string>();
        while (value && ts.isIdentifier(value) && constants.has(value.text) && !visited.has(value.text)) {
          visited.add(value.text);
          value = constants.get(value.text);
        }
        if (!value || ts.isObjectLiteralExpression(value)) record(property(value, 'status'), undefined, 200);
        else result.dynamicStatuses.push(`ResponseInit: ${value.getText(file)}`);
      };
      if (ts.isNewExpression(node) && node.expression.getText(file) === 'Response') {
        result.rawConstructors++;
        responseStatus(node.arguments?.[1]);
      }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
        && node.left.getText(file) === 'set.status') record(node.right);
      if (!ts.isCallExpression(node)) return;
      const name = node.expression.getText(file);
      result.calls.push(name);
      if (name === 'problem') {
        result.sharedRawHelpers.push(name);
        record(node.arguments[0], node.arguments[1]);
      } else if (name === 'status') record(node.arguments[0]);
      else if (name === 'Response.json' || name === 'Response.redirect') {
        result.rawConstructors++;
        if (name === 'Response.redirect') record(node.arguments[1], undefined, 302);
        else responseStatus(node.arguments[1]);
      } else if (['commandError', 'typedRefusal', 'workReadError'].includes(name)) result.sharedRawHelpers.push(name);
      if (followLocal && helpers.has(name)) scan(helpers.get(name)!);
    });
  };
  scan(handler);
  result.sharedRawHelpers = [...new Set(result.sharedRawHelpers)].sort();
  result.dynamicStatuses = [...new Set(result.dynamicStatuses)].sort();
  result.calls = [...new Set(result.calls)].sort();
  result.responses = [...new Map(result.responses.map(value => [JSON.stringify(value), value])).values()];
  return result;
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
function canonical(value: Json): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key]!)}`).join(',')}}`;
  return JSON.stringify(value);
}

export function schemaCodeKind(schema: Json | undefined): 'string' | 'literal' | 'absent' {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return 'absent';
  const properties = schema.properties;
  if (properties && typeof properties === 'object' && !Array.isArray(properties)) {
    const code = properties.code;
    if (code && typeof code === 'object' && !Array.isArray(code)) {
      if (typeof code.const === 'string' || Array.isArray(code.enum)) return 'literal';
      if (code.type === 'string') return 'string';
    }
  }
  for (const key of ['anyOf', 'oneOf', 'allOf']) {
    const variants = schema[key];
    if (!Array.isArray(variants)) continue;
    const kinds = variants.map(schemaCodeKind);
    if (kinds.includes('string')) return 'string';
    if (kinds.includes('literal')) return 'literal';
  }
  return 'absent';
}

export async function auditBoundary(root: string) {
  const output = join(root, '.temp/api-boundary');
  mkdirSync(output, { recursive: true });
  const openApiText = await buildMainOpenApi();
  writeFileSync(join(output, 'openapi.json'), openApiText);
  const document = JSON.parse(openApiText) as { paths: Record<string, Record<string, {
    responses?: Record<string, { content?: Record<string, { schema?: Json }> }>;
  }>> };
  const index = await buildOperationIndex(root);
  const groups = new Map<string, number>();
  const codeKinds = { string: 0, literal: 0, absent: 0 };
  let errorSchemas = 0;
  for (const methods of Object.values(document.paths)) for (const operation of Object.values(methods)) {
    for (const [status, response] of Object.entries(operation.responses ?? {})) {
      if (Number(status) < 400) continue;
      const schema = response.content?.['application/problem+json']?.schema;
      errorSchemas++;
      codeKinds[schemaCodeKind(schema)]++;
      if (schema) groups.set(canonical(schema), (groups.get(canonical(schema)) ?? 0) + 1);
    }
  }
  const operations = index.map(operation => {
    const source = readFileSync(join(root, operation.routeFile), 'utf8');
    const direct = inspectHandler(source, operation.handlerLine, false);
    const facts = inspectHandler(source, operation.handlerLine);
    const declared = document.paths[operation.path]?.[operation.method.toLowerCase()]?.responses;
    return { ...operation, testFiles: undefined, declared: declared ? Object.keys(declared).map(Number) : [], direct, facts,
      directGaps: direct?.responses.filter(response => declared && !declared[String(response.status)]) ?? [],
      gaps: facts?.responses.filter(response => declared && !declared[String(response.status)]) ?? [] };
  });
  const histogram = (values: string[]) => Object.fromEntries([...new Set(values)].sort().map(value => [value, values.filter(item => item === value).length]));
  const summary = {
    indexedOperations: operations.length,
    documentedOperations: Object.values(document.paths).reduce((count, methods) => count + Object.keys(methods).length, 0),
    paths: Object.keys(document.paths).length,
    analyzed: operations.filter(operation => operation.facts).length,
    missingHandlers: operations.filter(operation => !operation.facts).map(operation => operation.operationId),
    undocumented: operations.filter(operation => operation.declared.length === 0).map(operation => `${operation.method} ${operation.path}`),
    directRawConstructors: operations.filter(operation => operation.direct && operation.direct.rawConstructors > 0).length,
    localRawConstructors: operations.filter(operation => operation.facts && operation.facts.rawConstructors > 0).length,
    rawOrProblemHelpers: operations.filter(operation => operation.facts && (operation.facts.rawConstructors > 0 || operation.facts.sharedRawHelpers.length > 0)).length,
    documentedRaw: operations.filter(operation => operation.declared.length > 0 && operation.facts
      && (operation.facts.rawConstructors > 0 || operation.facts.sharedRawHelpers.length > 0)).length,
    documentedWithoutRawEvidence: operations.filter(operation => operation.declared.length > 0 && operation.facts
      && operation.facts.rawConstructors === 0 && operation.facts.sharedRawHelpers.length === 0).map(operation => `${operation.method} ${operation.path}`),
    gapOperations: operations.filter(operation => operation.gaps.length > 0).length,
    directGapOperations: operations.filter(operation => operation.directGaps.length > 0).length,
    directGapPairs: operations.reduce((count, operation) => count + new Set(operation.directGaps.map(gap => gap.status)).size, 0),
    directGapDetails: operations.filter(operation => operation.directGaps.length > 0).map(operation => ({
      route: `${operation.method} ${operation.path}`, file: operation.routeFile, gaps: operation.directGaps,
    })),
    gapPairs: operations.reduce((count, operation) => count + new Set(operation.gaps.map(gap => gap.status)).size, 0),
    dynamicStatusOperations: operations.filter(operation => operation.facts && operation.facts.dynamicStatuses.length > 0).length,
    errorSchemas, codeKinds, uniqueErrorSchemas: groups.size,
    repeatedErrorSchemaUses: [...groups.values()].reduce((count, uses) => count + Math.max(0, uses - 1), 0),
    schemaGroupSizes: [...groups.values()].sort((a, b) => b - a),
    exposure: histogram(operations.map(operation => operation.exposure)),
    bearer: histogram(operations.map(operation => operation.bearer)),
    rateLimit: histogram(operations.map(operation => operation.rateLimitFamily)),
    idempotency: operations.filter(operation => operation.idempotencyKey).length,
    declared202: operations.filter(operation => operation.declared.includes(202)).length,
    local202: operations.filter(operation => operation.facts?.responses.some(response => response.status === 202)).length,
    commandError: operations.filter(operation => operation.facts?.calls.includes('commandError')).length,
    verify: operations.filter(operation => operation.facts?.calls.some(call => /\.(verify|resolve)\b/.test(call))).length,
    missingHookStatuses: Object.fromEntries([400, 401, 429, 500, 503].map(status => [status,
      operations.filter(operation => operation.declared.length > 0 && !operation.declared.includes(status)).length])),
    rateLimitedDocumented: operations.filter(operation => operation.declared.length > 0
      && rateLimitFamily(operation.method, operation.path.replace(/\{[^}]+\}/g, 'example')) != null).length,
    limitedMissingHookStatuses: Object.fromEntries([401, 429, 503].map(status => [status,
      operations.filter(operation => operation.declared.length > 0 && !operation.declared.includes(status)
        && rateLimitFamily(operation.method, operation.path.replace(/\{[^}]+\}/g, 'example')) != null).length])),
    localGapGroups: [...new Set(operations.filter(operation => operation.gaps.length > 0).map(operation => operation.routeFile))].sort().map(file => ({
      file, operations: operations.filter(operation => operation.routeFile === file && operation.gaps.length > 0).length,
      statuses: [...new Set(operations.filter(operation => operation.routeFile === file).flatMap(operation => operation.gaps.map(gap => gap.status)))].sort((a, b) => a - b),
    })),
    nonBroadErrors: Object.entries(document.paths).flatMap(([path, methods]) => Object.entries(methods).flatMap(([method, operation]) =>
      Object.entries(operation.responses ?? {}).flatMap(([status, response]) => {
        const kind = schemaCodeKind(response.content?.['application/problem+json']?.schema);
        return Number(status) >= 400 && kind !== 'string' ? [{ method, path, status, kind }] : [];
      }))),
    openApiBytes: Buffer.byteLength(openApiText),
  };
  writeFileSync(join(output, 'inventory.json'), JSON.stringify({ summary, operations }, null, 2) + '\n');
  return summary;
}

/** Sequential runs avoid competing compilers. Logs retain failures and full native
 * extendedDiagnostics; declaration emit is a serialization-size experiment. */
async function diagnostics(root: string, baselineOnly = false) {
  const output = join(root, '.temp/api-boundary');
  mkdirSync(output, { recursive: true });
  const runs: Record<string, { exit: number; wallSeconds: number }> = {};
  writeFileSync(join(output, 'tsconfig-literals.json'), JSON.stringify({
    extends: '../../services/main/tsconfig.json', files: ['../../scripts/api/boundary-contract.types.ts'], include: [], exclude: [],
  }));
  writeFileSync(join(output, 'tsconfig-app.json'), JSON.stringify({
    extends: '../../services/main/tsconfig.json', files: ['../../scripts/api/boundary-app.types.ts'], include: [], exclude: [],
  }));
  const projects = baselineOnly ? [['app', '.temp/api-boundary/tsconfig-app.json']] :
    [['main', 'services/main/tsconfig.json'], ['web', 'apps/web/tsconfig.json'], ['eden', 'tests/qa/client/tsconfig.json'],
      ['literals', '.temp/api-boundary/tsconfig-literals.json'], ['app', '.temp/api-boundary/tsconfig-app.json']];
  for (const [name, project] of projects) {
    const start = performance.now();
    const child = Bun.spawn(['bun', 'node_modules/typescript/bin/tsc', '-p', project, '--extendedDiagnostics', '--pretty', 'false'],
      { cwd: root, stdout: Bun.file(join(output, `${name}-tsc.log`)), stderr: 'inherit' });
    runs[name] = { exit: await child.exited, wallSeconds: (performance.now() - start) / 1000 };
  }
  if (baselineOnly) {
    writeFileSync(join(output, 'app-diagnostics.json'), JSON.stringify(runs, null, 2) + '\n');
    console.log(JSON.stringify(runs, null, 2));
    return;
  }
  writeFileSync(join(output, 'tsconfig-declaration.json'), JSON.stringify({
    extends: '../../services/main/tsconfig.json',
    compilerOptions: { noEmit: false, declaration: true, emitDeclarationOnly: true, rootDir: '../..', outDir: './declarations' },
    files: ['../../services/main/src/app.ts'], include: [], exclude: [],
  }));
  const start = performance.now();
  const child = Bun.spawn(['bun', 'node_modules/typescript/bin/tsc', '-p', '.temp/api-boundary/tsconfig-declaration.json', '--extendedDiagnostics', '--pretty', 'false'],
    { cwd: root, stdout: Bun.file(join(output, 'declaration-tsc.log')), stderr: 'inherit' });
  runs.declaration = { exit: await child.exited, wallSeconds: (performance.now() - start) / 1000 };
  mkdirSync(join(output, 'declarations'), { recursive: true });
  const declarations = [...new Bun.Glob('**/app.d.ts').scanSync({ cwd: join(output, 'declarations') })];
  const sizes = declarations.map(file => ({ file, bytes: Buffer.byteLength(readFileSync(join(output, 'declarations', file))) }));
  const result = { runs, sizes, versions: { bun: Bun.version,
    typescript: JSON.parse(readFileSync(join(root, 'node_modules/typescript/package.json'), 'utf8')).version as string } };
  writeFileSync(join(output, 'diagnostics.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
}

async function typeSize(root: string) {
  const { API } = await import('typescript/unstable/async');
  const api = new API({ cwd: root });
  try {
    const projectPath = join(root, 'services/main/tsconfig.json');
    const snapshot = await api.updateSnapshot({ openProjects: [projectPath] });
    const project = snapshot.getProject(projectPath)!;
    const file = join(root, 'services/main/src/app.ts');
    const source = readFileSync(file, 'utf8');
    const app = (await project.checker.getTypeAtPosition(file, source.indexOf('MainApp =')))!;
    const property = (await project.checker.getPropertyOfType(app, '~Routes'))!;
    const routes = (await project.checker.getTypeOfSymbol(property))!;
    const flags = ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.InTypeAlias;
    const rendered = await project.checker.typeToString(app, undefined, flags);
    const renderedRoutes = await project.checker.typeToString(routes, undefined, flags);
    const output = join(root, '.temp/api-boundary');
    mkdirSync(output, { recursive: true });
    writeFileSync(join(output, 'MainApp.type.txt'), rendered);
    writeFileSync(join(output, 'MainApp-routes.type.txt'), renderedRoutes);
    const result = { appBytes: Buffer.byteLength(rendered), routesBytes: Buffer.byteLength(renderedRoutes),
      appEllipses: rendered.split('...').length - 1, routesEllipses: renderedRoutes.split('...').length - 1 };
    writeFileSync(join(output, 'type-size.json'), JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify(result, null, 2));
  } finally { await api.close(); }
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, '../..');
  if (Bun.argv.includes('--diagnostics')) await diagnostics(root);
  else if (Bun.argv.includes('--eden-baseline')) await diagnostics(root, true);
  else if (Bun.argv.includes('--type-size')) await typeSize(root);
  else console.log(JSON.stringify(await auditBoundary(root), null, 2));
}
