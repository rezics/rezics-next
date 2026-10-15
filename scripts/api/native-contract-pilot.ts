import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import ts from 'typescript-6';
import { buildMainOpenApi } from './generate.ts';
import { typecheck } from './native-contract-spike.ts';

export const pilotOperations = [
  ['get', '/v1/works/{id}', 'work-reads', 'work-header'],
  ['put', '/v1/me/acting-context-preferences/work.create', 'acting-contexts', 'acting-context-preference'],
  ['post', '/v1/works/{id}/scalar-value', 'works', 'work-scalar'],
] as const;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type ApiDocument = { paths: Record<string, Record<string, Record<string, Json>>>;
  components?: { schemas?: Record<string, Json> } };

/** Compare meaning rather than inline/reference representation or property order. */
export function normalized(value: Json, document: ApiDocument): Json {
  if (Array.isArray(value)) return value.map(item => normalized(item, document));
  if (value && typeof value === 'object') {
    if (typeof value.$ref === 'string' && value.$ref.startsWith('#/components/schemas/')) {
      const target = document.components?.schemas?.[value.$ref.slice('#/components/schemas/'.length)];
      if (!target) throw new Error(`Missing schema ${value.$ref}`);
      return normalized(target, document);
    }
    return Object.fromEntries(Object.keys(value).filter(key => key !== '$id').sort()
      .map(key => [key, normalized(value[key]!, document)]));
  }
  return value;
}

export function fingerprint(value: Json, document: ApiDocument) {
  return createHash('sha256').update(JSON.stringify(normalized(value, document))).digest('hex');
}

function routeLines(source: string, method: string, path: string, name: string) {
  const file = ts.createSourceFile('route.ts', source, ts.ScriptTarget.Latest, true);
  let lines = 0;
  let bindingLines = 0;
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === method
      && node.arguments[0] && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === path) {
      lines = file.getLineAndCharacterOfPosition(node.getEnd()).line
        - file.getLineAndCharacterOfPosition(node.expression.name.getStart(file)).line + 1;
    }
    if (ts.isCallExpression(node) && ts.isElementAccessExpression(node.expression)
      && node.expression.argumentExpression.getText(file) === `${name}.method`) {
      bindingLines = file.getLineAndCharacterOfPosition(node.getEnd()).line
        - file.getLineAndCharacterOfPosition(node.expression.argumentExpression.getStart(file)).line + 1;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return { inlineLines: lines, bindingLines };
}

export function operationMeasurements(directory: string) {
  return pilotOperations.map(([method, path, route, stem]) => {
    const source = readFileSync(join(directory, `${route}.ts`), 'utf8');
    const name = stem.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase()) + 'Operation';
    const declarations = ['contract', 'handler'].map(kind => {
      const file = `${stem}.${kind}.ts`;
      let source = '';
      try { source = readFileSync(join(directory, file), 'utf8'); } catch { /* before separation */ }
      const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
      return { file, lines: source.trim() ? source.trimEnd().split('\n').length : 0,
        declarations: ast.statements.filter(node => ts.isVariableStatement(node)
          || ts.isFunctionDeclaration(node) || ts.isTypeAliasDeclaration(node)).length };
    });
    return { method, path, ...routeLines(source, method, path.replace(/\{([^}]+)\}/g, ':$1'), name), declarations };
  });
}

export function invariantFingerprints(document: ApiDocument) {
  return pilotOperations.map(([method, path]) => {
    const operation = document.paths[path]![method]!;
    const responses = operation.responses as Record<string, Json>;
    const { responses: _, ...identity } = operation;
    return { method, path, identity: fingerprint(identity, document),
      success: Object.fromEntries(Object.entries(responses).filter(([status]) => Number(status) < 400)
        .map(([status, response]) => [status, fingerprint(response, document)])) };
  });
}

