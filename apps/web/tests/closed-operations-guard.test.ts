import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript-6';
import {
  operationExposures,
  type PlatformOperationId,
} from '../../../generated/openapi/main/exposure.ts';
import { escape, operationPattern, readWebSources, sources } from './support/eden-calls.ts';

// A refused request cannot protect the control that offered it. Inventory closed calls and their UI
// predicates separately; Main's generated exposure remains the only source of platform policy.

const closedIds = (Object.keys(operationExposures) as PlatformOperationId[]).filter(
  (id) => operationExposures[id] !== 'public',
);
const publicIds = Object.keys(operationExposures);
const spec = JSON.parse(readFileSync(join(import.meta.dir, '../../../generated/openapi/main/public.json'), 'utf8')) as {
  paths: Record<string, Record<string, { operationId?: string }>>;
};
const closedRoutes = Object.entries(spec.paths).flatMap(([path, methods]) => Object.entries(methods)
  .filter(([, value]) => value.operationId && closedIds.includes(value.operationId as PlatformOperationId))
  .map(([method, value]) => ({ method, segments: path.split('/').slice(2), operation: value.operationId as PlatformOperationId })));

export interface Call {
  /** Where the operation was recognised, for the failure message. */
  source: string;
  operations: PlatformOperationId[];
}

interface LocatedCall extends Call { node: ts.Node }

