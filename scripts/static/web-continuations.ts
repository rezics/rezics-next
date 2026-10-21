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
    && ['nextCursor', 'next'].includes(name(test.property)) && syntax(test.object) === syntax(node.object)
    || test.type === 'LogicalExpression' && test.operator === '||'
      && (remainder(test.left) || remainder(test.right));
  const exit = previous.consequent.type === 'BlockStatement' && previous.consequent.body.length === 1
    ? previous.consequent.body[0] : previous.consequent;
  return remainder(previous.test) && !!exit && (exit.type === 'ReturnStatement' || exit.type === 'ThrowStatement'
    || exit.type === 'ContinueStatement' && !exit.label);
}

/** A batch's explicit complete flag is different from a page frontier. Accept
 * only an immediately dominating refusal of this very envelope's false flag. */
function completeBatch(node: Node, parents: WeakMap<Node, Node>): boolean {
  if (node.type !== 'MemberExpression') return false;
  let statement: Node = node;
  for (let parent = parents.get(statement); parent; parent = parents.get(statement)) {
    if (isFunction(parent)) return false;
    if (parent.type === 'BlockStatement') {
      const previous = parent.body[parent.body.indexOf(statement as typeof parent.body[number]) - 1];
      if (previous?.type !== 'IfStatement' || previous.alternate || previous.test.type !== 'UnaryExpression'
        || previous.test.operator !== '!' || previous.test.argument.type !== 'MemberExpression'
        || staticKey(previous.test.argument) !== 'complete' || syntax(previous.test.argument.object) !== syntax(node.object)) return false;
      const exit = previous.consequent.type === 'BlockStatement' && previous.consequent.body.length === 1
        ? previous.consequent.body[0] : previous.consequent;
      if (exit?.type === 'ThrowStatement') return true;
      const failure = exit?.type === 'ReturnStatement' && exit.argument ? unwrap(exit.argument) : undefined;
      return failure?.type === 'ObjectExpression' && failure.properties.every(property => property.type === 'Property'
        && !property.computed && !property.method && property.kind === 'init')
        && failure.properties.filter(property => property.type === 'Property' && staticKey(property) === 'ok').length === 1
        && failure.properties.some(property => property.type === 'Property' && staticKey(property) === 'ok'
          && property.value.type === 'Literal' && property.value.value === false);
    }
    statement = parent;
  }
  return false;
}

type FunctionNode = Extract<Node, { expression: boolean; params: unknown }> & { body: Node };
const isFunction = (node: Node): node is FunctionNode => ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(node.type)
  && !!(node as FunctionNode).body;
const unwrap = (node: Node): Node => ['TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression', 'ParenthesizedExpression', 'ChainExpression'].includes(node.type)
  ? unwrap((node as Extract<Node, { expression: Node }>).expression) : node;
const staticKey = (node: Extract<Node, { type: 'Property' | 'MemberExpression' }>): string | undefined => {
  const key = node.type === 'Property' ? node.key : node.property;
  return !node.computed || key.type === 'Literal' ? name(key) : undefined;
};
interface Address { root: Node; path: string[]; element?: boolean }
interface Binding { value: Node; path: string[]; parameter?: boolean }
type ConstructedKind = 'group' | 'array';
interface InputProof { valid: boolean; count: number }

/** Local, read-only evidence for native envelopes and incoming positions. Unknown
 * calls/branches/spreads cannot prove retention; aliases never outlive a write.
 * Both inventories use the same output lifetime, rather than naming enrichments. */
