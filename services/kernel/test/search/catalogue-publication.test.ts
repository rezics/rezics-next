import { expect, test } from 'bun:test';
import { bundledRelease } from '@rezics/definitions/bundled';
import { enterCataloguePublicationMembers } from '../../src/library/collection-publication-staging-state.ts';
import { readCataloguePublicationPage } from '../../src/search/catalogue-publication.ts';
import type { OpenSearch } from '../../src/search/opensearch.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';

const first = '018f0000-0000-7000-8000-00a000000001';
const second = '018f0000-0000-7000-8000-00a000000002';
const third = '018f0000-0000-7000-8000-00a000000003';

function hit(id: string) {
  return {
    _id: id,
    _index: 'rezics-subjects-g1',
    _source: { partition: partitionOf(routeOf(id)!), security_revision: 1 },
    sort: [id],
  };
}

test('catalogue publication frontier admits matching subjects and exhausts an empty final page', () => {
  const started = enterCataloguePublicationMembers(
    { after: null, pending: null, exhausted: false },
    [first, second],
    false,
  );
  expect(started.pending).toMatchObject({
    subject: first,
    coveredThrough: second,
    lastInPage: false,
    sourceExhausted: false,
  });
  const last = enterCataloguePublicationMembers({ after: second, pending: null, exhausted: false }, [third], true);
  expect(last.pending).toMatchObject({ subject: third, lastInPage: true, sourceExhausted: true });
  expect(enterCataloguePublicationMembers({ after: third, pending: null, exhausted: false }, [], true)).toEqual({
    after: third,
    pending: null,
    exhausted: true,
  });
  expect(() =>
    enterCataloguePublicationMembers({ after: null, pending: null, exhausted: false }, [second, first], true),
  ).toThrow();
});

test('catalogue publication pages canonical unique ids from the public Search consumer', async () => {
  const client = {
    async request() {
      return {
        status: 200,
        body: {
          timed_out: false,
          _shards: { total: 1, successful: 1, skipped: 0, failed: 0 },
          hits: { hits: [hit(first), hit(second), hit(third)] },
        },
      };
    },
  } as unknown as OpenSearch;
  const page = await readCataloguePublicationPage({
    client,
    prefix: 'rezics-',
    filter: { type: { in: ['schema:Book'] } },
    release: bundledRelease,
    after: null,
    limit: 2,
  });
  expect(page).toEqual({ subjects: [first, second], exhausted: false });
});
