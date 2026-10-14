import { beforeAll, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  attachCallingTests,
  buildOperationIndex,
  groupTestFiles,
  searchOperations,
  sourceCallsPath,
  type IndexedOperation,
} from './operation-index.ts';

let operations: IndexedOperation[];

beforeAll(async () => {
  operations = await buildOperationIndex();
});

function findOperation(method: string, path: string): IndexedOperation {
  const matches = operations.filter((operation) => operation.method === method && operation.path === path);
  expect(matches).toHaveLength(1);
  return matches[0]!;
}

describe('Main API operation index', () => {
  it('finds an operation from words across its id, method and path', () => {
    const result = searchOperations(operations, 'browse realms modules');
    expect(result.more).toBe(0);
    expect(result.matches.map(({ operationId }) => operationId)).toEqual(['getV1RealmsByRealmModulesBrowse']);
  });

  it('finds an exact method and path query and shows its handler', () => {
    const result = searchOperations(operations, 'GET /v1/realms/{realm}/modules/browse');
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]).toMatchObject({
      exposure: 'public',
      rateLimitFamily: 'read',
      bearer: 'no',
      idempotencyKey: false,
      routeFile: 'services/main/src/routes/zone-modules.ts',
    });
    const operation = result.matches[0]!;
    const source = readFileSync(resolve(import.meta.dir, '../..', operation.routeFile), 'utf8');
    expect(source.split('\n')[operation.handlerLine - 1])
      .toContain(".get('/v1/realms/:realm/modules/browse'");
  });

  it('reports no match with the nearest operationIds', () => {
    const result = searchOperations(operations, 'no-such-endpoint-at-all');
    expect(result.matches).toEqual([]);
    expect(result.nearestOperationIds).toHaveLength(3);
  });

  it('limits broad searches to fifteen matches and reports the remainder', () => {
    const result = searchOperations(operations, 'GET');
    expect(result.matches).toHaveLength(15);
    expect(result.more).toBeGreaterThan(0);
  });

  it('groups tests by tier directory and reports files beyond ten', () => {
    const files = Array.from({ length: 12 }, (_, index) => `tests/qa/integration/file-${index}.test.ts`);
    const sorted = [...files].sort();
    expect(groupTestFiles(files)).toEqual([{
      directory: 'tests/qa/integration',
      files: sorted.slice(0, 10),
      more: 2,
    }]);
  });

  it('matches a template-literal API call in the real integration tests', () => {
    const aboutPosts = findOperation('POST', '/v1/realms/{realm}/about-posts');
    const zoneBrowse = findOperation('GET', '/v1/realms/{realm}/modules/browse');
    attachCallingTests([aboutPosts, zoneBrowse]);
    expect(aboutPosts.testFiles).toContain('tests/qa/integration/zone-realm-discussion.test.ts');
    expect(zoneBrowse.testFiles).toContain('tests/qa/integration/outcomes/books/catalogue-browse-and-search-in-its-zone.test.ts');
    expect(sourceCallsPath('client.get(`/v1/realms/${realm}/modules/browse`)',
      '/v1/realms/{realm}/modules/browse')).toBe(true);
  });

  it('does not count a path that only shares the route prefix', () => {
    expect(sourceCallsPath('client.get(`/v1/realms/${realm}/modules/browse-extra`)',
      '/v1/realms/{realm}/modules/browse')).toBe(false);
    expect(sourceCallsPath("client.get('/v1/realms/one/modules/browse/page')",
      '/v1/realms/{realm}/modules/browse')).toBe(false);
  });
});
