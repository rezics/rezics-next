import {
  WORKFLOW_RETENTION_BATCH_SIZE,
  WORKFLOW_RETENTION_MAX_BATCHES,
  SigningRotationPending,
  type WorkflowRetentionPorts,
  type AuthRetentionInvocation,
  type WorkflowRetentionCounts,
  type WorkflowRetentionPage,
  type NativeRequestRetentionPorts,
  type RetentionMaintenancePorts,
} from '../contract/index.ts';
import { createAuthRetentionInvocation, workflowRetentionCandidates, workflowRetentionCutoff } from '../core/index.ts';

/** Application owns preparation, destructive work and checkpoint order. The store
 * knows only the locked cursor; neither SQL nor SDK code chooses retention policy.
 */
export function createWorkflowRetention<Cursor>(ports: WorkflowRetentionPorts<Cursor>) {
  async function retire(
    copies: Parameters<typeof workflowRetentionCandidates>[0],
    invocation: AuthRetentionInvocation,
  ): Promise<WorkflowRetentionCounts> {
    let eligible = 0;
    let retired = 0;
    let pending = 0;
    const technical: string[] = [];
    for (const candidate of workflowRetentionCandidates(copies)) {
      if (!candidate.eligible) continue;
      invocation.copy(candidate.technical);
      eligible++;
      if (candidate.technical) technical.push(candidate.id);
      else if (await ports.retireCopy(candidate.id, invocation)) retired++;
      else pending++;
    }
    if (technical.length) await ports.deleteTechnical(technical, invocation);
    return { eligible, retired: retired + technical.length, pending };
  }

  async function examine(proposedCutoff: number, invocation: AuthRetentionInvocation): Promise<WorkflowRetentionPage> {
    invocation.page();
    ports.scan.admit();
    await invocation.charge('preparation');
    return ports.store.withSession(async (session) => {
      // This transaction MUST finish before deletion. Lost native replies replay
      // against the original application, createdBefore and upper key.
      await session.transaction(async (checkpoint) => {
        if ((await checkpoint.lock()) === null) {
          await invocation.charge('initialization');
          const opened = await ports.scan.open(proposedCutoff);
          if (opened !== null) await checkpoint.save(opened);
        }
      });
      await invocation.charge('examination');
      return session.transaction(async (checkpoint) => {
        const continuation = await checkpoint.lock();
        // Another caller may have drained the prepared sweep before this lock.
        if (continuation === null)
          return { cutoff: proposedCutoff, examined: 0, eligible: 0, retired: 0, pending: 0, done: true };
        const page = await ports.scan.read(continuation, WORKFLOW_RETENTION_BATCH_SIZE);
        invocation.examined(page.examined);
        const counts = await retire(page.copies, invocation);
        // Throws leave the last checkpoint intact. Successful exact retirements
        // may repeat; pending consumers do not stop raw cursor advancement.
        invocation.check();
        await checkpoint.save(page.exhausted ? null : page.continuation);
        return { cutoff: page.cutoff, examined: page.examined, ...counts, done: page.exhausted };
      });
    });
  }

  return {
    async page(retentionDays: number, invocation = createAuthRetentionInvocation()): Promise<WorkflowRetentionPage> {
      return examine(workflowRetentionCutoff(retentionDays, ports.now()), invocation);
    },
    async batch(retentionDays: number, invocation = createAuthRetentionInvocation()): Promise<number> {
      return (await examine(workflowRetentionCutoff(retentionDays, ports.now()), invocation)).retired;
    },
    /** Administrative drain retains one clock and at most 60 funded raw pages. */
    async sweep(
      retentionDays: number,
      invocation = createAuthRetentionInvocation({ maxPages: WORKFLOW_RETENTION_MAX_BATCHES }),
    ): Promise<number> {
      const cutoff = workflowRetentionCutoff(retentionDays, ports.now());
      let retired = 0;
      for (let batch = 0; batch < WORKFLOW_RETENTION_MAX_BATCHES; batch++) {
        const page = await examine(cutoff, invocation);
        retired += page.retired;
        if (page.done) break;
      }
      return retired;
    },
  };
}

/** Evidence remains independent of workflow age/status and SDK deletion. */
export async function retireNativeRequest(ports: NativeRequestRetentionPorts, workflowId: string): Promise<boolean> {
  const row = await ports.lock(workflowId);
  if (!row || row.request_party_version !== 1 || row.request_context_version !== 1) return false;
  if (!(await ports.terminal(workflowId))) return false;
  await ports.remove(workflowId);
  return true;
}

/** Scheduled admission uses the same manual workflow capability and native
 * signing CAS. Only an occupied/stale signing slot is an ordinary pending result.
 */
export function createRetentionMaintenance(ports: RetentionMaintenancePorts) {
  return {
    retainWorkflowHistory: (retentionDays: number) => ports.retainWorkflowHistory(retentionDays),
    async retireSigningKeys(): Promise<number> {
      try {
        const state = await ports.signing.status();
        if (!state.retiring) return 0;
        await ports.signing.prune({ expectedGeneration: state.generation });
        return 1;
      } catch (error) {
        if (error instanceof SigningRotationPending) return 0;
        throw error;
      }
    },
  };
}
