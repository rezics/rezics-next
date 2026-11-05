import { type SourceFigures } from './source-figures.ts';
/** Admission is provider policy; a configured fence alias never selects a profile. */
export declare const SOURCE_PROVIDERS: {
    readonly vndb: {
        readonly record: (id: string) => boolean;
        readonly scale: (min: number, max: number) => boolean;
    };
    readonly bangumi: {
        readonly record: (id: string) => boolean;
        readonly scale: (min: number, max: number) => boolean;
    };
};
export type SourceProvider = keyof typeof SOURCE_PROVIDERS;
export declare const SOURCE_PROVIDER_IDS: readonly ("bangumi" | "vndb")[];
export declare const SOURCE_OBSERVATION_PAYLOAD_VERSION: 1;
export declare function sourceProvider(value: string): {
    readonly record: (id: string) => boolean;
    readonly scale: (min: number, max: number) => boolean;
} | null;
export type SourceObservation = Readonly<{
    sourceAlias?: string;
    sourceRecordId: string;
    count: number;
    figures?: SourceFigures;
    asOf: string;
    scale?: {
        min: number;
        max: number;
    };
    mean?: number;
    licence?: string;
    attribution?: string;
    expectedObservation?: string | null;
}>;
/** An observation has no provider revision inferred from its date or digest.
 * Optional figures carry their own native encoding version; scalar digests stay unchanged.
 * CAS provenance is command input, not part of the immutable observed payload.
 * Explicit default aliases and omitted aliases identify the same source observation.
 */
export declare function sourceObservation(subjectId: string, source: string, value: SourceObservation): {
    digest: string;
    payload: {
        sourceRecordId: string;
        count: number;
        figures?: SourceFigures;
        asOf: string;
        scale?: {
            min: number;
            max: number;
        };
        mean?: number;
        licence?: string;
        attribution?: string;
        sourceAlias: string;
    };
};
