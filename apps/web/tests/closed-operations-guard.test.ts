import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript-6';
import {
  operationExposures,
  type PlatformOperationId,
} from '../../../generated/openapi/main/exposure.ts';
import { edenCalls, escape, operationPattern, readWebSources, sources } from './support/eden-calls.ts';

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

/** Operations the Eden client calls: `x.v1.me['saved-filters'].get(...)`, or the same chain kept in a variable. */
function closedCalls(text: string): Call[] {
  return edenCalls(text).flatMap((call) => {
    // A type/existence check of a client property is not an alias that calls every operation below it.
    if (call.method === null && !/\b(?:const|let)\s+[^;\n]*=\s*[^;\n]*$/.test(text.slice(0, call.start))) return [];
    const operations = closedIds.filter((id) =>
      operationPattern(call.method, call.segments, call.method === null).test(id),
    );
    return operations.length ? [{ source: call.chain, operations }] : [];
  });
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

export function callsIn(source: string, projected = new Map<string, PlatformOperationId[]>()): Call[] {
  const text = uncommented(source);
  return [
  ...closedCalls(text), ...pathCalls(text),
  ...[...text.matchAll(/\bfollowHref<([^>]+)>\s*\(/g)].flatMap(match => {
    const operations = [...projected].filter(([name]) => new RegExp(`\\b${escape(name)}\\b`).test(match[1]!))
      .flatMap(([, ids]) => ids);
    return operations.length ? [{ source: `followHref<${match[1]}>`, operations }] : [];
  }),
  ];
}

/** A typed refusal alone never establishes that a request or its UI entry was gated. */
function guarded(text: string, operation: string): boolean {
  return new RegExp(`operationOpen\\(\\s*['"]${escape(operation)}['"]`).test(text);
}

export function violations(files: Readonly<Record<string, string>>): string[] {
  const projected = projectedTypes(files);
  return Object.entries(files).flatMap(([file, text]) =>
    callsIn(text, projected).flatMap((call) =>
      call.operations
        .filter((operation) => !guarded(text, operation))
        .map(
          (operation) =>
            `${file}: ${call.source} reaches ${operation} (${operationExposures[operation]})`,
        ),
    ),
  );
}

const webRoot = join(import.meta.dir, '..');
const webSources = {
  ...readWebSources(),
  ...Object.fromEntries(sources(join(webRoot, 'zones')).map(path => [relative(webRoot, path), readFileSync(path, 'utf8')])),
};

// Regression entry inventory, not an exposure matrix: these are the concrete controls from the sweep.
// Component/stories prove their rendered states; this guard also fails when an entry loses its predicate.
const entries: readonly { file: string; function: string; operations: readonly PlatformOperationId[]; request?: boolean }[] = [
  { file: 'features/work-page/work-views.tsx', function: 'WorkOverview', operations: ['getV1HubWorksById'] },
  { file: 'features/feed/actions.tsx', function: 'PrimaryAction', operations: ['getV1HubWorksById'] },
  { file: 'features/showcase/work-action.tsx', function: 'PrimaryAction', operations: ['getV1HubWorksById'] },
  { file: 'zones/official/ai-workshop/slots.tsx', function: 'Actions', operations: ['getV1HubWorksById'] },
  { file: 'features/realm-appeal/panel.tsx', function: 'RealmBanPanel', operations: [
    'postV1RealmsByRealmMember-receiptsByReceiptIdAppeal', 'getV1RealmsByRealmMember-receiptsByReceiptIdAppeal',
  ] },
  { file: 'features/home/pin-picker.tsx', function: 'PinPicker', operations: [
    'getV1MeSaved-filters', 'postV1MeSaved-filters', 'patchV1MeSaved-filtersById',
  ] },
  { file: 'features/post-composer/api.ts', function: 'banned', operations: ['getV1RealmsByRealmMember-ban'], request: true },
  { file: 'features/zones/about-discussion.tsx', function: 'AboutDiscussionEntry', operations: ['postV1RealmsByRealmAbout-posts'] },
];

function hasPredicate(body: ts.Node, operation: string, request = false): boolean {
  const bindings = new Map<string, ts.Expression>();
  const nestedFunction = (node: ts.Node) => ts.isFunctionDeclaration(node) || ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node) || ts.isMethodDeclaration(node);
  function collect(node: ts.Node) {
    if (nestedFunction(node)) return;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      bindings.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, collect);
  }
  collect(body);
  function mentions(node: ts.Node, seen = new Set<string>()): boolean {
    if (ts.isIdentifier(node) && bindings.has(node.text) && !seen.has(node.text)) {
      return mentions(bindings.get(node.text)!, new Set([...seen, node.text]));
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && ['operationOpen', 'gate'].includes(node.expression.text) &&
      node.arguments[0] && ts.isStringLiteralLike(node.arguments[0]) && node.arguments[0].text === operation) return true;
    return ts.forEachChild(node, child => mentions(child, seen) || undefined) ?? false;
  }
  function renders(node: ts.Node, seen = new Set<string>()): boolean {
    if (ts.isIdentifier(node) && bindings.has(node.text) && !seen.has(node.text)) {
      return renders(bindings.get(node.text)!, new Set([...seen, node.text]));
    }
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node)) return true;
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'link') return true;
    if (nestedFunction(node)) return false;
    return ts.forEachChild(node, child => renders(child, seen) || undefined) ?? false;
  }
  function walk(node: ts.Node): boolean {
    // A handler can refuse a click while its button remains visible. Inspect the rendering expression,
    // not a gate in a nested callback or an unrelated boolean declaration.
    if (nestedFunction(node)) return false;
    if (ts.isIfStatement(node) && mentions(node.expression) && (request || renders(node.thenStatement))) return true;
    if (ts.isConditionalExpression(node) && mentions(node.condition) &&
      (request || renders(node.whenTrue) || renders(node.whenFalse) ||
        (ts.isJsxExpression(node.parent) && ts.isJsxAttribute(node.parent.parent)))) return true;
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
      mentions(node.left) && (request || renders(node.right))) return true;
    if (ts.isJsxOpeningElement(node) && node.tagName.getText() === 'OperationGate') {
      const prop = node.attributes.properties.find(item => ts.isJsxAttribute(item) && item.name.getText() === 'operation');
      if (prop && ts.isJsxAttribute(prop) && prop.initializer && ts.isStringLiteral(prop.initializer) &&
        prop.initializer.text === operation) return true;
    }
    return ts.forEachChild(node, child => walk(child) || undefined) ?? false;
  }
  return walk(body);
}

