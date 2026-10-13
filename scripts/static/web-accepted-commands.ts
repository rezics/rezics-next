import { relative, resolve } from 'node:path';
import ts from 'typescript-6';
import { commandSource, completesAdmission, resetCommandSources } from './web-accepted-commands-flow.ts';

export interface CommandOpenApi {
  paths: Record<string, Record<string, { responses?: Record<string, unknown> }>>;
}
export interface CommandInventory {
  path: string;
  completions: string[];
  operations: string[];
  reason?: string;
}
/** Ignore argument values, retaining the dynamic Eden route segment they select. */
function routeOf(expression: string, aliases: Map<string, string>, seen = new Set<string>()): string | null {
  const tokens: string[] = expression.match(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|[\w$-]+|[^\s]/g) ?? [];
  const start = tokens.indexOf('v1');
  if (start < 0) {
    const name = tokens[0] ?? '';
    if (seen.has(name) || !aliases.has(name)) return null;
    seen.add(name);
    const prefix = routeOf(aliases.get(name)!, aliases, seen);
    return prefix ? routeOf(`client.${prefix.slice(1).replaceAll('/', '.')}${expression.slice(name.length)}`, aliases, seen) : null;
  }
  const segments = ['v1'];
  for (let index = start + 1; index < tokens.length; index++) {
    const token = tokens[index];
    if (token === '.') { segments.push(tokens[++index]!); continue; }
    if (token === '[' && /^['"]/.test(tokens[index + 1] ?? '') && tokens[index + 2] === ']') {
      segments.push(tokens[index + 1]!.slice(1, -1)); index += 2; continue;
    }
    if (token === '(') {
      let depth = 1;
      while (++index < tokens.length && depth) {
        if (tokens[index] === '(') depth++;
        if (tokens[index] === ')') depth--;
      }
      index--;
      segments.push('*');
      continue;
    }
    return null;
  }
  return `/${segments.join('/')}`;
}

/** Local names in separate callbacks are distinct aliases, even when their spelling is the same. */
function routeAliases(call: ts.CallExpression): Map<string, string> {
  const aliases = new Map<string, string>();
  let scope: ts.Node | undefined = call.parent;
  while (scope) {
    if (ts.isBlock(scope) || ts.isSourceFile(scope)) {
      const visit = (node: ts.Node) => {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && !aliases.has(node.name.text))
          aliases.set(node.name.text, node.initializer.getText());
        if (ts.isFunctionLike(node) || ts.isBlock(node)) return;
        ts.forEachChild(node, visit);
      };
      ts.forEachChild(scope, visit);
    }
    scope = scope.parent;
  }
  return aliases;
}

interface Schema {
  const?: unknown; enum?: unknown[]; type?: string | string[];
  properties?: Record<string, Schema>; required?: string[]; anyOf?: Schema[]; oneOf?: Schema[];
}
function bodyOf(schema: Schema, partial: boolean): unknown {
  if ('const' in schema) return schema.const;
  if (schema.enum) return schema.enum.find(value => value === (partial ? 'partial' : 'accepted'))
    ?? schema.enum.find(value => typeof value === 'string' && value.includes('pending')) ?? schema.enum[0];
  const variants = schema.anyOf ?? schema.oneOf;
  if (variants) return bodyOf(variants[0]!, partial);
  if (schema.properties) return Object.fromEntries((schema.required ?? Object.keys(schema.properties))
    .map(key => [key, bodyOf(schema.properties![key] ?? {}, partial)]));
  if (schema.type === 'null') return null;
  if (schema.type === 'boolean') return false;
  if (schema.type === 'number' || schema.type === 'integer') return 1;
  if (schema.type === 'array') return [];
  return 'declared-value';
}
/** The declaration supplies discriminants: accepted/partial receipt bodies are also still pending. */
function admittedBodies(response: unknown): unknown[] | null {
  const schema = (response as { content?: { 'application/json'?: { schema?: Schema } } } | undefined)
    ?.content?.['application/json']?.schema;
  if (!schema) return null;
  const variants = schema.anyOf ?? schema.oneOf ?? [schema];
  return variants.flatMap(variant => [bodyOf(variant, false), bodyOf(variant, true)]);
}

/** Declared 202 calls are checked independently; unrelated edits need no admission review. */
export function commandInventory(root: string, api: CommandOpenApi,
  directory = 'apps/web'): CommandInventory[] {
  const production = (path: string) => !/\.(?:test|stories)\./.test(path) && !/(?:^|[-/])fixtures\.tsx?$/.test(path)
    && !path.includes('/tests/');
  resetCommandSources();
  const files = new Bun.Glob('**/*.{ts,tsx}').scanSync({ cwd: resolve(root, directory), absolute: true });
  const inventory: CommandInventory[] = [];
  for (const file of files) {
    const path = relative(root, file);
    if (!production(path)) continue;
    const source = commandSource(file);
    const calls: ts.CallExpression[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) calls.push(node);
      ts.forEachChild(node, visit);
    };
    visit(source);
    const operations: string[] = [];
    const completions: string[] = [];
    for (const call of calls) {
      const aliases = routeAliases(call);
      let callee = call.expression.getText(source);
      const seen = new Set<string>();
      while (/^[\w$]+$/.test(callee) && aliases.has(callee) && !seen.has(callee)) {
        seen.add(callee);
        callee = aliases.get(callee)!;
      }
      const method = callee.match(/(?:\.(post|put|patch|delete)|\[['"](post|put|patch|delete)['"]\])$/);
      if (!method) continue;
      const verb = method[1] ?? method[2]!;
      const route = routeOf(callee.slice(0, method.index), aliases);
      const declared = route ? Object.keys(api.paths).find(path => path.replace(/\{[^}]+\}/g, '*') === route) : null;
      const response = declared ? api.paths[declared]?.[verb]?.responses : undefined;
      if (declared && !response?.['202']) continue;
      if (!declared && (callee.includes('.objectStore(')
        || verb === 'delete' && !/main|api|client|imports|http|v1/i.test(callee))) continue;
      const operation = declared ? `${verb.toUpperCase()} ${declared} [202]`
        : `UNRESOLVED ${verb.toUpperCase()} ${callee}`;
      operations.push(operation);
      const fallback = { operationId: 'pending-command', status: 'reconciling', result: null,
        retry: { allowed: true, afterMs: 1 } };
      if (!declared) continue; // Keep unresolved aliases visible; their response declaration is not known.
      const bodies = admittedBodies(response?.['202']) ?? [fallback];
      if (bodies.some(data => completesAdmission(call, { data, error: null, status: 202, response: { status: 202 } }))) completions.push(operation);
    }
    if (operations.length) inventory.push({ path, operations: operations.sort(), completions: completions.sort() });
  }
  return inventory.sort((a, b) => a.path.localeCompare(b.path));
}

/** Exceptions identify existing completion debt by exact operation and count, never by whole-file identity. */
export function unreviewedCommands(actual: CommandInventory[], debt: CommandInventory[]): CommandInventory[] {
  return actual.flatMap(item => {
    const remaining = [...item.completions];
    const prior = debt.find(entry => entry.path === item.path);
    for (const operation of prior?.completions ?? []) {
      const index = remaining.indexOf(operation);
      if (index >= 0) remaining.splice(index, 1);
    }
    return remaining.length ? [{ ...item, completions: remaining }] : [];
  });
}
