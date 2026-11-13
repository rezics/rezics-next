import type { HostedChapterTarget } from './hosted-chapters-model.ts';

export const HOSTED_PUBLICATION_STAGING_STEP_LIMIT = 20;
export const HOSTED_PUBLICATION_STAGING_BATCH_LIMIT = 512;
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

export type HostedPublicationStagingMode = 'whole' | 'selection';
export type HostedPublicationStagingSourceKind = 'snapshot' | 'prefix' | 'ordered';
export type HostedPublicationStagingState =
  | 'collecting'
  | 'building'
  | 'closing'
  | 'ready'
  | 'sealed'
  | 'cancelled'
  | 'expired'
  | 'failed';
export type HostedPublicationStagingLocator = Readonly<{
  catalogueId: string;
  stageId: string;
}>;
export type BeginHostedPublicationStaging = HostedPublicationStagingLocator &
  Readonly<{
    expectedHeadRevisionId: string;
    expectedPublicationId: string | null;
    mode: HostedPublicationStagingMode;
    expiresAt: Date | string;
  }>;
export type AppendHostedPublicationSelection = HostedPublicationStagingLocator &
  Readonly<{
    batchId: string;
    occurrenceIds: readonly string[];
  }>;
export type HostedPublicationStagingCheckpoint = Readonly<{
  locator: HostedPublicationStagingLocator;
  state: HostedPublicationStagingState;
  mode: HostedPublicationStagingMode;
  /** Optional only for checkpoints persisted before the binding fields were added. */
  sourceRevisionId?: string;
  expectedHeadRevisionId?: string;
  expectedPublicationId?: string | null;
  inputVersion: string;
  inputCount: string;
  settledInputCount: string;
  candidateCount: string;
  sourceFrontier: string;
  sourceExhausted: boolean;
  closureFrontier: string;
  closureCheckedCount: string;
  closureMissingCount: string;
  failure: string | null;
}>;
export type HostedPublicationStagingStepResult = Readonly<{
  replayed: boolean;
  phase: 'whole' | 'selection' | 'closure';
  processed: number;
  progress: HostedPublicationStagingCheckpoint;
}>;
export type HostedPublicationStagingBatchResult = Readonly<{
  replayed: boolean;
  inputVersion: string;
  firstInputPosition: string;
  itemCount: number;
}>;
export type HostedPublicationStagingSeal = Readonly<{
  locator: HostedPublicationStagingLocator;
  sourceRevisionId: string;
  expectedHeadRevisionId: string;
  expectedPublicationId: string | null;
  mode: HostedPublicationStagingMode;
  inputVersion: string;
  candidateCount: string;
  sealedAt: string;
}>;
export type HostedPublicationStagedCandidate = Readonly<{
  sourceOrder: string;
  occurrenceId: string;
  parentId: string | null;
  position: string;
  sourceSegment: 'snapshot' | 'base' | 'append' | 'ordered';
  kind: 'part' | 'chapter';
  title: string | null;
  target: HostedChapterTarget | null;
}>;
export type HostedPublicationTargetObservation = Readonly<{
  target: HostedChapterTarget;
  authorId: string;
  licence: string;
  observedAt: string;
}>;
export type HostedPublicationActivationTarget = HostedPublicationTargetObservation & Readonly<{ occurrenceId: string }>;
export type HostedPublicationTargetCursor = Readonly<{
  threadId: string;
  postId: string;
  revisionId: string;
  sha256: string;
}>;
export type HostedPublicationStagingPage<T, C = string> = Readonly<{
  items: readonly T[];
  next: C | null;
}>;

export class HostedPublicationStagingConflictError extends Error {
  constructor(message = 'Hosted publication staging conflicts with its pinned source') {
    super(message);
    this.name = 'HostedPublicationStagingConflictError';
  }
}
export class HostedPublicationStagingNotFoundError extends Error {
  constructor() {
    super('Hosted publication staging is unavailable');
    this.name = 'HostedPublicationStagingNotFoundError';
  }
}
export class HostedPublicationStagingExpiredError extends Error {
  constructor() {
    super('Hosted publication staging has expired');
    this.name = 'HostedPublicationStagingExpiredError';
  }
}

export function requireSafeSourceOrder(value: string): number {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new HostedPublicationStagingConflictError('Invalid staged source order');
  const exact = BigInt(value);
  if (exact > MAX_SAFE_BIGINT)
    throw new HostedPublicationStagingConflictError('Staged source order exceeds exact range');
  return Number(exact);
}
