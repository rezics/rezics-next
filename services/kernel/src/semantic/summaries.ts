import { nativeSubjectReadingApplication } from './adapters/subject-reading.ts';
import type {
  CoverSummary,
  RelatedSubjectSummary,
  SubjectSummary,
  SummaryDependencies,
  SummaryReaderDependencies,
  SummaryCoverState,
  SubjectSummaryObservation,
} from './subject-reading-application.ts';

export type {
  CoverSummary,
  RelatedSubjectSummary,
  SubjectSummary,
  SummaryDependencies,
  SummaryReaderDependencies,
  SummaryCoverState,
  SubjectSummaryObservation,
};
export { summaryAuthorization } from './subject-reading-application.ts';

/** Compatibility facade; native Subject pages call the same operation through their injected application. */
export function readSubjectSummaries(
  deps: SummaryDependencies | SummaryReaderDependencies,
  ids: readonly string[],
  options: { languages?: readonly string[] } = {},
): Promise<Map<string, SubjectSummary | null>> {
  return nativeSubjectReadingApplication().readSubjectSummaries(deps, ids, options);
}

/** Ordinary projection plus source anchors for composed native readers. */
export function readSubjectSummaryObservation(
  deps: SummaryReaderDependencies,
  ids: readonly string[],
  options: { languages?: readonly string[]; displayFallback?: boolean } = {},
): Promise<SubjectSummaryObservation> {
  return nativeSubjectReadingApplication().readSubjectSummaryObservation(deps, ids, options);
}
