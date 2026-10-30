import type { Release } from '@rezics/definitions';
import type { MediaImportRequest } from '@rezics/definitions/media-import';
import type { Pool, PoolClient } from 'pg';
import { type Access, type Actor } from '../request/access.ts';
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
export type SummaryDependencies = {
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
    maySeeCover?: SummaryDependencies['maySeeCover'];
};
/** One bounded, shared display projection. Unknown and undisclosed ids remain explicit null entries. */
export declare function readSubjectSummaries(deps: SummaryDependencies | SummaryReaderDependencies, ids: readonly string[], { languages }?: {
    languages?: readonly string[];
}): Promise<Map<string, SubjectSummary | null>>;
