import { HANDLE_LOOKUP_PATTERN } from '../access/handle-policy.ts';

/** Shared pure query assembly for mixed capture and bounded engine execution. */
export function discoveryNativeQuery(
  plan: Readonly<{ query?: Record<string, unknown>; filter: Record<string, unknown>; boost?: string }>,
): Record<string, unknown> {
  const should: Record<string, unknown>[] =
    plan.boost === undefined
      ? []
      : [
          { term: { 'names.exact': { value: plan.boost, boost: 10 } } },
          { match_phrase: { names: { query: plan.boost, boost: 3 } } },
          ...(HANDLE_LOOKUP_PATTERN.test(plan.boost)
            ? [
                {
                  constant_score: {
                    filter: {
                      bool: {
                        filter: [
                          { term: { owner: 'accounts' } },
                          { term: { 'handle.exact': plan.boost.toLowerCase() } },
                        ],
                      },
                    },
                    boost: 10,
                  },
                },
              ]
            : []),
        ];
  return { bool: { must: plan.query ?? { match_all: {} }, filter: plan.filter, ...(should.length ? { should } : {}) } };
}
