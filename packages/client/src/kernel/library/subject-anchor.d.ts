import type { Pool } from 'pg';
import type { KernelClock } from '../clock.ts';
import type { AuthoritativeTime } from '../command/command.ts';
import { type Access, type AccessContext, type Actor } from '../request/access.ts';
export type SubjectAnchorDependencies = {
    pool: Pool;
    access: Access;
    clock?: KernelClock;
};
export type ResolvedSubject = {
    subjectId: string;
    requestedSubjectId: string | null;
};
export declare class SubjectIdentityUnavailableError extends Error {
    readonly reason: 'bootstrap' | 'missing-owner' | 'moved-owner';
    constructor(reason: 'bootstrap' | 'missing-owner' | 'moved-owner');
}
/** Resolve a subject on its own anchor using the semantic subject:read policy. */
export declare function resolveSubject(deps: SubjectAnchorDependencies, actor: Actor, subjectId: string, at?: AuthoritativeTime, context?: AccessContext): Promise<ResolvedSubject | null>;
/** Keep stored IDs that resolve, preserving page identity and bounds. */
export declare function readableSubjects(deps: SubjectAnchorDependencies, actor: Actor, subjectIds: readonly string[], at?: AuthoritativeTime): Promise<string[]>;
