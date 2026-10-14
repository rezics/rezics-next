import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript-6';
import {
  operationExposures,
  type PlatformOperationId,
} from '../../../generated/openapi/main/exposure.ts';
import { escape, operationPattern, readWebSources, sources } from './support/eden-calls.ts';

/**
 * Canonical request rule (deliberately conservative; false positives must be rewritten):
 * - An inline request is lexically in the block consequent of
 *   if (operationOpen('<same operation>', …)) { … }, or the true arm of
 *   operationOpen('<same operation>', …) ? <request> : …, in the SAME function.
 *   The hook's gate('<same operation>') is the equivalent direct predicate.
 * - A component effect/handler may instead START its own body with
 *   if (!operationOpen('<same operation>', …)) return; (or direct gate(...)).
 * - No other form proves a request: held/conditionally assigned gate results,
 *   logical expressions, JSX OperationGate children (evaluated eagerly), returned
 *   callbacks and unresolved aliases are intentionally rejected. Every closed
 *   client reference counts, including aliases, destructuring, shorthand properties
 *   and returned clients; only an inline final-method call can satisfy the rule.
 *   No client, path, boolean or component-prop data flow is modelled.
 * Fetch calls also require a plain string URL and a literal method property
 * (omitted method means GET). Computed keys, variable methods/options and spreads
 * cannot identify the operation conservatively. Dynamic Main requests use Eden.
 * Pure UI controls are inventoried separately. OperationGate can suppress a control,
 * but never proves a request. Main's generated exposure is the policy source.
 */

const closedIds = (Object.keys(operationExposures) as PlatformOperationId[]).filter(
  (id) => operationExposures[id] !== 'public',
);
const publicIds = Object.keys(operationExposures);
const spec = JSON.parse(readFileSync(join(import.meta.dir, '../../../generated/openapi/main/public.json'), 'utf8')) as {
  paths: Record<string, Record<string, { operationId?: string }>>;
};
const routes = Object.entries(spec.paths).flatMap(([path, methods]) => Object.entries(methods)
  .filter(([, value]) => value.operationId)
  .map(([method, value]) => ({ method, segments: path.split('/').slice(2), operation: value.operationId as PlatformOperationId })));
const closedRoutes = routes.filter(route => closedIds.includes(route.operation));

export interface Call {
  /** Where the operation was recognised, for the failure message. */
  source: string;
  operations: PlatformOperationId[];
}

interface LocatedCall extends Call { node: ts.Node; inline: boolean }

function parse(text: string): ts.SourceFile {
  return ts.createSourceFile('source.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

/** Read only the written chain; never resolve a binding, assignment or returned client. */
function route(node: ts.Expression): (string | null)[] | null {
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    const name = ts.isPropertyAccessExpression(node) ? node.name.text :
      node.argumentExpression && ts.isStringLiteralLike(node.argumentExpression) ? node.argumentExpression.text : null;
    if (name === 'v1') return [];
    const parent = route(node.expression);
    return parent && name ? [...parent, name] : null;
  }
  if (ts.isCallExpression(node)) {
    const parent = route(node.expression);
    return parent ? [...parent, null] : null;
  }
  return null;
}

/** Every closed reference counts, including a route before a dynamic member or method continuation. */
function closedCalls(source: ts.SourceFile): LocatedCall[] {
  const calls: LocatedCall[] = [];
  function reference(node: ts.Expression) {
    const invoked = ts.isCallExpression(node);
    const endpoint = route(invoked ? node.expression : node);
    if (!endpoint) return null;
    const method = endpoint.at(-1);
    const isMethod = typeof method === 'string' && ['get', 'post', 'put', 'patch', 'delete'].includes(method);
    const path = isMethod ? endpoint.slice(0, -1) : route(node);
    if (!path) return null;
    const matched = routes.filter(item => (!isMethod || item.method === method) &&
      (isMethod ? item.segments.length === path.length : item.segments.length >= path.length) &&
      path.every((segment, index) => /^\{[^}]+\}$/.test(item.segments[index]!) ? segment === null : segment === item.segments[index]));
    return { matched, inline: invoked && isMethod };
  }
  function visit(node: ts.Node) {
    if (ts.isTypeNode(node)) return;
    if (ts.isObjectBindingPattern(node) && node.elements.some(item => {
      const name = item.propertyName ?? item.name;
      const literal = ts.isComputedPropertyName(name) ? name.expression : name;
      return (ts.isIdentifier(literal) || ts.isStringLiteralLike(literal)) && literal.text === 'v1';
    }))
      calls.push({ source: node.getText(), operations: closedIds, node, inline: false });
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node) || ts.isCallExpression(node)) {
      const found = reference(node);
      const parent = node.parent;
      const continued = (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent) || ts.isCallExpression(parent)) &&
        parent.expression === node && Boolean(reference(parent)?.matched.length);
      if (found && !continued) {
        const operations = found.matched.filter(item => closedIds.includes(item.operation)).map(item => item.operation);
        if (operations.length) calls.push({ source: node.getText().replace(/\s+/g, ''), operations, node, inline: found.inline });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return calls;
}

