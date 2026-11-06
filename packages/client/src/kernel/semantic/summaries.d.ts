import type { AccessWorkAccounting } from '../access/work.ts';
import type { Release } from '@rezics/definitions';
import type { MediaImportRequest } from '@rezics/definitions/media-import';
import type { Pool, PoolClient } from 'pg';
import { type Access, type AccessCheck, type Actor } from '../request/access.ts';
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
/** One bounded, shared display projection. Unknown and undisclosed ids remain explicit null entries. */
export declare function readSubjectSummaries(deps: SummaryDependencies | SummaryReaderDependencies, ids: readonly string[], { languages }?: {
    languages?: readonly string[];
}): Promise<Map<string, SubjectSummary | null>>;
/** Read the ordinary projection and retain its actual source homes for a
 * composing native reader. No owner connection survives the returned promise.
 */
export declare function readSubjectSummaryObservation(deps: SummaryReaderDependencies, ids: readonly string[], { languages, displayFallback }?: {
    languages?: readonly string[];
    displayFallback?: boolean;
}): Promise<SubjectSummaryObservation>;
export {};
