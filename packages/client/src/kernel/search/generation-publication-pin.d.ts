import type { PublicFilterQueriedObservation } from './public-filter-consumer-contract.ts';
/** Durable publication pin. Resume and activation reuse this exact tuple, never a later cut. */
export type GenerationPublicationPin = Readonly<{
    job: string;
    bootstrap: string;
    queried: PublicFilterQueriedObservation;
    execution: string;
}>;
export type GenerationKeyCoverage = Readonly<{
    matched: readonly string[];
    missing: readonly string[];
    extra: readonly string[];
}>;
export declare function encodeGenerationProofValue(value: unknown): string;
export declare function decodeGenerationProofValue(value: string): unknown;
export declare function encodeGenerationPublicationQueried(value: PublicFilterQueriedObservation): string;
export declare function decodeGenerationPublicationQueried(value: string): PublicFilterQueriedObservation;
export declare function encodeGenerationPublicationPin(pin: GenerationPublicationPin): string;
export declare function decodeGenerationPublicationPin(value: string): GenerationPublicationPin;
export declare function publicationPinFromNative(publication: GenerationPublicationPin): GenerationPublicationPin;
export declare function sameGenerationPublicationPin(left: GenerationPublicationPin, right: GenerationPublicationPin): boolean;
/** Identity, body and version coverage names missing Source keys and extra engine keys independently. */
export declare function classifyGenerationCoverage(expected: readonly string[], observed: readonly string[]): GenerationKeyCoverage;
