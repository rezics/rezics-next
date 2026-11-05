import type { RelationFacetMatch } from './source.ts';
/** A descendant predicate is tied to its property, scheme, and observed source cut. */
export type ConceptDescendantSelection = Readonly<{
    concept: string;
    property: string;
    scheme: string;
    includeChildren: true;
}>;
/** Every field participates in currentness, including for exclusion. */
export type ConceptBrowseBinding = Readonly<{
    release: string;
    graph: string;
    scheme: string;
    membership: string;
    principal: string;
    request: string;
}>;
/** An internal locator in the existing retained-plan lifecycle, never a public cursor. */
export type ConceptBrowseLocator = Readonly<{
    id: string;
    revision: string;
}>;
export type ConceptBrowseState = Readonly<{
    version: 2;
    selection: ConceptDescendantSelection;
    binding: ConceptBrowseBinding;
    retained: ConceptBrowseLocator;
}>;
export type ConceptBrowseFrontier = Readonly<{
    parent: string;
    after: string | null;
}>;
export type ConceptBrowsePage = Readonly<{
    binding: ConceptBrowseBinding;
    children: readonly string[];
    /** Native rows examined, including duplicates and rows irrelevant to this scheme. */
    examined: number;
    /** The sortable full native edge key, independent of the disclosed child IDs. */
    after: string | null;
    hasMore: boolean;
}>;
export type ConceptBrowseObservation = Readonly<{
    status: 'current';
    binding: ConceptBrowseBinding;
}> | Readonly<{
    status: 'preparing' | 'unavailable' | 'rejected';
}>;
export type ConceptBrowseRead = Readonly<{
    status: 'current';
    page: ConceptBrowsePage;
}> | Readonly<{
    status: 'preparing' | 'unavailable' | 'rejected';
}>;
/** Current, scheme-scoped SKOS broader seeks. Withheld or incomplete graph evidence is unavailable,
 * never a successful empty page. Full-key cursors advance through duplicate/irrelevant rows.
 */
export type ConceptBrowseSource = Readonly<{
    observe(): Promise<ConceptBrowseObservation>;
    children(input: ConceptBrowseFrontier & Readonly<{
        binding: ConceptBrowseBinding;
        limit: number;
    }>): Promise<ConceptBrowseRead>;
}>;
/** Derived storage beneath the existing retained-plan worker, not another capture or scheduler.
 * Operations compare the supplied selection/binding to the retained definition and revision.
 * create seeds the root; read retrieves at most one frontier row. advance atomically advances that row, inserts distinct membership keys
 * and queues only newly inserted keys using indexed deduplication. seal requires an empty frontier.
 * Losing a CAS returns null. Retirement/expiry of the owning plan disables every operation.
 * contains returns a Boolean only for a sealed generation; root membership is included.
 */
export type ConceptBrowseStore = Readonly<{
    create(selection: ConceptDescendantSelection, binding: ConceptBrowseBinding): Promise<ConceptBrowseLocator>;
    read(state: ConceptBrowseState): Promise<Readonly<{
        status: 'building';
        next: ConceptBrowseFrontier | null;
    }> | Readonly<{
        status: 'complete' | 'retired';
    }>>;
    advance(state: ConceptBrowseState, expected: ConceptBrowseFrontier, delta: Readonly<{
        children: readonly string[];
        after: string | null;
        exhausted: boolean;
    }>): Promise<ConceptBrowseLocator | null>;
    seal(state: ConceptBrowseState): Promise<ConceptBrowseLocator | null>;
    retire(state: ConceptBrowseState): Promise<void>;
    contains(state: ConceptBrowseState, concept: string): Promise<boolean | null>;
}>;
/** Absolute working-set limits; total retained graph size is never a request-sized array. */
export declare const CONCEPT_BROWSE_LIMITS: Readonly<{
    pages: 32;
    edges: 4096;
    pageSize: 256;
    keyBytes: 1024;
}>;
/** Fixed per-dispatch worker allowance. Closure size is retained across dispatches. */
export declare const CONCEPT_BROWSE_WORKER_LIMITS: Readonly<{
    pages: 4;
    edges: 256;
    pageSize: 64;
}>;
export type ConceptBrowseLimits = Readonly<{
    pages: number;
    edges: number;
    pageSize: number;
}>;
export type ConceptBrowseResult = Readonly<{
    status: 'complete' | 'preparing';
    state: ConceptBrowseState;
    pages: number;
    edges: number;
}> | Readonly<{
    status: 'unavailable' | 'rejected' | 'restart';
}>;
export declare function startConceptBrowse(selection: ConceptDescendantSelection, binding: ConceptBrowseBinding, store: ConceptBrowseStore): Promise<ConceptBrowseState | null>;
/** One finite worker step. No discovered/frontier population is copied or returned. */
export declare function advanceConceptBrowse(source: ConceptBrowseSource, store: ConceptBrowseStore, input: ConceptBrowseState, limits: ConceptBrowseLimits): Promise<ConceptBrowseResult>;
/** Membership is not disclosure of a classification statement. The shared matcher must also prove
 * the same-statement witness. Unknown, unsealed, retired or changed evidence stays unknown under NOT.
 */
export declare function currentConceptMembership(source: ConceptBrowseSource, store: ConceptBrowseStore, state: ConceptBrowseState, concept: string): Promise<boolean | 'not_proven'>;
/** One bounded page of point probes shares a cut, independently of total closure size.
 * The source owns observation costs; the retained store reserves each distinct full-key probe.
 * No provisional verdict escapes when any probe or the final revision check loses the cut.
 */
export declare function currentConceptMemberships(source: ConceptBrowseSource, store: ConceptBrowseStore, state: ConceptBrowseState, concepts: readonly string[]): Promise<RelationFacetMatch[]>;
/** Native evidence about ONE classified statement. The owner must prove the property and value,
 * disclosure and every admitted qualifier (including the spoiler threshold) on that same statement.
 * A witness is request-local evidence, never a retained permission or a completeness certificate.
 */
export type ConceptStatementWitness = Readonly<{
    property: string;
    concept: string;
    witness: RelationFacetMatch;
}>;
/** Compose native classified-statement evidence with retained exact/descendant membership.
 * `complete` may be true only from the owner's current absence proof for the entire statement
 * predicate, never from a LIMIT, an exhausted sample or an empty witness page. The enclosing native
 * caller still revalidates the statement evidence before publishing a useful page.
 */
export declare function matchCurrentConceptStatements(source: ConceptBrowseSource, store: ConceptBrowseStore, state: ConceptBrowseState, input: Readonly<{
    selection: Readonly<{
        property: string;
        concept: string;
        scheme: string;
        includeChildren?: boolean;
    }>;
    statements: readonly ConceptStatementWitness[];
    complete: boolean;
}>): Promise<RelationFacetMatch>;
/** Current evidence for one bounded window, without claiming absence outside that window.
 * A null result invalidates the whole cut, including otherwise negative witnesses.
 */
export declare function currentConceptStatementWitnesses(source: ConceptBrowseSource, store: ConceptBrowseStore, state: ConceptBrowseState, input: Readonly<{
    selection: Readonly<{
        property: string;
        concept: string;
        scheme: string;
        includeChildren?: boolean;
    }>;
    statements: readonly ConceptStatementWitness[];
}>): Promise<readonly Readonly<{
    membership: RelationFacetMatch;
    witness: RelationFacetMatch;
}>[] | null>;
