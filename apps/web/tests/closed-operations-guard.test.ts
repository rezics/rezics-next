import { expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  operationExposures,
  type PlatformOperationId,
} from '../../../generated/openapi/main/exposure.ts';

// The web may call a Main operation that the platform keeps closed only behind `operationOpen` (or answering
// Main's `platform_closed` as the typed `closed` outcome). The scan reads every source file under `features/`
// and `app/` for the operations it calls, through the Eden client or a path literal, and checks each closed one
// against the generated exposure table, which is the only source of what is closed.

const webRoot = join(import.meta.dir, '..');
const METHODS = ['get', 'post', 'put', 'patch', 'delete'];
const closedIds = (Object.keys(operationExposures) as PlatformOperationId[]).filter(
  (id) => operationExposures[id] !== 'public',
);
const publicIds = Object.keys(operationExposures);
const upper = (word: string) => word[0]!.toUpperCase() + word.slice(1);
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const WORD_PARAMETER = 'By[A-Z][a-z0-9]*';

/** A route's operation ID pattern from path segments: a string is a literal segment, null an unnamed parameter. */
function operationPattern(method: string | null, segments: readonly (string | null)[], prefix = false): RegExp {
  const path = segments
    .map((segment) =>
      segment === null ? WORD_PARAMETER : segment.startsWith('By') ? segment : escape(upper(segment)),
    )
    .join('');
  const verb = method ?? '(?:get|post|put|patch|delete)';
  // A chain that ends before a method is an alias for a client: it may reach every operation below it.
  return new RegExp(`^${verb}V1${path}${prefix ? '(?:[A-Z].*)?' : ''}$`);
}

export interface Call {
  /** Where the operation was recognised, for the failure message. */
  source: string;
  operations: PlatformOperationId[];
}

const chain = /(?<=\.)v1((?:\s*\??\.\s*[A-Za-z_]\w*|\[['"][^'"]+['"]\]|\((?:[^()]|\([^()]*\))*\))*)/g;
const link = /\.\s*([A-Za-z_]\w*)|\[['"]([^'"]+)['"]\]|\((?:[^()]|\([^()]*\))*\)/g;

/** Operations the Eden client calls: `x.v1.me['saved-filters'].get(...)`, or the same chain kept in a variable. */
function edenCalls(text: string): Call[] {
  const calls: Call[] = [];
  for (const found of text.matchAll(chain)) {
    const segments: (string | null)[] = [];
    let method: string | null = null;
    const links = [...found[1]!.matchAll(link)];
    for (const item of links) {
      const name = item[1] ?? item[2];
      if (name === undefined) {
        const key = /^\(\s*\{\s*(\w+)/.exec(item[0])?.[1];
        segments.push(key ? `By${upper(key)}` : null);
        continue;
      }
      const after = text[found.index + 2 + item.index + item[0].length];
      if (item[1] && METHODS.includes(name) && after === '(') {
        method = name;
        break;
      }
      segments.push(name);
    }
    // A bare `.v1` names no route.
    if (!segments.length && method === null) continue;
    const pattern = operationPattern(method, segments, method === null);
    const operations = closedIds.filter((id) => pattern.test(id));
    if (operations.length) calls.push({ source: `.v1${found[1]!.replace(/\s+/g, '')}`, operations });
  }
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
    const path = (found.groups!.single ?? found.groups!.template!).replace(/^\/api\/main/, '').split('?')[0]!;
    // `/v1/media/` is a prefix test, not a request.
    if (path.endsWith('/')) continue;
    const segments = path
      .split('/')
      .slice(2)
      .map((segment) => (/^\$\{.*\}$|^\{.*\}$|^\$\{/.test(segment) ? null : segment));
    const operations = methodsAfter(text, found.index + found[0].length).flatMap((method) =>
      closedIds.filter((id) => operationPattern(method, segments).test(id)),
    );
    if (operations.length) calls.push({ source: path, operations });
  }
  return calls;
}

export const callsIn = (text: string): Call[] => [...edenCalls(text), ...pathCalls(text)];

/** Whether the file asks the viewer's gate for the operation, or answers Main's refusal as the closed outcome. */
function guarded(text: string, operation: string): boolean {
  return (
    new RegExp(`operationOpen\\(\\s*['"]${escape(operation)}['"]`).test(text) || /['"]closed['"]/.test(text)
  );
}

export function violations(files: Readonly<Record<string, string>>): string[] {
  return Object.entries(files).flatMap(([file, text]) =>
    callsIn(text).flatMap((call) =>
      call.operations
        .filter((operation) => !guarded(text, operation))
        .map((operation) => `${file}: ${call.source} reaches ${operation} (${operationExposures[operation]})`),
    ),
  );
}

const skipped = /\.(?:test|stories|e2e)\.tsx?$|(?:fixtures?|story-fetch)\.tsx?$/;

function sources(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : sources(path);
    return /\.tsx?$/.test(name) && !skipped.test(name) ? [path] : [];
  });
}

const webSources = Object.fromEntries(
  [...sources(join(webRoot, 'features')), ...sources(join(webRoot, 'app'))].map((path) => [
    relative(webRoot, path),
    readFileSync(path, 'utf8'),
  ]),
);

test('the exposure table marks closed operations and every operation ID has the shape the scan reads', () => {
  expect(closedIds.length).toBeGreaterThan(200);
  expect(publicIds.length).toBeGreaterThan(closedIds.length);
  expect(closedIds).toContain('getV1MeSaved-filters');
});

test('the scan sees the web calls to closed operations it must guard', () => {
  const seen = new Set(
    Object.entries(webSources).flatMap(([file, text]) =>
      callsIn(text).flatMap((call) => call.operations.map((operation) => `${file} ${operation}`)),
    ),
  );
  expect([...seen]).toContain('features/saved-filter/server.ts getV1MeSaved-filters');
  expect([...seen]).toContain('features/saved-filter/api.ts postV1MeSaved-filters');
  expect([...seen]).toContain('features/saved-filter/api.ts putV1MeSaved-filtersOrder');
  expect([...seen]).toContain('features/realm/read.ts getV1Mod-releasesByWork');
});

test('a closed operation is called only behind operationOpen or the typed closed outcome', () => {
  expect(violations(webSources)).toEqual([]);
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

test('the scan accepts a call that asks operationOpen or answers the closed outcome', () => {
  expect(
    violations({
      asked: "if (operationOpen('getV1MeSaved-filters', access)) main.v1.me['saved-filters'].get({ query: {} });",
      answered: "const read = await main().v1['mod-releases']({ work }).get({}); if (read.failure === 'closed') hide();",
      open: 'main.v1.works({ id }).releases.get({});',
    }),
  ).toEqual([]);
});
