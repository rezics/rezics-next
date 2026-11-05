import { afterAll, expect, test } from 'bun:test';
import { searchRunArgs } from '../../scripts/search.ts';
import { createSubjectIndex, subjectIndexName } from '../../src/search/indices.ts';
import { createOpenSearch, OpenSearchError } from '../../src/search/opensearch.ts';

const url = process.env.OPENSEARCH_URL;
if (!url) throw new Error("OPENSEARCH_URL must name the check's OpenSearch node");
const search = createOpenSearch(url);
const prefix = `test-${crypto.randomUUID()}-`;
const retired = subjectIndexName(prefix, 1);
const fresh = subjectIndexName(prefix, 2);
const probe = `${prefix}probe`;
const policy = 'action.auto_create_index=-*subjects-g*,+*';

type BulkResult = {
  errors: boolean;
  items: {
    index: {
      _index: string;
      _id: string;
      _version?: number;
      status: number;
      error?: { type: string; reason: string; index: string };
    };
  }[];
};

// Controlled native payload only: this test proves engine configuration, not source or membership behavior.
const document = {
  id: 'native-policy-probe',
  partition: 0,
  type: 'native-policy-probe',
  security_revision: 1,
  public_collection_count: 0,
  names: ['Native policy probe'],
  descriptions: [],
  name_sort: 'native policy probe',
  statements: [],
  relation_facet_overflow: [],
  facts: [],
};

function versionedWrite(index: string, version: number): unknown[] {
  return [{ index: { _index: index, _id: document.id, version, version_type: 'external' } }, document];
}

async function indexExists(index: string): Promise<boolean> {
  try {
    // HEAD the physical index itself: a missing document is not evidence of a missing index.
    const response = await search.request('HEAD', `/${index}`);
    expect(response.status).toBe(200);
    return true;
  } catch (error) {
    if (error instanceof OpenSearchError && error.status === 404) return false;
    throw error;
  }
}

async function expectDocument(index: string, version: number): Promise<void> {
  const response = await search.request('GET', `/${index}/_doc/${document.id}`);
  expect(response.status).toBe(200);
  expect(response.body).toMatchObject({ _index: index, _version: version, found: true, _source: document });
}

function expectCreated(result: BulkResult, index: string, version: number): void {
  expect(result.errors).toBe(false);
  expect(result.items).toHaveLength(1);
  expect(result.items[0]).toMatchObject({
    index: { _index: index, _id: document.id, _version: version, status: 201 },
  });
}

afterAll(async () => {
  // Attempt every owned name even if one cleanup fails, including an accidentally auto-created retired index.
  const results = await Promise.allSettled(
    [retired, fresh, probe].map((index) =>
      search.request('DELETE', `/${index}`, undefined, { query: { ignore_unavailable: true } }),
    ),
  );
  const failures = results.filter((result) => result.status === 'rejected').map((result) => result.reason);
  if (failures.length) throw new AggregateError(failures, 'Native policy probe cleanup failed');
}, 30_000);

test('development search node carries the exact ordered subject auto-create policy', () => {
  const args = searchRunArgs('native-policy-test-image');
  const environment = args.flatMap((arg, i) => (arg === '-e' ? [args[i + 1]] : []));
  expect(environment.filter((entry) => entry?.startsWith('action.auto_create_index='))).toEqual([policy]);
});

test('actual native late bulk cannot implicitly recreate a retired subject generation while explicit creation works', async () => {
  expect(await indexExists(retired)).toBe(false);
  await createSubjectIndex(search, prefix, 1);
  expect(await indexExists(retired)).toBe(true);
  expectCreated(await search.bulk<BulkResult>(versionedWrite(retired, 17)), retired, 17);
  await expectDocument(retired, 17);

  const delayed = versionedWrite(retired, 18);
  await search.request('DELETE', `/${retired}`);
  expect(await indexExists(retired)).toBe(false);
  const late = await search.bulk<BulkResult>(delayed);
  const retiredExistsAfterBulk = await indexExists(retired);

  // Explicit creation concerns a different generation; this says nothing about reusing retired names.
  expect(await indexExists(fresh)).toBe(false);
  await createSubjectIndex(search, prefix, 2);
  expect(await indexExists(fresh)).toBe(true);
  expectCreated(await search.bulk<BulkResult>(versionedWrite(fresh, 19)), fresh, 19);
  await expectDocument(fresh, 19);

  // No explicit PUT: the ordered +* rule still permits ordinary non-subject implicit creation.
  expect(await indexExists(probe)).toBe(false);
  expectCreated(await search.bulk<BulkResult>(versionedWrite(probe, 1)), probe, 1);
  expect(await indexExists(probe)).toBe(true);
  await expectDocument(probe, 1);

  // Bulk HTTP success is insufficient: decode the actual action's native failure.
  expect(late.errors).toBe(true);
  expect(late.items).toHaveLength(1);
  expect(late.items[0]).toMatchObject({
    index: {
      _index: retired,
      _id: document.id,
      status: 404,
      error: { type: 'index_not_found_exception' },
    },
  });
  expect(late.items[0]?.index.error?.reason).toContain('action.auto_create_index');
  expect(retiredExistsAfterBulk).toBe(false);
  expect(await indexExists(retired)).toBe(false);
}, 60_000);