export function pageOutputFlow(program: Node, importedReadOnly?: (name: string, index: number) => boolean,
  importedConstructed?: (name: string, path: string[], kind: ConstructedKind) => boolean,
  exportedInputs?: (name: string, path: string[], kind: ConstructedKind) => InputProof) {
  const parents = new WeakMap<Node, Node>();
  const programNodes: Node[] = [];
  const index = (node: Node) => { programNodes.push(node); for (const child of children(node)) { parents.set(child, node); index(child); } };
  index(program);
  const scopes = new WeakMap<Node, ReturnType<typeof scope>>();
  const declarations = new Map<string, FunctionNode>();
  const unavailableDeclarations = new Set<string>();
  for (const statement of children(program)) {
    const node = statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement;
    if (node?.type === 'FunctionDeclaration' && node.id && isFunction(node)) {
      if (declarations.has(node.id.name)) unavailableDeclarations.add(node.id.name);
      declarations.set(node.id.name, node);
    }
  }
  const bindingNames = (node: Node): string[] => node.type === 'Identifier' ? [node.name]
    : children(node).flatMap(bindingNames);
  const checkDeclarations = (node: Node) => {
    const bindings = node.type === 'VariableDeclarator' ? [node.id]
      : isFunction(node) ? node.params
        : node.type === 'AssignmentExpression' ? [node.left]
          : node.type === 'UpdateExpression' ? [node.argument]
            : node.type === 'CatchClause' && node.param ? [node.param]
              : node.type === 'ClassDeclaration' && node.id ? [node.id] : [];
    for (const binding of bindings) for (const identifier of bindingNames(binding)) unavailableDeclarations.add(identifier);
    if (node.type === 'FunctionDeclaration' && node.id && declarations.get(node.id.name) !== node) unavailableDeclarations.add(node.id.name);
    for (const child of children(node)) checkDeclarations(child);
  };
  checkDeclarations(program);
  for (const identifier of unavailableDeclarations) declarations.delete(identifier);
  const checkingEffects = new Set<FunctionNode>();
  const checkingOrigins = new Set<string>();
  const checkingSelections = new Set<string>();
  const functionFlow = (fn: FunctionNode) => {
    const flow = scopes.get(fn) ?? scope(fn);
    scopes.set(fn, flow);
    return flow;
  };
  const returnedConstructed = (fn: FunctionNode, path: string[], kind: ConstructedKind): boolean => {
    const key = `${fn.start}:${path.join('.')}:${kind}`;
    if (checkingOrigins.has(key)) return false;
    checkingOrigins.add(key);
    const result = functionFlow(fn).returnedConstructed(path, kind);
    checkingOrigins.delete(key);
    return result;
  };
  const readOnlyArgument = (fn: FunctionNode, index: number): boolean => {
    if (checkingEffects.has(fn)) return false;
    checkingEffects.add(fn);
    const flow = scopes.get(fn) ?? scope(fn);
    scopes.set(fn, flow);
    const result = flow.readOnlyArgument(index);
    checkingEffects.delete(fn);
    return result;
  };
  function scope(fn: FunctionNode) {
    const nodes: Node[] = [];
    const all: Node[] = [];
    const collect = (node: Node, own = true) => {
      all.push(node);
      own &&= node === fn || !isFunction(node);
      if (own) nodes.push(node);
      for (const child of children(node)) collect(child, own);
    };
    collect(fn);
    const bindings = new Map<string, Binding>();
    const ambiguous = new Set<string>();
    const bind = (pattern: Node, value: Node, path: string[] = [], parameter = false) => {
      if (pattern.type === 'Identifier') {
        if (bindings.has(pattern.name)) ambiguous.add(pattern.name);
        bindings.set(pattern.name, { value, path, parameter });
      } else if (pattern.type === 'ObjectPattern') {
        for (const property of pattern.properties) if (property.type === 'Property') {
          bind(property.value, value, [...path, staticKey(property) ?? '*'], parameter);
        }
      } else if (pattern.type === 'ArrayPattern') {
        pattern.elements.forEach((item, index) => { if (item) bind(item, value, [...path, String(index)], parameter); });
      }
    };
    for (const parameter of fn.params) bind(parameter, parameter, [], true);
    for (const node of nodes) if (node.type === 'VariableDeclarator' && node.init) bind(node.id, node.init);
    const elements: { name: string; value: Node; body: Node }[] = [];
    const localAliases: { name: string; value: Node; body: Node }[] = [];
    for (const node of all) {
      if (node.type === 'VariableDeclarator' && node.init && node.id.type === 'Identifier' && !nodes.includes(node)) {
        let owner = parents.get(node);
        while (owner && !isFunction(owner)) owner = parents.get(owner);
        if (owner && isFunction(owner)) localAliases.push({ name: node.id.name, value: node.init, body: owner.body });
      }
      if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression'
        && ['map', 'filter', 'flatMap', 'find', 'some', 'every', 'forEach'].includes(name(node.callee.property))) {
        const callback = node.arguments[0];
        if (callback && isFunction(callback) && callback.params[0]?.type === 'Identifier') {
          elements.push({ name: callback.params[0].name, value: node.callee.object, body: callback.body });
        }
      }
      if (node.type === 'ForOfStatement' && node.left.type === 'VariableDeclaration') {
        const pattern = node.left.declarations[0]?.id;
        if (pattern?.type === 'Identifier') elements.push({ name: pattern.name, value: node.right, body: node.body });
      }
    }
    const globals = new Map<string, Node>();
    const propertyValue = (object: Node, key: string, seen = new Set<Node>()): Node | undefined => {
      object = value(object, seen);
      if (object.type !== 'ObjectExpression') return;
      for (const property of [...object.properties].reverse()) {
        if (property.type !== 'Property' || staticKey(property) === undefined) return;
        if (staticKey(property) === key) return property.kind === 'init' && !property.method ? property.value : undefined;
      }
    };
    const value = (node: Node, seen = new Set<Node>()): Node => {
      node = unwrap(node);
      if (seen.has(node)) return node;
      seen.add(node);
      if (node.type === 'Identifier' && !ambiguous.has(node.name)) {
        const binding = bindings.get(node.name);
        if (binding && !binding.parameter && !binding.path.length) return value(binding.value, seen);
      }
      if (node.type === 'MemberExpression') {
        const key = staticKey(node);
        const selected = key === undefined ? undefined : propertyValue(node.object, key, new Set(seen));
        if (selected) return value(selected, seen);
      }
      return node;
    };
    const address = (node: Node, seen = new Set<Node>()): Address | undefined => {
      node = unwrap(node);
      if (seen.has(node)) return;
      seen.add(node);
      if (node.type === 'Identifier') {
        const local = [...localAliases].reverse().find(binding => binding.name === name(node) && node.start >= binding.body.start && node.end <= binding.body.end);
        if (local) return address(local.value, seen);
        const element = [...elements].reverse().find(binding => binding.name === name(node) && node.start >= binding.body.start && node.end <= binding.body.end);
        if (element) {
          const origin = address(element.value, seen);
          return origin && { ...origin, path: [...origin.path, '*'], element: true };
        }
        if (ambiguous.has(node.name)) return;
        const binding = bindings.get(node.name);
        if (binding?.parameter) return { root: binding.value, path: binding.path };
        if (binding) {
          const origin = address(binding.value, seen);
          return origin && { ...origin, path: [...origin.path, ...binding.path] };
        }
        if (!globals.has(node.name)) globals.set(node.name, node);
        return { root: globals.get(node.name)!, path: [] };
      }
      if (node.type === 'AwaitExpression') return address(node.argument, seen);
      if (node.type === 'MemberExpression') {
        const key = staticKey(node);
        const selected = key === undefined ? undefined : propertyValue(node.object, key, new Set(seen));
        if (selected) return address(selected, seen);
        const origin = address(node.object, seen);
        return origin && { ...origin, path: [...origin.path, key ?? '*'] };
      }
      if (node.type === 'CallExpression' || node.type === 'ObjectExpression' || node.type === 'ArrayExpression'
        || node.type === 'LogicalExpression' && node.operator === '??') return { root: node, path: [] };
    };
    const prefix = (left: Address, right: Address) => left.root === right.root && left.path.length <= right.path.length
      && left.path.every((key, index) => key === '*' || right.path[index] === '*' || key === right.path[index]);
    const same = (left: Address | undefined, right: Address) => !!left && left.path.length === right.path.length
      && !left.path.includes('*') && prefix(left, right);
    const exposes = (node: Node, target: Address, token: boolean): boolean => {
      const origin = address(node);
      if (origin && !origin.element && (token ? prefix(origin, target) && origin.path.length < target.path.length
        : prefix(origin, target) || prefix(target, origin))) return true;
      node = value(node);
      if (node.type === 'ObjectExpression') return node.properties.some(property =>
        property.type === 'Property' ? exposes(property.value, target, token) : exposes(property.argument, target, token));
      if (node.type === 'ArrayExpression') return node.elements.some(item => item && exposes(item, target, token));
      return false;
    };
    const readMethods = new Set(['map', 'filter', 'flatMap', 'find', 'findIndex', 'some', 'every', 'reduce', 'reduceRight',
      'forEach', 'at', 'includes', 'indexOf', 'lastIndexOf', 'slice', 'concat', 'join', 'entries', 'keys', 'values']);
    const writes = (node: Node): Node[] => node.type === 'ObjectPattern'
      ? node.properties.flatMap(property => writes(property.type === 'Property' ? property.value : property.argument))
      : node.type === 'ArrayPattern' ? node.elements.flatMap(item => item ? writes(item) : [])
        : node.type === 'AssignmentPattern' ? writes(node.left) : [node];
    const untouched = (target: Address, token = false, appendOnly = false, arrayLengths = false): boolean => !all.some(node => {
      const modified = node.type === 'AssignmentExpression' ? node.left
        : node.type === 'UpdateExpression' || node.type === 'UnaryExpression' && node.operator === 'delete' ? node.argument : undefined;
      if (modified && writes(modified).some(item => {
        const write = address(item);
        return write && (prefix(write, target) || prefix(target, write));
      })) return true;
      if (node.type === 'VariableDeclarator' && node.init && node.id.type === 'ObjectPattern'
        && node.id.properties.some(property => property.type === 'RestElement') && exposes(node.init, target, token)) return true;
      if (node.type !== 'CallExpression') return false;
      if (node.arguments.some((argument, index) => {
        // The constructed-array proof may read its scalar length through a
        // helper; passing that number cannot pass a writable array alias.
        if (arrayLengths && argument.type === 'MemberExpression' && staticKey(argument) === 'length') return false;
        const origin = appendOnly ? address(argument) : undefined;
        if (!exposes(argument, target, token) && !(origin?.element && (prefix(origin, target) || prefix(target, origin)))) return false;
        const callee = node.callee;
        if (callee.type === 'MemberExpression' && staticKey(callee) === 'stringify'
          && callee.object.type === 'Identifier' && callee.object.name === 'JSON'
          && !unavailableDeclarations.has('JSON') && !bindings.has('JSON') && node.arguments.length === 1) return false;
        if (!token && !appendOnly && callee.type === 'MemberExpression' && staticKey(callee) === 'push') {
          const array = address(callee.object);
          if (array?.root.type === 'ArrayExpression' && !array.path.length
            && (untouched(array, false, true) || preservedInArray(argument, target, array))) return false;
        }
        // A local helper is evidence only when its parameter has no writes,
        // opaque escapes or returned aliases. Recursive/unknown calls fail closed.
        const resolved = value(node.callee);
        const fn = isFunction(resolved) ? resolved : resolved.type === 'Identifier' && !bindings.has(resolved.name)
          ? declarations.get(resolved.name) : undefined;
        return fn ? !readOnlyArgument(fn, index) : resolved.type !== 'Identifier'
          || unavailableDeclarations.has(resolved.name) || bindings.has(resolved.name)
          || !importedReadOnly?.(resolved.name, index);
      })) return true;
      const receiver = node.callee.type === 'MemberExpression' ? address(node.callee.object) : undefined;
      return !token && !!receiver && (prefix(receiver, target) || prefix(target, receiver))
        && node.callee.type === 'MemberExpression' && (appendOnly
          ? name(node.callee.property) !== 'push' : !readMethods.has(name(node.callee.property)));
    });
    // A native page may also be held below a local presentation record. Changes
    // to a sibling legend do not change that page. Follow the exact literal
    // property path through array elements; writes or opaque uses on that path
    // (including a whole-record escape) are still rejected.
    const preservedInArray = (argument: Node, target: Address, array: Address): boolean => {
      const paths = (node: Node): string[][] | undefined => {
        if (same(address(node), target)) return [[]];
        node = value(node);
        if (node.type !== 'ObjectExpression') return;
        const result: string[][] = [];
        for (const property of node.properties) {
          if (property.type !== 'Property' || property.kind !== 'init' || property.method || staticKey(property) === undefined) return;
          const nested = paths(property.value);
          if (nested) result.push(...nested.map(path => [staticKey(property)!, ...path]));
          else if (exposes(property.value, target, false)) return;
        }
        return result.length ? result : undefined;
      };
      const locations = paths(argument);
      if (!locations) return false;
      return locations.every(path => {
        const protectedValue = { ...array, path: ['*', ...path] };
        const overlaps = (node: Node) => {
          const location = address(node);
          return !!location && (prefix(location, protectedValue) || prefix(protectedValue, location));
        };
        return !all.some(node => {
          const modified = node.type === 'AssignmentExpression' ? node.left
            : node.type === 'UpdateExpression' || node.type === 'UnaryExpression' && node.operator === 'delete' ? node.argument : undefined;
          if (modified && writes(modified).some(overlaps)) return true;
          if (node.type !== 'CallExpression') return false;
          if (node.arguments.some(overlaps)) return true;
          if (node.callee.type !== 'MemberExpression' || !overlaps(node.callee.object)) return false;
          const method = staticKey(node.callee);
          return !(same(address(node.callee.object), array) && method === 'push');
        });
      });
    };
    const controls = (node: Node): Node[] => {
      const result: Node[] = [];
      for (let parent = parents.get(node); parent && parent !== fn; node = parent, parent = parents.get(parent)) {
        if (isFunction(parent)) return [parent];
        if (['IfStatement', 'ConditionalExpression', 'ForOfStatement', 'ForStatement', 'WhileStatement', 'DoWhileStatement', 'SwitchCase', 'TryStatement'].includes(parent.type)) result.push(node);
      }
      return result;
    };
    const contains = (node: Node, target: Address, seen = new Set<Node>(), at?: Node): boolean => {
      if (same(address(node), target)) return true;
      node = value(node);
      if (seen.has(node)) return false;
      seen = new Set(seen).add(node);
      if (node.type === 'ConditionalExpression') return contains(node.consequent, target, seen, at) && contains(node.alternate, target, seen, at);
      if (node.type === 'LogicalExpression') return contains(node.left, target, seen, at) && contains(node.right, target, seen, at);
      if (node.type === 'ArrayExpression') {
        if (node.elements.some(item => item && item.type !== 'SpreadElement' && contains(item, target, seen, at))) return true;
        const array = address(node);
        return !!array && !!at && untouched(array, false, true) && all.some(call => call.type === 'CallExpression'
          && call.end <= at.start && call.callee.type === 'MemberExpression' && staticKey(call.callee) === 'push'
          && same(address(call.callee.object), array) && controls(call).every(control => controls(at).includes(control))
          && call.arguments.some(argument => contains(argument, target, seen, at)));
      }
      if (node.type !== 'ObjectExpression') return false;
      const keys = new Set<string>();
      const spreadKeys = (node: Node, seen = new Set<Node>()): Set<string> | undefined => {
        node = value(node);
        if (seen.has(node)) return;
        seen = new Set(seen).add(node);
        if (node.type === 'ConditionalExpression') {
          const left = spreadKeys(node.consequent, seen), right = spreadKeys(node.alternate, seen);
          return left && right && new Set([...left, ...right]);
        }
        if (node.type !== 'ObjectExpression') return;
        const result = new Set<string>();
        for (const property of node.properties) {
          if (property.type === 'SpreadElement') {
            const nested = spreadKeys(property.argument, seen);
            if (!nested) return;
            for (const key of nested) result.add(key);
          } else {
            const key = staticKey(property);
            if (key === undefined || property.kind !== 'init' || property.method) return;
            result.add(key);
          }
        }
        return result;
      };
      const fields = (object: Extract<Node, { type: 'ObjectExpression' }>): boolean => {
        for (const property of [...object.properties].reverse()) {
          if (property.type === 'SpreadElement') {
            if (same(address(property.argument), target)) {
              if (![...keys].some(key => key === 'items' || key === 'next' || continuations.has(key))) return true;
            } else {
              const spread = value(property.argument);
              if (spread.type === 'ObjectExpression') {
                if (fields(spread)) return true;
              } else {
                const possible = spreadKeys(spread);
                if (!possible) return false;
                if (contains(spread, target, seen, at)) return true;
                for (const key of possible) keys.add(key);
              }
            }
          } else {
            const key = staticKey(property);
            if (key === undefined) return false;
            if (!keys.has(key)) {
              keys.add(key);
              if (property.kind === 'init' && !property.method && contains(property.value, target, seen, at)) return true;
            }
          }
        }
        return false;
      };
      return fields(node);
    };
    const returns = fn.type === 'ArrowFunctionExpression' && fn.expression ? [fn.body]
      : nodes.flatMap(node => node.type === 'ReturnStatement' ? [node.argument] : []);
    const failed = (output: Node | null | undefined): boolean => {
      if (!output) return false;
      const literal = value(output);
      if (literal.type === 'ObjectExpression' && literal.properties.every(property => property.type === 'Property' && !property.computed)
        && literal.properties.filter(property => property.type === 'Property' && name(property.key) === 'ok').length === 1
        && literal.properties.some(property => property.type === 'Property' && name(property.key) === 'ok'
          && property.value.type === 'Literal' && property.value.value === false)) return true;
      const statement = parents.get(output);
      let branch = statement && parents.get(statement);
      if (branch?.type === 'BlockStatement' && branch.body.length === 1) branch = parents.get(branch);
      return branch?.type === 'IfStatement' && !branch.alternate && branch.test.type === 'UnaryExpression'
        && branch.test.operator === '!' && branch.test.argument.type === 'MemberExpression'
        && staticKey(branch.test.argument) === 'ok' && syntax(branch.test.argument.object) === syntax(output)
        && (branch.consequent === statement || branch.consequent.type === 'BlockStatement' && branch.consequent.body.length === 1
          && branch.consequent.body[0] === statement);
    };
    const altered = (node: Node, target: Address, seen = new Set<Node>()): boolean => {
      node = value(node);
      if (seen.has(node)) return false;
      seen = new Set(seen).add(node);
      if (node.type === 'ObjectExpression') {
        return node.properties.some((property, index) => property.type === 'SpreadElement'
          && same(address(property.argument), target) && node.properties.slice(index + 1).some(later =>
            later.type !== 'Property' || staticKey(later) === undefined
            || (staticKey(later) === 'items' || staticKey(later) === 'next' || continuations.has(staticKey(later)!))
              && !same(address(later.value), { ...target, path: [...target.path, staticKey(later)!] })))
          || node.properties.some(property => altered(property.type === 'Property' ? property.value : property.argument, target, seen));
      }
      if (node.type === 'ArrayExpression') return node.elements.some(item => item && altered(item, target, seen));
      if (node.type === 'ConditionalExpression') return altered(node.consequent, target, seen) || altered(node.alternate, target, seen);
      return false;
    };
    // These item arrays are constructed locally for presentation, rather than
    // read from a server envelope. A local Map is admitted only if every value
    // ever inserted has the same literal-array origin; opaque writes fail shut.
    const constructedItems = (envelope: Node, map = false): boolean => {
      const maps = new Set<Node>();
      const literalArray = (node: Node): boolean => {
        node = value(node);
        return node.type === 'ArrayExpression'
          || node.type === 'ConditionalExpression' && literalArray(node.consequent) && literalArray(node.alternate)
          || node.type === 'CallExpression' && !node.optional && node.callee.type === 'MemberExpression'
            && staticKey(node.callee) === 'map' && node.arguments.length === 1 && isFunction(node.arguments[0]!)
            && !node.arguments[0]!.async && node.arguments[0]!.params.length === 1;
      };
      const literal = (node: Node): boolean => {
        node = value(node);
        if (node.type === 'LogicalExpression' && node.operator === '??') return literal(node.left) && literal(node.right);
        if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression'
          && staticKey(node.callee) === 'get' && node.arguments.length === 1) return localMap(node.callee.object);
        return node.type === 'ObjectExpression' && node.properties.every(property => property.type === 'Property'
          && !property.computed && !property.method && property.kind === 'init'
          && !['next', 'nextCursor', 'continuation', 'cursor', 'after', 'before'].includes(name(property.key)))
          && node.properties.filter(property => property.type === 'Property' && name(property.key) === 'items').length === 1
          && node.properties.some(property => property.type === 'Property' && name(property.key) === 'items'
            && literalArray(property.value));
      };
      const cleanOrigin = (origin: Node): boolean => {
        const container = address(origin);
        const itemValue = propertyValue(origin, 'items');
        const items = itemValue ? address(itemValue) : container && { ...container, path: [...container.path, 'items'] };
        const protectedValues = [...(items ? [items] : []), ...(container
          ? ['next', ...continuations].map(key => ({ ...container, path: [...container.path, key] })) : [])];
        const touches = (node: Node) => protectedValues.some(target => exposes(node, target, false));
        return !all.some(candidate => {
          if (candidate.type === 'AssignmentExpression' || candidate.type === 'UpdateExpression'
            || candidate.type === 'UnaryExpression' && candidate.operator === 'delete') {
            const modified = candidate.type === 'AssignmentExpression' ? candidate.left : candidate.argument;
            let target = modified;
            while (target.type === 'MemberExpression') target = target.object;
            if (value(target) === origin || touches(modified)) return true;
          }
          if (candidate.type !== 'CallExpression') return false;
          const callee = candidate.callee;
          const inserted = callee.type === 'MemberExpression' && staticKey(callee) === 'set'
            && maps.has(value(callee.object));
          if (!inserted && candidate.arguments.some(argument => value(argument) === origin
            || !(argument.type === 'MemberExpression' && staticKey(argument) === 'length') && touches(argument))) return true;
          if (callee.type !== 'MemberExpression') return false;
          // The receiver itself is a writable alias, even with no arguments.
          // Locally constructed item arrays allow their builder's push and
          // ordinary reads; an opaque receiver can replace their contents.
          if (value(callee.object) === origin) return true;
          return touches(callee.object) && !readMethods.has(staticKey(callee) ?? '') && staticKey(callee) !== 'push';
        });
      };
      const localMap = (node: Node): boolean => {
        const origin = value(node);
        if (origin.type !== 'NewExpression' || origin.callee.type !== 'Identifier' || origin.callee.name !== 'Map'
          || origin.arguments.length || bindings.has('Map') || unavailableDeclarations.has('Map')) return false;
        if (maps.has(origin)) return true;
        maps.add(origin);
        let inserted = false;
        for (const candidate of all) {
          const modified = candidate.type === 'AssignmentExpression' ? candidate.left
            : candidate.type === 'UpdateExpression' || candidate.type === 'UnaryExpression' && candidate.operator === 'delete'
              ? candidate.argument : undefined;
          if (modified && value(modified) === origin) return false;
          if (candidate.type !== 'CallExpression') continue;
          const callee = candidate.callee;
          if (candidate.arguments.some(argument => value(argument) === origin)) return false;
          if (callee.type !== 'MemberExpression' || value(callee.object) !== origin) continue;
          const method = staticKey(callee);
          if (method === 'set' && candidate.arguments.length === 2) {
            inserted = true;
            if (!literal(candidate.arguments[1]!) || !cleanOrigin(value(candidate.arguments[1]!))) return false;
          } else if (!['get', 'values', 'entries', 'keys', 'has'].includes(method ?? '')) return false;
        }
        return inserted;
      };
      if (map) return localMap(envelope);
      const origin = value(envelope);
      if (!literal(origin)) return false;
      return cleanOrigin(origin);
    };
    // Follow only explicit construction paths: literal fields, known returned
    // values and element callbacks. The terminal group must still be a local
    // literal-array construction, never a server object with a frontier. This
    // distinguishes `group.items` from `page.items` without trusting a name or
    // an annotation. Unknown calls, cycles and aliases with writes fail shut.
    const deriveConstructed = (node: Node, path: string[], kind: ConstructedKind, seen: Set<string>): boolean => {
      node = unwrap(node);
      const key = `${node.type}:${node.start}:${node.end}:${path.join('.')}:${kind}`;
      if (seen.has(key)) return false;
      seen = new Set(seen).add(key);
      if (!path.length && kind === 'group' && constructedItems(node)) return true;
      const location = address(node);
      // Protect the selected construction and its aliases. A disjoint sibling
      // (such as a retained native page's cursor) cannot mutate these groups.
      const protectedPaths = kind === 'group' ? ['items', 'next', ...continuations].map(key => [...path, key]) : [path];
      if (location && protectedPaths.some(path => !untouched({ ...location, path: [...location.path, ...path] }, false, false, true))) return false;
      if (node.type === 'Identifier') {
        if (ambiguous.has(node.name)) return false;
        const binding = bindings.get(node.name);
        if (binding && !binding.parameter) return derivedConstructed(binding.value, [...binding.path, ...path], kind, seen);
        if (binding?.parameter) {
          const callback = parents.get(fn);
          if (callback?.type === 'CallExpression' && callback.arguments[0] === fn
            && callback.callee.type === 'MemberExpression'
            && ['map', 'flatMap', 'filter', 'find', 'some', 'every', 'forEach'].includes(staticKey(callback.callee) ?? '')
            && fn.params.length === 1 && fn.params[0] === binding.value) {
            return forNode(callback)?.derivedConstructed(callback.callee.object, ['*', ...binding.path, ...path], kind) ?? false;
          }
          if (fn.type !== 'FunctionDeclaration' || !fn.id || fn.params[0] !== binding.value) return false;
          const select = [...binding.path, ...path];
          const own = namedInputs(fn.id.name, select, kind);
          const exported = parents.get(fn)?.type === 'ExportNamedDeclaration'
            ? exportedInputs?.(fn.id.name, select, kind) : { valid: true, count: 0 };
          return own.valid && !!exported?.valid && own.count + exported.count > 0;
        }
        const outer = parents.get(fn);
        const outerFlow = outer && forNode(outer);
        return !!outerFlow && outerFlow !== scopes.get(fn) && outerFlow.derivedConstructed(node, path, kind);
      }
      if (node.type === 'MemberExpression') {
        const property = staticKey(node);
        return property !== undefined && derivedConstructed(node.object, [property, ...path], kind, seen);
      }
      if (node.type === 'ConditionalExpression') return derivedConstructed(node.consequent, path, kind, seen)
        && derivedConstructed(node.alternate, path, kind, seen);
      if (node.type === 'LogicalExpression' && node.operator === '??') return derivedConstructed(node.left, path, kind, seen)
        && derivedConstructed(node.right, path, kind, seen);
      if (node.type === 'ObjectExpression') {
        if (path.length) {
          const selected = propertyValue(node, path[0]!);
          return !!selected && derivedConstructed(selected, path.slice(1), kind, seen);
        }
        if (kind !== 'group' || node.properties.some(property => property.type !== 'Property' || staticKey(property) === undefined
          || property.method || property.kind !== 'init' || ['next', ...continuations].includes(staticKey(property)!))) return false;
        const items = node.properties.filter(property => property.type === 'Property' && staticKey(property) === 'items');
        return items.length === 1 && items[0]?.type === 'Property' && derivedConstructed(items[0].value, [], 'array', seen);
      }
      if (node.type === 'ArrayExpression') {
        if (!path.length) return kind === 'array';
        if (path[0] === '*') return node.elements.every(item => !item || (item.type === 'SpreadElement'
          ? derivedConstructed(item.argument, path, kind, seen) : derivedConstructed(item, path.slice(1), kind, seen)));
        const item = node.elements[Number(path[0])];
        return !!item && item.type !== 'SpreadElement' && derivedConstructed(item, path.slice(1), kind, seen);
      }
      const mapSelection = (map: Node, selection: string[]) => constructedItems(map, true)
        && (kind === 'group' && !selection.length || kind === 'array' && selection.length === 1 && selection[0] === 'items');
      if (node.type === 'NewExpression') return path[0] === '*' && path[1] === '1' && mapSelection(node, path.slice(2));
      if (node.type !== 'CallExpression' || node.optional) return false;
      const callee = node.callee;
      if (callee.type === 'Identifier') {
        if (bindings.has(callee.name) || unavailableDeclarations.has(callee.name)) return false;
        const target = declarations.get(callee.name);
        return target ? returnedConstructed(target, path, kind) : importedConstructed?.(callee.name, path, kind) ?? false;
      }
      if (callee.type !== 'MemberExpression') return false;
      const method = staticKey(callee);
      if (method === 'get' && node.arguments.length === 1) return mapSelection(callee.object, path);
      if (method === 'values' && !node.arguments.length && path[0] === '*') return mapSelection(callee.object, path.slice(1));
      if (method === 'filter' && path[0] === '*') return derivedConstructed(callee.object, path, kind, seen);
      const callback = node.arguments[0];
      return path[0] === '*' && ['map', 'flatMap'].includes(method ?? '') && !!callback && isFunction(callback)
        && callback.params.length === 1 && !callback.async
        && returnedConstructed(callback, method === 'flatMap' ? path : path.slice(1), kind);
    };
    const derivedConstructed = (node: Node, path: string[], kind: ConstructedKind, seen = new Set<string>()): boolean => {
      const key = `${fn.start}:${node.type}:${node.start}:${node.end}:${kind}`;
      if (checkingSelections.has(key)) return false;
      checkingSelections.add(key);
      try { return deriveConstructed(node, path, kind, seen); }
      finally { checkingSelections.delete(key); }
    };
    return {
      value,
      constructedItems,
      derivedConstructed,
      returnedConstructed(path: string[], kind: ConstructedKind) {
        return returns.length > 0 && returns.every(output => !!output && derivedConstructed(output, path, kind));
      },
      readOnlyArgument(index: number) {
        const parameter = fn.params[index];
        const target = parameter && address(parameter);
        return !!target && !target.path.includes('*') && untouched(target)
          && !all.some(node => node.type === 'AssignmentExpression' && exposes(node.right, target, false)
            || node.type === 'NewExpression' && node.arguments.some(argument => exposes(argument, target, false))
            || node.type === 'CallExpression' && node.callee.type === 'MemberExpression'
              && ['map', 'filter', 'flatMap', 'find', 'findIndex', 'some', 'every', 'forEach', 'reduce', 'reduceRight'].includes(name(node.callee.property))
              && exposes(node.callee.object, target, false)
              && (!node.arguments[0] || !isFunction(unwrap(node.arguments[0]))
                || (unwrap(node.arguments[0]) as FunctionNode).params.length > 1
                || ['reduce', 'reduceRight'].includes(name(node.callee.property))))
          && returns.every(output => !output || !exposes(output, target, false));
      },
      retains(envelope: Node, at: Node) {
        const target = address(envelope);
        const outputs = returns.filter(output => (!output || output.end >= at.end) && !failed(output));
        return !!target && !target.path.includes('*') && untouched(target) && outputs.length > 0
          && outputs.every(output => !!output && contains(output, target, new Set(), at) && !altered(output, target));
      },
      input(node: Node): boolean {
        node = unwrap(node);
        if (node.type === 'LogicalExpression' && node.operator === '??') return this.input(node.left)
          && (node.right.type === 'Literal' && node.right.value === null || name(node.right) === 'undefined');
        const origin = address(node);
        return !!origin && fn.params.includes(origin.root as typeof fn.params[number]) && !origin.path.includes('*') && untouched(origin, true);
      },
      fabricated(node: Node): boolean {
        node = value(node);
        if (node.type === 'LogicalExpression' && node.operator === '??') return this.fabricated(node.left);
        if (node.type === 'Literal') return node.value !== null;
        return ['BinaryExpression', 'UnaryExpression', 'UpdateExpression'].includes(node.type);
      },
      separate(selection: Node): boolean {
        const depends = (node: Node, seen = new Set<Node>()): boolean => {
          node = value(node);
          if (node === selection) return true;
          if (seen.has(node) || isFunction(node)) return false;
          seen = new Set(seen).add(node);
          return children(node).some(child => depends(child, seen));
        };
        const replaces = (node: Node, seen = new Set<Node>()): boolean => {
          node = value(node);
          if (seen.has(node) || isFunction(node)) return false;
          seen = new Set(seen).add(node);
          if (node.type === 'Property' && (staticKey(node) === 'items' || staticKey(node) === undefined) && depends(node.value)) return true;
          return children(node).some(child => replaces(child, seen));
        };
        return returns.every(output => !output || !replaces(output)) && !all.some(node => node.type === 'AssignmentExpression'
          && node.left.type === 'MemberExpression' && name(node.left.property) === 'items' && depends(node.right));
      },
      projected(callback: Node): boolean {
        if (!isFunction(callback)) return false;
        const parameter = callback.params[0];
        if (parameter?.type !== 'Identifier') return false;
        const projects = (node: Node): boolean => {
          node = value(node);
          if (node.type === 'MemberExpression' || node.type === 'Literal') return true;
          if (node.type === 'Identifier') return node.name === 'undefined';
          if (node.type === 'ArrayExpression') return node.elements.every(item => !item || projects(item));
          if (node.type === 'LogicalExpression') return projects(node.left) && projects(node.right);
          if (node.type === 'ConditionalExpression') return projects(node.consequent) && projects(node.alternate);
          return false;
        };
        return callback.type === 'ArrowFunctionExpression' && callback.expression && projects(callback.body);
      },
      envelope(node: Node): Node | undefined {
        node = value(node);
        if (node.type === 'MemberExpression' && name(node.property) === 'items') return node.object;
        if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression'
          && readMethods.has(name(node.callee.property))) return this.envelope(node.callee.object);
      },
    };
  }
  const forNode = (node: Node) => {
    let current: Node | undefined = node;
    while (current && !isFunction(current)) current = parents.get(current);
    if (!current || !isFunction(current)) return;
    const existing = scopes.get(current);
    if (existing) return existing;
    const flow = scope(current);
    scopes.set(current, flow);
    return flow;
  };
  // A component parameter is construction evidence only if every source use is
  // an explicit call/JSX input with the same proven origin. An opaque reference
  // or a spread that could replace that input invalidates the proof.
  const namedInputs = (identifier: string, path: string[], kind: ConstructedKind): InputProof => {
    if (unavailableDeclarations.has(identifier)) return { valid: false, count: 0 };
    let count = 0;
    const jsxName = (node: Node) => node.type === 'JSXIdentifier' ? node.name : name(node);
    for (const node of programNodes) {
      if (node.type === 'JSXOpeningElement' && jsxName(node.name) === identifier) {
        count++;
        if (!path.length || node.attributes.some(attribute => attribute.type === 'JSXSpreadAttribute')) return { valid: false, count };
        const attributes = node.attributes.filter(attribute => attribute.type === 'JSXAttribute' && jsxName(attribute.name) === path[0]);
        const attribute = attributes[0];
        if (attributes.length !== 1 || attribute?.type !== 'JSXAttribute' || attribute.value?.type !== 'JSXExpressionContainer'
          || attribute.value.expression.type === 'JSXEmptyExpression'
          || !forNode(attribute.value.expression)?.derivedConstructed(attribute.value.expression, path.slice(1), kind)) return { valid: false, count };
      }
      if (node.type === 'JSXIdentifier' && node.name === identifier) {
        const parent = parents.get(node);
        if (parent?.type !== 'JSXOpeningElement' && parent?.type !== 'JSXClosingElement') return { valid: false, count };
      }
      if (node.type !== 'Identifier' || node.name !== identifier) continue;
      const parent = parents.get(node);
      if (parent?.type === 'FunctionDeclaration' && parent.id === node || parent?.type === 'ImportSpecifier'
        || parent?.type === 'Property' && parent.key === node && !parent.computed) continue;
      if (parent?.type !== 'CallExpression' || parent.callee !== node || parent.optional || !parent.arguments[0]) return { valid: false, count };
      count++;
      if (!forNode(parent)?.derivedConstructed(parent.arguments[0], path, kind)) return { valid: false, count };
    }
    return { valid: true, count };
  };
  return {
    readOnlyExport: (name: string, index: number) => {
      const fn = declarations.get(name);
      return !!fn && readOnlyArgument(fn, index);
    },
    constructedExport: (name: string, path: string[], kind: ConstructedKind) => {
      const fn = declarations.get(name);
      return !!fn && returnedConstructed(fn, path, kind);
    },
    namedInputs,
    constructedItems: (envelope: Node, at: Node) => forNode(at)?.derivedConstructed(envelope, [], 'group') ?? false,
    constructedPattern: (pattern: Extract<Node, { type: 'ObjectPattern' }>) => pattern.properties.every(property => property.type === 'Property'
      && (name(property.key) !== 'items' || forNode(property.value)?.derivedConstructed(property.value, [], 'array'))),
    retains: (envelope: Node, at: Node) => forNode(at)?.retains(envelope, at) ?? false,
    input: (node: Node) => forNode(node)?.input(node) ?? false,
    fabricated: (node: Node) => forNode(node)?.fabricated(node) ?? false,
    callable: (node: Node) => { const resolved = forNode(node)?.value(node); return !!resolved && isFunction(resolved); },
    envelope: (node: Node) => forNode(node)?.envelope(node),
    projected: (callback: Node) => forNode(callback)?.projected(callback) ?? false,
    separate: (input: Node, callback: Node) => { const selection = parents.get(callback); return !!selection && (forNode(input)?.separate(selection) ?? false); },
  };
}

