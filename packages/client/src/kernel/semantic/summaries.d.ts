import type { SubjectSummaryObservation } from './contract/index.ts';
import type { SummaryDependencies, SummaryObservationOptions, SummaryReadOptions, DisplaySummary, SummaryReaderDependencies } from './subject-reading-application.ts';
export type { CoverCredit, CoverSummary, RelatedSubjectSummary, SubjectSummary, SummarySources, SummaryCoverState, SubjectSummaryObservation, } from './contract/index.ts';
export type { DisplaySummary, SummaryDependencies, SummaryReaderDependencies };
export { summaryAuthorization } from './subject-reading-application.ts';
/** Compatibility facade; native Subject pages call the same operation through their injected application. */
export declare function readSubjectSummaries(deps: SummaryDependencies | SummaryReaderDependencies, ids: readonly string[], options?: SummaryReadOptions): Promise<Map<string, DisplaySummary | null>>;
/** Ordinary projection plus source anchors for composed native readers. */
export declare function readSubjectSummaryObservation(deps: SummaryReaderDependencies, ids: readonly string[], options?: SummaryObservationOptions): Promise<SubjectSummaryObservation>;
