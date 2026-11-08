import { type ReviewedPersonExpectation } from './reviewed-person-identity.ts';
import type { Pool } from 'pg';
import { type CommandAuthorization, type CommandTransaction } from '../command/command.ts';
import type { AccountActor } from '../request/access.ts';
import type { Release } from '@rezics/definitions';
export { SubjectRedirectError } from './contract/subject-errors.ts';
export { redirectOf } from './subject-redirect.ts';
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
} & ({
    expectedIdentity: ReviewedPersonExpectation;
    routeKey: Uint8Array;
} | {
    expectedIdentity?: undefined;
    routeKey?: Uint8Array;
})): Promise<{
    component: {
        partition: number;
        epoch: number;
        position: bigint;
    };
    survivor: string;
    redirected: string;
    revision: number;
}>;
export type SubjectMergeAdmission = {
    operation: {
        id: string;
    };
};
/** Ordinary HTTP admission. Retains the identity job; mapping applies the catalogue
 * redirect. Callers observe publication through GET /v1/subjectIdentityOperations/{id}. */
export declare function admitMergeSubjects(pool: Pool, options: {
    subjects: string[];
    survivor?: string;
    actor: AccountActor;
    idempotencyKey: string;
    digest: Uint8Array;
    release: {
        digest: string;
        release: Release;
    };
    /** The redirect command's authorization, prepared for the redirected Subject's partition. */
    authorization: CommandAuthorization;
    /** Authorizations for the admission's own partitions; the store asks for each one it runs on. */
    authorizationFor: (partition: number) => Promise<CommandAuthorization>;
    deadline?: number;
    clock?: () => Date;
} & ({
    expectedIdentity: ReviewedPersonExpectation;
    routeKey: Uint8Array;
} | {
    expectedIdentity?: undefined;
    routeKey?: Uint8Array;
})): Promise<{
    operation: {
        id: string;
    };
    component: {
        partition: number;
        epoch: number;
        position: bigint;
    };
}>;
export type SubjectIdentityOperation = {
    id: string;
    done: false;
} | {
    id: string;
    done: true;
    result: {
        survivor: string;
        redirected: string;
        revision: number;
    };
};
/** Effects-free observation of one ordinary merge job. Caller already authorized merge and disclosure. */
export declare function observeSubjectIdentityOperation(tx: CommandTransaction, id: string): Promise<{
    operation: SubjectIdentityOperation;
    original: string;
    terminal: string;
} | null>;
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