/** Named relative imports share the same finite argument proof. No package,
 * namespace, dynamic, ambiguous or recursive binding is assumed read-only. */
export function pageOutputFlows(sources: readonly WebSource[]) {
  const files = new Map(sources.map(file => [file.path, file]));
  const flows = new Map<string, ReturnType<typeof pageOutputFlow>>();
  const importedBindings = new Map<string, Map<string, { path: string; name: string }>>();
  const opaqueImports = new Map<string, Set<string>>();
  const unknownDynamicImports = new Set<string>();
  const inputChecks = new Set<string>();
  const get = (path: string): ReturnType<typeof pageOutputFlow> | undefined => {
    const previous = flows.get(path);
    if (previous) return previous;
    const file = files.get(path);
    if (!file) return;
    const program = webProgram(file);
    const imports = new Map<string, { path: string; name: string }>();
    const opaque = new Set<string>();
    for (const statement of children(program)) {
      const relative = statement.type === 'ImportDeclaration' && statement.importKind !== 'type' ? statement.source
        : (statement.type === 'ExportAllDeclaration' || statement.type === 'ExportNamedDeclaration') && statement.exportKind !== 'type' ? statement.source : null;
      if (!relative || !String(relative.value).startsWith('.')) continue;
      const base = normalize(join(dirname(path), String(relative.value)));
      const target = [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`].find(path => files.has(path));
      if (!target) continue;
      if (statement.type !== 'ImportDeclaration') { opaque.add(target); continue; }
      for (const specifier of statement.specifiers) {
        if (specifier.type === 'ImportSpecifier' && specifier.importKind !== 'type') {
          imports.set(name(specifier.local), { path: target, name: name(specifier.imported) });
        } else if (specifier.type !== 'ImportSpecifier') opaque.add(target);
      }
    }
    const dynamicImports = (node: Node) => {
      if (node.type === 'ImportExpression') {
        if (node.source.type !== 'Literal' || typeof node.source.value !== 'string') unknownDynamicImports.add(path);
        else if (node.source.value.startsWith('.')) {
          const base = normalize(join(dirname(path), node.source.value));
          const target = [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`].find(candidate => files.has(candidate));
          if (target) opaque.add(target);
        }
      }
      for (const child of children(node)) dynamicImports(child);
    };
    dynamicImports(program);
    importedBindings.set(path, imports);
    opaqueImports.set(path, opaque);
    const flow = pageOutputFlow(program, (name, index) => {
      const target = imports.get(name);
      return !!target && (get(target.path)?.readOnlyExport(target.name, index) ?? false);
    }, (name, selection, kind) => {
      const target = imports.get(name);
      return !!target && (get(target.path)?.constructedExport(target.name, selection, kind) ?? false);
    }, (name, selection, kind) => {
      const key = `${path}:${name}:${selection.join('.')}:${kind}`;
      if (inputChecks.has(key)) return { valid: false, count: 0 };
      inputChecks.add(key);
      let count = 0, valid = true;
      for (const file of sources) {
        const candidate = get(file.path);
        if (opaqueImports.get(file.path)?.has(path) || unknownDynamicImports.has(file.path)) valid = false;
        for (const [alias, target] of importedBindings.get(file.path) ?? []) if (target.path === path && target.name === name) {
          const proof = candidate!.namedInputs(alias, selection, kind);
          count += proof.count;
          valid &&= proof.valid;
        }
      }
      inputChecks.delete(key);
      return { valid, count };
    });
    flows.set(path, flow);
    return flow;
  };
  return { get };
}

