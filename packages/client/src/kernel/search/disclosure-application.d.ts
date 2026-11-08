import type { DiscoveryFilterDocument } from '@rezics/filter';
import { type ConceptFilterExecution, type ConceptStatementReader } from './concept-browse-statements.ts';
import { type ConceptDescendantSelection, type ConceptBrowseSource, type ConceptBrowseStore } from './concept-browse.ts';
import type { DiscoveryOwnerHit, DiscoveryReadContext, DiscoveryPage } from './discovery.ts';
import type { PublicFilterCoveragePage } from './public-filter-coverage-page.ts';
import { type EngineToken } from './disclosure/admission.ts';
import { checkHits } from './disclosure/check.ts';
import { type CurrentTextAnalyzer as Analyzer } from './disclosure/current-text.ts';
import { revalidateOwnerCurrentSummaries, type OwnerDisclosurePorts, type DiscoveryOwnerCandidate } from './disclosure/owner-current.ts';
export type { Hit, FactClause } from './disclosure/admission.ts';
export { checkHits } from './disclosure/check.ts';
export { createCurrentTextMatcher, CURRENT_TEXT_LIMITS } from './disclosure/current-text.ts';
export { ownerSummaryUnchanged, revalidateOwnerCurrentSummaries } from './disclosure/owner-current.ts';
/** Request-scoped analysis is supplied by the installed native adapter, never by HTTP. */
export type SearchDisclosurePorts = Readonly<{
    analyze(index: string, analyzer: Analyzer, text: string): Promise<readonly EngineToken[]>;
}>;
/** Native hierarchy/storage costs retain the existing admitted reservation dimensions. */
export type ConceptDiscoveryPorts = Readonly<{
    browse(selection: ConceptDescendantSelection, binding: {
        principal: string;
        request: string;
    }, reserve: (cost: {
        keys: number;
        rows: number;
        points: number;
        statements: number;
        bytes: number;
        emptySeeks: number;
    }) => void): ConceptBrowseSource;
    store(id: string, options: {
        expiresAt: number;
        reserve: (cost: {
            statements: number;
            rows: number;
            bytes: number;
        }) => void;
    }): ConceptBrowseStore;
    readStatements: ConceptStatementReader;
}>;
/** Finite request work is owned here; physical analyzer and native persistence are adapters. */
export declare function createSearchDisclosureApplication(ports: SearchDisclosurePorts): {
    checkHits: typeof checkHits;
    discloseOwnerHits: typeof discloseOwnerHits;
    revalidateOwnerCurrentSummaries: typeof revalidateOwnerCurrentSummaries;
    finishDiscoveryDisclosure: typeof finishDiscoveryDisclosure;
    prepareConceptFilter: typeof prepareConceptDisclosure;
    currentText: (index: string) => {
        matchesText: (subject: import("./source.ts").IndexedSubject, query: import("@rezics/search-text").TextNode) => Promise<boolean>;
        matchesPrefix: (subject: import("./source.ts").IndexedSubject, prefix: string) => Promise<boolean>;
    };
};
export type SearchDisclosureApplication = ReturnType<typeof createSearchDisclosureApplication>;
/** Nested context never authorizes a result: re-read every accepted owner before projection. */
export declare function discloseOwnerHits(ports: OwnerDisclosurePorts, candidates: readonly DiscoveryOwnerCandidate[], context: DiscoveryReadContext): Promise<readonly (DiscoveryOwnerHit | undefined)[]>;
/** Project every dependent value before the one CURRENT native page final.
 * The native root owns the closed plan, complete child chain and own-row sets;
 * returned hits and diagnostic readStatus are not disclosure authority.
 * Kind counts on the projected page must already be decided from this execution:
 * a disclosed sample never becomes an exact total after FINAL.
 */
export declare function finishDiscoveryDisclosure(coverage: Pick<PublicFilterCoveragePage, 'finish'>, project: () => Promise<DiscoveryPage>): Promise<DiscoveryPage>;
/**
 * Retain scheme-bound closures in the existing scope-preparation lifecycle before Universal Search
 * evaluates candidates. The same complete cut serves exact and descendant statements; the shared
 * native matcher still decides exactness, qualifiers, Boolean logic and current disclosure.
 */
export declare function prepareConceptDisclosure(input: Readonly<{
    principal: string;
    request: unknown;
    filter: DiscoveryFilterDocument;
    limit: number;
    countCandidateLimit: number;
    now: () => number;
}>, ports: ConceptDiscoveryPorts): Promise<ConceptFilterExecution | undefined>;
/** Current-evidence refusal applies to the whole page, including negative predicates. */
export declare function runSearchSource<T>(operation: () => Promise<T>, preserveAdapterError: (error: unknown) => boolean): Promise<T>;
/** Each installed service retains one template initialization and retries it after a failed attempt. */
export declare function createSearchIndexRequest(ports: Readonly<{
    install(): Promise<void>;
    unavailable(error: unknown): boolean;
}>): <T>(operation: () => Promise<T>) => Promise<T>;
