import { type Actor } from '../request/access.ts';
import type { SpaceDependencies } from './space.ts';
import type { CommunityAmbient } from './ambient.ts';
export type PublicationDependencies = SpaceDependencies & CommunityAmbient;
export type PublicationContext = Readonly<{
    idempotencyKey: string;
    deadline: number;
}>;
export type PublicationReadContext = Readonly<{
    actor: Actor;
    deadline: number;
    languages?: readonly string[];
}>;
export type PublicationInput = Readonly<{
    realmId: string;
    subjectId: string;
    expectedHead?: string;
}>;
export type PublicationVerdict = 'adopt' | 'reject' | 'withdraw';
export type PublicationResult = Readonly<{
    publicationId: string;
    realmId: string;
    subjectId: string;
    verdict: PublicationVerdict;
    predecessor: string | null;
    /** Semantic subject point reads expose no revision id, so this stays null. */
    subjectRevisionId: null;
    publishedAt: string;
}>;
export type PublicationHead = Readonly<{
    realmId: string;
    subjectId: string;
    publicationId: string;
    verdict: 'adopt';
    subjectRevisionId: null;
    publishedAt: string;
}>;
export type PublicationPage = Readonly<{
    items: readonly PublicationHead[];
    next: string | null;
}>;
export type PublicationQuery = Readonly<{
    cursor?: string;
    limit?: number;
}>;
/** Trusted composition handle. The raw window and its cursor are selected once;
 * current() checks those exact heads without selecting another window.
 */
export type PublicationSelection = Readonly<{
    page: PublicationPage;
    current: () => Promise<boolean>;
}>;
export declare class PublicationConflictError extends Error {
    constructor();
}
export declare class PublicationOccupiedSlotError extends PublicationConflictError {
    constructor();
}
export declare class PublicationInputError extends Error {
    constructor();
}
export declare class PublicationCursorError extends Error {
    readonly reason: 'expired' | 'invalid' | 'stale';
    constructor(reason: 'expired' | 'invalid' | 'stale');
}
export declare function publish(deps: PublicationDependencies, actor: Actor, input: PublicationInput, context: PublicationContext): Promise<import("../command/command.ts").CommandOutcome<Readonly<{
    publicationId: string;
    realmId: string;
    subjectId: string;
    verdict: PublicationVerdict;
    predecessor: string | null;
    /** Semantic subject point reads expose no revision id, so this stays null. */
    subjectRevisionId: null;
    publishedAt: string;
}>>>;
export declare function withdraw(deps: PublicationDependencies, actor: Actor, input: PublicationInput, context: PublicationContext): Promise<import("../command/command.ts").CommandOutcome<Readonly<{
    publicationId: string;
    realmId: string;
    subjectId: string;
    verdict: PublicationVerdict;
    predecessor: string | null;
    /** Semantic subject point reads expose no revision id, so this stays null. */
    subjectRevisionId: null;
    publishedAt: string;
}>>>;
export declare function reject(deps: PublicationDependencies, actor: Actor, input: PublicationInput, context: PublicationContext): Promise<import("../command/command.ts").CommandOutcome<Readonly<{
    publicationId: string;
    realmId: string;
    subjectId: string;
    verdict: PublicationVerdict;
    predecessor: string | null;
    /** Semantic subject point reads expose no revision id, so this stays null. */
    subjectRevisionId: null;
    publishedAt: string;
}>>>;
export declare function readPublication(deps: PublicationDependencies, realmId: string, subjectId: string, context: PublicationReadContext): Promise<PublicationHead | null>;
export declare function listPublications(deps: PublicationDependencies, realmId: string, context: PublicationReadContext, query?: PublicationQuery): Promise<PublicationPage | null>;
/** Release the origin connection before a consumer hydrates selected Subjects.
 * The consumer must call current() after hydration and withhold the entire
 * observation when it fails. A replacement head cannot reuse the old summary.
 */
export declare function preparePublicationPage(deps: PublicationDependencies, realmId: string, context: PublicationReadContext, query?: PublicationQuery): Promise<PublicationSelection | null>;
