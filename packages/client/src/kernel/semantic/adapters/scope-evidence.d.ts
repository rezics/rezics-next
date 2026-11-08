import type { Pool } from 'pg';
import type { Access, Actor, AccessClient } from '../../request/access.ts';
import type { AccessWorkAccounting } from '../../access/work.ts';
import type { ScopeEvidenceHost, ScopeEvidenceObservation } from '../contract/index.ts';
type Dependencies = Readonly<{
    pool: Pool;
    access: Access;
}>;
type Context = Readonly<{
    actor: Actor;
    deadline: number;
    work: AccessWorkAccounting;
}>;
import type { ScopeEvidenceReader } from '../contract/index.ts';
import type { AuthoritativeTime } from '../../command/command.ts';
import type { ScopeWorkContext } from '../../search/adapters/index.ts';
export type NativeScopeReader = ScopeEvidenceReader<Access, Actor, AuthoritativeTime, ScopeWorkContext>;
/** Exact original reference and terminal state; no redirect replacement or publication inference. */
export declare function createSubjectScopeEvidence<A>(host: ScopeEvidenceHost<Dependencies, Context, AccessClient, A>): {
    observe: (dependencies: Dependencies, subjectId: string, context: Context) => Promise<ScopeEvidenceObservation<A> | null>;
};
export {};