/** Conservative syntax guard. Projecting items requires an explicit sibling
 * continuation from the same envelope, either directly or through the tested
 * browse URL encoder. A complete batch can reject its remainder before iteration.
 * Read-only aliases can also retain the native envelope in every returned output.
 * Unproved helper calls and loops still need an exact exception.
 * Its syntax context also pins the enclosing function: changing a cap or an
 * alias initializer cannot silently inherit the exception. Trivia stays benign. */
export function continuationInventory(sources: readonly WebSource[]): ContinuationInventory {
  const violations: ContinuationInventory = [];
  const flows = pageOutputFlows(sources);
  for (const file of sources.filter(file => production(file.path))) {
    const program = webProgram(file);
    if (isWebDataModule(program)) continue;
    const linkBuilders = browseLinkBuilders(file, program);
    const flow = flows.get(file.path)!;
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
          return (direct || link) && container.properties.slice(index + 1).every(later =>
            later.type === 'Property' && !later.computed && name(later.key) !== name(property.key));
        });
        if (!forwarded && !completeIteration(node, parent, objectParents) && !completeBatch(node, objectParents)
          && !flow.constructedItems(node.object, node) && !flow.retains(node.object, node)) report('dropped-continuation');
      }
      if (node.type === 'ObjectPattern' && node.properties.some(property =>
        property.type === 'Property' && name(property.key) === 'items') && !flow.constructedPattern(node)) report('dropped-continuation');
      if (node.type === 'Property' && continuations.has(name(node.key))) {
        const direct = (value: Node): boolean => value.type === 'Identifier' && continuations.has(value.name)
          || value.type === 'MemberExpression' && continuations.has(name(value.property))
          || value.type === 'LogicalExpression' && value.operator === '??' && direct(value.left)
            && (value.right.type === 'Identifier' && value.right.name === 'undefined'
              || value.right.type === 'Literal' && value.right.value === null)
          || name(node.key) !== 'nextCursor' && value.type === 'Literal' && value.value === null;
        // A known callable exported as a continuation helper is not a token.
        const callable = flow.callable(node.value);
        if (!(name(node.key) === 'continuation' && callable)
          && ((!direct(node.value) && !flow.input(node.value)) || callable || flow.fabricated(node.value))) report('invented-continuation');
      }
      const modified = node.type === 'AssignmentExpression' ? node.left
        : node.type === 'UpdateExpression' || node.type === 'UnaryExpression' && node.operator === 'delete'
          ? node.argument : undefined;
      if (modified && continuations.has(name(modified))) report('invented-continuation');
      if (node.type === 'VariableDeclarator' && continuations.has(name(node.id)) && node.init
        && !['MemberExpression', 'Identifier', 'Literal'].includes(node.init.type) && !isFunction(node.init)
        && !flow.input(node.init)) report('invented-continuation');
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
