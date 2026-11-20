import { nativeSubjectReadingApplication } from './adapters/subject-reading.ts';
import type { SubjectSummary, SubjectSummaryObservation } from './contract/index.ts';
import type {
  SummaryDependencies,
  SummaryObservationOptions,
  SummaryReadOptions,
  DisplaySummary,
  SummaryReaderDependencies,
} from './subject-reading-application.ts';

export type {
  CoverCredit,
  CoverSummary,
  RelatedSubjectSummary,
  SubjectSummary,
  SummarySources,
  SummaryCoverState,
  SubjectSummaryObservation,
} from './contract/index.ts';
export type { DisplaySummary, SummaryDependencies, SummaryReaderDependencies };
export { summaryAuthorization } from './subject-reading-application.ts';

/** Compatibility facade; native Subject pages call the same operation through their injected application. */
export function readSubjectSummaries(
  deps: SummaryDependencies | SummaryReaderDependencies,
  ids: readonly string[],
  options: SummaryReadOptions = {},
): Promise<Map<string, DisplaySummary | null>> {
  return nativeSubjectReadingApplication().readSubjectSummaries(deps, ids, options);
}

/** Ordinary projection plus source anchors for composed native readers. */
export function readSubjectSummaryObservation(
  deps: SummaryReaderDependencies,
  ids: readonly string[],
  options: SummaryObservationOptions = {},
): Promise<SubjectSummaryObservation> {
  return nativeSubjectReadingApplication().readSubjectSummaryObservation(deps, ids, options);
}