export async function capturePilot(directory: string) {
  mkdirSync(directory, { recursive: true });
  const openapi = await buildMainOpenApi();
  writeFileSync(join(directory, 'openapi.json'), openapi);
  for (const [, , route, stem] of pilotOperations) {
    const source = readFileSync(`services/main/src/routes/${route}.ts`, 'utf8');
    writeFileSync(join(directory, `${route}.ts`), source);
    for (const kind of ['contract', 'handler']) {
      const file = `${stem}.${kind}.ts`;
      writeFileSync(join(directory, file), readFileSync(`services/main/src/routes/${file}`));
    }
  }
  writeFileSync(join(directory, 'operations.json'), JSON.stringify(operationMeasurements(directory), null, 2) + '\n');
  writeFileSync(join(directory, 'invariants.json'), JSON.stringify(invariantFingerprints(JSON.parse(openapi)), null, 2) + '\n');
  for (const [name, project] of [['main', 'services/main/tsconfig.json'], ['eden', 'tests/qa/client/tsconfig.json']]) {
    const result = await typecheck(resolve(project!));
    writeFileSync(join(directory, `${name}.json`), JSON.stringify(result, null, 2) + '\n');
    if (result.exitCode) throw new Error(result.diagnostics);
  }
}

export function comparePilot(before: ApiDocument, after: ApiDocument) {
  const selected = new Set(pilotOperations.map(([method, path]) => `${method} ${path}`));
  const changes: { method: string; path: string; status: string; before?: Json; after?: Json }[] = [];
  if (JSON.stringify(invariantFingerprints(before)) !== JSON.stringify(invariantFingerprints(after))) {
    throw new Error('Pilot changed operation identity, request, policy, headers, media or success schema');
  }
  for (const [path, methods] of Object.entries(before.paths)) {
    for (const [method, operation] of Object.entries(methods)) {
      const next = after.paths[path]?.[method];
      if (!next) throw new Error(`Removed operation ${method} ${path}`);
      if (!selected.has(`${method} ${path}`)) {
        if (fingerprint(operation, before) !== fingerprint(next, after)) throw new Error(`Changed unrelated operation ${method} ${path}`);
        continue;
      }
      const oldResponses = operation.responses as Record<string, Json>;
      const newResponses = next.responses as Record<string, Json>;
      for (const status of new Set([...Object.keys(oldResponses), ...Object.keys(newResponses)])) {
        const oldValue = oldResponses[status];
        const newValue = newResponses[status];
        if (oldValue && !newValue) throw new Error(`Removed response ${method} ${path} ${status}`);
        if (JSON.stringify(oldValue && normalized(oldValue, before)) !== JSON.stringify(newValue && normalized(newValue, after))) {
          if (Number(status) < 400) throw new Error(`Changed success ${method} ${path} ${status}`);
          if (oldValue && newValue) assertProblemPrecision(normalized(oldValue, before), normalized(newValue, after));
          changes.push({ method, path, status,
            before: oldValue && normalized(oldValue, before), after: newValue && normalized(newValue, after) });
        }
      }
    }
  }
  if (Object.keys(before.paths).length !== Object.keys(after.paths).length) throw new Error('Changed path inventory');
  return changes;
}

/** Existing Problem members/headers/media cannot disappear or widen. A union
 * refines the old envelope only when every alternative does. */
export function assertProblemPrecision(before: Json, after: Json, path = ''): void {
  if (JSON.stringify(before) === JSON.stringify(after)) return;
  if (before && after && typeof before === 'object' && typeof after === 'object'
    && !Array.isArray(before) && !Array.isArray(after)) {
    if (Array.isArray(after.anyOf)) {
      for (const variant of after.anyOf) assertProblemPrecision(before, variant, path);
      return;
    }
    if (path.endsWith('/properties/code') && before.type === 'string' && typeof after.const === 'string') return;
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (!(key in before) || !(key in after)) throw new Error(`Changed Problem member ${path}/${key}`);
      assertProblemPrecision(before[key]!, after[key]!, `${path}/${key}`);
    }
    return;
  }
  throw new Error(`Changed Problem contract ${path}`);
}

/** One new same-status failure must flow from its owner into runtime, OpenAPI
 * and Eden without editing a route, a handler or the central mapper. */
