import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildMainOpenApi } from './generate.ts';
import { buildOperationIndex } from './operation-index.ts';
import { rateLimitFamily } from '../../services/main/src/modules/rate-limit/budgets.ts';
import { inferenceTypeSize } from './inference-type-size.ts';

import { inspectHandler } from './handler-responses.ts';
export { inspectHandler, type HandlerFacts } from './handler-responses.ts';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
function canonical(value: Json): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key]!)}`).join(',')}}`;
  return JSON.stringify(value);
}

export function schemaCodeKind(schema: Json | undefined, models: Record<string, Json> = {}, seen = new Set<string>()): 'string' | 'literal' | 'absent' {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return 'absent';
  if (typeof schema.$ref === 'string') {
    if (!schema.$ref.startsWith('#/components/schemas/') || seen.has(schema.$ref)) return 'absent';
    return schemaCodeKind(models[schema.$ref.slice('#/components/schemas/'.length)], models, new Set([...seen, schema.$ref]));
  }
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
    const kinds = variants.map(variant => schemaCodeKind(variant, models, seen));
    if (kinds.includes('string')) return 'string';
    if (kinds.length > 0 && kinds.every(kind => kind === 'literal')) return 'literal';
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
  }>>; components?: { schemas?: Record<string, Json> } };
  const models = document.components?.schemas ?? {};
  const index = await buildOperationIndex(root);
  const groups = new Map<string, number>();
  const codeKinds = { string: 0, literal: 0, absent: 0 };
  let errorSchemas = 0;
  for (const methods of Object.values(document.paths)) for (const operation of Object.values(methods)) {
    for (const [status, response] of Object.entries(operation.responses ?? {})) {
      if (Number(status) < 400) continue;
      const schema = response.content?.['application/problem+json']?.schema;
      errorSchemas++;
      codeKinds[schemaCodeKind(schema, models)]++;
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
        const kind = schemaCodeKind(response.content?.['application/problem+json']?.schema, models);
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
  const { appBytes, routesBytes, rendered, renderedRoutes } = await inferenceTypeSize(root, 'services/main/tsconfig.json');
  const output = join(root, '.temp/api-boundary');
  mkdirSync(output, { recursive: true });
  writeFileSync(join(output, 'MainApp.type.txt'), rendered);
  writeFileSync(join(output, 'MainApp-routes.type.txt'), renderedRoutes);
  const result = { appBytes, routesBytes,
    appEllipses: rendered.split('...').length - 1, routesEllipses: renderedRoutes.split('...').length - 1 };
  writeFileSync(join(output, 'type-size.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, '../..');
  if (Bun.argv.includes('--diagnostics')) await diagnostics(root);
  else if (Bun.argv.includes('--eden-baseline')) await diagnostics(root, true);
  else if (Bun.argv.includes('--type-size')) await typeSize(root);
  else console.log(JSON.stringify(await auditBoundary(root), null, 2));
}
