import type { IdentityEpochParticipantPorts } from '../contract/identity-epoch-ports.ts';
import type { IdentityJobRef, IdentityStepName, IdentityStepProgress } from '../contract/identity-values.ts';
import { identityObservedNext, identityScopedReceipt, type IdentityControlStep, type IdentityProduceDispatch, type IdentityEpochObservation } from '../core/index.ts';
export type IdentityCoordination<Native> = Readonly<{
    participants: IdentityEpochParticipantPorts<Native>;
    next(view: IdentityEpochObservation): ReturnType<typeof identityObservedNext>;
    publicationReady(view: IdentityEpochObservation): boolean;
    dispatch(next: ReturnType<typeof identityObservedNext>, mapping: (native: Native, job: IdentityJobRef) => Promise<IdentityStepProgress>): IdentityProduceDispatch<Native> | {
        kind: 'control';
        next: IdentityControlStep;
    };
    receipt(ref: IdentityJobRef, step: IdentityStepName, progress: IdentityStepProgress): ReturnType<typeof identityScopedReceipt>;
}>;
/** Identity epoch use cases over the fixed participant ports. Mapping remains a Semantic producer. */
export declare function createIdentityCoordination<Native>(participants: IdentityEpochParticipantPorts<Native>): IdentityCoordination<Native>;
