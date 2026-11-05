import { type OpenSearch, type SearchRequestWork } from './opensearch.ts';
import { type MixedDiscoveryDocumentCodec } from './discovery-documents.ts';
import { MAX_SUBJECT_GENERATIONS } from './generation-limit.ts';
export declare const SUBJECT_SORT_FORMAT = 1;
export declare const DISCOVERY_INDEX_FORMAT = 1;
export { MAX_SUBJECT_GENERATIONS };
type SubjectIndexDefinition = Record<string, unknown>;
/** A write is never retried: only a fresh bounded native observation can resolve its effect. */
export declare function observedWrite(write: () => Promise<unknown>, observe: () => Promise<boolean>, message: string): Promise<void>;
export declare function subjectIndexName(prefix: string, generation: number): string;
export declare function subjectAlias(prefix: string): string;
export declare function subjectIndexDefinition(): SubjectIndexDefinition;
export declare function createSubjectIndex(search: OpenSearch, prefix: string, generation: number, calendarFormat?: 1): Promise<void>;
/** Successor mapping in the same physical family; legacy Subject generations keep their format. */
export declare function discoveryIndexDefinition(): SubjectIndexDefinition;
/** Allocation only; source exhaustion, replay, exact-key reconciliation and custody precede activation. */
export declare function createDiscoveryIndex(search: OpenSearch, prefix: string, generation: number, incarnation?: string): Promise<void>;
/** Read the codec from one physical mapping; callers bind it to their persisted UUID separately. */
export declare function readDiscoveryDocumentCodec(search: OpenSearch, index: string): Promise<MixedDiscoveryDocumentCodec>;
export declare function discoveryIndexName(prefix: string, generation: number): string;
export declare function discoveryAlias(prefix: string): string;
export declare function discoveryIndexUuid(search: OpenSearch, index: string, work?: SearchRequestWork): Promise<string>;
/** Read the bounded name-sort writer format from one physical generation's native mapping metadata. */
export declare function readSubjectSortFormat(search: OpenSearch, prefix: string, generation: number): Promise<number | null>;
/** Calendar writes follow the actual target mapping, including while it is still being populated. */
export declare function readSubjectCalendarMappingFormat(search: OpenSearch, prefix: string, generation: number): Promise<1 | null>;
export declare function readSubjectCalendarMappingFormatForIndex(search: OpenSearch, index: string): Promise<1 | null>;
/** A calendar projection is searchable only after full population marked the exact physical UUID ready. */
export declare function readSubjectCalendarFormat(search: OpenSearch, prefix: string, generation: number): Promise<1 | null>;
/** Called only after the generation owner has proved complete population and reconciliation. */
export declare function markSubjectCalendarReady(search: OpenSearch, prefix: string, generation: number): Promise<string>;
/** Read the UUID of one immutable physical generation, never through its mutable alias. */
export declare function readSubjectIndexUuid(search: OpenSearch, prefix: string, generation: number): Promise<string>;
export declare function readSubjectActivationTime(search: OpenSearch, prefix: string, generation: number): Promise<number | null>;
/** Set activation metadata once and admit it only after the exact complete mapping is observed. */
export declare function ensureSubjectActivationMetadata(search: OpenSearch, prefix: string, generation: number): Promise<number>;
/** Add rating sort fields to an existing generation without changing its analyzers or sort-key bounds. */
export declare function ensureSubjectRatingMapping(search: OpenSearch, prefix: string, generation: number): Promise<void>;
export declare function subjectGenerations(search: OpenSearch, prefix: string, work?: SearchRequestWork): Promise<{
    generations: number[];
    active: number | null;
}>;
