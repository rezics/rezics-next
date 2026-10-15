import { repositoryGlob } from '../lib/repository-files.ts';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { parseSync, visitorKeys, type Node } from 'oxc-parser';
import type { ListOpenApi } from './list-convention.ts';

export interface WebSource { path: string; source: string }
export interface ContinuationViolation {
  path: string;
  consumer: string;
  operation: string;
  rule: 'dropped-continuation' | 'invented-continuation';
  expression: string;
  context: string;
}
export type ContinuationInventory = ContinuationViolation[];
const production = (path: string) => /\.[cm]?[jt]sx?$/.test(path)
  && !/(?:^|\/)(?:__tests__|fixtures|test|tests)(?:\/|\.)|\.(?:test|spec|stories)\.|(?:^|\/)[^/]*fixtures\./.test(path);
const continuations = new Set(['nextCursor', 'continuation', 'after', 'before', 'cursor']);

function children(node: Node): Node[] {
  const fields = node as unknown as Record<string, unknown>;
  return (visitorKeys[node.type] ?? []).flatMap(key => {
    const value = fields[key];
    return (Array.isArray(value) ? value : [value]).filter((child): child is Node =>
      !!child && typeof child === 'object' && 'type' in child);
  });
}
function name(node: Node | null | undefined): string {
  if (node?.type === 'Identifier') return node.name;
  if (node?.type === 'Literal') return String(node.value);
  if (node?.type === 'MemberExpression') return name(node.property);
  return '';
}
// Structural text ignores trivia without erasing string values inside opaque tokens.
function syntax(node: Node): string {
  if (node.type === 'Identifier') return name(node);
  if (node.type === 'Literal') return typeof node.value === 'bigint' ? `${node.value}n` : JSON.stringify(node.value);
  if (node.type === 'MemberExpression') return `${syntax(node.object)}${node.optional ? '?' : ''}${node.computed
    ? `[${syntax(node.property)}]` : `.${syntax(node.property)}`}`;
  if (node.type === 'CallExpression') return `${syntax(node.callee)}(${node.arguments.map(syntax).join(',')})`;
  if (node.type === 'ObjectExpression' || node.type === 'ObjectPattern') return `{${node.properties.map(syntax).join(',')}}`;
  if (node.type === 'Property') return `${syntax(node.key)}:${syntax(node.value)}`;
  if (node.type === 'SpreadElement') return `...${syntax(node.argument)}`;
  if (node.type === 'AwaitExpression') return `await ${syntax(node.argument)}`;
  if (node.type === 'ParenthesizedExpression') return `(${syntax(node.expression)})`;
  return JSON.stringify(node, (key, value) => ['start', 'end', 'raw', 'loc', 'range', 'comments'].includes(key) ? undefined : typeof value === 'bigint' ? `${value}n` : value);
}

export function pagedOperations(api: ListOpenApi): Set<string> {
  const page = (schema: unknown): boolean => {
    if (!schema || typeof schema !== 'object') return false;
    const shape = schema as { properties?: Record<string, unknown>; anyOf?: unknown[]; oneOf?: unknown[]; allOf?: unknown[] };
    return !!(shape.properties?.nextCursor || shape.properties?.continuation)
      || page(shape.properties?.result) || [...shape.anyOf ?? [], ...shape.oneOf ?? [], ...shape.allOf ?? []].some(page);
  };
  return new Set(Object.entries(api.paths).flatMap(([path, methods]) => Object.entries(methods)
    .filter(([, operation]) => page(operation.responses?.['200']?.content?.['application/json']?.schema))
    .map(([method]) => `${method.toUpperCase()} ${path}`)));
}
/** Conservative syntax guard. Projecting items requires an explicit sibling
 * continuation from the same envelope. Aliases, loops and helper calls do not
 * establish forwarding: those sites require an exact expression exception.
 * Its syntax context also pins the enclosing function: changing a cap or an
 * alias initializer cannot silently inherit the exception. Trivia stays benign. */
