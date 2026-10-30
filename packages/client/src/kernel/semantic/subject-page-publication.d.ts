import type { Pool } from 'pg';
import type { KernelClock } from '../clock.ts';
import type { Access } from '../request/access.ts';
import { type SubjectKey } from './subject-page-publication-store.ts';
export type SubjectPagePublication = {
    requestRebuild(subject: SubjectKey): Promise<void>;
    step(options: {
        limit: number;
    }): Promise<{
        processed: number;
        next: string | null;
        done: boolean;
    }>;
};
/** Defer kernel construction until publication is used, after Access composition. */
export declare function mountSubjectPagePublication(app: object, runtime: SubjectPagePublication | (() => SubjectPagePublication)): void;
export declare function subjectPagePublicationFor(app: object): SubjectPagePublication;
/** One committed step shares its source budget across phase changes. */
export declare function createSubjectPagePublication({ pool, clock, routeKey, }: {
    pool: Pool;
    access: Access;
    clock: KernelClock;
    routeKey: Uint8Array;
}): SubjectPagePublication;
