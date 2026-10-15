import { repositoryGlob } from '../lib/repository-files.ts';
import { readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import type { Node } from 'oxc-parser';
import { isWebDataModule, webChildren as children, webProgram } from './web-source-scan.ts';
import type { ListOpenApi } from './list-convention.ts';

export interface WebSource { path: string; source: string }
export interface ContinuationViolation {
  path: string;
  consumer: string;
  operation: string;
  rule: 'dropped-continuation' | 'invented-continuation';
  expression: string;
}
export type ContinuationInventory = ContinuationViolation[];
const production = (path: string) => /\.[cm]?[jt]sx?$/.test(path)
  && !/(?:^|\/)(?:__tests__|fixtures|test|tests)(?:\/|\.)|\.(?:test|spec|stories)\.|(?:^|\/)[^/]*fixtures\./.test(path);
const continuations = new Set(['nextCursor', 'continuation', 'after', 'before', 'cursor']);

function name(node: Node | null | undefined): string {
  if (node?.type === 'Identifier') return node.name;
  if (node?.type === 'Literal') return String(node.value);
  if (node?.type === 'MemberExpression') return name(node.property);
  return '';
}
// Structural text ignores trivia without erasing string values inside opaque tokens.
function syntax(node: Node): string {
  if (node.type === 'Identifier') return name(node);
  if (node.type === 'Literal') return JSON.stringify(node.value);
  if (node.type === 'MemberExpression') return `${syntax(node.object)}${node.optional ? '?' : ''}${node.computed
    ? `[${syntax(node.property)}]` : `.${syntax(node.property)}`}`;
  if (node.type === 'CallExpression') return `${syntax(node.callee)}(${node.arguments.map(syntax).join(',')})`;
  if (node.type === 'ObjectExpression' || node.type === 'ObjectPattern') return `{${node.properties.map(syntax).join(',')}}`;
  if (node.type === 'Property') return `${syntax(node.key)}:${syntax(node.value)}`;
  if (node.type === 'SpreadElement') return `...${syntax(node.argument)}`;
  if (node.type === 'AwaitExpression') return `await ${syntax(node.argument)}`;
  if (node.type === 'ParenthesizedExpression') return `(${syntax(node.expression)})`;
  return JSON.stringify(node, (key, value) => ['start', 'end', 'raw', 'loc', 'range', 'comments'].includes(key) ? undefined : value);
}
interface Unit { file: WebSource; consumer: string; nodes: Node[] }

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
function apiOperation(call: Node): string {
  if (call.type !== 'CallExpression') return '';
  const parts = (node: Node): string[] => node.type === 'MemberExpression'
    ? [...parts(node.object), name(node.property)] : node.type === 'CallExpression'
      ? [...parts(node.callee), ...node.arguments.slice(0, 1).flatMap(argument => argument.type === 'ObjectExpression'
        ? argument.properties.slice(0, 1).flatMap(property => property.type === 'Property' ? [`{${name(property.key)}}`] : []) : [])]
      : [name(node)];
  const route = parts(call.callee);
  const start = route.indexOf('v1');
  return start < 0 ? '' : `${route.at(-1)!.toUpperCase()} /${route.slice(start, -1).join('/')}`;
}

/** Syntax/data-flow guard, not a proof of UI reachability. Each exemption is one
 * offending expression; benign changes and additional forwarding clients need none. */
export function continuationInventory(sources: readonly WebSource[], operations = new Set<string>()): ContinuationInventory {
  const units: Unit[] = [];
  const parents = new WeakMap<Node, Node>();
  const imported = new Map<string, string>();
  const paths = new Set(sources.map(file => file.path));
  const resolve = (path: string, specifier: string) => {
    const target = normalize(join(dirname(path), specifier));
    return [target, `${target}.ts`, `${target}.tsx`, `${target}/index.ts`, `${target}/index.tsx`]
      .find(candidate => paths.has(candidate)) ?? target;
  };
  for (const file of sources.filter(file => production(file.path))) {
    const program = webProgram(file);
    if (isWebDataModule(program)) continue;
    const root: Unit = { file, consumer: '<module>', nodes: [] };
    units.push(root);
    const visit = (node: Node, unit: Unit, parent?: Node) => {
      if (parent) parents.set(node, parent);
      if (node.type === 'ImportDeclaration' && String(node.source.value).startsWith('.')) {
        for (const specifier of node.specifiers) if (specifier.type === 'ImportSpecifier') {
          imported.set(`${file.path}:${name(specifier.local)}`, `${resolve(file.path, String(node.source.value))}:${name(specifier.imported)}`);
        }
      }
      // Anonymous request/map callbacks remain part of their enclosing consumer.
      const consumer = node.type === 'FunctionDeclaration' ? name(node.id)
        : /^(?:ArrowFunctionExpression|FunctionExpression)$/.test(node.type)
          ? parent?.type === 'VariableDeclarator' ? name(parent.id)
            : parent?.type === 'Property' ? name(parent.key)
              : parent?.type === 'CallExpression' && parents.get(parent)?.type === 'VariableDeclarator'
                ? name((parents.get(parent) as Extract<Node, { type: 'VariableDeclarator' }>).id) : ''
          : '';
      if (consumer) { unit = { file, consumer, nodes: [] }; units.push(unit); }
      unit.nodes.push(node);
      for (const child of children(node)) visit(child, unit, node);
    };
    visit(program, root);
  }
  const key = (unit: Unit) => `${unit.file.path}:${unit.consumer}`;
  const callKey = (unit: Unit, callee: Node): string => {
    if (callee.type === 'MemberExpression') {
      let base = callee.object;
      while (base.type === 'AwaitExpression' || base.type === 'ParenthesizedExpression') {
        base = base.type === 'AwaitExpression' ? base.argument : base.expression;
      }
      if (base.type === 'ImportExpression') return `${resolve(unit.file.path, name(base.source))}:${name(callee.property)}`;
      if (base.type === 'CallExpression') {
        const factory = imported.get(`${unit.file.path}:${name(base.callee)}`);
        if (factory) return `${factory.slice(0, factory.lastIndexOf(':'))}:${name(callee.property)}`;
      }
    }
    const local = `${unit.file.path}:${name(callee)}`;
    return imported.get(local) ?? local;
  };
  const paged = new Set<string>();
  const isCap = (node: Node) => node.type === 'Property' && name(node.key) === 'limit';
  for (const unit of units) {
    if (unit.nodes.some(node => isCap(node) || operations.has(apiOperation(node)) || node.type === 'MemberExpression'
      && continuations.has(name(node.property)))) paged.add(key(unit));
  }
  // Propagate page-producing adapters, including consumers loaded with import().
  for (let changed = true; changed;) {
    changed = false;
    for (const unit of units) if (!paged.has(key(unit)) && unit.nodes.some(node =>
      node.type === 'CallExpression' && paged.has(callKey(unit, node.callee)))) {
      paged.add(key(unit)); changed = true;
    }
  }
  const violations: ContinuationInventory = [];
  for (const unit of units) {
    const variables = new Map<string, Node | null>();
    for (const node of unit.nodes) if (node.type === 'VariableDeclarator') {
      variables.set(name(node.id), node.init);
      if (node.id.type === 'ArrayPattern' && node.init?.type === 'AwaitExpression'
        && node.init.argument.type === 'CallExpression' && node.init.argument.arguments[0]?.type === 'ArrayExpression') {
        const inputs = node.init.argument.arguments[0].elements;
        node.id.elements.forEach((item, index) => { if (item) variables.set(name(item), inputs[index] ?? null); });
      }
    }
    for (const node of unit.nodes) if (node.type === 'AssignmentExpression' && node.left.type === 'Identifier') {
      variables.set(node.left.name, node.operator === '=' ? node.right : node);
    }
    const callOf = (node: Node | null | undefined, seen = new Set<Node>()): Node | undefined => {
      if (!node || seen.has(node)) return;
      seen.add(node);
      if (node.type === 'Identifier') {
        const initializer = variables.get(node.name);
        if (initializer) return callOf(initializer, seen);
        const parameter = unit.nodes.find(candidate =>
          /^(?:ArrowFunctionExpression|FunctionExpression)$/.test(candidate.type)
          && 'params' in candidate && candidate.params.some(param => name(param) === node.name));
        const caller = parameter && parents.get(parameter);
        if (caller?.type === 'CallExpression' && caller.callee.type === 'MemberExpression'
          && name(caller.callee.property) === 'then') return callOf(caller.callee.object, seen);
      }
      if (node.type === 'MemberExpression') return callOf(node.object, seen);
      if (node.type === 'TSAsExpression' || node.type === 'TSNonNullExpression'
        || node.type === 'ChainExpression' || node.type === 'ParenthesizedExpression') return callOf(node.expression, seen);
      if (node.type === 'AwaitExpression') return callOf(node.argument, seen);
      if (node.type === 'CallExpression') {
        if (node.callee.type === 'Identifier' && variables.get(node.callee.name)) {
          return callOf(variables.get(node.callee.name), seen);
        }
        if (paged.has(callKey(unit, node.callee)) || ['get', 'post', 'fetch'].includes(name(node.callee))) return node;
        for (const child of children(node)) {
          const found = callOf(child, seen);
          if (found) return found;
        }
      }
      if ((node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression') && node.body) {
        for (const child of children(node.body)) {
          const found = callOf(child, seen);
          if (found) return found;
        }
        return callOf(node.body, seen);
      }
      if (node.type === 'ReturnStatement') return callOf(node.argument, seen);
      return;
    };
    const capped = (call: Node) => {
      if (operations.has(apiOperation(call))) return true;
      const nodes = [call];
      while (nodes.length) {
        const node = nodes.pop()!;
        if (isCap(node)) return true;
        nodes.push(...children(node));
      }
      return call.type === 'CallExpression' && paged.has(callKey(unit, call.callee));
    };
    const operation = (call?: Node) => call?.type === 'CallExpression'
      ? apiOperation(call) || syntax(call.callee) : '<continuation>';
    const report = (node: Node, rule: ContinuationViolation['rule'], call?: Node) => {
      if (call && violations.some(item => item.path === unit.file.path && item.consumer === unit.consumer
        && item.rule === rule && item.expression.endsWith(` <- ${syntax(call)}`))) return;
      violations.push({ path: unit.file.path, consumer: unit.consumer, operation: operation(call), rule,
        expression: `${syntax(node)}${call ? ` <- ${syntax(call)}` : ''}` });
    };
    const same = (left: Node | undefined, right: Node) => left && syntax(left) === syntax(right);
    const arrayValue = (node: Node, seen = new Set<Node>()): boolean => {
      if (seen.has(node)) return false;
      seen.add(node);
      if (node.type === 'Identifier' && variables.get(node.name)) return arrayValue(variables.get(node.name)!, seen);
      if (node.type === 'MemberExpression' && name(node.property) === 'items') return true;
      return children(node).some(child => arrayValue(child, seen));
    };
    const used = (node: Node): boolean => {
      const parent = parents.get(node);
      const binding = parent?.type === 'VariableDeclarator' ? name(parent.id)
        : parent?.type === 'AssignmentExpression' ? name(parent.left) : '';
      return !binding || unit.nodes.some(candidate => candidate !== node && candidate.type === 'Identifier'
        && candidate.name === binding && parents.get(candidate) !== parent
        && !(parents.get(candidate)?.type === 'Property'
          && (parents.get(candidate) as Extract<Node, { type: 'Property' }>).key === candidate));
    };
    const loop = unit.nodes.some(node => ['ForStatement', 'WhileStatement', 'DoWhileStatement'].includes(node.type));
    const returnedArray = (node: Node, seen = new Set<Node>()): boolean => {
      if (seen.has(node)) return false;
      seen.add(node);
      if (node.type === 'Identifier' && variables.get(node.name)) return returnedArray(variables.get(node.name)!, seen);
      if (node.type === 'ArrayExpression') return true;
      if (node.type === 'ObjectExpression') return !node.properties.some(property => property.type === 'Property'
        && continuations.has(name(property.key))) && node.properties.some(property => property.type === 'Property'
          && returnedArray(property.value, seen));
      return node.type === 'CallExpression' && ['map', 'flatMap', 'filter', 'slice'].includes(name(node.callee));
    };
    for (const node of unit.nodes) {
      const parent = parents.get(node);
      const destructured = node.type === 'Property' && parent?.type === 'ObjectPattern' && name(node.key) === 'items';
      if (node.type === 'MemberExpression' && name(node.property) === 'items' || destructured) {
        const declaration = destructured && parents.get(parent!);
        const input = node.type === 'MemberExpression' ? node.object
          : declaration && declaration.type === 'VariableDeclarator' ? declaration.init : undefined;
        const call = callOf(input);
        if (!call || !capped(call)) continue;
        const remainder = (destructured && parent?.type === 'ObjectPattern' && parent.properties.some(property =>
          property.type === 'Property' && continuations.has(name(property.key)) && unit.nodes.some(reference =>
            reference.type === 'Identifier' && reference.name === name(property.value) && parents.get(reference) !== property
            && !(parents.get(reference)?.type === 'Property'
              && (parents.get(reference) as Extract<Node, { type: 'Property' }>).key === reference)))) || unit.nodes.some(candidate => {
          if (candidate.type === 'MemberExpression' && continuations.has(name(candidate.property))
            && used(candidate) && same(callOf(candidate.object), call)) return true;
          if (candidate.type !== 'Identifier' && !(candidate.type === 'MemberExpression'
            && ['data', 'result'].includes(name(candidate.property)))) return false;
          const parent = parents.get(candidate);
          const branch = parent && parents.get(parent);
          if (parent?.type === 'ReturnStatement' && branch?.type === 'IfStatement'
            && branch.test.type === 'UnaryExpression' && branch.test.operator === '!') return false;
          return parent && ['ReturnStatement', 'SpreadElement', 'JSXExpressionContainer', 'Property', 'CallExpression']
            .includes(parent.type) && !(parent.type === 'CallExpression' && parent.callee === candidate)
            && !(parent.type === 'Property' && parent.value !== candidate)
            && !arrayValue(candidate) && same(callOf(candidate), call);
        });
        if (!remainder) report(node, 'dropped-continuation', call);
      }
      const modified = node.type === 'UnaryExpression' && node.operator === 'delete' ? node.argument
        : node.type === 'AssignmentExpression' ? node.left : undefined;
      if (modified?.type === 'MemberExpression' && continuations.has(name(modified.property))) {
        const call = callOf(modified.object);
        if (call && capped(call)) report(node, 'dropped-continuation', call);
      }
      if (loop && node.type === 'ReturnStatement' && node.argument) {
        const value = node.argument.type === 'Identifier' ? variables.get(node.argument.name) : node.argument;
        if (value && returnedArray(value)) {
          const call = unit.nodes.find(candidate => candidate.type === 'CallExpression' && capped(candidate)
            && ['get', 'post', 'fetch'].includes(name(candidate.callee)));
          if (call) report(node, 'dropped-continuation', call);
        }
      }
      if (node.type === 'Property' && continuations.has(name(node.key))) {
        let request = name(node.key) === 'nextCursor';
        for (let ancestor = parent; ancestor; ancestor = parents.get(ancestor)) {
          if (ancestor.type === 'CallExpression' && (['get', 'post', 'fetch'].includes(name(ancestor.callee))
            || paged.has(callKey(unit, ancestor.callee)))) request = true;
        }
        const invented = (value: Node, seen = new Set<Node>()): boolean => {
          if (seen.has(value)) return false;
          seen.add(value);
          if (value.type === 'Identifier' && variables.get(value.name)) return invented(variables.get(value.name)!, seen);
          if (['BinaryExpression', 'TemplateLiteral', 'UpdateExpression', 'AssignmentExpression'].includes(value.type)) return true;
          if (value.type === 'Literal' && value.value !== null) return request;
          if (value.type === 'CallExpression' && ['Number', 'String', 'parseInt', 'parseFloat', 'trim', 'slice', 'replace']
            .includes(name(value.callee))) return true;
          return false;
        };
        if (invented(node.value)) report(node, 'invented-continuation');
        if (name(node.key) === 'nextCursor' && node.value.type === 'Literal' && node.value.value === null
          && parent?.type === 'ObjectExpression') {
          for (const property of parent.properties) if (property.type === 'SpreadElement'
            || property.type === 'Property' && name(property.key) === 'items') {
            const call = callOf(property.type === 'SpreadElement' ? property.argument : property.value);
            if (call && capped(call)) report(node, 'dropped-continuation', call);
          }
        }
      }
    }
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
