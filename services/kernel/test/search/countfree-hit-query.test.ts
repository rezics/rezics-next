import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { GLOBAL_CONTEXT } from '../../src/access/gates/catalogue.ts';
import { STANDARD_QUESTION_ID } from '../../src/rating/votes.ts';
import { createSubjectIndex, subjectIndexName } from '../../src/search/indices.ts';
import { createOpenSearch, SearchUnavailableError, type OpenSearch } from '../../src/search/opensearch.ts';
import {
  HIT_TEMPLATE,
  installTemplates,
  searchSubjectHits,
  searchSubjects,
  type SearchPlan,
} from '../../src/search/query.ts';

describe('native hit-only query and parser', () => {
  const url = process.env.OPENSEARCH_URL;
  if (!url) throw new Error('OPENSEARCH_URL must name the check node');
  const native = createOpenSearch(url);
  const prefix = `hit-query-${crypto.randomUUID().slice(0, 8)}-`;
  const index = subjectIndexName(prefix, 1);
  const id = (n: number) => `018f0000-0000-7000-8000-00a0${String(n).padStart(8, '0')}`;
  const plans: SearchPlan[] = [
    { sort: 'id', size: 3, generation: 1 },
    {
      sort: 'rating',
      size: 3,
      generation: 1,
      rating: { questionId: STANDARD_QUESTION_ID, populationId: GLOBAL_CONTEXT.id, priorEpoch: 7 },
    },
  ];
  beforeAll(async () => {
    await createSubjectIndex(native, prefix, 1);
    await installTemplates(native, prefix);
    const result = await native.bulk<{ errors: boolean }>(
      [1, 2, 3, 4].flatMap((n) => [
        { index: { _index: index, _id: id(n) } },
        {
          id: id(n),
          partition: 10,
          security_revision: 1,
          type: 'schema:Book',
          name_sort: `Book ${n}`,
          search_text: 'needle',
          names: ['needle'],
          ...(n < 3 ? { rating_score: 9 - n, rating_prior_epoch: 7 } : {}),
        },
      ]),
      { query: { refresh: 'wait_for' } },
    );
    expect(result.errors).toBe(false);
  });
  afterAll(async () => {
    await native.request('DELETE', `/${index}`);
    for (const name of ['subjects-hits-v1', 'subjects-search-v2', 'subjects-suggest-v1', 'subjects-facets-v1'])
      await native.request('DELETE', `/_scripts/${prefix}${name}`);
  });

  function observed(mutate?: (body: any) => void) {
    const replies: any[] = [];
    const client: OpenSearch = {
      bulk: native.bulk,
      async request<T>(...args: Parameters<OpenSearch['request']>) {
        const response = await native.request<T>(...args);
        if (!args[1].endsWith('/_search/template')) return response;
        expect((args[2] as any).id).toBe(`${prefix}${HIT_TEMPLATE}`);
        const body = structuredClone(response.body) as any;
        expect(body.hits.total).toBeUndefined();
        replies.push(structuredClone(body));
        mutate?.(body);
        return { ...response, body };
      },
    };
    return { client, replies };
  }
  for (const plan of plans) {
    test(`native hit-only ${plan.sort}/${plan.ratingPhase ?? 'initial'} accepts omitted totals and preserves phase tuples`, async () => {
      const capture = observed();
      const result = await searchSubjectHits(capture.client, prefix, plan);
      expect(result).not.toHaveProperty('total');
      expect(result.hits.length).toBeGreaterThan(0);
      expect(capture.replies.length).toBe(plan.sort === 'rating' && !plan.ratingPhase ? 2 : 1);
      for (const hit of result.hits) {
        expect(hit.index).toBe(index);
        expect(hit.partition).toBe(10);
        expect(hit.sort.at(-1)).toBe(hit.id);
        if (plan.sort === 'id') expect(hit.sort).toEqual([hit.id]);
        if (plan.sort === 'rating') {
          expect(['scored', 'unscored']).toContain(hit.ratingPhase!);
          expect(hit.sort.length).toBe(hit.ratingPhase === 'scored' ? 3 : 2);
        }
      }
    });
    const faults: ((body: any) => void)[] = [
      (b) => {
        delete b.hits;
      },
      (b) => {
        b.timed_out = true;
      },
      (b) => {
        b._shards.failed = 1;
      },
      (b) => {
        b.terminated_early = true;
      },
      (b) => {
        b.hits.hits[0]._index = 'other';
      },
      (b) => {
        b.hits.hits[0]._source.partition = 11;
      },
      (b) => {
        b.hits.hits[0].sort = [];
      },
      (b) => {
        b.hits.hits[0].matched_queries = [1];
      },
      (b) => {
        b.hits.hits[0]._source.security_revision = -1;
      },
      (b) => {
        b.hits.hits = Array(4).fill(b.hits.hits[0]);
      },
    ];
    faults.forEach((fault, n) =>
      test(`hit-only malformed control ${plan.sort}/${plan.ratingPhase ?? 'initial'}/${n}`, async () => {
        await expect(searchSubjectHits(observed(fault).client, prefix, plan)).rejects.toBeInstanceOf(
          SearchUnavailableError,
        );
      }),
    );
    test(`hit-only ${plan.sort}/${plan.ratingPhase ?? 'initial'} validates optional overflow`, async () => {
      const withOverflow = { ...plan, overflowProperties: ['schema:author'] };
      await expect(
        searchSubjectHits(
          observed((b) => {
            delete b.aggregations;
          }).client,
          prefix,
          withOverflow,
        ),
      ).rejects.toBeInstanceOf(SearchUnavailableError);
    });
  }
  test('the released counted path still requires its consumed native total', async () => {
    const legacy: OpenSearch = {
      bulk: native.bulk,
      async request<T>(...args: Parameters<OpenSearch['request']>) {
        const result = await native.request<T>(...args);
        if (args[1].endsWith('/_search/template')) delete (result.body as any).hits.total;
        return result;
      },
    };
    await expect(searchSubjects(legacy, prefix, plans[0]!)).rejects.toBeInstanceOf(SearchUnavailableError);
  });
});

describe('native immutable hit template', () => {
  const url = process.env.OPENSEARCH_URL;
  if (!url) throw new Error('OPENSEARCH_URL must name the check node');
  const client = createOpenSearch(url);
  const prefix = `hit-template-${crypto.randomUUID().slice(0, 8)}-`;
  const script = `${prefix}subjects-hits-v1`;
  afterAll(async () => {
    await client.request('DELETE', `/_scripts/${script}`).catch(() => undefined);
  });

  test('the native versioned hit template disables total tracking and preserves serialized query input', async () => {
    await installTemplates(client, prefix);
    const stored = await client.request<{ script: { source: string } }>('GET', `/_scripts/${script}`);
    expect(stored.body.script.source).toContain('track_total_hits');
    const rendered = await client.request<{ template_output: Record<string, unknown> }>('POST', '/_render/template', {
      id: script,
      params: {
        query: { match_all: {} },
        has_query: true,
        has_filter: false,
        has_boost: false,
        size: 3,
        sort: [{ id: 'asc' }],
        has_after: false,
        has_overflow: false,
      },
    });
    expect(rendered.body.template_output.track_total_hits).toBe(false);
    expect(rendered.body.template_output.size).toBe(3);
    expect(rendered.body.template_output.sort).toEqual([{ id: 'asc' }]);
    expect(JSON.stringify(rendered.body.template_output.query)).toContain('match_all');
  });
});
