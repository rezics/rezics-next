import { createHash } from 'node:crypto';
import type { AccountAssertionVerifier } from '../account/verify-assertion.ts';
import type { OrgRosterPolicyInput,
  AccessManagedOrganizations } from '../access/managed-organizations.ts';
import type { WorkActivationEnvironment } from '../work/activate.ts';
import { AccessProposalExecutions, type ProposalExecutionBasis } from './access.ts';
import { ProposalDenied, ProposalPending, ProposalStale, readProposalGraphBasis,
  readProposalExecutionReceipt, recordProposalExecution } from './graph.ts';

export interface ExecuteProposalInput {
  proposal: string; proposalRevision: string; poll: string; resolution: string;
  body: string; representationId: string; capabilityGrantId: string;
  effectDigest: string; expectedTargetState: string; effect: OrgRosterPolicyInput;
}
export interface ProposalExecutionResult {
  proposal: string; proposalRevision: string; resolution: string; effectDigest: string;
  target: string; policyRevision: string; receipt: string; replayed: boolean;
}
export interface ProposalExecutionDependencies {
  environment: WorkActivationEnvironment;
  account: Pick<AccountAssertionVerifier, 'verify'>;
  access: AccessProposalExecutions;
  target: AccessManagedOrganizations;
}

/** Contract canonical JSON: recursively sorted keys, preserved array order. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
export const proposalDigest = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');

/** Two bounded graph reads, one Access admission, one G-017 CAS and one graph
 * completion. A saved target receipt is reconciled before any current-head read. */
export async function executeProposal(deps: ProposalExecutionDependencies,
  request: Request, input: ExecuteProposalInput, key: string): Promise<ProposalExecutionResult> {
  const principal = await deps.account.verify(request, ['vote:manage']);
  const digest = proposalDigest(input.effect);
  if (digest !== input.effectDigest) {
    throw new ProposalDenied('effect differs from the approved digest');
  }
  const target = input.effect.organizationSubject;
  const basis: ProposalExecutionBasis = {
    proposal: input.proposal, proposalRevision: input.proposalRevision, resolution: input.resolution,
    body: input.body, effectDigest: input.effectDigest, effectTarget: target,
    expectedTargetState: input.expectedTargetState, capability: 'access.org.roster.policy',
    capabilityScope: `access:org-roster:${target.slice(-36)}`,
    capabilityGrantId: input.capabilityGrantId, representationId: input.representationId,
  };
  const requestDigest = proposalDigest(input);
  let admission = await deps.access.replay(principal, basis, key, requestDigest);
  let graph = null;
  if (!admission) {
    graph = await readProposalGraphBasis(deps.environment, input.proposal, input.proposalRevision, input.poll);
    if (graph.resolution !== input.resolution || graph.body !== input.body
      || graph.effectDigest !== digest || graph.effectTarget !== target
      || graph.effectCapability !== basis.capability
      || graph.expectedTargetState !== input.expectedTargetState) {
      throw new ProposalDenied('proposal capability, target or effect is outside its approved scope');
    }
    const state = await deps.access.readTargetState(target);
    const currentStateDigest = proposalDigest({ profile: 'access-organization-roster-policy-state-v1',
      organizationSubject: target, policyRevision: state.policyRevision,
      admissionsOpen: state.admissionsOpen });
    if (currentStateDigest !== input.expectedTargetState
      || state.policyRevision !== input.effect.expectedPolicyRevision) {
      throw new ProposalStale('approved roster state changed');
    }
    admission = await deps.access.admit(principal, basis, key, requestDigest);
  }
  const targetKey = `proposal-execution:${admission.id}`;
  let targetReceipt = await deps.target.readRosterPolicyReceipt(principal, input.effect, targetKey);
  let graphReceipt = await readProposalExecutionReceipt(deps.environment, admission);
  if (graphReceipt && !targetReceipt) throw new ProposalPending(`urn:rezics:operation:${admission.id}`);
  if (!targetReceipt) {
    const state = await deps.access.readTargetState(target);
    if (proposalDigest({ profile: 'access-organization-roster-policy-state-v1',
      organizationSubject: target, policyRevision: state.policyRevision,
      admissionsOpen: state.admissionsOpen }) !== basis.expectedTargetState) {
      throw new ProposalStale('approved roster state changed');
    }
    try { targetReceipt = await deps.target.setRosterPolicy(principal, input.effect, targetKey,
      async client => {
        await deps.access.assertCurrent(client, admission);
        const current = (await client.query<{ revision: string; open: boolean }>(`SELECT revision::text, open
          FROM access.membership_policy WHERE kind = 'org' AND owner_subject = $1 FOR SHARE`,
        [target])).rows[0];
        if (!current || proposalDigest({ profile: 'access-organization-roster-policy-state-v1',
          organizationSubject: target, policyRevision: current.revision,
          admissionsOpen: current.open }) !== basis.expectedTargetState) {
          throw new ProposalStale('approved roster state changed');
        }
      }); }
    catch (error) {
      targetReceipt = await deps.target.readRosterPolicyReceipt(principal, input.effect, targetKey);
      if (!targetReceipt) throw error;
    }
  }
  if (!graphReceipt) {
    graph ??= await readProposalGraphBasis(deps.environment, input.proposal, input.proposalRevision, input.poll);
    if (graph.resolution !== basis.resolution || graph.effectDigest !== basis.effectDigest
      || graph.effectTarget !== basis.effectTarget || graph.effectCapability !== basis.capability) {
      throw new ProposalPending(`urn:rezics:operation:${admission.id}`);
    }
    graphReceipt = await recordProposalExecution(deps.environment, admission, graph,
      targetReceipt.policyRevision);
  }
  try { await deps.access.seal(admission, graphReceipt); }
  catch { throw new ProposalPending(`urn:rezics:operation:${admission.id}`); }
  return { proposal: basis.proposal, proposalRevision: basis.proposalRevision,
    resolution: basis.resolution, effectDigest: basis.effectDigest, target,
    policyRevision: targetReceipt.policyRevision, receipt: graphReceipt.receipt,
    replayed: admission.replayed || targetReceipt.replayed };
}
