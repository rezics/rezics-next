import type { Pool, PoolClient } from 'pg';
import { type AuthoritativeTime } from '../command/command.ts';
import { type Access, type Actor } from '../request/access.ts';
import { type SubjectComponent } from '../semantic/subject.ts';
import { type LibraryProfileDescriptor, type LibraryProfilePin } from './profile.ts';
export type LibraryProfileSourceDependencies = {
    pool: Pool;
    access: Access;
    actor: Actor;
    at: AuthoritativeTime;
    deadline: number;
};
type Source = {
    subjectId: string;
    requestedSubjectId: string | null;
    component: SubjectComponent;
};
export type LibraryProfileAnchor = Source & {
    acceptingType: string;
    identityEpoch: bigint;
};
export type LibraryProfileSource = (Source & {
    kind: 'supported';
    pin: Extract<LibraryProfilePin, {
        provenance: 'profile';
    }>;
    profile: LibraryProfileDescriptor;
}) | (Source & {
    kind: 'unsupported';
    acceptingType: string;
}) | null;
/** Private, current observations only: native T binds Access, not historical SQL snapshots. */
export declare function readLibraryProfileSource(deps: LibraryProfileSourceDependencies, subjectId: string): Promise<LibraryProfileSource>;
/** The same source producer with its private before/final fence retained for a bounded detail. */
export declare function readLibraryProfileSourceObservation(deps: LibraryProfileSourceDependencies, subjectId: string): Promise<{
    source: NonNullable<LibraryProfileSource>;
    anchor: LibraryProfileAnchor;
} | null>;
/** Current source/type/disclosure only. No profile or release lookup; each foreign home is released. */
export declare function readLibraryProfileAnchor(deps: LibraryProfileSourceDependencies, subjectId: string): Promise<LibraryProfileAnchor | null>;
export declare function sameLibraryProfileAnchor(before: LibraryProfileAnchor, after: LibraryProfileAnchor | null): boolean;
/** Read-only rollout boundary. Existing fixed-contract DTOs can expose an unpinned
 * historical fact only before that owner's live-fact cutover. A missing job never
 * prevents reading a current pinned fact, and reads never create owner metadata.
 */
export declare function assertPreProfileLibraryRead(client: Pick<PoolClient, 'query'>, accountId: string): Promise<void>;
export {};
