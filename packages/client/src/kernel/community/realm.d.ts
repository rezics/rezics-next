import { type ResourceEligibility } from '../access/index.ts';
import { type Actor, type Resource } from '../request/access.ts';
import { type RealmContinuity } from './realm-continuity.ts';
import type { RealmVotes } from './realm-votes.ts';
import type { SpaceDependencies, SpaceContext } from './space.ts';
import { type RealmPresentation } from './presentation.ts';
import read from './realm-read.sql.d.ts';
export type RealmDependencies = SpaceDependencies;
export type RealmContext = SpaceContext;
export type RealmInput = Readonly<{
    spaceId: string;
    title: string;
    summary?: string;
    visibility: 'public' | 'protected';
    contextId: string;
    votes?: RealmVotes;
}>;
export type RealmUpdate = Readonly<{
    realmId: string;
    expectedHead: string;
    title?: string;
    summary?: string;
    visibility?: 'public' | 'protected';
    contextId?: string;
    votes?: RealmVotes;
    presentation?: RealmPresentation;
}>;
export type Realm = Readonly<{
    realmId: string;
    spaceId: string;
    state: string;
    visibility: string;
    contextId: string;
    headRevisionId: string;
    createdAt: string;
    creator: string;
    predecessor: string | null;
    title: string;
    summary: string;
    presentation: RealmPresentation;
    revisionCreatedAt: string;
    author: string;
}>;
/** Head read used by HTTP. The scheme and vote weights travel on the same row. */
export type RealmView = Realm & RealmContinuity & Readonly<{
    boardSchemeId: string | null;
    votes: RealmVotes;
}>;
export declare class RealmConflictError extends Error {
    constructor();
}
export declare class RealmInputError extends Error {
    constructor();
}
/** Exact current source for a composed management read. The caller owns disclosure,
 * management, partition and lifecycle checks on this same snapshot. */
export declare function readRealmSettingsHead(client: Parameters<typeof read.run>[0], realmId: string, at: string): Promise<RealmView | null>;
/** One head seek at Access's authoritative T, with the native grant branch
 * and no current ban required for protected Realms. Missing and denied resources both return null.
 */
export declare function readRealm(deps: Pick<RealmDependencies, 'pool' | 'access'>, actor: Actor, realmId: string, context: {
    deadline: number;
}): Promise<RealmView | null>;
export declare function realmReadEligibility(identity: Resource): ResourceEligibility;
export declare function createRealm(deps: RealmDependencies, actor: Actor, input: RealmInput, context: RealmContext): Promise<import("../command/command.ts").CommandOutcome<{
    realmId: string;
    revisionId: string;
}>>;
export declare function updateRealm(deps: RealmDependencies, actor: Actor, input: RealmUpdate, context: RealmContext): Promise<import("../command/command.ts").CommandOutcome<{
    realmId: string;
    revisionId: string;
}>>;
/** The read route's exact identity/head eligibility, batched by supplied full keys. */
export declare const realmViewerActionResource: import('../access/viewer-actions.ts').ViewerActionResource;
