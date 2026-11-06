import type { IdentityJobRef, IdentityStepName, IdentityStepProgress } from '../contract/identity-values.ts';
import type { IdentityEpochParticipantPorts, IdentityEpochParticipantName } from '../contract/identity-epoch-ports.ts';
import {
  identityEpochNext,
  identityEpochReceiptLocator,
  type IdentityEpochConflict,
  type IdentityEpochNext,
  type IdentityEpochObservation,
} from './identity-epoch-sequence.ts';

export type IdentityObservedStep = IdentityEpochNext | IdentityEpochConflict;
export type IdentityControlStep = Exclude<IdentityObservedStep, IdentityStepName>;
export type IdentityCoordinationStep =
  | IdentityObservedStep
  | IdentityEpochParticipantName
  | 'mapping'
  | 'publish'
  | 'published'
  | 'cancelled';

export type IdentityProduceDispatch<Native> = Readonly<{
  step: IdentityStepName;
  run: (native: Native, job: IdentityJobRef) => Promise<IdentityStepProgress>;
}>;

/** Choose the producer for one observed next step. Mapping is supplied by Semantic; participants come from ports. */
export function identityProduceDispatch<Native>(
  next: IdentityObservedStep,
  mapping: (native: Native, job: IdentityJobRef) => Promise<IdentityStepProgress>,
  participants: IdentityEpochParticipantPorts<Native>,
): IdentityProduceDispatch<Native> | { kind: 'control'; next: IdentityControlStep } {
  if (next === 'mapping') return { step: 'mapping', run: mapping };
  if (next === 'search-canonical-index')
    return { step: 'search-canonical-index', run: participants['search-canonical-index'] };
  if (next === 'library-private-follow-counts')
    return { step: 'library-private-follow-counts', run: participants['library-private-follow-counts'] };
  return { kind: 'control', next };
}

export function identityObservedNext(view: IdentityEpochObservation): IdentityObservedStep {
  return identityEpochNext(view);
}

export function identityScopedReceipt(ref: IdentityJobRef, step: IdentityStepName, progress: IdentityStepProgress) {
  return identityEpochReceiptLocator(ref, step, progress);
}

export function identityParticipantComplete(
  progress: IdentityStepProgress | null | undefined,
): progress is IdentityStepProgress {
  return progress?.state === 'complete';
}

export function identityPublicationReady(view: IdentityEpochObservation): boolean {
  return identityEpochNext(view) === 'publish';
}
