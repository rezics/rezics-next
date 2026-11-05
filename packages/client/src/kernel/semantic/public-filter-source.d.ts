import type { PublicFilterSource, PublicFilterSourceFactory, RecordPrivacyReduction as RecordPrivacyReductionType } from './public-filter-source-contract.ts';
type SourceConfiguration = Parameters<PublicFilterSourceFactory>[0];
/** Internal constructor routing only. The binding independently validates persisted owner rows. */
export declare function publicFilterSourceOrigin(source: PublicFilterSource): SourceConfiguration | undefined;
/**
 * Constructor-origin routing is internal; the binding independently registers and verifies
 * persisted Source metadata. Population coverage stays closed until its retained cut is complete.
 */
export declare const publicFilterSource: PublicFilterSourceFactory;
export declare const recordPrivacyReduction: RecordPrivacyReductionType;
export {};
