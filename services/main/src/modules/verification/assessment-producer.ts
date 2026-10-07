import type { AssessClaimInput } from './operations.ts';
import type { ActivationOutcome } from './store.ts';

export const ASSESSMENT_PRODUCER_COST = {
  intentBytes: 16_384,
  terminalBytes: 4096,
  challenges: 8,
  page: 32,
} as const;

/** Continuations resume the bounded analysis walk; they are excluded by the original assessment digest. */
export type AssessmentProducerIntent = Omit<AssessClaimInput, 'lineageContinuation'>;
export interface AssessmentProducerStage {
  admission: string;
  requestDigest: string;
  principal: string;
  actingSubject: string;
  scope: string;
  authorityEpoch: string;
  idempotencyKey: string;
  claim: string;
  claimRevision: string;
  intent: AssessmentProducerIntent;
}
export interface AssessmentProducerPermit {
  mode: 'ordinary' | 'maintenance';
  job: string | null;
  generation: string;
  restoreEpoch: string;
}
export interface AssessmentProducerTerminal {
  status: 'activated' | 'refused' | 'no-activation' | 'cancelled';
  receipt: string;
  assessment: string | null;
  activation:
    | ActivationOutcome
    | { status: 'not-reproduced' | 'cancelled' | 'refused'; reason?: string };
}
export interface AssessmentProducerRecord extends AssessmentProducerStage {
  stageGeneration: string;
  restoreEpoch: string;
  terminal: AssessmentProducerTerminal | null;
}
export interface StagedAssessmentProducer {
  row: AssessmentProducerRecord;
  permit: AssessmentProducerPermit;
}
