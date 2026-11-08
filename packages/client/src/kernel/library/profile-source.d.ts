import type { Pool } from 'pg';
import { type AuthoritativeTime } from '../command/command.ts';
import type { Access, Actor } from '../request/access.ts';
import type { NativeCopyDefinitions } from './copy-model.ts';
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
export declare function readLibraryProfileSourceObservation(deps: LibraryProfileSourceDependencies, subjectId: string, definitions?: Pick<NativeCopyDefinitions, 'active'>): Promise<{
    source: NonNullable<LibraryProfileSource>;
    anchor: LibraryProfileAnchor;
} | null>;
/** Current source/type/disclosure only. No profile or release lookup; each foreign home is released. */
export declare function readLibraryProfileAnchor(deps: LibraryProfileSourceDependencies, subjectId: string): Promise<LibraryProfileAnchor | null>;
export { sameCopyProfileAnchor as sameLibraryProfileAnchor } from './copy-model.ts';
export { assertPreProfileLibraryRead } from './profile-read-gate.ts';
