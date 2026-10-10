import { expect, test } from 'bun:test';
import {
  operationExposures,
  type PlatformOperationId,
} from '../../../generated/openapi/main/exposure.ts';
import { edenCalls, escape, operationPattern, readWebSources } from './support/eden-calls.ts';

// The web may call a Main operation that the platform keeps closed only behind `operationOpen` (or answering
// Main's `platform_closed` as the typed `closed` outcome). The scan reads every source file under `features/`
// and `app/` for the operations it calls, through the Eden client or a path literal, and checks each closed one
// against the generated exposure table, which is the only source of what is closed.

const closedIds = (Object.keys(operationExposures) as PlatformOperationId[]).filter(
  (id) => operationExposures[id] !== 'public',
);
const publicIds = Object.keys(operationExposures);

export interface Call {
  /** Where the operation was recognised, for the failure message. */
  source: string;
  operations: PlatformOperationId[];
}

/** Operations the Eden client calls: `x.v1.me['saved-filters'].get(...)`, or the same chain kept in a variable. */
function closedCalls(text: string): Call[] {
  return edenCalls(text).flatMap((call) => {
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

export const callsIn = (text: string): Call[] => [...closedCalls(text), ...pathCalls(text)];

/** Whether the file asks the viewer's gate for the operation, or answers Main's refusal as the closed outcome. */
function guarded(text: string, operation: string): boolean {
  return (
    new RegExp(`operationOpen\\(\\s*['"]${escape(operation)}['"]`).test(text) ||
    /['"]closed['"]/.test(text)
  );
}

export function violations(files: Readonly<Record<string, string>>): string[] {
  return Object.entries(files).flatMap(([file, text]) =>
    callsIn(text).flatMap((call) =>
      call.operations
        .filter((operation) => !guarded(text, operation))
        .map(
          (operation) =>
            `${file}: ${call.source} reaches ${operation} (${operationExposures[operation]})`,
        ),
    ),
  );
}

const webSources = readWebSources();

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
      asked:
        "if (operationOpen('getV1MeSaved-filters', access)) main.v1.me['saved-filters'].get({ query: {} });",
      answered:
        "const read = await main().v1['mod-releases']({ work }).get({}); if (read.failure === 'closed') hide();",
      open: 'main.v1.works({ id }).releases.get({});',
    }),
  ).toEqual([]);
});
