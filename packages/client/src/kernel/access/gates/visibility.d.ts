import type { Pool } from 'pg';
import { type ExposureCatalogue, type ExposureOperation } from '@rezics/access';
import { type MountedRoute } from '../../http/request.ts';
import type { Access, Actor } from '../../request/access.ts';
export type VisibleOperation = {
    readonly method: string;
    readonly path: string;
    readonly operationId: string;
    readonly action: string;
    readonly exposure: 'public' | `gate:${string}`;
};
/** Mounted contract operations. Hidden routes are omitted, matching the generated document. */
export declare function classifyExposureRoutes(routes: readonly MountedRoute[]): readonly ExposureOperation[];
/** Cache only immutable mounted policy facts; opening and authority observations remain request-local. */
export declare function mountedExposureCatalogue(routes: readonly MountedRoute[]): ExposureCatalogue;
type DiscoveryInput = {
    viewer: Actor;
    pool: Pool;
    access: Access;
    routes: readonly MountedRoute[];
    deadline: number;
    clock: () => Date;
};
/** Mounted groups that are open or have at least one visible operation for this viewer. */
export declare function admittedGroups(input: DiscoveryInput): Promise<readonly string[]>;
/** The mounted operations this viewer may use at the kernel clock. */
export declare function visibleOperations(input: DiscoveryInput): Promise<readonly VisibleOperation[]>;
export {};
