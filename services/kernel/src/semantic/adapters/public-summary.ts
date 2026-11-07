import type { PublicSummaryQuery, SubjectSummary } from '../contract/index.ts';
import {
  readSubjectSummaries,
  type SubjectSummary as NativeSubjectSummary,
  type SummaryReaderDependencies,
} from '../summaries.ts';

export { CoverSummarySchema, RelatedSubjectSummarySchema, SubjectSummarySchema } from './public-summary-schema.ts';
export type { CoverCredit, CoverSummary, RelatedSubjectSummary, SubjectSummary } from './public-summary-schema.ts';

export type PublicSummaryAdapter = Readonly<{
  read(
    query: PublicSummaryQuery & Omit<SummaryReaderDependencies, 'deadline'>,
  ): Promise<ReadonlyMap<string, SubjectSummary>>;
}>;

/** Native disclosed summaries. Composition binds this producer; Content never imports the reader. */
export function createPublicSummaryAdapter(): PublicSummaryAdapter {
  return {
    async read(query) {
      const { ids, languages, deadline, ...dependencies } = query;
      const summaries = await readSubjectSummaries({ ...dependencies, deadline }, ids, { languages });
      const disclosed = new Map<string, SubjectSummary>();
      for (const [id, summary] of summaries) if (summary) disclosed.set(id, summary);
      return disclosed;
    },
  };
}

export function asDisclosedSubjectSummary(summary: NativeSubjectSummary): SubjectSummary {
  return summary;
}
