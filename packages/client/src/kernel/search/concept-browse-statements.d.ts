import { type FilterDocument, type FilterQualifier, type SpoilerThreshold } from '@rezics/filter';
import { type ConceptBrowseSource, type ConceptBrowseState, type ConceptBrowseStore } from './concept-browse.ts';
import type { IndexedStatement, RelationFacetMatch } from './source.ts';
import { type CurrentNativeLeaf } from './current-filter-plan.ts';
export type ConceptStatementRequest = Readonly<{
    subject: string;
    selection: Readonly<{
        property: string;
        concept: string;
        scheme: string;
        includeChildren?: boolean;
    }>;
    qualifiers?: readonly FilterQualifier[];
    spoilerThreshold?: SpoilerThreshold;
}>;
/** Internal full native statement key. A continuation is usable only with its original observation. */
export type ConceptStatementCursor = Readonly<{
    slot: string;
    candidate: string;
    observation: string;
}>;
export type ConceptStatementWindow = Readonly<{
    statements: readonly IndexedStatement[];
    examined: number;
    after: ConceptStatementCursor | null;
    terminal: boolean;
    /** True only when the native owner proves the complete selected prefix in this window. */
    complete: boolean;
    /** Native owner's ready, unsampled selected prefix identity. Every raw row, including
     * rejected/hidden rows, participates in the full-key continuation and revalidation.
     * This is not an absence proof until traversal from the start reaches a short window.
     */
    readyPrefix?: string;
}>;
export type ConceptStatementRead = Readonly<{
    status: 'current';
    page: ConceptStatementWindow;
    /** Re-read native selection, disclosure, original/terminal identities and source witnesses.
     * This attempt-local function must run after retained membership I/O, even for rejected rows.
     */
    revalidate(): Promise<'current' | 'changed' | 'unavailable'>;
}> | Readonly<{
    status: 'preparing' | 'unavailable' | 'changed';
}>;
export type ConceptStatementReader = (partition: number, request: ConceptStatementRequest, after: ConceptStatementCursor | null, limit: number) => Promise<ConceptStatementRead>;
export declare const CONCEPT_STATEMENT_PAGE_SIZE = 64;
/** Attempt-local revalidators retain native evidence. These bound one dispatch, not a prefix. */
export declare const CONCEPT_STATEMENT_PREFIX_LIMITS: Readonly<{
    windows: 32;
    rows: 2048;
}>;
export type ConceptStatementPrefixAllowance = Readonly<{
    /** Dispatches, including a possible empty terminal seek. */
    windows: number;
    /** Sum of admitted raw window limits, including rejected rows and terminal seeks. */
    rows: number;
}>;
export type ConceptStatementPrefixResult = Readonly<{
    status: 'current' | 'preparing' | 'unavailable' | 'restart';
    match: RelationFacetMatch;
    windows: number;
    examined: number;
    complete: boolean;
}>;
/** A short first window over a ready selection is the whole current native prefix. */
export declare function completeNativeStatementPrefix(selectionReady: boolean, after: ConceptStatementCursor | null, examined: number, limit: number): boolean;
/** A ready selection proves enumeration, not disclosure. Missing native witnesses cannot
 * become negative evidence, even when the raw keyset has reached its end. A disclosed
 * nonmatching witness (for example, a spoiler above the threshold) can still prove false.
 */
export declare function nativeConceptStatementCoverage(selectionReady: boolean, after: ConceptStatementCursor | null, examined: number, limit: number, disclosed: number, observation: string): Readonly<{
    complete: boolean;
    readyPrefix?: string;
}>;
/** Own and structurally admit inputs before any native or retained await. */
export declare function conceptStatementRequest(partition: number, input: ConceptStatementRequest, after: ConceptStatementCursor | null, limit: number): ConceptStatementRequest;
export declare function conceptStatementQualifiers(request: ConceptStatementRequest): readonly FilterQualifier[];
/** A bounded native witness window composed with a retained closure. Never traverses the graph
 * per candidate and never refills. A native mutation on a rejected row also retires the cut.
 */
export declare function matchNativeConceptStatements(reader: ConceptStatementReader, source: ConceptBrowseSource, store: ConceptBrowseStore, state: ConceptBrowseState, partition: number, input: ConceptStatementRequest, after?: ConceptStatementCursor | null, limit?: number): Promise<Readonly<{
    status: 'current' | 'preparing' | 'unavailable' | 'restart';
    match: RelationFacetMatch;
    page?: ConceptStatementWindow;
}>>;
/** Prove a selected prefix across explicitly admitted bounded windows. Always starts at
 * the beginning: a caller cannot supply a suffix cursor as an absence certificate. This
 * performs no refill beyond the supplied dispatch and raw-row allowance. Callers must
 * reserve native and retained owner costs before enabling it in a Search dispatcher.
 * Revalidation closures retain at most the admitted windows, never a whole population.
 */
export declare function matchNativeConceptStatementPrefix(reader: ConceptStatementReader, source: ConceptBrowseSource, store: ConceptBrowseStore, state: ConceptBrowseState, partition: number, input: ConceptStatementRequest, allowance: ConceptStatementPrefixAllowance): Promise<ConceptStatementPrefixResult>;
export type ConceptStatementCut = Readonly<{
    source: ConceptBrowseSource;
    store: ConceptBrowseStore;
    state: ConceptBrowseState;
}>;
/** Request-scoped current execution shared by Universal Search and the native matcher. */
export type ConceptFilterExecution = Readonly<{
    reader: ConceptStatementReader;
    resolveCut(request: ConceptStatementRequest): ConceptStatementCut | null;
}>;
/** A non-concept condition is resolved by its current native owner. The request is copied and
 * frozen before any resolver runs. Admission, authorization and finite work reservations remain
 * with that owner; neither an index match nor a retained observation supplies current evidence.
 */
export type ConceptNativeConditionRequest = Readonly<{
    partition: number;
    subject: string;
    leaf: CurrentNativeLeaf;
    spoilerThreshold?: SpoilerThreshold;
}>;
export type ConceptNativeConditionRead = Readonly<{
    status: 'current';
    match: RelationFacetMatch;
    /** Revalidate even a rejected condition, after every leaf's membership work. This must
     * only recheck native evidence; it cannot perform more retained membership reads.
     */
    revalidate(): Promise<'current' | 'changed' | 'unavailable'>;
}> | Readonly<{
    status: 'preparing' | 'unavailable' | 'changed';
}>;
export type ConceptNativeCondition = Readonly<{
    /** The owner reserves the complete read and revalidation before performing native I/O. */
    read(): Promise<ConceptNativeConditionRead>;
}>;
export type ConceptNativeConditionResolver = (request: ConceptNativeConditionRequest) => ConceptNativeCondition | null;
/** Native Boolean conditions. Release admission stays with each native owner.
 * Uses the canonical current interpreter and one attempt allowance across deduplicated
 * concept leaves. Every cut and other native condition is resolved before I/O; every visited
 * witness is revalidated after all leaves' membership work, including rejected candidates and
 * alternatives already true. Without a native resolver this remains a concept-only port.
 * This internal port does not activate universal Search or reserve native all-pool work.
 */
export declare function matchNativeConceptFilter(reader: ConceptStatementReader, partition: number, input: Readonly<{
    subject: string;
    filter: FilterDocument;
    spoilerThreshold?: SpoilerThreshold;
}>, resolveCut: (request: ConceptStatementRequest) => ConceptStatementCut | null, allowance: ConceptStatementPrefixAllowance, resolveNative?: ConceptNativeConditionResolver): Promise<ConceptStatementPrefixResult>;