function entryViolations(files: Readonly<Record<string, string>>): string[] {
  return entries.flatMap(entry => {
    const source = ts.createSourceFile(entry.file, files[entry.file] ?? '', ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let body: ts.Node | undefined;
    function find(node: ts.Node) {
      if (ts.isFunctionDeclaration(node) && node.name?.text === entry.function) body = node.body;
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === entry.function &&
        node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) body = node.initializer.body;
      ts.forEachChild(node, find);
    }
    find(source);
    return entry.operations.filter(operation => !body || !hasPredicate(body, operation, entry.request))
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
    "alias: .v1.me['saved-filters'] reaches deleteV1MeSaved-filtersById (platform:saved-views)",
    "alias: .v1.me['saved-filters'] reaches getV1MeSaved-filters (platform:saved-views)",
    "alias: .v1.me['saved-filters'] reaches patchV1MeSaved-filtersById (platform:saved-views)",
    "alias: .v1.me['saved-filters'] reaches postV1MeSaved-filters (platform:saved-views)",
    "alias: .v1.me['saved-filters'] reaches putV1MeSaved-filtersOrder (platform:saved-views)",
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
    expect(entryViolations({ ...webSources, [entry.file]: webSources[entry.file]!.replaceAll(operation, 'getV1Types') }))
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
