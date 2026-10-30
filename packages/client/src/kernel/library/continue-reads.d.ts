import { type Actor } from '../request/access.ts';
import type { KeyRing } from '../tokens/seal.ts';
import type { OwnerQueryDependencies } from './builtin-runtime-query.ts';
import type { ContinueActiveSession } from './continue-source.ts';
export type ContinueSubject = Readonly<{
    subjectId: string;
    state: string | null;
    lastActivityAt: string;
    activeProgressSession: ContinueActiveSession | null;
}>;
export type ContinuePage = {
    subjects: ContinueSubject[];
    next: string | null;
};
/** Pure default reader. Admission precedes native owner/cursor reads; GET never starts retained work. */
export declare function createContinueReads(deps: Omit<OwnerQueryDependencies, 'access'> & {
    tokens: KeyRing;
    access?: OwnerQueryDependencies['access'];
}): {
    list(actor: Actor, query: {
        limit?: number;
        cursor?: string;
    }, deadline: number): Promise<ContinuePage>;
};
