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

type FunctionNode = Extract<Node, { type: 'FunctionDeclaration' | 'FunctionExpression' | 'ArrowFunctionExpression' }>;
const isFunction = (node: Node): node is FunctionNode => ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(node.type);
const unwrap = (node: Node): Node => ['TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression', 'ParenthesizedExpression', 'ChainExpression'].includes(node.type)
  ? unwrap((node as Extract<Node, { expression: Node }>).expression) : node;
const staticKey = (node: Extract<Node, { type: 'Property' | 'MemberExpression' }>): string | undefined => {
  const key = node.type === 'Property' ? node.key : node.property;
  return !node.computed || key.type === 'Literal' ? name(key) : undefined;
};
interface Address { root: Node; path: string[]; element?: boolean }
interface Binding { value: Node; path: string[]; parameter?: boolean }

/** Local, read-only evidence for native envelopes and incoming positions. Unknown
 * calls/branches/spreads cannot prove retention; aliases never outlive a write.
 * Both inventories use the same output lifetime, rather than naming enrichments. */
export function pageOutputFlow(program: Node) {
  const parents = new WeakMap<Node, Node>();
  const index = (node: Node) => { for (const child of children(node)) { parents.set(child, node); index(child); } };
  index(program);
  const scopes = new WeakMap<Node, ReturnType<typeof scope>>();
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
      if (node.type === 'CallExpression' || node.type === 'ObjectExpression') return { root: node, path: [] };
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
    const untouched = (target: Address, token = false) => !all.some(node => {
      const modified = node.type === 'AssignmentExpression' ? node.left
        : node.type === 'UpdateExpression' || node.type === 'UnaryExpression' && node.operator === 'delete' ? node.argument : undefined;
      if (modified && writes(modified).some(item => {
        const write = address(item);
        return write && (prefix(write, target) || prefix(target, write));
      })) return true;
      if (node.type === 'VariableDeclarator' && node.init && node.id.type === 'ObjectPattern'
        && node.id.properties.some(property => property.type === 'RestElement') && exposes(node.init, target, token)) return true;
      if (node.type !== 'CallExpression') return false;
      if (node.arguments.some(argument => exposes(argument, target, token))) return true;
      const receiver = node.callee.type === 'MemberExpression' ? address(node.callee.object) : undefined;
      return !token && !!receiver && (prefix(receiver, target) || prefix(target, receiver))
        && node.callee.type === 'MemberExpression' && !readMethods.has(name(node.callee.property));
    });
    const contains = (node: Node, target: Address, seen = new Set<Node>()): boolean => {
      if (same(address(node), target)) return true;
      node = value(node);
      if (seen.has(node)) return false;
      seen = new Set(seen).add(node);
      if (node.type === 'ConditionalExpression') return contains(node.consequent, target, seen) && contains(node.alternate, target, seen);
      if (node.type === 'LogicalExpression') return contains(node.left, target, seen) && contains(node.right, target, seen);
      if (node.type === 'ArrayExpression') return node.elements.some(item => item && item.type !== 'SpreadElement' && contains(item, target, seen));
      if (node.type !== 'ObjectExpression') return false;
      const keys = new Set<string>();
      const fields = (object: Extract<Node, { type: 'ObjectExpression' }>): boolean => {
        for (const property of [...object.properties].reverse()) {
          if (property.type === 'SpreadElement') {
            if (same(address(property.argument), target)) {
              if (![...keys].some(key => key === 'items' || key === 'next' || continuations.has(key))) return true;
            } else {
              const spread = value(property.argument);
              if (spread.type !== 'ObjectExpression') return false;
              if (fields(spread)) return true;
            }
          } else {
            const key = staticKey(property);
            if (key === undefined) return false;
            if (!keys.has(key)) {
              keys.add(key);
              if (property.kind === 'init' && !property.method && contains(property.value, target, seen)) return true;
            }
          }
        }
        return false;
      };
      return fields(node);
    };
    const returns = fn.type === 'ArrowFunctionExpression' && fn.expression ? [fn.body]
      : nodes.flatMap(node => node.type === 'ReturnStatement' ? [node.argument] : []);
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
    return {
      value,
      retains(envelope: Node, at: Node) {
        const target = address(envelope);
        const outputs = returns.filter(output => !output || output.end >= at.end);
        return !!target && !target.path.includes('*') && untouched(target) && outputs.length > 0
          && outputs.every(output => !!output && contains(output, target) && !altered(output, target));
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
  return {
    retains: (envelope: Node, at: Node) => forNode(at)?.retains(envelope, at) ?? false,
    input: (node: Node) => forNode(node)?.input(node) ?? false,
    fabricated: (node: Node) => forNode(node)?.fabricated(node) ?? false,
    callable: (node: Node) => { const resolved = forNode(node)?.value(node); return !!resolved && isFunction(resolved); },
    envelope: (node: Node) => forNode(node)?.envelope(node),
    projected: (callback: Node) => forNode(callback)?.projected(callback) ?? false,
    separate: (input: Node, callback: Node) => { const selection = parents.get(callback); return !!selection && (forNode(input)?.separate(selection) ?? false); },
  };
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
  for (const file of sources.filter(file => production(file.path))) {
    const program = webProgram(file);
    if (isWebDataModule(program)) continue;
    const linkBuilders = browseLinkBuilders(file, program);
    const flow = pageOutputFlow(program);
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
        if (!forwarded && !completeIteration(node, parent, objectParents) && !flow.retains(node.object, node)) report('dropped-continuation');
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
