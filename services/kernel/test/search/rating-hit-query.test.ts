import { expect, test } from 'bun:test';
import { createOpenSearch, type OpenSearch } from '../../src/search/opensearch.ts';
import { createSubjectIndex, subjectIndexName } from '../../src/search/indices.ts';
import { HIT_TEMPLATE, installTemplates, searchSubjectHits } from '../../src/search/query.ts';
import { STANDARD_QUESTION_ID } from '../../src/rating/votes.ts';
import { GLOBAL_CONTEXT } from '../../src/access/gates/catalogue.ts';

test('a full native scored hit page executes no unused unscored count phase', async () => {
  const native = createOpenSearch(process.env.OPENSEARCH_URL!);
  const prefix = `rating-hits-${crypto.randomUUID().slice(0, 8)}-`,
    index = subjectIndexName(prefix, 1);
  await createSubjectIndex(native, prefix, 1);
  await installTemplates(native, prefix);
  try {
    const ids = [1, 2, 3].map((n) => `018f0000-0000-7000-8000-00a0${String(n).padStart(8, '0')}`);
    await native.bulk(
      ids.flatMap((id, n) => [
        { index: { _index: index, _id: id } },
        {
          id,
          partition: 10,
          security_revision: 1,
          type: 'schema:Book',
          name_sort: `Rated ${n}`,
          names: [`Rated ${n}`],
          descriptions: [],
          statements: [],
          facts: [],
          ...(n < 2 ? { rating_score: 9 - n, rating_prior_epoch: 7 } : {}),
        },
      ]),
      { query: { refresh: 'wait_for' } },
    );
    const calls: { id: string; params: { size: number } }[] = [];
    const observed: OpenSearch = {
      bulk: native.bulk,
      async request<T>(...args: Parameters<OpenSearch['request']>) {
        if (args[1].endsWith('/_search/template'))
          calls.push(structuredClone(args[2]) as { id: string; params: { size: number } });
        return native.request<T>(...args);
      },
    };
    const result = await searchSubjectHits(observed, prefix, {
      sort: 'rating',
      size: 1,
      generation: 1,
      rating: { questionId: STANDARD_QUESTION_ID, populationId: GLOBAL_CONTEXT.id, priorEpoch: 7 },
    });
    expect(result).not.toHaveProperty('total');
    expect(result.hits.map((hit) => hit.id)).toEqual([ids[0]!]);
    expect(calls).toHaveLength(1);
    expect(calls.every((call) => call.id === `${prefix}${HIT_TEMPLATE}` && call.params.size > 0)).toBe(true);
  } finally {
    await native.request('DELETE', `/${index}`);
    for (const name of ['subjects-hits-v1', 'subjects-search-v2', 'subjects-suggest-v1', 'subjects-facets-v1'])
      await native.request('DELETE', `/_scripts/${prefix}${name}`).catch(() => undefined);
  }
});
