/** Access-owned actor, resource and decision vocabulary. Time and facts arrive as values. */
export type AccessAccountActor = {
    readonly kind: 'account';
    readonly accountId: string;
    readonly clientId: string;
    readonly scopes: readonly string[];
    readonly requestedBy: string | null;
    readonly authnEpoch: number;
};
export type AccessAnonymousActor = {
    readonly kind: 'anonymous';
};
export type AccessActor = AccessAccountActor | AccessAnonymousActor;
export type AccessResourceRef = {
    readonly route: number;
    readonly id: string;
};
export type AccessDecisionOutcome = 'allow' | 'deny' | 'unavailable' | 'invalid';
export type AccessDecision = {
    readonly outcome: AccessDecisionOutcome;
    readonly explicit: boolean;
};
export type AccessClock = () => Date;
export type AccessIdentityExpiry = {
    readonly expires: number;
    readonly expiryClock: 'wall' | 'kernel';
};
export type AccessIdentityReceiptKind = 'account-agent.verify' | 'account-agent.unverify';
export type AccessIdentityReceipt = {
    readonly kind: AccessIdentityReceiptKind;
    readonly account: string;
    readonly receipt: string;
};
export type AccessIdentityIntent = {
    readonly kind: 'merge';
    readonly survivor: string;
    readonly redirected: string;
    readonly release: string;
} | {
    readonly kind: 'unmerge';
    readonly original: string;
    readonly undoJob: AccessIdentityJobRef;
    readonly verificationReceipt: string;
    readonly release: string;
};
export type AccessIdentityJobRef = {
    readonly jobId: string;
    readonly epoch: number;
};
export type AccessQueryResult<T = Record<string, unknown>> = {
    readonly rows: readonly T[];
    readonly rowCount: number;
};
export type AccessQueryClient = {
    query<T = Record<string, unknown>>(queryTextOrConfig: string | {
        text: string;
        values?: unknown[];
    }, values?: unknown[]): Promise<AccessQueryResult<T>>;
};
export type AccessPool = object;
export type AccessDeadline = {
    readonly deadline: number;
    readonly requestId?: string;
};
export declare function isAccessAccountActor(actor: AccessActor): actor is AccessAccountActor;
export declare function accessActorIdentity(actor: AccessActor): string;
