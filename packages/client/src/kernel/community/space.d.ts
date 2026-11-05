import type { Pool } from 'pg';
import { type ResourceEligibility } from '../access/index.ts';
import type { Access, AccessCheck, AccessClient, Actor, Resource } from '../request/access.ts';
export type SpaceDependencies = Readonly<{
    pool: Pool;
    access: Access;
    routeKey: Uint8Array;
    clock?: () => Date;
}>;
export type SpaceContext = Readonly<{
    idempotencyKey: string;
    deadline: number;
}>;
export type SpaceInput = Readonly<{
    title: string;
    summary?: string;
}>;
export type SpaceUpdate = Readonly<{
    spaceId: string;
    expectedHead: string;
    title?: string;
    summary?: string;
}>;
export type Space = Readonly<{
    spaceId: string;
    state: string;
    headRevisionId: string;
    createdAt: string;
    creator: string;
    predecessor: string | null;
    address: string | null;
    title: string;
    summary: string;
    revisionCreatedAt: string;
    author: string;
}>;
export declare class SpaceConflictError extends Error {
    constructor();
}
export declare class SpaceInputError extends Error {
    constructor();
}
/** One routed point read joining only the current exact revision. No authorization is implied. */
export declare function readSpace(client: AccessClient, spaceId: string, time: string): Promise<(Space & {
    lifecycleVersion: string;
}) | null>;
/** Read the Space and its exact Realm slot together. Callers supply Space authorization;
 * the derived Realm id always uses the ordinary Realm reader and its own authorization.
 */
export declare function readSpaceForViewer(deps: Pick<SpaceDependencies, 'pool' | 'access'>, actor: Actor, spaceId: string, time: string, context: {
    deadline: number;
}, check?: AccessCheck): Promise<(Space & {
    realmId: string | null;
}) | null>;
export declare function spaceReadEligibility(identity: Resource): ResourceEligibility;
export declare function createSpace(deps: SpaceDependencies, actor: Actor, input: SpaceInput, context: SpaceContext): Promise<import("../command/command.ts").CommandOutcome<{
    spaceId: string;
    revisionId: string;
}>>;
export declare function updateSpace(deps: SpaceDependencies, actor: Actor, input: SpaceUpdate, context: SpaceContext): Promise<import("../command/command.ts").CommandOutcome<{
    spaceId: string;
    revisionId: string;
}>>;
/** The read route's exact identity/head eligibility, batched by supplied full keys. */
export declare const spaceViewerActionResource: import('../access/viewer-actions.ts').ViewerActionResource;
