/** Semantic-owned immutable review operands and closed admission outcomes. No observation grants authority. */
export type IdentityRatingControlLocator = Readonly<{
    partition: number;
    group: string;
}>;
export type IdentityRatingReviewOperand = Readonly<{
    version: 1;
    requestedOriginalId: string;
    canonicalTerminalId: string;
    sourceIdentities: readonly string[];
    sourceHomes: readonly number[];
    controlLocators: readonly IdentityRatingControlLocator[];
    evidence: string;
}>;
export type IdentityRatingReviewUnavailableReason = 'bootstrap' | 'missing-owner' | 'changed-during-read' | 'control-limit' | 'redirect-chain' | 'canonical-mismatch' | 'operand-too-large';
export type IdentityRatingReviewResult = Readonly<{
    state: 'reviewed';
    operand: IdentityRatingReviewOperand;
}> | Readonly<{
    state: 'pending';
    jobId: string;
    epoch: string;
}> | Readonly<{
    state: 'moved';
    home: number;
}> | Readonly<{
    state: 'changed';
    canonicalTerminalId: string;
}> | Readonly<{
    state: 'absent';
}> | Readonly<{
    state: 'undisclosed';
}> | Readonly<{
    state: 'unavailable';
    reason: IdentityRatingReviewUnavailableReason;
}>;
declare const preparation: unique symbol;
/** Factory-local immutable input only; it conveys neither authorization nor a held lock. */
export type IdentityRatingCommitPreparation = Readonly<{
    [preparation]: true;
}>;
export type IdentityRatingCommitHeld = Readonly<{
    ownerId: string;
    ownerEpoch: number;
    partition: number;
    subjectId: string;
    publishedHeads: readonly Readonly<{
        partition: number;
        group: string;
        epoch: string;
    }>[];
}>;
export type IdentityRatingCommitParticipant<Tx> = Readonly<{
    prepare(operand: IdentityRatingReviewOperand): IdentityRatingCommitPreparation;
    /** Fresh command body only, after receipt lookup and before no-op, cleanup or effects. */
    admit(tx: Tx, prepared: IdentityRatingCommitPreparation): Promise<IdentityRatingCommitHeld>;
}>;
export type IdentityRatingAdmissionReason = 'redirect-chain' | 'epoch-pending' | 'source-pending';
export type IdentityRatingAdmissionResult = Readonly<{
    status: 'admitted';
    subjectId: string;
}> | Readonly<{
    status: 'pending';
    reason: IdentityRatingAdmissionReason;
}>;
export {};
