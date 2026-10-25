import type { Pool } from 'pg';
import { type MountedRoute } from '../../http/request.ts';
import type { Access, Actor } from '../../request/access.ts';
export type VisibleOperation = {
    readonly method: string;
    readonly path: string;
    readonly operationId: string;
    readonly action: string;
    readonly exposure: 'public' | `gate:${string}`;
};
/** The mounted operations this viewer may use at the kernel clock. */
export declare function visibleOperations(input: {
    viewer: Actor;
    pool: Pool;
    access: Access;
    routes: readonly MountedRoute[];
    deadline: number;
    clock: () => Date;
}): Promise<readonly VisibleOperation[]>;
