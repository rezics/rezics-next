import type { PublicSummaryRead, SubjectSummary } from '../contract/index.ts';
import { readSubjectSummaries, type SummaryReaderDependencies } from '../summaries.ts';

export { CoverSummarySchema, RelatedSubjectSummarySchema, SubjectSummarySchema } from './public-summary-schema.ts';
export type { CoverCredit, CoverSummary, RelatedSubjectSummary, SubjectSummary } from './public-summary-schema.ts';

export type PublicSummaryAdapter = Readonly<{
  read(
    actor: SummaryReaderDependencies['actor'],
    query: Parameters<PublicSummaryRead>[0],
  ): ReturnType<PublicSummaryRead>;
}>;

/** Bind the native host once; each read retains its current actor, deadline and exact keys. */
export function createPublicSummaryAdapter(
  dependencies: Omit<SummaryReaderDependencies, 'deadline' | 'actor'>,
): PublicSummaryAdapter {
  return {
    async read(actor, { ids, languages, deadline }) {
      const summaries = await readSubjectSummaries({ ...dependencies, actor, deadline }, ids, { languages });
      const disclosed = new Map<string, SubjectSummary>();
      for (const [id, summary] of summaries) if (summary) disclosed.set(id, summary);
      return disclosed;
    },
  };
}
