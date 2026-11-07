import {
  accountIdentityAcceptedBindingDeclaration,
  accountIdentityRetainedReferenceDeclaration,
} from './agent-identity-maintenance-work.ts';
import type { AgentIdentityMaintenancePort } from '../../access/adapters/index.ts';
import { readOriginalAccountAgentIdentity } from '../account-agent-identity-recovery.ts';
import { accountAgentId } from '../agents.ts';
import { activeRelease } from '../definitions.ts';
import { verifyAccountAgent, unverifyAccountAgent } from '../account-agents.ts';
import { withReadTransaction } from '../read.ts';
import { identityEpochStore, identityJobPartition } from '../identity-adapters/index.ts';
import {
  identityBindingData,
  readAcceptedAccountIdentityBinding,
  readAccountIdentityUndo,
  lookupIdentityBinding,
} from '../identity-adapters/identity-epoch-binding.ts';
import { resumeIdentityEpochJob, waitIdentityEpochPublished } from '../identity-epoch-coordinator.ts';
import { runIdentityTerminalCommand } from '../identity-terminal-closure-command.ts';
import { verifyIdentitySourceConsumerCustody } from '../identity-source-consumer-custody.ts';
import {
  activeIdentitySourceConsumerMaintenance,
  currentIdentitySourceConsumerMaintenance,
  isLiveIdentitySourceConsumerMaintenance,
  isPrepaidIdentitySourceConsumerMaintenance,
  reserveIdentitySourceConsumerNativeWork,
  IdentitySourceOriginalUnavailable,
} from '../identity-source-consumer-maintenance.ts';
import retainedReference from '../identity-source-consumer-custody-select.sql';

export type IdentityTerminalCommand = typeof runIdentityTerminalCommand;

/** Constructing this adapter dispatches no work. Opaque proof validation, native
 * receipt custody, bounded terminal drain/release and frame authority remain with
 * the original producers; each selected operation runs on the supplied host.
 */
export function createAgentIdentityMaintenance(): AgentIdentityMaintenancePort {
  return Object.freeze({
    runTerminalCommand: runIdentityTerminalCommand,
    accountAgentId,
    activeRelease,
    withReadTransaction,
    verifyAccountAgent,
    unverifyAccountAgent,
    store: identityEpochStore,
    jobPartition: identityJobPartition,
    resume: resumeIdentityEpochJob,
    waitPublished: waitIdentityEpochPublished,
    readOriginal: readOriginalAccountAgentIdentity,
    readUndo: readAccountIdentityUndo,
    lookupBinding: lookupIdentityBinding,
    async acceptedBinding(tx, input) {
      const proof = await readAcceptedAccountIdentityBinding(tx, input);
      return proof ? identityBindingData(proof) : null;
    },
    verifyCustody: verifyIdentitySourceConsumerCustody,
    activeMaintenance: activeIdentitySourceConsumerMaintenance,
    currentMaintenance: currentIdentitySourceConsumerMaintenance,
    isLiveMaintenance: isLiveIdentitySourceConsumerMaintenance,
    isPrepaidMaintenance: isPrepaidIdentitySourceConsumerMaintenance,
    reserveNativeWork: reserveIdentitySourceConsumerNativeWork,
    originalUnavailable: (reason: string) => new IdentitySourceOriginalUnavailable(reason),
    acceptedBindingDeclaration: accountIdentityAcceptedBindingDeclaration,
    retainedReferenceDeclaration: accountIdentityRetainedReferenceDeclaration,
    async retainedReference(tx, reference) {
      const receipt = reference.receipt;
      const key = JSON.stringify([receipt.kind, receipt.account, receipt.receipt]);
      return !!(
        await tx.query(retainedReference.sql, [
          reference.source.partition,
          key,
          reference.sourceDigest,
          reference.source.epoch,
          reference.source.position.toString(),
          reference.source.transactionId,
          reference.job.jobId,
          reference.job.epoch.toString(),
          reference.barrier.accountId,
          reference.barrier.accountRoute,
          reference.barrier.version,
          reference.barrier.at,
          reference.erasedRole,
        ])
      ).rows[0];
    },
    async readPublishedScope(tx, binding) {
      const job = binding.job;
      const saved = await identityEpochStore().readJob(tx, job);
      const current = (
        await tx.query<{ scope_digest: string }>(
          `SELECT j.scope_digest FROM semantic.identity_epoch_job j
       JOIN semantic.identity_epoch_native_commit n ON n.partition_no=j.partition_no
        AND n.transaction_id=j.recorded_transaction_id AND n.purpose='admission'
       JOIN core.partition p ON p.partition_no=j.partition_no AND p.write_state='active'
        AND p.moved_to IS NULL AND p.epoch=n.epoch AND p.position>=n.position
       JOIN semantic.identity_epoch_control c ON c.partition_no=j.partition_no
       WHERE j.partition_no=$1 AND j.job_id=$2 AND j.epoch=$3 AND j.state='published'
        AND c.published_epoch>=j.epoch AND c.pending_job IS DISTINCT FROM j.job_id
       FOR SHARE OF j,n,p,c`,
          [binding.home, job.jobId, job.epoch.toString()],
        )
      ).rows[0];
      return { saved, scope: current?.scope_digest ?? null };
    },
  } satisfies AgentIdentityMaintenancePort);
}
