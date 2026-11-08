import type { Pool } from 'pg';
import type { KernelClock } from '../clock.ts';
import type { AuthoritativeTime } from '../command/command.ts';
import type { Access, AccessContext, Actor } from '../request/access.ts';
export { SubjectIdentityUnavailableError, type ResolvedSubject } from './contract/index.ts';
export type SubjectAnchorDependencies = {
    pool: Pool;
    access: Access;
    clock?: KernelClock;
};
/** Compatibility entry: the application owns redirect/identity orchestration, Semantic owns native observations. */
export declare function resolveSubject(deps: SubjectAnchorDependencies, actor: Actor, subjectId: string, at?: AuthoritativeTime, context?: AccessContext): Promise<import("./subject-anchor.ts").ResolvedSubject | null>;
/** Preserve stored keys, input ordering, the 100-ID limit and four concurrent reads. */
export declare function readableSubjects(deps: SubjectAnchorDependencies, actor: Actor, subjectIds: readonly string[], at?: AuthoritativeTime): Promise<string[]>;