export async function scratchDomainError(directory: string) {
  mkdirSync(directory, { recursive: true });
  const owner = 'services/main/src/modules/access/acting-context-problems.ts';
  const proof = 'services/main/tests/native-contract-pilot.test.ts';
  const originals = new Map([owner, proof].map(file => [file, readFileSync(file, 'utf8')]));
  for (const [file, source] of originals) writeFileSync(join(directory, file.replaceAll('/', '_')), source);
  const source = originals.get(owner)!
    .replace("import { problem }", "import { problem, t }")
    .replace('export const actingContextProblemSchemas', `export class PreferenceRepairRequired extends Error {}
export const preferenceRepairRequired = problemDefinition(409, 'preference_repair_required', 'Preference repair is required');

export const actingContextProblemSchemas`)
    .replace('409: actingContextStale.schema,', '409: t.Union([actingContextStale.schema, preferenceRepairRequired.schema]),')
    .replace('export function actingContextFailure(error: unknown) {', `export function actingContextFailure(error: unknown) {
  if (error instanceof PreferenceRepairRequired) return problem(preferenceRepairRequired.body);`);
  if (!source.includes('409: t.Union')) throw new Error('Scratch owner no longer matches; update the experiment');
  try {
    writeFileSync(owner, source);
    writeFileSync(proof, originals.get(proof)! + `
import { PreferenceRepairRequired } from '../src/modules/access/acting-context-problems.ts';
import { treaty as scratchTreaty } from '@elysia/eden';
type ScratchApp = ReturnType<typeof import('../src/routes/acting-contexts.ts').actingContextRoutes>;
const scratchClient = scratchTreaty<ScratchApp>('http://main.invalid');
type ScratchError = NonNullable<Awaited<ReturnType<typeof scratchClient.v1.me['acting-context-preferences']['work.create']['put']>>['error']>;
type ScratchCode = Extract<ScratchError, { status: 409 }>['value']['code'];
type ScratchAssert<T extends true> = T;
export type ScratchLiteralProof = ScratchAssert<
  ScratchCode extends 'stale_context' | 'preference_repair_required'
    ? 'stale_context' | 'preference_repair_required' extends ScratchCode ? true : false : false>;
test('a new domain-owned failure needs no route, handler or central mapping edit', async () => {
  const f = fixture();
  f.fault(new PreferenceRepairRequired());
  const response = await f.request(actingContextPreferenceOperation.path, 'PUT', preferenceBody);
  expect(response.status).toBe(409);
  expect(await response.json()).toHaveProperty('code', 'preference_repair_required');
  const document = JSON.parse(await buildMainOpenApi());
  expect(document.components.schemas.ActingContextPreferenceStale.anyOf
    .map((schema: { properties: { code: { const: string } } }) => schema.properties.code.const))
    .toEqual(['stale_context', 'preference_repair_required']);
});
`);
    const project = join(directory, 'tsconfig.json');
    writeFileSync(project, JSON.stringify({ extends: resolve('services/main/tsconfig.json'),
      files: [resolve(proof)], include: [], exclude: [] }));
    const types = await typecheck(resolve(project));
    if (types.exitCode) throw new Error(types.diagnostics);
    const child = Bun.spawn(['bun', 'scripts/goal/goalctl.ts', 'test', proof,
      'scripts/api/native-contract-pilot.test.ts', 'scripts/api/boundary-audit.test.ts'], { stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    const result = { changedFiles: [owner, proof], types, exitCode, qa: stdout.match(/# QA (\S+)/)?.[1] };
    writeFileSync(join(directory, 'result.json'), JSON.stringify(result, null, 2) + '\n');
    writeFileSync(join(directory, 'qa.log'), stdout + stderr);
    if (exitCode) throw new Error((stdout + stderr).slice(-2200));
    console.log(JSON.stringify(result));
  } finally {
    for (const [file, original] of originals) writeFileSync(file, original);
  }
}

if (import.meta.main) {
  const [action, directory, second] = Bun.argv.slice(2);
  if (!directory) throw new Error('capture <.temp/directory> | compare <before.json> <after.json> <output.json> | invariants <openapi.json> <output.json>');
  if (action === 'capture') await capturePilot(directory);
  else if (action === 'scratch') await scratchDomainError(directory);
  else if (action === 'lines') {
    writeFileSync(join(directory, 'operations.json'), JSON.stringify(operationMeasurements(directory), null, 2) + '\n');
  }
  else if (action === 'compare' && second) {
    const changes = comparePilot(JSON.parse(readFileSync(directory, 'utf8')), JSON.parse(readFileSync(second, 'utf8')));
    const output = Bun.argv[5] ?? '.temp/contract-pilot/openapi-diff.json';
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, JSON.stringify(changes, null, 2) + '\n');
    console.log(`${changes.length} changed error responses; identity, requests, success, unrelated operations preserved`);
  } else if (action === 'invariants' && second) {
    mkdirSync(dirname(second), { recursive: true });
    writeFileSync(second, JSON.stringify(invariantFingerprints(JSON.parse(readFileSync(directory, 'utf8'))), null, 2) + '\n');
  } else throw new Error('Unknown pilot action');
}
