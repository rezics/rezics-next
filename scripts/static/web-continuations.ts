import { repositoryGlob } from '../lib/repository-files.ts';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, normalize } from 'node:path';
import { visitorKeys, type Node } from 'oxc-parser';
import { webProgram, isWebDataModule } from './web-source-scan.ts';
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

/** One supported URL encoder, identified by its import, never by a call's name
 * alone. Reject shadowed bindings file-wide rather than modelling scope/flow. */
function browseLinkBuilders(file: WebSource, program: Node): Set<string> {
  const builders = new Set<string>();
  for (const node of children(program)) {
    if (node.type !== 'ImportDeclaration' || node.importKind === 'type'
      || normalize(join(dirname(file.path), String(node.source.value))) !== 'apps/web/features/zones/browse-state.ts') continue;
    for (const specifier of node.specifiers) if (specifier.type === 'ImportSpecifier'
      && name(specifier.imported) === 'browseHref' && specifier.importKind !== 'type') builders.add(name(specifier.local));
  }
  const namesIn = (node: Node): string[] => node.type === 'Identifier' ? [node.name] : children(node).flatMap(namesIn);
  const checkBindings = (node: Node) => {
    const bindings = node.type === 'VariableDeclarator' ? [node.id]
      : node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression'
        ? [...node.params, ...node.type !== 'ArrowFunctionExpression' && node.id ? [node.id] : []]
        : node.type === 'ClassDeclaration' || node.type === 'ClassExpression' ? node.id ? [node.id] : []
          : node.type === 'CatchClause' ? node.param ? [node.param] : []
            : node.type === 'AssignmentExpression' ? [node.left]
              : node.type === 'UpdateExpression' ? [node.argument] : [];
    for (const binding of bindings) for (const identifier of namesIn(binding)) builders.delete(identifier);
    for (const child of children(node)) checkBindings(child);
  };
  checkBindings(program);
  return builders;
}