const literal =
  /(?<quote>['"])(?<single>(?:\/api\/main)?\/v1\/[^'"\s]*)\k<quote>|`(?:\$\{[^}]*\})?(?<template>(?:\/api\/main)?\/v1\/(?:[^`$]|\$\{[^}]*\})*)`/g;

/** Operations named by a path literal such as `'/v1/me/saved-filters'` or `` `/v1/realms/${id}/join-page` ``. */
function pathCalls(text: string, reference = false, method = 'get'): Call[] {
  const calls: Call[] = [];
  for (const found of text.matchAll(literal)) {
    const path = (found.groups!.single ?? found.groups!.template!)
      .replace(/^\/api\/main/, '')
      .split('?')[0]!;
    // `/v1/media/` is a prefix test, not a request.
    if (path.endsWith('/')) continue;
    const segments = path.split('/').slice(2);
    const methods = reference ? [...new Set(closedRoutes.map(route => route.method))] : [method];
    const operations = methods.flatMap((method) =>
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
        const path = node.arguments[0];
        const options = node.arguments[1];
        const fields = options && ts.isObjectLiteralExpression(options) ? options.properties : [];
        const methodField = fields.find(item => item.name?.getText().replace(/^['"]|['"]$/g, '') === 'method');
        const method = methodField && ts.isPropertyAssignment(methodField) && ts.isStringLiteralLike(methodField.initializer)
          ? methodField.initializer.text.toLowerCase() : 'get';
        const unknownOptions = name !== 'URL' && Boolean(options && !ts.isObjectLiteralExpression(options) ||
          fields.some(ts.isSpreadAssignment) || methodField && !(ts.isPropertyAssignment(methodField) && ts.isStringLiteralLike(methodField.initializer)));
        const scanned = pathCalls(path.getText(), unknownOptions, method);
        const parent = node.parent;
        const urlArgument = name === 'URL' && ts.isCallExpression(parent) &&
          /^(?:fetch|fetchImpl|serverRead)$/.test(parent.expression.getText()) && parent.arguments[0] === node;
        if (!urlArgument) calls.push(...scanned.map(call => ({ ...call, node, inline: name !== 'URL' && !unknownOptions })));
      }
      if (ts.isCallExpression(node) && name === 'followHref') {
        const types = node.typeArguments?.map(item => item.getText()).join(' ') ?? '';
        const operations = [...projected].filter(([type]) => new RegExp(`\\b${escape(type)}\\b`).test(types)).flatMap(([, ids]) => ids);
        if (operations.length) calls.push({ source: `followHref<${types}>`, operations, node, inline: true });
      }
    }
    if (ts.isTypeNode(node)) return;
    if (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node)) {
      const parent = node.parent;
      const direct = (ts.isCallExpression(parent) || ts.isNewExpression(parent)) &&
        /^(?:fetch|fetchImpl|serverRead|URL)$/.test(parent.expression.getText()) && parent.arguments?.[0] === node;
      if (!direct) calls.push(...pathCalls(node.getText(), true).map(call => ({ ...call, node, inline: false })));
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return calls;
}

export function callsIn(text: string, projected = new Map<string, PlatformOperationId[]>()): Call[] {
  return locatedCalls(text, projected).map(({ source, operations }) => ({ source, operations }));
}

/** Exact syntactic whitelist; parentheses do not change the written condition. */
function directGate(node: ts.Expression, operation: string): boolean {
  if (ts.isParenthesizedExpression(node)) return directGate(node.expression, operation);
  return ts.isCallExpression(node) && ts.isIdentifier(node.expression) &&
    ['operationOpen', 'gate'].includes(node.expression.text) && Boolean(node.arguments[0] &&
      ts.isStringLiteralLike(node.arguments[0]) && node.arguments[0].text === operation);
}

function componentHandler(fn: ts.SignatureDeclaration): boolean {
  for (let parent = fn.parent; parent; parent = parent.parent) {
    if (ts.isFunctionDeclaration(parent)) return Boolean(parent.name && /^[A-Z]/.test(parent.name.text));
    if (ts.isArrowFunction(parent) || ts.isFunctionExpression(parent)) {
      return ts.isVariableDeclaration(parent.parent) && ts.isIdentifier(parent.parent.name) &&
        /^[A-Z]/.test(parent.parent.name.text);
    }
  }
  return false;
}

function leadingRefusal(fn: ts.SignatureDeclaration, operation: string, site: ts.Node): boolean {
  if (!componentHandler(fn) || !('body' in fn) || !fn.body || !ts.isBlock(fn.body as ts.Node)) return false;
  const first = (fn.body as ts.Block).statements[0];
  return Boolean(first && site.getStart() >= first.end && ts.isIfStatement(first) && !first.elseStatement &&
    ts.isPrefixUnaryExpression(first.expression) && first.expression.operator === ts.SyntaxKind.ExclamationToken &&
    directGate(first.expression.operand, operation) && ts.isReturnStatement(first.thenStatement) && !first.thenStatement.expression);
}

/** Requests stop at EVERY function boundary, including inline callbacks and JSX event handlers. */
function requestGuarded(node: ts.Node, operation: string): boolean {
  let child = node;
  for (let parent = node.parent; parent; child = parent, parent = parent.parent) {
    if (ts.isFunctionLike(parent)) return leadingRefusal(parent, operation, node);
    if (ts.isIfStatement(parent) && child === parent.thenStatement && ts.isBlock(parent.thenStatement) &&
      directGate(parent.expression, operation)) return true;
    if (ts.isConditionalExpression(parent) && child === parent.whenTrue && directGate(parent.condition, operation)) return true;
  }
  return false;
}

/** Pure controls can use OperationGate; an eagerly evaluated request cannot. No binding/prop tracing. */
function uiGuarded(node: ts.Node, operation: string): boolean {
  let child = node;
  for (let parent = node.parent; parent; child = parent, parent = parent.parent) {
    if (ts.isConditionalExpression(parent) && child === parent.whenTrue && directGate(parent.condition, operation)) return true;
    if (ts.isIfStatement(parent) && child === parent.thenStatement && directGate(parent.expression, operation)) return true;
    if (ts.isJsxElement(parent) && child !== parent.openingElement && parent.openingElement.tagName.getText() === 'OperationGate') {
      const attribute = parent.openingElement.attributes.properties.find(item => ts.isJsxAttribute(item) && item.name.getText() === 'operation');
      if (attribute && ts.isJsxAttribute(attribute) && attribute.initializer && ts.isStringLiteral(attribute.initializer) &&
        attribute.initializer.text === operation) return true;
    }
    // A map callback constructs pure controls; event handlers and unrelated functions are separate.
    if (ts.isFunctionLike(parent) && !(ts.isArrowFunction(parent) && ts.isCallExpression(parent.parent) &&
      ts.isPropertyAccessExpression(parent.parent.expression) && parent.parent.expression.name.text === 'map')) return false;
  }
  return false;
}

/** Fetch syntax is checked even when an unresolved URL/method hides its operation. */
function fetchViolations(text: string): string[] {
  const failures: string[] = [];
  function visit(node: ts.Node) {
    if (ts.isTypeNode(node)) return;
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) &&
      ['fetch', 'fetchImpl'].includes(node.expression.text)) {
      if (!node.arguments[0] || !ts.isStringLiteral(node.arguments[0]))
        failures.push(`${node.expression.text} URL must be a string literal`);
      const options = node.arguments[1];
      if (options) {
        const fields = ts.isObjectLiteralExpression(options) ? options.properties : null;
        if (!fields || fields.some(field => ts.isSpreadAssignment(field) || field.name && ts.isComputedPropertyName(field.name) ||
          field.name?.getText().replace(/^['"]|['"]$/g, '') === 'method' &&
          !(ts.isPropertyAssignment(field) && ts.isStringLiteral(field.initializer))))
          failures.push(`${node.expression.text} method must be a plain literal property (or omitted GET)`);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(parse(text));
  return failures;
}

export function violations(files: Readonly<Record<string, string>>): string[] {
  const projected = projectedTypes(files);
  return Object.entries(files).flatMap(([file, text]) => [
    ...fetchViolations(text).map(failure => `${file}: ${failure}`),
    ...locatedCalls(text, projected).flatMap(call =>
      call.operations.filter(operation => !call.inline || !requestGuarded(call.node, operation)).map(operation =>
        `${file}: ${call.source} reaches ${operation} (${operationExposures[operation]})`)),
  ]);
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
  | { expression: string }
  | { property: string }
  | { branch: readonly [string, string] };
interface Entry {
  file: string;
  function: string;
  operations: readonly PlatformOperationId[];
  targets?: Partial<Record<PlatformOperationId, readonly Target[]>>;
}
const entries: readonly Entry[] = [
  { file: 'features/work-page/work-views.tsx', function: 'WorkOverview', operations: ['getV1HubWorksById'],
    targets: { getV1HubWorksById: [{ branch: ["experience.kind === 'prompt'", 'TypeExperience'] }] } },
  { file: 'features/feed/actions.tsx', function: 'PrimaryAction', operations: ['getV1HubWorksById'],
    targets: { getV1HubWorksById: [{ call: ['link', 'install'] }, { call: ['link', 'usePrompt'] }] } },
  { file: 'features/showcase/work-action.tsx', function: 'PrimaryAction', operations: ['getV1HubWorksById'],
    targets: { getV1HubWorksById: [{ branch: ["work.hub?.kind === 'skill'", 'action'] }] } },
  { file: 'features/zones/zone-home.tsx', function: 'slotCard', operations: ['getV1HubWorksById'],
    targets: { getV1HubWorksById: [{ property: 'tryHref' }] } },
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
    'getV1MeSaved-filters', 'patchV1MeSaved-filtersById', 'putV1MeSaved-filtersOrder',
  ], targets: {
    'getV1MeSaved-filters': [{ expression: 'shown.map' }, { jsx: 'RenameDialog' }],
    'patchV1MeSaved-filtersById': [{ jsx: 'RenameDialog' }],
    'putV1MeSaved-filtersOrder': [{ attribute: ['li', 'draggable'] }],
  } },
  { file: 'features/home/tabs.tsx', function: 'TabMenu', operations: [
    'getV1MeSaved-filters', 'patchV1MeSaved-filtersById', 'putV1MeSaved-filtersOrder', 'deleteV1MeSaved-filtersById',
  ], targets: {
    'getV1MeSaved-filters': [{ jsx: 'Menu' }],
    'patchV1MeSaved-filtersById': [{ jsx: 'MenuItem', prop: 'value', value: 'rename' }, { jsx: 'MenuItem', prop: 'value', value: 'unpin' }],
    'putV1MeSaved-filtersOrder': [{ jsx: 'MenuItem', prop: 'value', value: 'left' }, { jsx: 'MenuItem', prop: 'value', value: 'right' }],
    'deleteV1MeSaved-filtersById': [{ jsx: 'MenuItem', prop: 'value', value: 'delete' }],
  } },
  { file: 'features/zones/about-discussion.tsx', function: 'AboutDiscussionEntry', operations: ['postV1RealmsByRealmAbout-posts'],
    targets: { 'postV1RealmsByRealmAbout-posts': [{ jsx: 'form' }, { jsx: 'Button', prop: 'onClick', text: 'setOpened' }] } },
];

/** Match every concrete inventoried payload; a protected sibling does not protect this one. */
function targetProof(body: ts.Node, operation: string, target: Target): boolean {
  const proofs: boolean[] = [];
  function absent(node: ts.Expression): boolean {
    return node.kind === ts.SyntaxKind.NullKeyword || node.kind === ts.SyntaxKind.FalseKeyword ||
      ts.isArrayLiteralExpression(node) && !node.elements.length;
  }
  function payload(node: ts.Expression): boolean {
    if (absent(node)) return true;
    if (ts.isConditionalExpression(node)) {
      if (directGate(node.condition, operation) && absent(node.whenFalse)) return true;
      return payload(node.whenTrue) && payload(node.whenFalse);
    }
    return uiGuarded(node, operation);
  }
  function refs(node: ts.Node, name: string) {
    if (ts.isIdentifier(node) && node.text === name) proofs.push(uiGuarded(node, operation));
    if (!ts.isFunctionLike(node)) ts.forEachChild(node, child => refs(child, name));
  }
  function walk(node: ts.Node) {
    if (ts.isFunctionLike(node) && !(ts.isArrowFunction(node) && ts.isCallExpression(node.parent) &&
      ts.isPropertyAccessExpression(node.parent.expression) && node.parent.expression.name.text === 'map')) return;
    if ('expression' in target && ts.isCallExpression(node) && node.expression.getText() === target.expression) proofs.push(uiGuarded(node, operation));
    if ('property' in target && ts.isPropertyAssignment(node) && node.name.getText() === target.property)
      proofs.push(uiGuarded(node.initializer, operation));
    if ('binding' in target && ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === target.binding && node.initializer)
      proofs.push(payload(node.initializer));
    if ('branch' in target && ts.isConditionalExpression(node) && node.condition.getText().includes(target.branch[0])) refs(node.whenTrue, target.branch[1]);
    if ('call' in target && ts.isCallExpression(node) && node.expression.getText() === target.call[0] &&
      node.arguments.some(item => ts.isPropertyAccessExpression(item) && item.name.text === target.call[1])) proofs.push(uiGuarded(node, operation));
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const opening = ts.isJsxElement(node) ? node.openingElement : node;
      if ('jsx' in target && opening.tagName.getText() === target.jsx) {
        const attr = target.prop ? opening.attributes.properties.find(item => ts.isJsxAttribute(item) && item.name.getText() === target.prop) : null;
        const value = attr && ts.isJsxAttribute(attr) ? attr.initializer : null;
        if ((!target.prop || value) && (!target.value || value && ts.isStringLiteral(value) && value.text === target.value) &&
          (!target.text || value?.getText().includes(target.text) || !target.prop && node.getText().includes(target.text))) proofs.push(uiGuarded(node, operation));
      }
      if ('attribute' in target && opening.tagName.getText() === target.attribute[0]) {
        const attr = opening.attributes.properties.find(item => ts.isJsxAttribute(item) && item.name.getText() === target.attribute[1]);
        if (attr && ts.isJsxAttribute(attr) && attr.initializer && ts.isJsxExpression(attr.initializer) && attr.initializer.expression)
          proofs.push(payload(attr.initializer.expression));
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
    return entry.operations.filter(operation => !body || !entry.targets?.[operation]?.every(target => targetProof(body!, operation, target)))
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
}, 30_000);

test('closed requests have explicit operation gates and the swept UI entries have predicates', () => {
  expect(violations(webSources)).toEqual([]);
  expect(entryViolations(webSources)).toEqual([]);
}, 30_000);

test('a host-provided Try destination is gated before it is spread into a Zone card', () => {
  const operation = 'getV1HubWorksById';
  const inventory: readonly Entry[] = [{ file: 'fixture', function: 'slotCard', operations: [operation],
    targets: { [operation]: [{ property: 'tryHref' }] } }];
  const source = (condition: string) => `function slotCard() {
    return <Slot {...( ${condition} ? { tryHref: props.work.href } : {} )} />;
  }`;
  expect(entryViolations({ fixture: source(`operationOpen('${operation}', access)`) }, inventory)).toEqual([]);
  for (const condition of ['true', "operationOpen('getV1Mod-releasesByWork', access)"])
    expect(entryViolations({ fixture: source(condition) }, inventory)).toHaveLength(1);
  expect(entryViolations({ fixture: 'function slotCard() { return <Slot tryHref={props.work.href} />; }' }, inventory)).toHaveLength(1);
});


const savedOperation = 'getV1MeSaved-filters';
const savedRequest = "main.v1.me['saved-filters'].get({})";
const savedGate = `operationOpen('${savedOperation}', access)`;
const rejects = (source: string) => expect(violations({ fixture: source }).some(item => item.includes(savedOperation))).toBe(true);
const accepts = (source: string) => expect(violations({ fixture: source })).toEqual([]);

test('canonical positive block and ternary accept only the same operation in the same function', () => {
  accepts(`function read() { if (${savedGate}) { return ${savedRequest}; } return null; }`);
  accepts(`${savedGate} ? ${savedRequest} : null;`);
  accepts(`gate('${savedOperation}') ? ${savedRequest} : null;`);
  for (const source of [
    `if (operationOpen('postV1MeSaved-filters', access)) { ${savedRequest}; }`,
    `if (${savedGate}) ${savedRequest};`,
    `${savedGate} && ${savedRequest};`,
    `!${savedGate} ? null : ${savedRequest};`,
    `if (!${savedGate}) return; ${savedRequest};`,
    `if (${savedGate}) { return () => ${savedRequest}; }`,
    `${savedGate} ? () => ${savedRequest} : null;`,
    `if (${savedGate}) { function read() { return ${savedRequest}; } }`,
    `if (${savedGate}) { (() => ${savedRequest})(); }`,
    `if (${savedGate}) { const callback = function () { return ${savedRequest}; }; }`,
    `${savedGate} ? ${savedRequest} : ${savedRequest};`,
  ]) rejects(source);
});

test('component effect and handler must start with the direct canonical refusal', () => {
  accepts(`function Component() { useEffect(() => { if (!${savedGate}) return; ${savedRequest}; }, []); }`);
  accepts(`function Component() { const handler = () => { if (!gate('${savedOperation}')) return; ${savedRequest}; }; }`);
  rejects(`function Component() { const handler = () => { if (!${savedGate}) return ${savedRequest}; ${savedRequest}; }; }`);
  rejects(`function Component() { const handler = () => { ready(); if (!${savedGate}) return; ${savedRequest}; }; }`);
  rejects(`function Component() { const handler = () => { if (!${savedGate}) { if (ready) return; } ${savedRequest}; }; }`);
  rejects(`function Component() { if (!${savedGate}) return; const handler = () => ${savedRequest}; }`);
  rejects(`function Component() { useEffect(() => { if (!${savedGate}) return; return () => ${savedRequest}; }, []); }`);
});

test('reviewer gate-variable, eager JSX-child and escaped callback examples are rejected', () => {
  rejects(`let allowed = false; if (ready) allowed = ${savedGate}; if (allowed) { ${savedRequest}; }`);
  rejects(`return <OperationGate operation="${savedOperation}">{${savedRequest}}</OperationGate>;`);
  rejects(`function factory() { if (${savedGate}) { return () => ${savedRequest}; } } factory()();`);
  rejects(`const allowed = ${savedGate}; if (allowed) { ${savedRequest}; }`);
  rejects(`const can = { read: ${savedGate} }; can.read ? ${savedRequest} : null;`);
  rejects(`${savedGate}; ${savedRequest}; const status = 'closed';`);
});

test('every closed client reference is inventoried, with no alias resolution', () => {
  for (const source of [
    "const { v1 } = main; v1.me['saved-filters'].get({});",
    "const { v1: client } = main; client.me['saved-filters'].get({});",
    "const { 'v1': client } = main; client.me['saved-filters'].get({});",
    "const { ['v1']: client } = main; client.me['saved-filters'].get({});",
    "const v1 = main.v1; v1.me['saved-filters'].get({});",
    "main.v1.me['saved-filters'].get.call(null, {});",
    "main.v1.me['saved-filters'].get.bind(null);",
    "main.v1.me['saved-filters'][method]({});",
    "const filters = main.v1.me['saved-filters']; filters.get({});",
    "let filters; filters = main.v1.me['saved-filters']; filters.get({});",
    "const { get } = main.v1.me['saved-filters']; get({});",
    "const get = main.v1.me['saved-filters'].get; const client = { get }; client.get({});",
    "function client() { return main.v1.me['saved-filters']; } client().get({});",
    "const client = () => main.v1.me['saved-filters']; client().get({});",
    `if (${savedGate}) { const get = main.v1.me['saved-filters'].get; return { get }; }`,
    `if (${savedGate}) { return main.v1.me['saved-filters']; }`,
  ]) {
    expect(callsIn(source).some(call => call.operations.includes(savedOperation))).toBe(true);
    rejects(source);
  }
  rejects(`${savedRequest}.then(handle);`);
  accepts(`if (${savedGate}) { ${savedRequest}.then(handle); }`);
  accepts('main.v1.works({ id }).releases.get({});');
  accepts('await main.v1.works({ id }).releases({ release }).put({});');
});

test('HTTP literals and projected followers require the same canonical gate', () => {
  const admin = "operationOpen('postV1Types', access)";
  const http = "fetch('/v1/types', { method: 'POST' })";
  expect(violations({ request: `${admin} ? ${http} : null;` })).toEqual([]);
  expect(violations({ request: `${admin}; ${http};` })).toHaveLength(1);
  expect(violations({ request: `${admin} ? ${http} : ${http};` })).toHaveLength(1);
  expect(violations({ request: "const path = '/v1/me/saved-filters'; fetch(path);" }).length).toBeGreaterThan(0);
  rejects(`if (${savedGate}) { fetch('/v1/me/saved-filters', options); }`);
  rejects(`if (${savedGate}) { fetch('/v1/me/saved-filters', { method: verb }); }`);
  rejects(`let url; if (${savedGate}) { url = new URL('/v1/me/saved-filters', base); } fetch(url);`);
  accepts(`if (${savedGate}) { serverRead(new URL('/v1/me/saved-filters', base)); }`);
  const types = "export type HubWorkPage = NonNullable<Ok<ReturnType<Main['v1']['hub']['works']>['get']>>;";
  const projected = 'followHref<HubWorkPage | null>(main, href)';
  const hubGate = "operationOpen('getV1HubWorksById', access)";
  expect(violations({ types, read: `${hubGate} ? ${projected} : null;` })).toEqual([]);
  expect(violations({ types, read: `if (${hubGate}) { return () => ${projected}; }` })).toHaveLength(1);
  expect(violations({ types, read: `${hubGate}; ${projected};` })).toHaveLength(1);
  expect(callsIn('fetch(`/v1/realms/${realm}/member-receipts/${receipt}/appeal`, { method: "POST" });')[0]?.operations)
    .toEqual(['postV1RealmsByRealmMember-receiptsByReceiptIdAppeal']);
  expect(callsIn('// Main owns `/v1/me/saved-filters`.')).toEqual([]);
  expect(callsIn("fetch('/v1/compositions/one');")).toEqual([]);
});

test('each UI entry loses its proof when a required direct predicate is removed', () => {
  for (const entry of entries) for (const operation of entry.operations) {
    expect(entryViolations({ [entry.file]: webSources[entry.file]!.replaceAll(operation, 'getV1Types') }, [entry]))
      .toContain(`${entry.file}: ${entry.function} must gate its entry on ${operation}`);
  }
});

test('pure UI wrappers are accepted, but held booleans and protected siblings are rejected', () => {
  const fixture: Entry = { file: 'entry.tsx', function: 'Entry', operations: [savedOperation],
    targets: { [savedOperation]: [{ jsx: 'button', text: 'Install' }] } };
  for (const source of [
    `return <>{${savedGate} ? <span>Unrelated</span> : null}<button>Install</button></>;`,
    `return <>{${savedGate} ? <button>Install</button> : null}<button>Install</button></>;`,
    `return ${savedGate} ? <button>Install</button> : <button>Install</button>;`,
    `return !${savedGate} ? <button>Install</button> : null;`,
    `const allowed = ${savedGate}; return allowed ? <button>Install</button> : null;`,
    `const unused = ${savedGate}; return <button>Install</button>;`,
  ]) expect(entryViolations({ 'entry.tsx': `function Entry() { ${source} }` }, [fixture])).toHaveLength(1);
  for (const source of [
    `return ${savedGate} ? <button>Install</button> : null;`,
    `return <OperationGate operation="${savedOperation}"><button>Install</button></OperationGate>;`,
  ]) expect(entryViolations({ 'entry.tsx': `function Entry() { ${source} }` }, [fixture])).toEqual([]);
});


test('fetch methods must be plain literal properties, including for a canonically gated request', () => {
  for (const options of ["{ ['method']: 'POST' }", "{ [key]: 'POST' }", '{ method }',
    '{ method: verb }', "{ ...options, method: 'POST' }", 'options']) {
    expect(violations({ fixture: `if (${savedGate}) { fetch('/v1/me/saved-filters', ${options}); }` }))
      .toContain('fixture: fetch method must be a plain literal property (or omitted GET)');
  }
  accepts(`if (${savedGate}) { fetch('/v1/me/saved-filters', { method: 'GET', cache: 'no-store' }); }`);
  accepts("fetch('/auth/session', { method: 'GET' });");
});

test('fetch URLs must be plain string literals, including for a canonically gated request', () => {
  for (const url of ["new URL('/v1/me/saved-filters', origin)", 'url', '`/v1/me/${path}`',
    "'/v1/me/' + path", '`/v1/me/saved-filters`']) {
    expect(violations({ fixture: `if (${savedGate}) { fetch(${url}); }` }))
      .toContain('fixture: fetch URL must be a string literal');
  }
  accepts(`if (${savedGate}) { fetch('/v1/me/saved-filters'); }`);
  accepts("fetch('/auth/session');");
});
