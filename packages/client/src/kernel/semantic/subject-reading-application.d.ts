import type { AccessWorkAccounting } from '../access/work.ts';
import type { Release } from '@rezics/definitions';
import type { MediaImportRequest } from '@rezics/definitions/media-import';
import type { Pool, PoolClient } from 'pg';
import type { ContentCoverRef, ContentImportedFieldGroup } from './contract/domain-ports.ts';
import type { SubjectComponent } from './contract/subject-values.ts';
import type { SubjectReadingAuthorizationPort, SubjectReadingNativePort, SubjectReadingFenceTuple, SubjectReadingFence } from './contract/index.ts';
import type { ContextRecord } from './context.ts';
import { type Access, type AccessCheck, type AccessClient, type Actor } from '../request/access.ts';
import { type Item } from './item.ts';
import { type SelectedSynopsisInput, type SelectedSynopsisResult } from './selected-synopsis.ts';
import { type ReviewedPersonEndpoint, type ReviewedPersonSource } from './reviewed-person-identity.ts';
import { loadRelated, readRelated as readRelatedNative } from './related-subject-read.ts';
export type { RelatedState } from './related-subject-read.ts';
import { type ViewerActionBindings, type ViewerActionResource, type ViewerActionResources } from '../access/index.ts';
export type SubjectReadingRuntime = Readonly<{
    pool: Pool;
    access: Access;
    actor: Actor;
    routeKey: Uint8Array;
    deadline: number;
    clock: () => Date;
    work?: AccessWorkAccounting;
}>;
type SubjectDocumentRead = {
    document: {
        availability: string;
        subjectId: string;
        candidateId: string;
        digest: string;
        language: string;
    } | null;
    anchors: readonly {
        partition: {
            partitionNo: number;
        };
        epoch: number;
        position: bigint;
    }[];
} | null;
type SubjectCharacterDocumentsRead = {
    documents: Record<string, unknown>;
    anchors: readonly {
        partition: {
            partitionNo: number;
        };
        epoch: number;
        position: bigint;
    }[];
};
export type SubjectReadingPorts = SubjectReadingNativePort<SubjectReadingRuntime, Pool | Pick<PoolClient, 'query'>, Release, ContextRecord, SubjectDocumentRead, SubjectCharacterDocumentsRead, ContentCoverRef, SubjectFenceTuple, SubjectFence>;
type SubjectFenceTuple = SubjectReadingFenceTuple & {
    field_group: ContentImportedFieldGroup;
};
type SubjectFence = SubjectReadingFenceTuple & {
    field_group: ContentImportedFieldGroup;
} & SubjectReadingFence;
export type SubjectReadOptions = {
    reviewIdentity?: ReviewedPersonSource;
    selectedSynopsis?: {
        input: SelectedSynopsisInput;
        admit: () => Promise<boolean>;
    };
    languages?: readonly string[];
    authorize?: SummaryDependencies['authorize'];
    seen?: readonly SubjectComponent[];
    deadline?: number;
    prepareAuthorization?: () => Promise<AccessCheck>;
    prepareAuthorize?: (id: string) => Promise<AccessCheck>;
    readAs?: <T>(read: () => Promise<T>) => Promise<T>;
};
export type SubjectReadResult = {
    selectedSynopsis?: SelectedSynopsisResult;
    reviewedIdentity?: ReviewedPersonEndpoint | null;
    subject: Item;
    account: {
        id: string;
    } | null;
    summary: SubjectSummary | null;
    component: SubjectComponent;
};
export type SubjectSummaryReader = (deps: SummaryDependencies | SummaryReaderDependencies, ids: readonly string[], options?: {
    languages?: readonly string[];
}) => Promise<Map<string, SubjectSummary | null>>;
export type SubjectReadingPageRequest = {
    runtime: SubjectReadingRuntime;
    subject: string;
    context: string;
    languages: readonly string[];
    authorization: SubjectReadingAuthorizationPort<AccessCheck>;
    runNative: <T>(read: () => Promise<T>) => Promise<T>;
    readAs: <T>(read: () => Promise<T>) => Promise<T>;
    seen: readonly SubjectComponent[];
    selectedSynopsis?: SelectedSynopsisInput;
    reviewIdentity?: ReviewedPersonSource;
    includeViewerActions?: boolean;
    includeDocuments?: boolean;
    viewerActionBindings?: ViewerActionBindings;
};
export type SubjectReadingPageAnswer = {
    subject: Item;
    selectedSynopsis?: SelectedSynopsisResult;
    reviewedIdentity?: ReviewedPersonEndpoint | null;
    account: {
        id: string;
    } | null;
    summary: SubjectSummary | null;
    related: Record<string, {
        labels: Record<string, string>;
        redirect?: string;
        type?: string;
        types?: string[];
        cover?: CoverSummary | null;
    }>;
    documents?: Record<string, unknown>;
    viewerActions?: {
        state: 'available';
        actions: {
            action: string;
            operations: string[];
        }[];
    } | {
        state: 'unavailable';
    };
};
export type SubjectReadingPageResult = {
    kind: 'not-found';
} | {
    kind: 'redirect';
    from: string;
    to: string;
} | {
    kind: 'answer';
    answer: SubjectReadingPageAnswer;
    revision: number;
    anchors: readonly SubjectComponent[];
    private: boolean;
};
export type CoverSummary = {
    media: string;
    width: number;
    height: number;
    placeholder: {
        thumbhash: string;
        color: string;
    };
    variants: {
        format: 'avif' | 'webp';
        width: number;
    }[];
    focalPoint: {
        x: number;
        y: number;
    } | null;
    credit: MediaImportRequest['credit'];
};
export type SubjectSummary = {
    id: string;
    type: string;
    types: string[];
    label: {
        value: string;
        language: string;
    } | null;
    creativeWork: boolean;
    cover: CoverSummary | null;
};
/** A merged original keeps its id; its summary is the survivor's and `redirect` names that survivor. */
export type RelatedSubjectSummary = SubjectSummary & {
    redirect?: string;
};
export type SummaryDependencies = {
    /** Compatibility input; the executor binds the live same-pool snapshot, never a pool.query facade. */
    client: Pick<PoolClient, 'query'>;
    pool: Pool;
    /** Trusted server routing configuration; never selected by the reader. */
    routeKey: Uint8Array;
    deadline?: number;
    /** The active release, resolved once by the caller for the whole page. */
    release: Release;
    authorize: (client: Pick<PoolClient, 'query'>, id: string, batch: readonly string[]) => Promise<boolean>;
    /** Reader suitability policy. Withholding an image never withholds the subject. */
    maySeeCover?: (media: string, subject: string) => boolean;
};
export type SummaryReaderDependencies = {
    pool: Pool;
    routeKey: Uint8Array;
    access: Access;
    actor: Actor;
    deadline: number;
    work?: AccessWorkAccounting;
    maySeeCover?: SummaryDependencies['maySeeCover'];
};
type SummaryAuthorize = SummaryDependencies['authorize'];
type SummarySources = readonly Readonly<{
    partition: number;
    epoch: number;
    position: bigint;
}>[];
export type SummaryCoverState = 'available' | 'absent' | 'concealed';
/** Internal composition, never a browser-supplied witness or a cached allow.
 * Each component is an independent native home position, as in Subject reads.
 */
