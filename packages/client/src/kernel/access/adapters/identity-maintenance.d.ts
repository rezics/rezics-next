import type { CommandTransaction } from '../../command/command.ts';
import type { AccessWorkDeclaration } from '../contract/index.ts';
import type { IdentityEpochStore, IdentityJob } from '../../semantic/identity-epoch-contract.ts';
import type { IdentityBindingData } from '../../semantic/identity-adapters/identity-epoch-binding.ts';
import type { IdentitySourceConsumerReference } from '../../semantic/identity-source-consumer-custody.ts';
type Binding = typeof import('../../semantic/identity-adapters/identity-epoch-binding.ts');
type Maintenance = typeof import('../../semantic/identity-source-consumer-maintenance.ts');
/** Access consumes native operations, not Semantic SQL or another identity registry.
 * Every function runs in the admitted operation; opaque frames, proofs, Pool and
 * deadlines pass directly to their existing producer. Composition owns this binding.
 */
export type AgentIdentityMaintenancePort = Readonly<{
    runTerminalCommand: import('../../semantic/adapters/index.ts').IdentityTerminalCommand;
    accountAgentId: typeof import('../../semantic/agents.ts').accountAgentId;
    activeRelease: typeof import('../../semantic/definitions.ts').activeRelease;
    withReadTransaction: typeof import('../../semantic/read.ts').withReadTransaction;
    verifyAccountAgent: import('../../semantic/identity-epoch-contract.ts').VerifyAccountAgent;
    unverifyAccountAgent: import('../../semantic/identity-epoch-contract.ts').UnverifyAccountAgent;
    store(): Pick<IdentityEpochStore, 'prepareAdmission' | 'bindReceipt' | 'findJob' | 'readJob' | 'reconcileStepReceipt'>;
    jobPartition: typeof import('../../semantic/identity-adapters/index.ts').identityJobPartition;
    resume: import('../../semantic/identity-epoch-contract.ts').ResumeIdentityEpochJob;
    waitPublished: import('../../semantic/identity-epoch-contract.ts').WaitIdentityEpochPublished;
    readOriginal: typeof import('../../semantic/account-agent-identity-recovery.ts').readOriginalAccountAgentIdentity;
    readUndo: Binding['readAccountIdentityUndo'];
    lookupBinding: Binding['lookupIdentityBinding'];
    acceptedBinding(tx: CommandTransaction, input: Parameters<Binding['readAcceptedAccountIdentityBinding']>[1]): Promise<IdentityBindingData | null>;
    verifyCustody: typeof import('../../semantic/identity-source-consumer-custody.ts').verifyIdentitySourceConsumerCustody;
    activeMaintenance: Maintenance['activeIdentitySourceConsumerMaintenance'];
    currentMaintenance: Maintenance['currentIdentitySourceConsumerMaintenance'];
    isLiveMaintenance: Maintenance['isLiveIdentitySourceConsumerMaintenance'];
    isPrepaidMaintenance: Maintenance['isPrepaidIdentitySourceConsumerMaintenance'];
    reserveNativeWork: Maintenance['reserveIdentitySourceConsumerNativeWork'];
    originalUnavailable(reason: string): Error;
    acceptedBindingDeclaration(): AccessWorkDeclaration;
    retainedReferenceDeclaration(): AccessWorkDeclaration;
    retainedReference(tx: CommandTransaction, reference: IdentitySourceConsumerReference): Promise<boolean>;
    readPublishedScope(tx: CommandTransaction, binding: Readonly<{
        home: number;
        scope: string;
        job: IdentityBindingData['job'];
    }>): Promise<Readonly<{
        saved: IdentityJob | null;
        scope: string | null;
    }>>;
}>;
export {};
