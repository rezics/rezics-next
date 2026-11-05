import type { Pool } from 'pg';
import { type CommandAuthorization, type CommandTransaction } from '../command/command.ts';
import type { AccountActor } from '../request/access.ts';
import type { Release } from '@rezics/definitions';
export declare class SubjectRedirectError extends Error {
    readonly from: string;
    readonly to: string;
    constructor(from: string, to: string);
}
export declare function redirectOf(client: CommandTransaction, id: string): Promise<string | null>;
export declare function mergeSubjects(pool: Pool, options: {
    subjects: string[];
    survivor?: string;
    actor: AccountActor;
    idempotencyKey: string;
    digest: Uint8Array;
    release: {
        digest: string;
        release: Release;
    };
    authorization: CommandAuthorization;
    deadline?: number;
    clock?: () => Date;
}): Promise<{
    component: {
        partition: number;
        epoch: number;
        position: bigint;
    };
    survivor: string;
    redirected: string;
    revision: number;
}>;
/** The redirect and revision work shared by ordinary and verified account-agent merges. */
export declare function mergeSubjectsInCommand(tx: CommandTransaction, transactionId: string, options: {
    survivor: string;
    redirected: string;
    release: {
        digest: string;
        release: Release;
    };
    verificationReceiptId?: string;
    allowAccountAgent?: boolean;
}): Promise<{
    value: {
        survivor: string;
        redirected: string;
        revision: number;
    };
    events: {
        type: string;
        subject: string;
        data: unknown;
    }[];
}>;
