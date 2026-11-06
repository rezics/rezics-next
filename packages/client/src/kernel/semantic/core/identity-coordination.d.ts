import type { IdentityJobRef, IdentityStepName, IdentityStepProgress } from '../contract/identity-values.ts';
import type { IdentityEpochParticipantPorts, IdentityEpochParticipantName } from '../contract/identity-epoch-ports.ts';
import { type IdentityEpochConflict, type IdentityEpochNext, type IdentityEpochObservation } from './identity-epoch-sequence.ts';
export type IdentityObservedStep = IdentityEpochNext | IdentityEpochConflict;
export type IdentityControlStep = Exclude<IdentityObservedStep, IdentityStepName>;
export type IdentityCoordinationStep = IdentityObservedStep | IdentityEpochParticipantName | 'mapping' | 'publish' | 'published' | 'cancelled';
export type IdentityProduceDispatch<Native> = Readonly<{
    step: IdentityStepName;
    run: (native: Native, job: IdentityJobRef) => Promise<IdentityStepProgress>;
}>;
/** Choose the producer for one observed next step. Mapping is supplied by Semantic; participants come from ports. */
export declare function identityProduceDispatch<Native>(next: IdentityObservedStep, mapping: (native: Native, job: IdentityJobRef) => Promise<IdentityStepProgress>, participants: IdentityEpochParticipantPorts<Native>): IdentityProduceDispatch<Native> | {
    kind: 'control';
    next: IdentityControlStep;
};
export declare function identityObservedNext(view: IdentityEpochObservation): IdentityObservedStep;
export declare function identityScopedReceipt(ref: IdentityJobRef, step: IdentityStepName, progress: IdentityStepProgress): import("./identity-epoch-sequence.ts").IdentityEpochReceiptCheck;
export declare function identityParticipantComplete(progress: IdentityStepProgress | null | undefined): progress is IdentityStepProgress;
export declare function identityPublicationReady(view: IdentityEpochObservation): boolean;
