import type { MatchEvidenceQuery } from './match-evidence.ts';

type QueryInput = {
  query?: Record<string, unknown>;
  filter?: Record<string, unknown>;
  after?: readonly (string | number | null)[];
  overflowProperties?: readonly string[];
  matchEvidence?: MatchEvidenceQuery;
};

/** Own the query family's nested JSON inputs; retain live request work by identity. */
export function ownQueryInput<T extends QueryInput>(input: T): T {
  return {
    ...input,
    query: structuredClone(input.query),
    filter: structuredClone(input.filter),
    after: structuredClone(input.after),
    overflowProperties: structuredClone(input.overflowProperties),
    matchEvidence: structuredClone(input.matchEvidence),
  };
}
