import type { PoolClient } from 'pg';
import { type AuthoritativeTime } from '../command/command.ts';
export type LifecycleTarget = {
    kind: 'candidate';
    subject: string;
    candidate: string;
} | {
    kind: 'context';
    context: string;
};
export type LifecycleEvidence = {
    target: LifecycleTarget;
    owner: {
        kind: 'write_basis' | 'owner_grant';
        accountId: string;
    } | null;
    state: 'active' | 'deleted' | 'purged';
    deletedAt: string | null;
    purgeAfter: string | null;
    held: boolean;
};
type LifecycleInput = {
    target: LifecycleTarget;
    accountId: string;
    nativeT: AuthoritativeTime;
};
/** Trusted metadata only. The caller owns authorization, native T and the read/command snapshot. */
export declare function readSemanticLifecycle(client: Pick<PoolClient, 'query'>, input: LifecycleInput): Promise<LifecycleEvidence | null>;
export {};