function forwardsBrowseLink(value: Node, envelope: string, builders: ReadonlySet<string>): boolean {
  if (value.type !== 'ConditionalExpression' || value.test.type !== 'MemberExpression'
    || !continuations.has(name(value.test.property)) || syntax(value.test.object) !== envelope
    || value.alternate.type !== 'Literal' || value.alternate.value !== null) return false;
  const call = value.consequent;
  if (call.type !== 'CallExpression' || call.optional || call.callee.type !== 'Identifier'
    || !builders.has(call.callee.name) || call.arguments.length !== 2) return false;
  const state = call.arguments[1]!;
  if (state.type !== 'ObjectExpression') return false;
  const cursor = state.properties.at(-1);
  // Last, unique, literal key: a later spread/computed key cannot replace it.
  return cursor?.type === 'Property' && !cursor.computed && name(cursor.key) === 'cursor'
    && syntax(cursor.value) === syntax(value.test)
    && state.properties.filter(property => property.type === 'Property' && name(property.key) === 'cursor').length === 1;
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
/** A whole-batch iteration may refuse any remainder immediately before it starts. */
function completeIteration(node: Node, parent: Node | undefined, parents: WeakMap<Node, Node>): boolean {
  if (parent?.type !== 'ForOfStatement' || parent.right !== node || node.type !== 'MemberExpression') return false;
  const block = parents.get(parent);
  if (block?.type !== 'BlockStatement') return false;
  const previous = block.body[block.body.indexOf(parent) - 1];
  if (previous?.type !== 'IfStatement' || previous.alternate) return false;
  const remainder = (test: Node): boolean => test.type === 'MemberExpression'
    && name(test.property) === 'nextCursor' && syntax(test.object) === syntax(node.object)
    || test.type === 'LogicalExpression' && test.operator === '||'
      && (remainder(test.left) || remainder(test.right));
  const exit = previous.consequent.type === 'BlockStatement' && previous.consequent.body.length === 1
    ? previous.consequent.body[0] : previous.consequent;
  return remainder(previous.test) && !!exit && (exit.type === 'ReturnStatement' || exit.type === 'ThrowStatement'
    || exit.type === 'ContinueStatement' && !exit.label);
}

/** A deliberately small proof: two local arrays receive the unchanged incidence
 * in exhaustive branches, and both arrays and the unchanged native page escape
 * together. Unknown helpers, callbacks, mutations and extra statements fail closed. */
export function nativePagePartition(loop: Node, parents: WeakMap<Node, Node>): { preserved: boolean; predicate: Node } | null {
  if (loop.type !== 'ForOfStatement' || loop.await || loop.left.type !== 'VariableDeclaration'
    || loop.left.kind !== 'const' || loop.left.declarations.length !== 1
    || loop.left.declarations[0]?.id.type !== 'Identifier'
    || loop.right.type !== 'MemberExpression' || loop.right.computed || loop.right.optional
    || name(loop.right.property) !== 'items' || loop.right.object.type !== 'Identifier'
    || loop.body.type !== 'BlockStatement' || loop.body.body.length < 1
    || loop.body.body.slice(1).some(node => node.type !== 'EmptyStatement')) return null;
  const branch = loop.body.body[0];
  if (branch?.type !== 'IfStatement') return null;
  const item = name(loop.left.declarations[0].id);
  const push = (node: Node | null): string | null => {
    if (node?.type === 'BlockStatement') return node.body.length === 1 ? push(node.body[0]!) : null;
    if (node?.type !== 'ExpressionStatement' || node.expression.type !== 'CallExpression') return null;
    const call = node.expression;
    return !call.optional && call.callee.type === 'MemberExpression' && !call.callee.computed && !call.callee.optional
      && call.callee.object.type === 'Identifier' && name(call.callee.property) === 'push'
      && call.arguments.length === 1 && call.arguments[0]?.type === 'Identifier' && call.arguments[0].name === item
      ? call.callee.object.name : null;
  };
  const yes = push(branch.consequent), no = push(branch.alternate);
  // Only inspect this direct partition form. Other algorithms retain their existing findings.
  if ((!yes && branch.consequent.type !== 'EmptyStatement') || branch.alternate && !no
    && branch.alternate.type !== 'EmptyStatement') return null;
  if (!yes && !no) return null;
  const answer = { preserved: false, predicate: branch.test };
  const body = parents.get(loop), fn = body && parents.get(body);
  if (body?.type !== 'BlockStatement' || !fn || !('params' in fn)
    || !['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(fn.type)
    || body.body.length !== 4 || body.body[2] !== loop || loop.body.body.length !== 1 || !yes || !no || yes === no) return answer;
  const page = loop.right.object.name;
  if (new Set([page, item, yes, no]).size !== 4
    || fn.params.filter(parameter => parameter.type === 'Identifier' && parameter.name === page).length !== 1
    || fn.params.some(parameter => parameter.type !== 'Identifier' || [item, yes, no].includes(parameter.name))) return answer;
  const allocation = (node: Node, identifier: string) => node.type === 'VariableDeclaration' && node.kind === 'const'
    && node.declarations.length === 1 && node.declarations[0]?.id.type === 'Identifier'
    && node.declarations[0].id.name === identifier && node.declarations[0].init?.type === 'ArrayExpression'
    && node.declarations[0].init.elements.length === 0;
  if (!allocation(body.body[0]!, yes) || !allocation(body.body[1]!, no)) return answer;
  const pure = (node: Node): boolean => node.type === 'Identifier' ? [item, page].includes(node.name)
    : node.type === 'Literal' ? true
      : node.type === 'MemberExpression' ? !node.computed && pure(node.object)
        : node.type === 'BinaryExpression' ? ['===', '!=='].includes(node.operator) && pure(node.left) && pure(node.right)
          : node.type === 'LogicalExpression' ? pure(node.left) && pure(node.right)
          : node.type === 'UnaryExpression' && ['!', 'typeof', 'void'].includes(node.operator) && pure(node.argument);
  if (!pure(branch.test)) return answer;
  const returned = body.body[3];
  if (returned?.type !== 'ReturnStatement' || returned.argument?.type !== 'ObjectExpression') return answer;
  const properties = returned.argument.properties;
  if (properties.length !== 3 || properties.some(property => property.type !== 'Property' || property.computed
    || property.kind !== 'init' || property.method || !property.shorthand || property.value.type !== 'Identifier'
    || name(property.key) !== name(property.value))) return answer;
  const keys = properties.map(property => property.type === 'Property' ? name(property.key) : '');
  const values = properties.map(property => property.type === 'Property' ? name(property.value) : '');
  answer.preserved = !keys.includes('__proto__') && new Set(keys).size === 3 && new Set(values).size === 3
    && [page, yes, no].every(value => values.includes(value));
  return answer;
}

/** The new native `next` form is admitted only without writes, escapes or shadowed
 * envelope bindings in this function. A matching property name is not a proof. */
function stableNativeEnvelope(node: Node, parents: WeakMap<Node, Node>): boolean {
  if (node.type !== 'MemberExpression' || node.object.type !== 'Identifier') return false;
  const envelope = node.object.name;
  let scope: Node | undefined = node;
  while (scope && !['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(scope.type)) scope = parents.get(scope);
  if (!scope) return false;
  const property = parents.get(node), container = property && parents.get(property);
  if (container?.type !== 'ObjectExpression') return false;
  const forwarded = new Set(container.properties.flatMap(property => property.type === 'Property' ? [property.value] : []));
  let bindings = 0, stable = true;
  const rooted = (value: Node): boolean => value.type === 'Identifier' ? value.name === envelope
    : value.type === 'MemberExpression' ? rooted(value.object) : false;
  const visit = (value: Node, parent?: Node) => {
    if (value.type === 'MemberExpression' && rooted(value) && !forwarded.has(value)) stable = false;
    if (value.type === 'Identifier' && value.name === envelope && !(parent?.type === 'MemberExpression' && parent.object === value)
      && !(parent?.type === 'VariableDeclarator' && parent.id === value)
      && !(parent && 'params' in parent && parent.params.some(parameter => parameter === value))) stable = false;
    if (value.type === 'VariableDeclarator' && name(value.id) === envelope) bindings++;
    if ('params' in value) for (const parameter of value.params) if (name(parameter) === envelope) bindings++;
    if ((value.type === 'FunctionDeclaration' || value.type === 'ClassDeclaration') && name(value.id) === envelope) bindings++;
    if (value.type === 'AssignmentExpression' && rooted(value.left)
      || (value.type === 'UpdateExpression' || value.type === 'UnaryExpression' && value.operator === 'delete') && rooted(value.argument)
      || value.type === 'CallExpression' && (value.arguments.some(argument => rooted(argument))
        || value.callee.type === 'MemberExpression' && rooted(value.callee.object))) stable = false;
    for (const child of children(value)) visit(child, value);
  };
  visit(scope);
  return stable && bindings === 1;
}

/** Conservative syntax guard. Projecting items requires an explicit sibling
 * continuation from the same envelope, either directly or through the tested
 * browse URL encoder. A complete batch can reject its remainder before iteration.
 * Other helpers, aliases and loops need an exact exception.
 * Its syntax context also pins the enclosing function: changing a cap or an
 * alias initializer cannot silently inherit the exception. Trivia stays benign. */
export function continuationInventory(sources: readonly WebSource[]): ContinuationInventory {
  const violations: ContinuationInventory = [];
  for (const file of sources.filter(file => production(file.path))) {
    const program = webProgram(file);
    if (isWebDataModule(program)) continue;
    const linkBuilders = browseLinkBuilders(file, program);
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
        const forwarded = container?.type === 'ObjectExpression' && container.properties.some((property, index) => {
          if (property.type !== 'Property' || property.computed) return false;
          const direct = continuations.has(name(property.key))
            && property.value.type === 'MemberExpression' && continuations.has(name(property.value.property))
            && syntax(property.value.object) === envelope;
          const link = name(property.key) === 'next' && forwardsBrowseLink(property.value, envelope, linkBuilders);
          const native = name(property.key) === 'next' && property.value.type === 'MemberExpression'
            && !property.value.computed && !property.value.optional && name(property.value.property) === 'next'
            && syntax(property.value.object) === envelope && stableNativeEnvelope(node, objectParents)
            && container.properties.every(item => item.type === 'Property' && !item.computed && item.kind === 'init' && !item.method)
            && !container.properties.some(item => item.type === 'Property' && name(item.key) === '__proto__')
            && new Set(container.properties.map(item => item.type === 'Property' ? name(item.key) : '')).size === container.properties.length;
          return (direct || link || native) && container.properties.slice(index + 1).every(later =>
            later.type === 'Property' && !later.computed && name(later.key) !== name(property.key));
        });
        const partition = parent?.type === 'ForOfStatement' && parent.right === node
          && nativePagePartition(parent, objectParents)?.preserved;
        if (!forwarded && !partition && !completeIteration(node, parent, objectParents)) report('dropped-continuation');
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
    visit(program, '<module>', createHash('sha256').update(syntax(program)).digest('hex'));
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
