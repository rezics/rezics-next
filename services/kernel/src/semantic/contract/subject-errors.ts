/** Subject command/read failures shared without loading editorial command implementations. */
export class SubjectNotFoundError extends Error {}
export type MissingCheckpointOwner = 'absent' | 'inactive' | 'epoch' | 'empty' | 'behind' | 'covers';
type MissingCheckpointSource = `${'global' | 'nonroot'}/required-positive/owner-${MissingCheckpointOwner}`;
type MissingCheckpointScan = `first-${'present' | 'absent'}/scan-${'unseen' | 'recorded' | 'before-first' | 'since-first'}`;
type EffectsCheckpoint = 'covers' | 'behind' | 'absent';
export type SubjectLinkWaitReason =
  | 'deadline'
  | 'checkpoint-deadline'
  | 'merge-deadline'
  | 'merge'
  | `${'local' | 'foreign'}-checkpoint-${'missing' | 'uninitialized' | 'zero-position' | 'epoch' | 'position'}`
  | `foreign-checkpoint-missing/${MissingCheckpointSource}/${MissingCheckpointScan}/effects-${EffectsCheckpoint}`;

export class SubjectProjectionPreparingError extends Error {
  constructor(
    readonly identity: 'subject' | 'merged-member',
    readonly stage: 'initial' | 'revision-recheck',
    readonly reason: SubjectLinkWaitReason,
  ) {
    super('Subject projection is preparing');
  }
}
export class EditorialConflictError extends Error {}

export class SubjectRedirectError extends Error {
  constructor(
    public readonly from: string,
    public readonly to: string,
  ) {
    super('Subject has been redirected');
  }
}
