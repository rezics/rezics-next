/** Private exact-target projections. Command operands are request-only. */
export type LifecycleOriginal = Readonly<{
    operationId: 'account.suspend' | 'account.reinstate';
    key: string;
    reason?: string;
}>;
export type LifecycleReviewInput = Readonly<{
    original?: LifecycleOriginal;
    operatorPageKey?: string;
}>;
export type LifecycleAdvertisement = {
    action: 'account:suspend';
    operationId: 'account.suspend';
} | {
    action: 'account:reinstate';
    operationId: 'account.reinstate';
};
export type LifecycleEffects = Readonly<{
    state: 'complete' | 'pending' | 'unknown';
    sessionRevocation: 'unknown' | 'not_required';
    sessionRevocationAuthorization: 'recorded' | 'unknown' | 'not_required';
    accountAgentSynchronization: 'unknown';
    operator: 'complete' | 'pending' | 'unknown';
    inspectedPages: number;
    terminalSubjects: number;
    operatorPage?: {
        state: 'complete' | 'pending';
        nextPageKey: string | null;
    };
}>;
export type LifecycleOriginalResult = {
    status: 'unknown';
} | {
    status: 'recorded';
    receiptId: string;
    effects: LifecycleEffects;
};
export type LifecycleReview = Readonly<{
    account: {
        id: string;
        kind: 'actor' | 'organization';
        displayName: string | null;
        handle: string | null;
    };
    current: {
        state: 'pending' | 'active' | 'suspended' | 'deleted';
        minimumAuthnEpoch: string;
        fenced: boolean;
    };
    actions: LifecycleAdvertisement[];
    original?: LifecycleOriginalResult;
}>;