export function continuationInventory(sources: readonly WebSource[]): ContinuationInventory {
  const violations: ContinuationInventory = [];
  for (const file of sources.filter(file => production(file.path))) {
    const parsed = parseSync(file.path, file.source);
    if (parsed.errors.length) throw new Error(`${file.path}: ${parsed.errors[0]!.message}`);
    const visit = (node: Node, consumer: string, context: string, parent?: Node) => {
      if (['FunctionDeclaration', 'ArrowFunctionExpression', 'FunctionExpression'].includes(node.type)) {
        context = createHash('sha256').update(syntax(node)).digest('hex');
      }
      if (node.type === 'FunctionDeclaration') consumer = name(node.id);
      if ((node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression')
        && parent?.type === 'VariableDeclarator') consumer = name(parent.id);
      const report = (rule: ContinuationViolation['rule']) => violations.push({
        path: file.path, consumer, operation: '<syntax>', rule, expression: syntax(node), context,
      });
      if (node.type === 'MemberExpression' && name(node.property) === 'items') {
        const envelope = syntax(node.object);
        const explicit = parent?.type === 'Property' && parent.value === node;
        // Only this object literal can prove the projection carries its remainder.
        const container = explicit ? objectParents.get(parent) : undefined;
        const forwarded = container?.type === 'ObjectExpression' && container.properties.some(property =>
          property.type === 'Property' && continuations.has(name(property.key))
          && property.value.type === 'MemberExpression' && continuations.has(name(property.value.property))
          && syntax(property.value.object) === envelope);
        if (!forwarded) report('dropped-continuation');
      }
      if (node.type === 'ObjectPattern' && node.properties.some(property =>
        property.type === 'Property' && name(property.key) === 'items')) report('dropped-continuation');
      if (node.type === 'Property' && continuations.has(name(node.key))) {
        const direct = (value: Node): boolean => value.type === 'Identifier' && continuations.has(value.name)
          || value.type === 'MemberExpression' && continuations.has(name(value.property))
          || value.type === 'LogicalExpression' && value.operator === '??' && direct(value.left)
            && (value.right.type === 'Identifier' && value.right.name === 'undefined'
              || value.right.type === 'Literal' && value.right.value === null)
          || name(node.key) !== 'nextCursor' && value.type === 'Literal' && value.value === null;
        if (!direct(node.value)) report('invented-continuation');
      }
      const modified = node.type === 'AssignmentExpression' ? node.left
        : node.type === 'UpdateExpression' || node.type === 'UnaryExpression' && node.operator === 'delete'
          ? node.argument : undefined;
      if (modified && continuations.has(name(modified))) report('invented-continuation');
      if (node.type === 'VariableDeclarator' && continuations.has(name(node.id)) && node.init
        && !['MemberExpression', 'Identifier', 'Literal'].includes(node.init.type)) report('invented-continuation');
      for (const child of children(node)) {
        objectParents.set(child, node);
        visit(child, consumer, context, node);
      }
    };
    const objectParents = new WeakMap<Node, Node>();
    visit(parsed.program, '<module>', createHash('sha256').update(syntax(parsed.program)).digest('hex'));
  }
  return [...new Map(violations.map(violation => [JSON.stringify(violation), violation])).values()]
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

export function changedContinuationGroups(current: ContinuationInventory, accepted: ContinuationInventory): string[] {
  const debt = new Set(accepted.map(violation => JSON.stringify(violation)));
  return current.filter(violation => !debt.has(JSON.stringify(violation)))
    .map(violation => `${violation.path}: ${violation.consumer}: ${violation.operation}: ${violation.rule}: ${violation.expression}`);
}

export async function webSources(root: string): Promise<WebSource[]> {
  const sources: WebSource[] = [];
  for await (const path of repositoryGlob(root, 'apps/web/**/*.{ts,tsx,js,jsx,mts,cts}')) {
    if (production(path)) sources.push({ path, source: readFileSync(join(root, path), 'utf8') });
  }
  return sources;
}
