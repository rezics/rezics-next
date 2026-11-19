/** Subject command/read failures shared without loading editorial command implementations. */
export declare class SubjectNotFoundError extends Error {
}
export type MissingCheckpointOwner = 'absent' | 'inactive' | 'epoch' | 'empty' | 'behind' | 'covers';
type MissingCheckpointSource = `${'global' | 'nonroot'}/required-positive/owner-${MissingCheckpointOwner}`;
type MissingCheckpointScan = `first-${'present' | 'absent'}/scan-${'unseen' | 'recorded' | 'before-first' | 'since-first'}`;
type EffectsCheckpoint = 'covers' | 'behind' | 'absent';
export type SubjectLinkWaitReason = 'deadline' | 'checkpoint-deadline' | 'merge-deadline' | 'merge' | `${'local' | 'foreign'}-checkpoint-${'missing' | 'uninitialized' | 'zero-position' | 'epoch' | 'position'}` | `foreign-checkpoint-missing/${MissingCheckpointSource}/${MissingCheckpointScan}/effects-${EffectsCheckpoint}`;
export declare class SubjectProjectionPreparingError extends Error {
    readonly identity: 'subject' | 'merged-member';
    readonly stage: 'initial' | 'revision-recheck';
    readonly reason: SubjectLinkWaitReason;
    constructor(identity: 'subject' | 'merged-member', stage: 'initial' | 'revision-recheck', reason: SubjectLinkWaitReason);
}
export declare class EditorialConflictError extends Error {
}
export declare class SubjectRedirectError extends Error {
    readonly from: string;
    readonly to: string;
    constructor(from: string, to: string);
}
export {};