function parse(text: string): ts.SourceFile {
  return ts.createSourceFile('source.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

/** Resolve only the named binding/property; a gate in a neighbouring object member is unrelated. */
const scopeBindings = new WeakMap<ts.Node, Map<string, { value?: ts.Expression; position: number; assigned: boolean }[]>>();
function binding(node: ts.Identifier): ts.Expression | undefined {
  let scope: ts.Node | undefined = node.parent;
  while (scope) {
    if (ts.isBlock(scope) || ts.isSourceFile(scope) || ts.isFunctionLike(scope)) {
      let bindings = scopeBindings.get(scope);
      if (!bindings) {
        bindings = new Map();
        const add = (name: string, value: ts.Expression | undefined, position: number, assigned = false) =>
          bindings!.set(name, [...bindings!.get(name) ?? [], { value, position, assigned }]);
        function visit(child: ts.Node) {
          if (child !== scope && ts.isBlock(child)) return;
          if (child !== scope && ts.isFunctionLike(child)) {
            if (ts.isFunctionDeclaration(child) && child.name) add(child.name.text, child as unknown as ts.Expression, child.pos);
            return;
          }
          if (ts.isVariableDeclaration(child) && ts.isIdentifier(child.name)) add(child.name.text, child.initializer, child.pos);
          if (ts.isParameter(child) && ts.isIdentifier(child.name)) add(child.name.text, undefined, child.pos);
          if (ts.isBinaryExpression(child) && child.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(child.left))
            add(child.left.text, child.right, child.getStart(), true);
          ts.forEachChild(child, visit);
        }
        visit(scope);
        scopeBindings.set(scope, bindings);
      }
      const candidates = bindings.get(node.text)?.filter(item => !item.assigned || item.position < node.getStart());
      if (candidates?.length) return candidates.at(-1)!.value;
    }
    scope = scope.parent;
  }
  return undefined;
}

function resolved(node: ts.Expression, seen = new Set<ts.Node>(), props = new Map<string, ts.Expression>()): ts.Expression {
  if (seen.has(node)) return node;
  seen.add(node);
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node))
    return resolved(node.expression, seen, props);
  if (ts.isIdentifier(node)) {
    const value = props.get(node.text) ?? binding(node);
    if (value) return resolved(value, seen, props);
  }
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    const value = resolved(node.expression, seen, props);
    const name = ts.isPropertyAccessExpression(node) ? node.name.text :
      node.argumentExpression && ts.isStringLiteralLike(node.argumentExpression) ? node.argumentExpression.text : null;
    if (name && ts.isObjectLiteralExpression(value)) {
      const property = value.properties.find(item => item.name?.getText().replace(/^['"]|['"]$/g, '') === name);
      if (property && ts.isPropertyAssignment(property)) return resolved(property.initializer, seen, props);
    }
  }
  return node;
}

/** Eden routes are followed through bindings, assignments, returned clients and parameter calls. */
function route(node: ts.Expression, seen = new Set<ts.Node>()): (string | null)[] | null {
  if (seen.has(node)) return null;
  seen.add(node);
  const value = resolved(node);
  if (value !== node) return route(value, seen);
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    const name = ts.isPropertyAccessExpression(node) ? node.name.text :
      node.argumentExpression && ts.isStringLiteralLike(node.argumentExpression) ? node.argumentExpression.text : null;
    if (name === 'v1') return [];
    const parent = route(node.expression, seen);
    return parent && name ? [...parent, name] : null;
  }
  if (ts.isCallExpression(node)) {
    const target = resolved(node.expression);
    if (ts.isArrowFunction(target) || ts.isFunctionExpression(target) || ts.isFunctionDeclaration(target)) {
      const body = target.body;
      if (body && !ts.isBlock(body)) return route(body, seen);
      const returned: ts.Expression[] = [];
      function visit(child: ts.Node) {
        if (child !== body && ts.isFunctionLike(child)) return;
        if (ts.isReturnStatement(child) && child.expression) returned.push(child.expression);
        ts.forEachChild(child, visit);
      }
      if (body) visit(body);
      const routes = returned.map(item => route(item, new Set(seen)));
      if (routes.length && routes.every(item => JSON.stringify(item) === JSON.stringify(routes[0]))) return routes[0]!;
      return null;
    }
    const parent = route(node.expression, seen);
    return parent ? [...parent, null] : null;
  }
  return null;
}

function closedCalls(source: ts.SourceFile): LocatedCall[] {
  const calls: LocatedCall[] = [];
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node)) {
      const endpoint = resolved(node.expression);
      if (!ts.isPropertyAccessExpression(endpoint) && !ts.isElementAccessExpression(endpoint)) { ts.forEachChild(node, visit); return; }
      const method = ts.isPropertyAccessExpression(endpoint) ? endpoint.name.text :
        endpoint.argumentExpression && ts.isStringLiteralLike(endpoint.argumentExpression) ? endpoint.argumentExpression.text : null;
      const segments = route(endpoint.expression);
      if (method && ['get', 'post', 'put', 'patch', 'delete'].includes(method) && segments) {
        const operations = closedRoutes.filter(item => item.method === method && item.segments.length === segments.length &&
          item.segments.every((segment, index) => /^\{[^}]+\}$/.test(segment) ? segments[index] === null : segment === segments[index]))
          .map(item => item.operation);
        if (operations.length) {
          const text = node.getText().replace(/\s+/g, '');
          calls.push({ source: text.includes('.v1') ? text.slice(text.indexOf('.v1')) : text, operations, node });
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return calls;
}

const literal =
  /(?<quote>['"])(?<single>(?:\/api\/main)?\/v1\/[^'"\s]*)\k<quote>|`(?:\$\{[^}]*\})?(?<template>(?:\/api\/main)?\/v1\/(?:[^`$]|\$\{[^}]*\})*)`/g;

/** HTTP methods named right after a path literal (`method: 'POST'`, a `'PUT'` argument); a bare path is a GET. */
function methodsAfter(text: string, end: number): string[] {
  const window = text.slice(end, end + 250);
  const next = window.indexOf('/v1/');
  const found = [
    ...(next < 0 ? window : window.slice(0, next)).matchAll(
      /method:\s*['"](\w+)['"]|['"](GET|POST|PUT|PATCH|DELETE)['"]/g,
    ),
  ].map((item) => (item[1] ?? item[2]!).toLowerCase());
  return found.length ? found : ['get'];
}

/** Operations named by a path literal such as `'/v1/me/saved-filters'` or `` `/v1/realms/${id}/join-page` ``. */
function pathCalls(text: string): Call[] {
  const calls: Call[] = [];
  for (const found of text.matchAll(literal)) {
    const path = (found.groups!.single ?? found.groups!.template!)
      .replace(/^\/api\/main/, '')
      .split('?')[0]!;
    // `/v1/media/` is a prefix test, not a request.
    if (path.endsWith('/')) continue;
    const segments = path.split('/').slice(2);
    const operations = methodsAfter(text, found.index + found[0].length).flatMap((method) =>
      closedRoutes.filter(route => route.method === method && route.segments.length === segments.length &&
        route.segments.every((segment, index) => /^\{[^}]+\}$/.test(segment) || segment === segments[index]))
        .map(route => route.operation),
    );
    if (operations.length) calls.push({ source: path, operations });
  }
  return calls;
}

/** A projection follower's response type identifies the owning Eden route, including indirect Hub reads. */
function projectedTypes(files: Readonly<Record<string, string>>): Map<string, PlatformOperationId[]> {
  const types = new Map<string, PlatformOperationId[]>();
  for (const text of Object.values(files)) {
    for (const match of text.matchAll(/\btype\s+(\w+)\s*=\s*[^;\n]*?ReturnType<Main(?:Client)?((?:\['[^']+'\])+)>\['get'\]/g)) {
      const segments = [...match[2]!.matchAll(/\['([^']+)'\]/g)].map(part => part[1]!);
      if (segments.shift() !== 'v1') continue;
      const operations = closedIds.filter(id => operationPattern('get', segments, true).test(id));
      if (operations.length) types.set(match[1]!, operations);
    }
  }
  return types;
}

function uncommented(text: string): string {
  const parsed = ts.createSourceFile('source.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const ranges = new Map<number, number>();
  function visit(node: ts.Node) {
    for (const position of [node.pos, node.end]) for (const range of [
      ...ts.getLeadingCommentRanges(text, position) ?? [], ...ts.getTrailingCommentRanges(text, position) ?? [],
    ]) ranges.set(range.pos, range.end);
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  for (const [start, end] of [...ranges].sort(([left], [right]) => right - left)) {
    text = text.slice(0, start) + text.slice(start, end).replace(/[^\n]/g, ' ') + text.slice(end);
  }
  return text;
}

function locatedCalls(text: string, projected = new Map<string, PlatformOperationId[]>()): LocatedCall[] {
  const source = parse(uncommented(text));
  const calls = closedCalls(source);
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const name = node.expression.getText();
      if (/^(?:fetch|fetchImpl|serverRead|URL)$/.test(name) && node.arguments?.[0]) {
        const path = resolved(node.arguments[0]);
        const scanned = pathCalls(path.getText() + ', ' + (node.arguments[1]?.getText() ?? ''));
        calls.push(...scanned.map(call => ({ ...call, node })));
      }
      if (ts.isCallExpression(node) && name === 'followHref') {
        const types = node.typeArguments?.map(item => item.getText()).join(' ') ?? '';
        const operations = [...projected].filter(([type]) => new RegExp(`\\b${escape(type)}\\b`).test(types)).flatMap(([, ids]) => ids);
        if (operations.length) calls.push({ source: `followHref<${types}>`, operations, node });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return calls;
}

export function callsIn(text: string, projected = new Map<string, PlatformOperationId[]>()): Call[] {
  return locatedCalls(text, projected).map(({ source, operations }) => ({ source, operations }));
}

/** Possible boolean results with this operation denied. Unknown predicates may be either value. */
function deniedValues(node: ts.Expression, operation: string, seen = new Set<ts.Node>(), props = new Map<string, ts.Expression>()): Set<boolean> {
  if (seen.has(node)) return new Set([true, false]);
  seen.add(node);
  const value = resolved(node, new Set(), props);
  if (value !== node) return deniedValues(value, operation, seen, props);
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && ['operationOpen', 'gate'].includes(node.expression.text) &&
    node.arguments[0] && ts.isStringLiteralLike(node.arguments[0]) && node.arguments[0].text === operation) return new Set([false]);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return new Set([true]);
  if (node.kind === ts.SyntaxKind.FalseKeyword || node.kind === ts.SyntaxKind.NullKeyword) return new Set([false]);
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken)
    return new Set([...deniedValues(node.operand, operation, new Set(seen), props)].map(item => !item));
  if (ts.isBinaryExpression(node)) {
    const left = deniedValues(node.left, operation, new Set(seen), props);
    const right = deniedValues(node.right, operation, new Set(seen), props);
    if (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken)
      return new Set([...left].flatMap(a => [...right].map(b => a && b)));
    if (node.operatorToken.kind === ts.SyntaxKind.BarBarToken)
      return new Set([...left].flatMap(a => [...right].map(b => a || b)));
    if ([ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken].includes(node.operatorToken.kind) &&
      (node.right.kind === ts.SyntaxKind.TrueKeyword || node.right.kind === ts.SyntaxKind.FalseKeyword))
      return new Set([...left].map(item => item === (node.right.kind === ts.SyntaxKind.TrueKeyword)));
  }
  return new Set([true, false]);
}

function entailsOpen(condition: ts.Expression, operation: string, branch: boolean, props = new Map<string, ts.Expression>()): boolean {
  return !deniedValues(condition, operation, new Set(), props).has(branch);
}

function terminates(node: ts.Node): boolean {
  if (ts.isReturnStatement(node) || ts.isThrowStatement(node)) return true;
  if (ts.isBlock(node)) return node.statements.some(terminates);
  if (ts.isIfStatement(node)) return Boolean(node.elseStatement && terminates(node.thenStatement) && terminates(node.elseStatement));
  return false;
}

/** Only ancestor branches and preceding exits can dominate this exact request expression. */
function requestGuarded(node: ts.Node, operation: string, props = new Map<string, ts.Expression>()): boolean {
  let child = node;
  for (let parent = node.parent; parent; child = parent, parent = parent.parent) {
    if (ts.isJsxElement(parent) && child !== parent.openingElement) {
      const opening = parent.openingElement;
      if (opening.tagName.getText() === 'OperationGate') {
        const attribute = opening.attributes.properties.find(item => ts.isJsxAttribute(item) && item.name.getText() === 'operation');
        if (attribute && ts.isJsxAttribute(attribute) && attribute.initializer && ts.isStringLiteral(attribute.initializer) &&
          attribute.initializer.text === operation) return true;
      }
    }
    if (ts.isConditionalExpression(parent)) {
      if (child === parent.whenTrue && entailsOpen(parent.condition, operation, true, props)) return true;
      if (child === parent.whenFalse && entailsOpen(parent.condition, operation, false, props)) return true;
    }
    if (ts.isIfStatement(parent)) {
      if (child === parent.thenStatement && entailsOpen(parent.expression, operation, true, props)) return true;
      if (child === parent.elseStatement && entailsOpen(parent.expression, operation, false, props)) return true;
    }
    if (ts.isBinaryExpression(parent) && child === parent.right) {
      const branch = parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ? true :
        parent.operatorToken.kind === ts.SyntaxKind.BarBarToken ? false : null;
      if (branch !== null && entailsOpen(parent.left, operation, branch, props)) return true;
    }
    if (ts.isBlock(parent) || ts.isSourceFile(parent)) {
      for (const statement of parent.statements) {
        if (statement === child || statement.end > child.pos) break;
        if (ts.isIfStatement(statement)) {
          if (terminates(statement.thenStatement) && entailsOpen(statement.expression, operation, false, props)) return true;
          if (statement.elseStatement && terminates(statement.elseStatement) && entailsOpen(statement.expression, operation, true, props)) return true;
        }
      }
    }
    // A separately declared function can be called from anywhere; its caller's lexical body is no proof.
    if (ts.isFunctionDeclaration(parent) || (ts.isArrowFunction(parent) && ts.isVariableDeclaration(parent.parent))) break;
  }
  return false;
}

export function violations(files: Readonly<Record<string, string>>): string[] {
  const projected = projectedTypes(files);
  return Object.entries(files).flatMap(([file, text]) => locatedCalls(text, projected).flatMap(call =>
    call.operations.filter(operation => !requestGuarded(call.node, operation)).map(operation =>
      `${file}: ${call.source} reaches ${operation} (${operationExposures[operation]})`)));
}

const webRoot = join(import.meta.dir, '..');
const webSources = {
  ...readWebSources(),
  ...Object.fromEntries(sources(join(webRoot, 'zones')).map(path => [relative(webRoot, path), readFileSync(path, 'utf8')])),
};

// Regression entry inventory, not an exposure matrix: these are the concrete controls from the sweep.
// Component/stories prove their rendered states; this guard also fails when an entry loses its predicate.
type Target =
  | { jsx: string; prop?: string; value?: string; text?: string }
  | { attribute: readonly [string, string] }
  | { call: readonly [string, string] }
  | { binding: string }
  | { branch: readonly [string, string] };
interface Entry {
  file: string;
  function: string;
  operations: readonly PlatformOperationId[];
  request?: boolean;
  targets?: Partial<Record<PlatformOperationId, readonly Target[]>>;
}
const entries: readonly Entry[] = [
  { file: 'features/work-page/work-views.tsx', function: 'WorkOverview', operations: ['getV1HubWorksById'],
    targets: { getV1HubWorksById: [{ branch: ["experience.kind === 'prompt'", 'specialist'] }] } },
  { file: 'features/feed/actions.tsx', function: 'PrimaryAction', operations: ['getV1HubWorksById'],
    targets: { getV1HubWorksById: [{ call: ['link', 'install'] }, { call: ['link', 'usePrompt'] }] } },
  { file: 'features/showcase/work-action.tsx', function: 'PrimaryAction', operations: ['getV1HubWorksById'],
    targets: { getV1HubWorksById: [{ branch: ["work.hub?.kind === 'skill'", 'action'] }] } },
  { file: 'zones/official/ai-workshop/slots.tsx', function: 'Actions', operations: ['getV1HubWorksById'],
    targets: { getV1HubWorksById: [{ branch: ['hub', 'tryIt'] }] } },
  { file: 'features/realm-appeal/panel.tsx', function: 'RealmBanPanel', operations: [
    'postV1RealmsByRealmMember-receiptsByReceiptIdAppeal', 'getV1RealmsByRealmMember-receiptsByReceiptIdAppeal',
  ], targets: {
    'postV1RealmsByRealmMember-receiptsByReceiptIdAppeal': [{ jsx: 'form' }],
    'getV1RealmsByRealmMember-receiptsByReceiptIdAppeal': [{ jsx: 'form' }],
  } },
  { file: 'features/home/pin-picker.tsx', function: 'PinPicker', operations: [
    'getV1MeSaved-filters', 'postV1MeSaved-filters', 'patchV1MeSaved-filtersById',
  ], targets: {
    'getV1MeSaved-filters': [{ binding: 'visibleFilters' }, { jsx: 'SaveCurrent' }, { attribute: ['TopicSearch', 'unpinned'] }],
    'postV1MeSaved-filters': [{ jsx: 'SaveCurrent' }],
    'patchV1MeSaved-filtersById': [{ attribute: ['TopicSearch', 'unpinned'] }],
  } },
  { file: 'features/home/tabs.tsx', function: 'HomeTabs', operations: [
    'getV1MeSaved-filters', 'patchV1MeSaved-filtersById', 'putV1MeSaved-filtersOrder', 'deleteV1MeSaved-filtersById',
  ], targets: {
    'getV1MeSaved-filters': [{ binding: 'visibleFilters' }],
    'patchV1MeSaved-filtersById': [{ jsx: 'RenameDialog' }, { jsx: 'MenuItem', prop: 'value', value: 'rename' }, { jsx: 'MenuItem', prop: 'value', value: 'unpin' }],
    'putV1MeSaved-filtersOrder': [{ attribute: ['li', 'draggable'] }, { jsx: 'MenuItem', prop: 'value', value: 'left' }, { jsx: 'MenuItem', prop: 'value', value: 'right' }],
    'deleteV1MeSaved-filtersById': [{ jsx: 'MenuItem', prop: 'value', value: 'delete' }],
  } },
  { file: 'features/post-composer/api.ts', function: 'banned', operations: ['getV1RealmsByRealmMember-ban'], request: true },
  { file: 'features/zones/about-discussion.tsx', function: 'AboutDiscussionEntry', operations: ['postV1RealmsByRealmAbout-posts'],
    targets: { 'postV1RealmsByRealmAbout-posts': [{ jsx: 'form' }, { jsx: 'Button', prop: 'onClick', text: 'setOpened' }] } },
];

function hasPredicate(body: ts.Node, operation: string, request = false, props = new Map<string, ts.Expression>(), visited = new Set<string>()): boolean {
  const nestedFunction = (node: ts.Node) => ts.isFunctionLike(node);
  function absent(node: ts.Expression): boolean {
    const value = resolved(node, new Set(), props);
    return value.kind === ts.SyntaxKind.NullKeyword || value.kind === ts.SyntaxKind.FalseKeyword ||
      (ts.isIdentifier(value) && value.text === 'undefined') || (ts.isArrayLiteralExpression(value) && !value.elements.length);
  }
  function payload(node: ts.Node, seen = new Set<ts.Node>()): boolean {
    if (seen.has(node)) return false;
    seen.add(node);
    if (ts.isIdentifier(node)) {
      const value = resolved(node, new Set(), props);
      if (value !== node) return payload(value, seen);
    }
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node)) return true;
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'link') return true;
    if (nestedFunction(node)) return false;
    return ts.forEachChild(node, child => payload(child, new Set(seen)) || undefined) ?? false;
  }
  function rendered(node: ts.Node): boolean {
    for (let parent = node.parent; parent; parent = parent.parent) {
      if (ts.isReturnStatement(parent) || ts.isJsxExpression(parent) || ts.isJsxAttribute(parent)) return true;
      if (ts.isVariableDeclaration(parent) || ts.isFunctionLike(parent)) return false;
    }
    return false;
  }
  function walk(node: ts.Node): boolean {
    const mapped = ts.isArrowFunction(node) && ts.isCallExpression(node.parent) &&
      ts.isPropertyAccessExpression(node.parent.expression) && node.parent.expression.name.text === 'map' && rendered(node.parent);
    if (nestedFunction(node) && !mapped) return false;
    if (request && (ts.isCallExpression(node) || ts.isNewExpression(node)) && requestGuarded(node, operation)) return true;
    if (ts.isConditionalExpression(node) && rendered(node)) {
      const attribute = ts.isJsxExpression(node.parent) && ts.isJsxAttribute(node.parent.parent);
      if (entailsOpen(node.condition, operation, true, props) && absent(node.whenFalse) && (payload(node.whenTrue) || attribute)) return true;
      if (entailsOpen(node.condition, operation, false, props) && absent(node.whenTrue) && (payload(node.whenFalse) || attribute)) return true;
    }
    if (ts.isBinaryExpression(node) && rendered(node) && node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
      entailsOpen(node.left, operation, true, props) && payload(node.right)) return true;
    // Boolean attributes control enablement; a denied gate must make the exact attribute false.
    if (ts.isJsxAttribute(node) && ['disabled', 'draggable'].includes(node.name.getText()) && node.initializer &&
      ts.isJsxExpression(node.initializer) && node.initializer.expression &&
      entailsOpen(node.initializer.expression, operation, node.name.getText() === 'draggable', props)) return true;
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const name = node.tagName.getText();
      if (!visited.has(name)) {
        let component: ts.FunctionDeclaration | undefined;
        function find(child: ts.Node) {
          if (ts.isFunctionDeclaration(child) && child.name?.text === name) component = child;
          ts.forEachChild(child, find);
        }
        find(body.getSourceFile());
        if (component?.body && component.parameters[0] && ts.isObjectBindingPattern(component.parameters[0].name)) {
          const supplied = new Map<string, ts.Expression>();
          for (const item of component.parameters[0].name.elements) {
            if (!ts.isIdentifier(item.name)) continue;
            const propName = item.propertyName?.getText() ?? item.name.text;
            const attribute = node.attributes.properties.find(item => ts.isJsxAttribute(item) && item.name.getText() === propName);
            if (attribute && ts.isJsxAttribute(attribute) && attribute.initializer && ts.isJsxExpression(attribute.initializer) && attribute.initializer.expression)
              supplied.set(item.name.text, resolved(attribute.initializer.expression, new Set(), props));
          }
          if (hasPredicate(component.body, operation, false, supplied, new Set([...visited, name]))) return true;
        }
      }
    }
    if (ts.isJsxOpeningElement(node) && node.tagName.getText() === 'OperationGate') {
      const prop = node.attributes.properties.find(item => ts.isJsxAttribute(item) && item.name.getText() === 'operation');
      if (prop && ts.isJsxAttribute(prop) && prop.initializer && ts.isStringLiteral(prop.initializer) && prop.initializer.text === operation) return true;
    }
    return ts.forEachChild(node, child => walk(child) || undefined) ?? false;
  }
  return walk(body);
}

/** Every inventoried closed payload proves its own suppression; public siblings are not targets. */
function targetProof(body: ts.Node, operation: string, target: Target, props = new Map<string, ts.Expression>(), visited = new Set<string>(), proofs: boolean[] = []): boolean {
  function expressionProof(node: ts.Node): boolean {
    return requestGuarded(node, operation, props);
  }
  function absent(node: ts.Expression): boolean {
    const value = resolved(node, new Set(), props);
    return value.kind === ts.SyntaxKind.NullKeyword || value.kind === ts.SyntaxKind.FalseKeyword ||
      ts.isArrayLiteralExpression(value) && value.elements.length === 0;
  }
  function refs(node: ts.Node, name: string) {
    if (ts.isIdentifier(node) && node.text === name) proofs.push(expressionProof(node));
    if (!ts.isFunctionLike(node)) ts.forEachChild(node, child => refs(child, name));
  }
  function walk(node: ts.Node) {
    const mapped = ts.isArrowFunction(node) && ts.isCallExpression(node.parent) &&
      ts.isPropertyAccessExpression(node.parent.expression) && node.parent.expression.name.text === 'map';
    if (ts.isFunctionLike(node) && !mapped) return;
    if ('binding' in target && ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === target.binding && node.initializer) {
      const value = resolved(node.initializer, new Set(), props);
      proofs.push(ts.isConditionalExpression(value) && absent(value.whenFalse) && expressionProof(value.whenTrue));
    }
    if ('branch' in target && ts.isConditionalExpression(node) && node.condition.getText().includes(target.branch[0])) refs(node.whenTrue, target.branch[1]);
    if ('call' in target && ts.isCallExpression(node) && node.expression.getText() === target.call[0] &&
      node.arguments.some(item => ts.isPropertyAccessExpression(item) && item.name.text === target.call[1])) proofs.push(expressionProof(node));
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const opening = ts.isJsxElement(node) ? node.openingElement : node;
      if ('jsx' in target && opening.tagName.getText() === target.jsx) {
        const attr = target.prop ? opening.attributes.properties.find(item => ts.isJsxAttribute(item) && item.name.getText() === target.prop) : null;
        const value = attr && ts.isJsxAttribute(attr) ? attr.initializer : null;
        if ((!target.prop || value) && (!target.value || value && ts.isStringLiteral(value) && value.text === target.value) &&
          (!target.text || value?.getText().includes(target.text) || !target.prop && node.getText().includes(target.text))) proofs.push(expressionProof(node));
      }
      if ('attribute' in target && opening.tagName.getText() === target.attribute[0]) {
        const attr = opening.attributes.properties.find(item => ts.isJsxAttribute(item) && item.name.getText() === target.attribute[1]);
        if (attr && ts.isJsxAttribute(attr) && attr.initializer && ts.isJsxExpression(attr.initializer) && attr.initializer.expression) {
          const value = attr.initializer.expression;
          if (target.attribute[1] === 'draggable') proofs.push(entailsOpen(value, operation, true, props));
          else proofs.push(ts.isConditionalExpression(value) && absent(value.whenFalse) && expressionProof(value.whenTrue));
        }
      }
      const name = opening.tagName.getText();
      if (!visited.has(name)) {
        let component: ts.FunctionDeclaration | undefined;
        function find(child: ts.Node) {
          if (ts.isFunctionDeclaration(child) && child.name?.text === name) component = child;
          ts.forEachChild(child, find);
        }
        find(body.getSourceFile());
        if (component?.body && component.parameters[0] && ts.isObjectBindingPattern(component.parameters[0].name)) {
          const supplied = new Map<string, ts.Expression>();
          for (const item of component.parameters[0].name.elements) {
            if (!ts.isIdentifier(item.name)) continue;
            const propName = item.propertyName?.getText() ?? item.name.text;
            const attr = opening.attributes.properties.find(item => ts.isJsxAttribute(item) && item.name.getText() === propName);
            if (attr && ts.isJsxAttribute(attr) && attr.initializer && ts.isJsxExpression(attr.initializer) && attr.initializer.expression)
              supplied.set(item.name.text, resolved(attr.initializer.expression, new Set(), props));
          }
          // The inventory's target can be owned by a child, such as a tab's delete menu item.
          targetProof(component.body, operation, target, supplied, new Set([...visited, name]), proofs);
        }
      }
    }
    ts.forEachChild(node, walk);
  }
  walk(body);
  return proofs.length > 0 && proofs.every(Boolean);
}

function entryViolations(files: Readonly<Record<string, string>>, inventory: readonly Entry[] = entries): string[] {
  return inventory.flatMap(entry => {
    const source = ts.createSourceFile(entry.file, files[entry.file] ?? '', ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let body: ts.Node | undefined;
    function find(node: ts.Node) {
      if (ts.isFunctionDeclaration(node) && node.name?.text === entry.function) body = node.body;
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === entry.function &&
        node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) body = node.initializer.body;
      ts.forEachChild(node, find);
    }
    find(source);
    return entry.operations.filter(operation => !body || (entry.targets?.[operation]
      ? !entry.targets[operation]!.every(target => targetProof(body!, operation, target))
      : !hasPredicate(body, operation, entry.request)))
      .map(operation => `${entry.file}: ${entry.function} must gate its entry on ${operation}`);
  });
}

test('the exposure table marks closed operations and every operation ID has the shape the scan reads', () => {
  expect(closedIds.length).toBeGreaterThan(200);
  expect(publicIds.length).toBeGreaterThan(closedIds.length);
  expect(closedIds).toContain('getV1MeSaved-filters');
});

test('the scan sees the web calls to closed operations it must guard', () => {
  const projected = projectedTypes(webSources);
  const seen = new Set(
    Object.entries(webSources).flatMap(([file, text]) =>
      callsIn(text, projected).flatMap((call) => call.operations.map((operation) => `${file} ${operation}`)),
    ),
  );
  expect([...seen]).toContain('features/saved-filter/server.ts getV1MeSaved-filters');
  expect([...seen]).toContain('features/saved-filter/api.ts postV1MeSaved-filters');
  expect([...seen]).toContain('features/saved-filter/api.ts putV1MeSaved-filtersOrder');
  expect([...seen]).toContain('features/realm/read.ts getV1Mod-releasesByWork');
  expect([...seen]).toContain('features/work-page/read.ts getV1HubWorksById');
});

test('closed requests have explicit operation gates and the swept UI entries have predicates', () => {
  expect(violations(webSources)).toEqual([]);
  expect(entryViolations(webSources)).toEqual([]);
});

test('the scan rejects an ungated call to a closed operation, by Eden chain and by path', () => {
  expect(
    violations({
      eden: "const read = () => main.v1.me['saved-filters'].get({ query: {} });",
      alias: "const filters = main.v1.me['saved-filters']; filters.order.put({});",
      works: 'await main.v1.works({ id }).releases({ release }).put({});',
      mods: "main().v1['mod-releases']({ work }).get({ query: {} });",
      path: "const response = await fetch(`${origin}/v1/types`, { method: 'POST' });",
    }),
  ).toEqual([
    "eden: .v1.me['saved-filters'].get({query:{}}) reaches getV1MeSaved-filters (platform:saved-views)",
    "alias: filters.order.put({}) reaches putV1MeSaved-filtersOrder (platform:saved-views)",
    "mods: .v1['mod-releases']({work}).get({query:{}}) reaches getV1Mod-releasesByWork (platform:developer-extras)",
    'path: /v1/types reaches postV1Types (platform:platform-admin)',
  ]);
});

test('the scan accepts an explicit operation gate and ignores public requests', () => {
  expect(
    violations({
      asked:
        "if (operationOpen('getV1MeSaved-filters', access)) main.v1.me['saved-filters'].get({ query: {} });",
      open: 'main.v1.works({ id }).releases.get({});',
    }),
  ).toEqual([]);
});

test('an unrelated closed literal or a refusal after the call cannot substitute for an operation gate', () => {
  for (const suffix of ["const status = 'closed';", "if (read.failure === 'closed') hide();"]) {
    expect(violations({ read: `const read = await main().v1['mod-releases']({ work }).get({}); ${suffix}` })).toHaveLength(1);
  }
});

test('projected closed reads are discovered from their owning Eden response type', () => {
  const files = {
    types: "export type HubWorkPage = NonNullable<Ok<ReturnType<Main['v1']['hub']['works']>['get']>>;",
    read: 'const read = followHref<HubWorkPage | null>(main, section.href);',
  };
  expect(violations(files)).toEqual(['read: followHref<HubWorkPage | null> reaches getV1HubWorksById (platform:developer-extras)']);
  expect(violations({ ...files, read: "if (!operationOpen('getV1HubWorksById', access)) return null; " + files.read })).toEqual([]);
});

test('closed path inventory recognises multiword parameter names', () => {
  const text = 'fetch(`/v1/realms/${realm}/member-receipts/${receipt}/appeal`, { method: "POST" });';
  expect(callsIn(text)).toEqual([{ source: '/v1/realms/${realm}/member-receipts/${receipt}/appeal',
    operations: ['postV1RealmsByRealmMember-receiptsByReceiptIdAppeal'] }]);
});

test('property existence checks and public parameterised paths do not invent closed calls', () => {
  expect(callsIn("if (typeof main.v1.realms !== 'function') return false;")).toEqual([]);
  expect(callsIn('fetch(`/v1/compositions/${id}`);')).toEqual([]);
  expect(callsIn('// Main owns `/v1/compositions/{id}`.')).toEqual([]);
});

test('each UI entry loses its proof when any required operation predicate is removed', () => {
  for (const entry of entries) for (const operation of entry.operations) {
    expect(entryViolations({ [entry.file]: webSources[entry.file]!.replaceAll(operation, 'getV1Types') }, [entry]))
      .toContain(`${entry.file}: ${entry.function} must gate its entry on ${operation}`);
  }
});

test('an unused gate or a closed error string is not a UI predicate', () => {
  const parse = (text: string) => ts.createSourceFile('entry.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  expect(hasPredicate(parse("const ignored = operationOpen('getV1HubWorksById'); return <button>Retry</button>;"), 'getV1HubWorksById')).toBe(false);
  expect(hasPredicate(parse("const status = 'closed'; return <button>Retry</button>;"), 'getV1HubWorksById')).toBe(false);
  expect(hasPredicate(parse("const submit = () => { if (!operationOpen('getV1HubWorksById')) return; }; return <button onClick={submit}>Retry</button>;"), 'getV1HubWorksById')).toBe(false);
  expect(hasPredicate(parse("const allowed = operationOpen('getV1HubWorksById') && ready; return <button>Retry</button>;"), 'getV1HubWorksById')).toBe(false);
  expect(hasPredicate(parse("return operationOpen('getV1HubWorksById') ? <button>Retry</button> : null;"), 'getV1HubWorksById')).toBe(true);
});

test('request gates dominate each invocation, not the file or a neighbouring expression', () => {
  const call = "main.v1.me['saved-filters'].get({})";
  const gate = "operationOpen('getV1MeSaved-filters', access)";
  for (const source of [
    `${gate}; ${call};`,
    `const unused = ${gate}; ${call};`,
    `${gate} ? ${call} : ${call};`,
    `!${gate} ? ${call} : null;`,
    `if (!${gate}) { ${call}; }`,
    `if (${gate}) {} ${call};`,
    `${gate} && ${call}; ${call};`,
    `function allowed() { if (!${gate}) return; return ${call}; } function denied() { return ${call}; }`,
    `if (!${gate}) { if (ready) return; } ${call};`,
  ]) expect(violations({ fixture: source }).some(item => item.includes('getV1MeSaved-filters'))).toBe(true);
  for (const source of [
    `if (!${gate}) return null; ${call};`,
    `${gate} ? ${call} : null;`,
    `!${gate} ? null : ${call};`,
    `const can = { read: ${gate}, edit: operationOpen('postV1MeSaved-filters') }; can.read && ${call};`,
  ]) expect(violations({ fixture: source })).toEqual([]);
});

test('Eden aliases retain the exact operation across assignments, returns and multiline declarations', () => {
  for (const source of [
    "let filters; filters = main.v1.me['saved-filters']; filters.get({});",
    "const client = () => main.v1.me['saved-filters']; client().get({});",
    "function client() { return main.v1.me['saved-filters']; } client().get({});",
    "const filters =\n main.v1.me['saved-filters'];\n filters.get({});",
    "const filters = main.v1.me['saved-filters']; const alias = filters; alias.get({});",
    "const filters = main.v1.me['saved-filters']; const read = filters.get; read({});",
  ]) {
    expect(violations({ fixture: source })).toHaveLength(1);
    expect(violations({ fixture: source })[0]).toContain('getV1MeSaved-filters');
  }
  expect(callsIn("let filters; filters = main.v1.me['saved-filters']; if (typeof filters.get === 'function') ready();")).toEqual([]);
});

test('UI fixtures reject inverted, identical and unused predicates and unrelated object members', () => {
  const operation = 'getV1HubWorksById';
  const gate = `operationOpen('${operation}')`;
  for (const source of [
    `return ${gate} ? <button>Install</button> : <button>Install</button>;`,
    `return !${gate} ? <button>Install</button> : null;`,
    `const unused = ${gate}; return <button>Install</button>;`,
    `const unused = ${gate} ? <button>Install</button> : null; return <button>Install</button>;`,
    `const can = { install: ready, unrelated: ${gate} }; return can.install ? <button>Install</button> : null;`,
    `if (!${gate}) return <button>Install</button>; return null;`,
  ]) expect(hasPredicate(parse(source), operation)).toBe(false);
  expect(hasPredicate(parse(`const can = { install: ${gate}, unrelated: ready }; return can.install ? <button>Install</button> : null;`), operation)).toBe(true);
});

test('HTTP paths and projected reads require a gate dominating their own expression', () => {
  const http = "fetch('/v1/types', { method: 'POST' })";
  const adminGate = "operationOpen('postV1Types', access)";
  expect(violations({ request: `${adminGate}; ${http};` })).toHaveLength(1);
  expect(violations({ request: `${adminGate} ? ${http} : ${http};` })).toHaveLength(1);
  expect(violations({ request: `${adminGate} && ${http}; ${http};` })).toHaveLength(1);
  expect(violations({ request: `${adminGate} ? ${http} : null;` })).toEqual([]);
  const types = "export type HubWorkPage = NonNullable<Ok<ReturnType<Main['v1']['hub']['works']>['get']>>;";
  const projected = 'followHref<HubWorkPage>(main, href)';
  const hubGate = "operationOpen('getV1HubWorksById', access)";
  expect(violations({ types, read: `${hubGate}; ${projected};` })).toHaveLength(1);
  expect(violations({ types, read: `${hubGate} && ${projected}; ${projected};` })).toHaveLength(1);
  expect(violations({ types, read: `!${hubGate} ? ${projected} : null;` })).toHaveLength(1);
  expect(violations({ types, read: `${hubGate} ? ${projected} : null;` })).toEqual([]);
});

test('a gated unrelated sibling cannot protect the inventoried closed action', () => {
  const fixture: Entry = { file: 'entry.tsx', function: 'Entry', operations: ['getV1HubWorksById'],
    targets: { getV1HubWorksById: [{ jsx: 'button', text: 'Install' }] } };
  const gate = "operationOpen('getV1HubWorksById')";
  for (const source of [
    `function Entry() { return <>{${gate} ? <span>Unrelated</span> : null}<button>Install</button></>; }`,
    `function Entry() { return <>{${gate} ? <button>Install</button> : null}<button>Install</button></>; }`,
    `function Entry() { return ${gate} ? <button>Install</button> : <button>Install</button>; }`,
    `function Entry() { return !${gate} ? <button>Install</button> : null; }`,
  ]) expect(entryViolations({ 'entry.tsx': source }, [fixture])).toHaveLength(1);
  expect(entryViolations({ 'entry.tsx': `function Entry() { return <><button>Copy</button>{${gate} ? <button>Install</button> : null}</>; }` }, [fixture])).toEqual([]);
});
