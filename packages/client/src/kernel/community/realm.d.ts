export { RealmInputError } from './contract/index.ts';
export { readRealm, readRealmSettingsHead, realmReadEligibility, allowRealmRead, realmViewerActionResource, } from './realm-read.ts';
import { type Actor } from '../request/access.ts';
import { type RealmContinuity } from './realm-governance.ts';
import type { RealmVotes } from './realm-votes.ts';
import type { SpaceDependencies, SpaceContext } from './space.ts';
import { type CommunityAmbient } from './ambient.ts';
import { type RealmPresentation } from './presentation.ts';
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
export declare function createRealm(deps: RealmDependencies & CommunityAmbient, actor: Actor, input: RealmInput, context: RealmContext): Promise<import("../command/command.ts").CommandOutcome<{
    realmId: string;
    revisionId: string;
}>>;
export declare function updateRealm(deps: RealmDependencies & CommunityAmbient, actor: Actor, input: RealmUpdate, context: RealmContext): Promise<import("../command/command.ts").CommandOutcome<{
    realmId: string;
    revisionId: string;
}>>;
/** The read route's exact identity/head eligibility, batched by supplied full keys. */
