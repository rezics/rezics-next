import type { Pool } from 'pg';
import { type Actor } from '../request/access.ts';
import { type KernelClock } from '../clock.ts';
import type { KeyRing } from '../tokens/seal.ts';
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
export declare function createContinueReads(deps: {
    pool: Pool;
    tokens: KeyRing;
    clock?: KernelClock;
}): {
    list(actor: Actor, query: {
        limit?: number;
        cursor?: string;
    }, deadline: number): Promise<ContinuePage>;
};
