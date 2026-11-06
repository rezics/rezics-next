import type { IdentityJobRef, IdentityStepName, IdentityStepProgress } from './identity-values.ts';
/** Semantic-owned port for one fixed identity participant. The native handle is bound by the composition root, so
 * this contract names no database client. The participant rereads its saved job, commits locally and returns
 * progress that Semantic validates and reconciles through its Store.
 */
export type IdentityParticipantStepPort<Native> = (native: Native, job: IdentityJobRef) => Promise<IdentityStepProgress>;
/** Fixed, versioned participant composition: exactly these two ports, with no default and no caller-selected list. */
export type IdentityEpochParticipantPorts<Native> = Readonly<{
    version: 1;
    /** Search currentness: canonical index membership for the job's originals. */
    'search-canonical-index': IdentityParticipantStepPort<Native>;
    /** Library custody: private follow counts and every canonical removal, addition or directory rekey. */
    'library-private-follow-counts': IdentityParticipantStepPort<Native>;
}>;
export declare const IDENTITY_EPOCH_PARTICIPANT_NAMES: readonly ['search-canonical-index', 'library-private-follow-counts'];
export type IdentityEpochParticipantName = (typeof IDENTITY_EPOCH_PARTICIPANT_NAMES)[number];
/** Locator of one committed participant step. It carries no native proof or authorization. */
export type IdentityStepReceiptLocator = Readonly<{
    job: Readonly<{
        jobId: string;
        epoch: string;
    }>;
    step: IdentityStepName;
    version: 1;
    native: Readonly<{
        partition: number;
        epoch: number;
        position: string;
        transactionId: string;
    }>;
}>;
