import type { MainWorkDependencies } from '../../routes/dependencies.ts';
import type { AccessAdmissionRegistry } from '../access/admission.ts';
import { GRAPHS, RV, iri } from '../work/activate.ts';
import { setWorkMetadata, readMetadataReceipt } from '../work/metadata-command.ts';
import { metadataComponent, checkedMetadataState, StaleWorkMetadata } from '../work/metadata-schema.ts';
import { PendingAdmittedWork } from '../work/create-admitted.ts';
import { admittedSemanticChange } from '../semantic/admitted.ts';
import { readCurrentComponent, readSemanticChangeTerminal, StaleSemanticHead } from '../semantic/change.ts';
import { EditorialBlocked, canonicalCandidate, type ApplyInput, type ApplyOutcome, type OwnerReceipt } from './contract.ts';
import type { ComponentCorrectionOwners } from './component-correction-adapter.ts';

export interface EditorialRuntime { work: MainWorkDependencies; request: Request }

function permittedAccess(work: MainWorkDependencies, input: ApplyInput): MainWorkDependencies['access'] {
  return new Proxy(work.access, { get(target, property) {
    if (property === 'register') return (request: Parameters<AccessAdmissionRegistry['register']>[0]) =>
      target.register({ ...request, editorialPermit: input.permit.proof });
    const value: unknown = Reflect.get(target,property,target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}
export function ownerReceipt(input: ApplyInput, receipt: string, revision: string, owner: unknown): OwnerReceipt {
  return { receipt, proposal: input.revision.proposal, revision: input.revision.n,
    candidateDigest: input.revision.candidateDigest, operationKey: input.operationKey,
    beforeHeads: input.expectedHeads, afterHeads: input.expectedHeads.map(row => ({ ...row, head: revision })),
    candidate: input.revision.candidate, before: input.revision.before, owner: canonicalCandidate(owner).candidate };
}
export function componentOwners(runtime: EditorialRuntime): ComponentCorrectionOwners {
  const { work,request } = runtime, env = work.environment;
  // The transport capability is review. The server-bound permit narrows the
  // command; Access independently requires the ordinary owner authority.
  const account: MainWorkDependencies['account'] = { verify: (req,scopes) => work.account.verify(req,
    scopes.length === 1 && scopes[0] === 'work:edit' ? ['work:review'] : scopes) };
  const owners: ComponentCorrectionOwners = {
    async readMetadata(target) {
      const empty = checkedMetadataState({ kind: 'header',originalTitle: null,localized: [] });
      const component = metadataComponent(target.resource,empty);
      const rows = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?head ?state WHERE {
        GRAPH ${iri(GRAPHS.current)} { ${iri(component)} rv:metadataHead ?head ; rv:work ${iri(target.resource)} }
        OPTIONAL { GRAPH ${iri(GRAPHS.revisions)} { ?head rv:component ${iri(component)} ; rv:metadataState ?state } }
      } LIMIT 2`, 70_000)).results?.bindings ?? [];
      if (rows.length > 1 || rows.length && !rows[0]?.state) throw new EditorialBlocked({ code: 'owner_unavailable' });
      return { state: rows.length ? checkedMetadataState(JSON.parse(rows[0]!.state!.value)) : empty,
        heads: [{ component,head: rows[0]?.head?.value ?? null }] };
    },
    async readSemantic(target,component) {
      const current = await readCurrentComponent(env,target.resource,component);
      if (current) return { state: current.state,heads: [{ component: target.resource,head: current.head }] };
      if (component !== 'resource' || target.work !== target.resource) throw new EditorialBlocked({ code: 'owner_unavailable' });
      const rows = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?head WHERE {
        GRAPH ${iri(GRAPHS.current)} { ${iri(target.resource)} a <https://schema.org/CreativeWork> ; rv:head ?head }
      } LIMIT 2`,4096)).results?.bindings ?? [];
      if (rows.length !== 1 || !rows[0]?.head) throw new EditorialBlocked({ code: 'owner_unavailable' });
      return { state: { component: 'resource',types: [],properties: [],lifecycle: 'active' },
        heads: [{ component: target.resource,head: rows[0].head.value }] };
    },
    async commitMetadata(input,state): Promise<ApplyOutcome> {
      try {
        const result = await setWorkMetadata({ ...work,account,access: permittedAccess(work,input) },request,
          { work: input.target.resource,state,expectedHead: input.expectedHeads[0]!.head,
            actingSubject: input.permit.decidingAgent,idempotencyKey: input.operationKey });
        return { outcome: 'applied',receipt: ownerReceipt(input,result.receipt,result.revision,result) };
      } catch (error) {
        if (error instanceof StaleWorkMetadata) return { outcome: 'stale_base',actualHeads: (await owners.readMetadata(input.target)).heads };
        if (error instanceof PendingAdmittedWork) return { outcome: 'pending' };
        throw error;
      }
    },
    async commitSemantic(input,state): Promise<ApplyOutcome> {
      try {
        const result = await admittedSemanticChange(env,account,permittedAccess(work,input),request,
          { target: input.target.resource,state,expectedHead: input.expectedHeads[0]!.head,
            actingSubject: input.permit.decidingAgent,idempotencyKey: input.operationKey });
        return { outcome: 'applied',receipt: ownerReceipt(input,result.receipt,result.revision,result) };
      } catch (error) {
        if (error instanceof StaleSemanticHead) return { outcome: 'stale_base',actualHeads: (await owners.readSemantic(input.target,state.component)).heads };
        if (error instanceof PendingAdmittedWork) return { outcome: 'pending' };
        throw error;
      }
    },
  };
  return owners;
}
export async function resolveComponent(runtime: EditorialRuntime, input: ApplyInput) {
  if (!input.admissionId) return null;
  const candidate = input.revision.candidate as { command: string };
  if (candidate.command === 'work-metadata') {
    const terminal = await readMetadataReceipt(runtime.work.environment,input.admissionId);
    if (!terminal) return null;
    if (terminal.requestDigest !== input.revision.ownerCommand?.digest
      || terminal.scope !== input.revision.ownerCommand.scope) throw new EditorialBlocked({ code: 'owner_unavailable' });
    await runtime.work.access.recordGraphOutcome(input.admissionId,terminal);
    if (terminal.outcome === 'cancelled') return { outcome: 'cancelled' as const };
    return { outcome: 'applied' as const,receipt: ownerReceipt(input,terminal.receipt,terminal.revision!,terminal) };
  }
  const terminal = await readSemanticChangeTerminal(runtime.work.environment,input.admissionId);
  if (!terminal) return null;
  if (terminal.requestDigest !== input.revision.ownerCommand?.digest
    || terminal.scope !== input.revision.ownerCommand.scope) throw new EditorialBlocked({ code: 'owner_unavailable' });
  await runtime.work.access.recordGraphOutcome(input.admissionId,terminal);
  if (terminal.outcome === 'cancelled') return { outcome: 'cancelled' as const };
  return { outcome: 'applied' as const,receipt: ownerReceipt(input,terminal.receipt,terminal.revision!,terminal) };
}