export type SubjectSummaryObservation = Readonly<{
    summaries: ReadonlyMap<string, SubjectSummary | null>;
    covers: ReadonlyMap<string, SummaryCoverState>;
    components: SummarySources;
    current: () => Promise<boolean>;
}>;
/** Preserve the callable related-read adapter, and expose preparation to the batch owner.
 * Preparation never runs while the final snapshot is checked out. Only the returned
 * native checks execute on that snapshot; no allow decision is retained.
 */
export declare function summaryAuthorization(prepare: (id: string, batch: readonly string[]) => Promise<AccessCheck>): SummaryAuthorize;
export type SubjectCorrectionActions = {
    state: 'available';
    actions: {
        action: string;
        operations: string[];
    }[];
} | {
    state: 'concealed' | 'stale' | 'unavailable';
};
export type SubjectCorrectionActionsInput = {
    pool: Pool;
    access: Access;
    bindings: ViewerActionBindings;
    actor: Actor;
    clock: () => Date;
    subject: string;
    type: string;
    revision: number;
    deadline: number;
};
export type SubjectReadingApplication = Readonly<{
    readSubject(pool: Pool, id: string, authorize: (client: PoolClient) => Promise<boolean>, context: string, routeKey: Uint8Array, options?: SubjectReadOptions): Promise<SubjectReadResult | null>;
    readSubjectSummaries: SubjectSummaryReader;
    readSubjectSummaryObservation: (deps: SummaryReaderDependencies, ids: readonly string[], options?: {
        languages?: readonly string[];
        displayFallback?: boolean;
    }) => Promise<SubjectSummaryObservation>;
    readSubjectCorrectionActions(input: SubjectCorrectionActionsInput): Promise<SubjectCorrectionActions>;
    readRelated(db: Pool | PoolClient, ids: readonly string[]): ReturnType<typeof readRelatedNative>;
    loadRelated(client: object, ids: readonly string[]): ReturnType<typeof loadRelated>;
    readPage(input: SubjectReadingPageRequest): Promise<SubjectReadingPageResult>;
}>;
/** Build one read application from explicit Semantic and current Content capabilities. */
export declare function createSubjectReadingApplication(ports: SubjectReadingPorts): SubjectReadingApplication;
/** Shared native evidence for ordinary subject disclosure and personal batches. */
export declare function readSubjectPublicStates(client: AccessClient, ids: readonly string[]): Promise<{
    id: string;
    type: string;
    visibility: "visible" | "hidden" | "taken_down";
    security_revision: string;
}[]>;
/** Register generic Subject disclosure and the released catalogue, including namespaced Types. */
export declare function subjectViewerActionResources(): ViewerActionResources;
/** Native Context resolver shares the exact directory lifecycle reader; candidates and creators never grant. */
export declare const contextViewerActionResource: ViewerActionResource;
