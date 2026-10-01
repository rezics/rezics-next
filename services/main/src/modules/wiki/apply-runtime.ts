import { AdmissionDenied, type RegisteredAdmission, type GraphTerminalProof } from '../access/admission.ts';
import { CommandRejected } from '../../infrastructure/fuseki.ts';
import { canonicalCandidate, type CommandDelivery, type CommandOutcome, type EditorialCommand,
  type OwnerCommand } from '../editorial-review/contract.ts';
import type { EditorialRuntime } from '../editorial-review/runtime.ts';
import { InvalidContextCommand, ContextCommandUnavailable } from '../context/command.ts';
import { SemanticChangeRejected, SemanticTargetUnavailable, StaleSemanticHead } from '../semantic/command.ts';
import { InvalidCompositionChange, StaleCompositionHead } from '../structure/change.ts';

export interface WikiGraphCommand {
  binding: OwnerCommand;
  read(admission: string): Promise<(GraphTerminalProof & { component?: string; revision?: string; structure?: string }) | null>;
  dispatch(admission: RegisteredAdmission): Promise<unknown>;
  cancel(admission: RegisteredAdmission): Promise<unknown>;
}
export const commandResult = (outcome: CommandOutcome | undefined) => outcome?.outcome === 'applied'
  && outcome.result && typeof outcome.result === 'object' && !Array.isArray(outcome.result) ? outcome.result : null;
export function dependencyRejected(key: string): CommandOutcome {
  return { key,outcome: 'dependency_rejected',receipt: null,result: { code: 'dependency_rejected' } };
}
/** Reuse owner dispatch/terminal receipts. A recognized denial can seal that
 * item's cancellation; an unknown acknowledgement stays pending. */
export function wikiGraphCommand(runtime: EditorialRuntime, key: string,
  build: (settled: readonly CommandOutcome[]) => Promise<WikiGraphCommand | null>,
  finalize: (result: { component: string; revision: string; receipt: string }, settled: readonly CommandOutcome[]) => Promise<void>
    = async () => {}, deferredAuthority?: Pick<OwnerCommand, 'action' | 'scope'>): EditorialCommand {
  const finish = async (delivery: CommandDelivery, settled: readonly CommandOutcome[], spec: WikiGraphCommand) => {
    if (!delivery.admissionId) return null;
    const terminal = await spec.read(delivery.admissionId);
    if (!terminal) return null;
    if (terminal.requestDigest !== delivery.binding.digest || terminal.scope !== delivery.binding.scope) {
      throw new Error('Wiki command receipt differs from its retained binding');
    }
    await runtime.work.access.recordGraphOutcome(delivery.admissionId,terminal);
    if (terminal.outcome !== 'succeeded') return { key,outcome: 'rejected' as const,receipt: terminal.receipt,
      result: { code: 'owner_rejected' } };
    const component = terminal.component ?? terminal.structure;
    if (!component || !terminal.revision) throw new Error('Wiki owner receipt lacks its resource');
    const result = { component,revision: terminal.revision,receipt: terminal.receipt };
    await finalize(result,settled);
    return { key,outcome: 'applied' as const,receipt: terminal.receipt,result };
  };
  return { key,
    authority: async () => (await build([]))?.binding ?? deferredAuthority ?? null,
    prepare: async settled => (await build(settled))?.binding ?? { action: 'wiki.dependency-rejected',scope: 'wiki:dependency',
      digest: canonicalCandidate({ key,code: 'dependency_rejected' }).digest },
    resolve: async (delivery,settled) => {
      const spec = await build(settled);
      return spec ? finish(delivery,settled,spec) : dependencyRejected(key);
    },
    execute: async (delivery,settled) => {
      const spec = await build(settled);
      if (!spec) return dependencyRejected(key);
      const principal = await runtime.work.account.verify(runtime.request,['work:review']);
      const { binding,input } = delivery;
      let registered: RegisteredAdmission;
      try { registered = await runtime.work.access.register({ principal,actingSubject: input.permit.decidingAgent,
        editorialPermit: input.permit.proof,action: binding.action,scope: binding.scope,
        requestDigest: binding.digest,idempotencyKey: key }); }
      catch (error) {
        if (!(error instanceof AdmissionDenied)) throw error;
        return { key,outcome: 'rejected',receipt: null,result: { code: 'owner_authority_required' } };
      }
      const receipt = await finish({ ...delivery,admissionId: registered.id },settled,spec);
      if (receipt) return receipt;
      if (!registered.dispatchEligible) {
        // Expired admissions cannot dispatch. Seal their original receipt so a
        // late owner acknowledgement wins or this item settles as rejected.
        await spec.cancel(registered);
        return finish({ ...delivery,admissionId: registered.id },settled,spec);
      }
      let admission: RegisteredAdmission;
      try { admission = await runtime.work.access.claim(registered.id,binding.digest,principal); }
      catch (error) {
        if (!(error instanceof AdmissionDenied)) throw error;
        await spec.cancel(registered);
        return finish({ ...delivery,admissionId: registered.id },settled,spec);
      }
      try { await spec.dispatch(admission); }
      catch (error) {
        if (error instanceof CommandRejected || error instanceof SemanticChangeRejected || error instanceof SemanticTargetUnavailable
          || error instanceof StaleSemanticHead || error instanceof InvalidContextCommand || error instanceof ContextCommandUnavailable
          || error instanceof InvalidCompositionChange || error instanceof StaleCompositionHead) await spec.cancel(admission);
        else return null;
      }
      return finish({ ...delivery,admissionId: registered.id },settled,spec);
    },
  };
}
