export { readSpace, readSpaceForViewer, spaceReadEligibility, spaceViewerActionResource } from './space-read.ts';
import type { Pool } from 'pg';
import type { Access, Actor } from '../request/access.ts';
export type SpaceDependencies = Readonly<{
    pool: Pool;
    access: Access;
    routeKey: Uint8Array;
    clock: () => Date;
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
export declare function createSpace(deps: SpaceDependencies, actor: Actor, input: SpaceInput, context: SpaceContext): Promise<import("../command/command.ts").CommandOutcome<{
    spaceId: string;
    revisionId: string;
}>>;
export declare function updateSpace(deps: SpaceDependencies, actor: Actor, input: SpaceUpdate, context: SpaceContext): Promise<import("../command/command.ts").CommandOutcome<{
    spaceId: string;
    revisionId: string;
}>>;
