import type { Release } from '@rezics/definitions';
import type { Pool } from 'pg';
import type { Access, AccessCheck, Actor } from '../request/access.ts';
import type { SessionComponent } from '../tokens/session.ts';
import type { SourceFenceTuple } from '../content/index.ts';
import type { CopyWorkDisclosureObservation, CopyWorkDisclosureState } from './copy-work-disclosure-contract.ts';
import type { IdentityMapping } from './identity-epoch-contract.ts';
import type { SubjectSummary, SubjectSummaryObservation, SummaryDependencies } from './summaries.ts';
import type { Statement } from './item.ts';
import type { WorkReleaseCards } from './work-release-cards.ts';
import type { FacetPopulationSourceFactory } from './facet-population-contract.ts';
/** Native request authority supplied by the mounted Semantic caller. */
export type CopyWorkDisclosureDependencies = Readonly<{
    pool: Pool;
    access: Access;
    actor: Actor;
    routeKey: Uint8Array;
    deadline: number;
}>;
export type CopyWorkListPresentationDependencies = CopyWorkDisclosureDependencies;
export type CopyWorkListPresentationOptions = Readonly<{
    languages?: readonly string[];
    workContext?: boolean;
}>;
export type CopyWorkListFact = Readonly<{
    kind: 'item';
    id: string;
    labels: Record<string, string>;
}> | Readonly<{
    kind: 'time';
    year: number;
    month?: number;
    day?: number;
}> | Readonly<{
    kind: 'quantity';
    amount: number;
    unit: string;
}> | Readonly<{
    kind: 'code';
    value: string;
}>;
export type CopyWorkPendingFact = Exclude<CopyWorkListFact, {
    kind: 'item';
}> | Readonly<{
    kind: 'item';
    id: string;
}>;
export type CopyWorkIndexedStatement = Readonly<{
    property: string;
    value: string;
    facet?: Readonly<{
        kind: 'item' | 'code';
    }> | Readonly<{
        kind: 'time';
        year: number;
        month?: number;
        day?: number;
    }> | Readonly<{
        kind: 'quantity';
        amount: number;
        unit: string;
    }>;
}>;
export type CopyWorkWorkKind = 'work' | 'release' | 'recording';
export type CopyWorkWorkTerm = Readonly<{
    id: string;
    labels: Record<string, string>;
}>;
export type CopyWorkWorkValue = Readonly<{
    state: 'somevalue';
}> | Readonly<{
    state: 'novalue';
}> | Readonly<{
    state: 'unsupported';
}> | Readonly<{
    state: 'value';
    kind: 'item';
    id: string;
    originalId: string;
    type: CopyWorkWorkTerm;
    labels: Record<string, string>;
}> | Readonly<{
    state: 'value';
    kind: 'text';
    text: string;
}> | Readonly<{
    state: 'value';
    kind: 'quantity';
    amount: string;
    unit: string;
}> | Readonly<{
    state: 'value';
    kind: 'time';
    calendar: 'gregorian';
    year: number;
    month?: number;
    day?: number;
}>;
export type CopyWorkWorkQualifier = Readonly<{
    property: CopyWorkWorkTerm;
    value: CopyWorkWorkValue;
}>;
export type CopyWorkWorkStatement = Readonly<{
    statementId: string;
    sourceId: string;
    direction: 'outgoing';
    property: CopyWorkWorkTerm;
    revision: number;
    release: string;
    rank: 'normal' | 'preferred';
    value: CopyWorkWorkValue;
    qualifiers: Readonly<{
        state: 'empty';
    }> | Readonly<{
        state: 'unsupported';
    }> | Readonly<{
        state: 'unavailable';
        reason: 'limit';
    }> | Readonly<{
        state: 'current';
        items: CopyWorkWorkQualifier[];
    }>;
}>;
export type CopyWorkWorkSection = Readonly<{
    state: 'empty';
}> | Readonly<{
    state: 'withheld';
}> | Readonly<{
    state: 'unsupported';
}> | Readonly<{
    state: 'unavailable';
    reason: 'native' | 'limit' | 'response_limit';
}> | Readonly<{
    state: 'current';
    items: CopyWorkWorkStatement[];
    overflow: boolean;
}>;
export type CopyWorkWorkContext = Readonly<{
    state: 'unavailable';
    reason: 'native' | 'limit' | 'response_limit';
}> | Readonly<{
    state: 'current';
    subjectId: string;
    type: CopyWorkWorkTerm;
    kind: CopyWorkWorkKind;
    creators: CopyWorkWorkSection;
    relations: CopyWorkWorkSection;
    dates: CopyWorkWorkSection;
}>;
export type CopyWorkListPresentationResult = Map<string, {
    id: string;
    facts: Record<string, CopyWorkListFact[]>;
    workContext?: CopyWorkWorkContext;
} | null>;
/** Search-owned hit formatting and admission. Semantic consumes only this structural evidence port. */
export type CopyWorkSearchEvidencePort = Readonly<{
    validateHitOptions(request: {
        descriptions?: unknown;
        languages?: unknown;
        properties?: unknown;
    }): {
        languages?: readonly string[];
    };
    chooseTexts(values: readonly Readonly<{
        language: string;
        value: string;
    }>[], languages: readonly string[] | undefined, original: string | undefined, map?: (value: string) => string): Record<string, string>;
    pendingFacts(subject: Readonly<{
        statements: readonly CopyWorkIndexedStatement[];
    }>, properties: readonly string[]): Map<string, CopyWorkPendingFact[]>;
    workContext: Readonly<{
        limits: Readonly<{
            entries: number;
            lookahead: number;
            qualifiers: number;
            labelBytes: number;
            hitBytes: number;
            pageBytes: number;
        }>;
        bytes(value: unknown): number;
        kind(identities: readonly string[]): CopyWorkWorkKind;
    }>;
}>;
export type CopyWorkDisclosureHeader = Readonly<{
    id: string;
    type: string;
    visibility: string;
    security: string;
    release: string | null;
    revision: number | null;
    source_epoch: number | null;
    source_position: string | null;
    redirect: string | null;
}>;
export type CopyWorkMembership = Readonly<{
    kind: 'works';
    ids: readonly string[];
}> | Readonly<{
    kind: 'concealed';
}> | Readonly<{
    kind: 'overflow';
}>;
export type CopyWorkSourceObservation = {
    header: CopyWorkDisclosureHeader;
    allowed: boolean;
    membership: CopyWorkMembership | null;
};
export type CopyWorkPartitionCut = Readonly<{
    partition: number;
    epoch: number;
    position: bigint;
}>;
export type CopyWorkSourceHomeObservation = Readonly<{
    found: Map<string, CopyWorkSourceObservation>;
    tuples: SourceFenceTuple[];
    owners: string[];
    cut: CopyWorkPartitionCut;
}>;
export type CopyWorkSummaryBatch = Readonly<{
    summaries: Map<string, SubjectSummary | null>;
    components: SubjectSummaryObservation['components'];
}>;
export type CopyWorkReleaseObservation = Readonly<{
    release: Release;
    digest: string;
    head: number;
}>;
/** Native read producers used by the Semantic application; their transaction and accounting rules stay local. */
export type CopyWorkDisclosureNativeReader = Readonly<{
    requireDeadline(deadline: number): void;
    withinDeadline<T>(deadline: number, work: () => Promise<T>): Promise<T>;
    readActiveRelease(deps: CopyWorkDisclosureDependencies): Promise<CopyWorkReleaseObservation>;
    readIdentityMappings(deps: CopyWorkDisclosureDependencies, ids: readonly string[]): Promise<Map<string, IdentityMapping | undefined>>;
    prepareChecks(deps: CopyWorkDisclosureDependencies, ids: readonly string[]): Promise<Map<string, AccessCheck>>;
    observeHome(deps: CopyWorkDisclosureDependencies, release: Release, home: number, ids: readonly string[], checks: ReadonlyMap<string, AccessCheck>): Promise<CopyWorkSourceHomeObservation>;
    readTakenFenceKeys(deps: CopyWorkDisclosureDependencies, tuples: readonly SourceFenceTuple[]): Promise<ReadonlySet<string>>;
    readSummaries(deps: CopyWorkDisclosureDependencies, ids: readonly string[], options: {
        languages: readonly string[];
    }): Promise<CopyWorkSummaryBatch>;
    observation(deps: CopyWorkDisclosureDependencies, results: Map<string, CopyWorkDisclosureState>, cuts: readonly CopyWorkPartitionCut[], digest: string | null, head: number | null): CopyWorkDisclosureObservation;
    isUnavailable(error: unknown): boolean;
    isRelationProperty(release: Release, property: string): boolean;
    fenceKey(tuple: SourceFenceTuple): string;
}>;
export type WorkReleaseCardMembershipLink = Readonly<{
    subject: string;
    property: string;
    statement: string;
    assertion?: Statement;
    related?: Record<string, SubjectSummary>;
    summary?: SubjectSummary | null;
}>;
export declare const workReleaseCardLimit = 20;
export declare const workReleaseCardFieldLimit = 32;
export declare const workReleaseCardProperties: readonly ['schema:gamePlatform', 'schema:inLanguage', 'schema:datePublished', 'schema:creativeWorkStatus', 'wdt:P5804', 'rezics:releaseStatus', 'schema:contentRating', 'schema:publisher', 'schema:producer', 'wdt:P178', 'wdt:P162', 'wdt:P2899'];
export declare const workReleaseCardQualifierLimit = 64;
export declare const workReleaseCardReferenceLimit = 32;
export declare const workReleaseCardReferencePartLimit = 64;
export declare const workReleaseCardStatementBytes: number;
export declare const workReleaseCardResponseBytes: number;
export type WorkReleaseCardsInput = Readonly<{
    pool: Pool;
    routeKey: Uint8Array;
    subject: string;
    context?: string;
    defaults?: Readonly<Record<string, 'inherit' | 'suppress'>>;
    links: readonly WorkReleaseCardMembershipLink[];
    caughtUp: boolean;
    release: Release;
    languages: readonly string[];
    deadline: number;
    seen: readonly SessionComponent[];
    authorizeSummary?: SummaryDependencies['authorize'];
}>;
export type CopyWorkListReader = (deps: CopyWorkListPresentationDependencies, originals: readonly string[], options: CopyWorkListPresentationOptions, evidence: CopyWorkSearchEvidencePort) => Promise<CopyWorkListPresentationResult>;
/** Effectful native operations installed by the process composition root. */
export type CopyWorkReaderPort = Readonly<{
    searchEvidence: CopyWorkSearchEvidencePort;
    copyWorkDisclosure: CopyWorkDisclosureNativeReader;
    readWorkReleaseCards(input: WorkReleaseCardsInput): Promise<WorkReleaseCards>;
    createFacetPopulationSource: FacetPopulationSourceFactory;
    readListPresentationFacts: CopyWorkListReader;
}>;
