import type { Pool, PoolClient } from 'pg';
import { type LibraryProfilePin } from './profile.ts';
import { currentOwnerState } from './owner-index.ts';
import type { ShelfSession } from './shelf-contract.ts';
type Client = Pick<PoolClient, 'query'>;
export type ContinueActiveSession = ShelfSession;
/** One original's actual state and bounded top active session. No entry is required for session support. */
export declare function readContinueOriginalFacts(client: Client, accountId: string, original: string): Promise<{
    truth: {
        clear?: {
            sequence: bigint;
        };
        original: string;
        presence: boolean | null;
        families: {
            entry: boolean;
            label: boolean | null;
            session: boolean;
            copy: boolean;
        };
        state: {
            id: string;
            sequence: bigint | null;
            pin: import("@rezics/definitions").LibraryProfilePin | null;
        } | null;
    };
    session: ShelfSession | null;
    sessionPin: import("@rezics/definitions").LibraryProfilePin | null;
    sessionLastChangedAt: string | null;
    lastActivityAt: string | null;
}>;
/** Evaluate the shared canonical state winner and an independently selected native active session.
 * The shared owner plan owns original/terminal disclosure and complete alias/session coverage.
 * Resolve immutable releases only after releasing the owner snapshot; never infer history from today's profile.
 */
export declare function evaluateContinueSupports(pool: Pool, state: ReturnType<typeof currentOwnerState>, session: ContinueActiveSession | null, sessionPin: LibraryProfilePin | null): Promise<{
    eligible: boolean;
    state: string | null;
    activeProgressSession: ShelfSession | null;
}>;
export type ContinueOriginalFacts = Awaited<ReturnType<typeof readContinueOriginalFacts>>;
/**
 * Fold a complete, currently disclosed native canonical group from the SAME shared owner plan.
 * This does not resolve identity, enumerate aliases, grant disclosure or prove group completion.
 * Large groups remain that plan's retained preparation work rather than a per-page alias sweep.
 */
export declare function evaluateContinueGroup(pool: Pool, subjectId: string, originals: readonly ContinueOriginalFacts[]): Promise<{
    subjectId: string;
    state: string | null;
    lastActivityAt: string;
    activeProgressSession: ShelfSession | null;
} | null>;
export {};
