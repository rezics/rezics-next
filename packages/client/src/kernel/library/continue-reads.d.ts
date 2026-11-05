import { type Actor } from '../request/access.ts';
import type { KeyRing } from '../tokens/seal.ts';
import type { OwnerQueryDependencies } from './builtin-runtime-query.ts';
import type { ContinueActiveSession } from './continue-source.ts';
import type { SubjectSummary } from '../semantic/summaries.ts';
export type ContinueSubject = Readonly<{
    subjectId: string;
    state: string | null;
    lastActivityAt: string;
    activeProgressSession: ContinueActiveSession | null;
    subject?: SubjectSummary | null;
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
        view?: 'BASIC' | 'FULL';
        spaceId?: string;
        kind?: string;
    }, deadline: number, languages?: readonly string[]): Promise<ContinuePage>;
};
