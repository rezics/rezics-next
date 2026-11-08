import type { PublicFilterSource, PublicFilterSourceFactory, RecordPrivacyReduction as RecordPrivacyReductionType } from './public-filter-source-contract.ts';
import type { PublicFilterAccessBindingPort, PublicFilterSearchBindingPort, SourceBindingFactory } from './source-binding-port.ts';
type SourceConfiguration = Parameters<PublicFilterSourceFactory>[0];
export declare function publicFilterSourceOrigin(source: PublicFilterSource): SourceConfiguration | undefined;
/**
 * Constructor-origin routing is internal; the binding independently registers and verifies
 * persisted Source metadata. Population coverage stays closed until its retained cut is complete.
 */
export declare function createNativePublicFilterSource(config: SourceConfiguration, bindingFactory: SourceBindingFactory, search: PublicFilterSearchBindingPort, accessPort: PublicFilterAccessBindingPort): PublicFilterSource;
export declare const recordPrivacyReduction: RecordPrivacyReductionType;
/** Public Source factory resolves through the single application installed by Semantic composition. */
export declare const publicFilterSource: PublicFilterSourceFactory;
export {};
