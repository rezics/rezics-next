import { profileValidations } from '../../infrastructure/profile.ts';
import { DATASET, GRAPHS, ID, RV, hash, iri, lit, type WorkActivationEnvironment } from '../work/activate.ts';
import type { GraphTerminalProof } from '../access/admission.ts';
import type { ProposalExecutionAdmission, ProposalExecutionBasis } from './access.ts';
import { proposalReceiptIri } from './access.ts';

export class ProposalStale extends Error {}
export class ProposalDenied extends Error {}
export class ProposalPending extends Error {
  constructor(readonly operationId: string) { super('proposal execution outcome requires reconciliation'); }
}

export interface ProposalGraphBasis {
  proposal: string; proposalRevision: string; poll: string; resolution: string; body: string;
  effectDigest: string; effectTarget: string; effectCapability: string; expectedTargetState: string;
}

const executionIri = (admissionId: string) => {
  const h = hash(`proposal-execution:${admissionId}`);
  return `${ID}${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
};
const operationIri = (admissionId: string) => `urn:rezics:operation:${hash(`proposal-execution:${admissionId}`)}`;
const targetRevisionIri = (organization: string, revision: string) =>
  `urn:rezics:org-roster-policy:${organization.slice(-36)}:${revision}`;

/** One proposal, one poll/resolution and one immutable revision; no graph scan. */
export async function readProposalGraphBasis(env: WorkActivationEnvironment,
  proposal: string, proposalRevision: string, poll: string): Promise<ProposalGraphBasis> {
  const result = await env.fuseki.query(`PREFIX rv: <${RV}>
    SELECT ?body ?resolution ?digest ?target ?capability ?state WHERE {
      GRAPH ${iri(GRAPHS.current)} {
        ${iri(proposal)} a rv:Proposal ; rv:governingBody ?body ;
          rv:proposalHead ${iri(proposalRevision)} ; rv:proposalState rv:ProposalAdopted .
        ${iri(poll)} a rv:Poll ; rv:governingBody ?body ;
          rv:pollState rv:PollFinalized ; rv:pollResolution ?resolution .
        FILTER NOT EXISTS { ${iri(proposal)} rv:proposalExecution ?prior }
      }
      GRAPH ${iri(GRAPHS.revisions)} {
        ${iri(proposalRevision)} a rv:ProposalRevision ; rv:proposal ${iri(proposal)} ;
          rv:effectDigest ?digest ; rv:effectTarget ?target ;
          rv:effectCapability ?capability ; rv:expectedTargetState ?state .
        ?resolution a rv:PollResolution ; rv:poll ${iri(poll)} ;
          rv:resolutionOutcome rv:ResolutionAdopted ;
          rv:proposalRevision ${iri(proposalRevision)} ; rv:effectDigest ?digest .
      }
    } LIMIT 2`);
  const rows = result.results?.bindings ?? [];
  if (rows.length !== 1) throw new ProposalStale('proposal is not an exact adopted resolution');
  const row = rows[0]!;
  if (!row.body || !row.resolution || !row.digest || !row.target || !row.capability || !row.state) {
    throw new ProposalStale('proposal effect basis is incomplete');
  }
  return { proposal, proposalRevision, poll, resolution: row.resolution.value,
    body: row.body.value, effectDigest: row.digest.value, effectTarget: row.target.value,
    effectCapability: row.capability.value, expectedTargetState: row.state.value };
}

export async function readProposalExecutionReceipt(env: WorkActivationEnvironment,
  admission: ProposalExecutionAdmission): Promise<GraphTerminalProof | null> {
  const receipt = proposalReceiptIri(admission.id);
  const result = await env.fuseki.query(`PREFIX rv: <${RV}>
    SELECT ?digest ?id ?scope ?authorityEpoch ?dataEpoch ?sequence ?outcome ?execution
      ?proposalRevision ?resolution ?effectDigest ?effectTarget ?expectedState WHERE {
      GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} a rv:OperationReceipt ;
        rv:requestDigest ?digest ; rv:admissionId ?id ; rv:admittedScope ?scope ;
        rv:authorityEpoch ?authorityEpoch ; rv:dataEpoch ?dataEpoch ; rv:sequence ?sequence ;
        rv:outcome ?outcome ; rv:application ?execution . }
      GRAPH ${iri(GRAPHS.revisions)} { ?execution a rv:ProposalExecution ;
        rv:proposalRevision ?proposalRevision ; rv:pollResolution ?resolution ;
        rv:effectDigest ?effectDigest ; rv:effectTarget ?effectTarget ;
        rv:expectedTargetState ?expectedState . }
    } LIMIT 2`);
  const rows = result.results?.bindings ?? [];
  if (!rows.length) return null;
  const row = rows[0]!;
  if (rows.length !== 1 || row.digest?.value !== admission.requestDigest
    || row.id?.value !== admission.id || row.scope?.value !== admission.scope
    || row.authorityEpoch?.value !== admission.authorityEpoch
    || row.outcome?.value !== `${RV}Succeeded`
    || row.execution?.value !== executionIri(admission.id)
    || row.proposalRevision?.value !== admission.basis.proposalRevision
    || row.resolution?.value !== admission.basis.resolution
    || row.effectDigest?.value !== admission.basis.effectDigest
    || row.effectTarget?.value !== admission.basis.effectTarget
    || row.expectedState?.value !== admission.basis.expectedTargetState
    || !row.dataEpoch?.value || !/^[0-9]+$/.test(row.sequence?.value ?? '')) {
    throw new ProposalDenied('proposal execution receipt differs from admission');
  }
  return { outcome: 'succeeded', receipt, admissionId: admission.id,
    requestDigest: admission.requestDigest, authorityEpoch: admission.authorityEpoch,
    scope: admission.scope, dataEpoch: row.dataEpoch.value, sequence: row.sequence.value };
}

/** The graph's guarded completion binds the target owner's saved policy revision. */
export async function recordProposalExecution(env: WorkActivationEnvironment,
  admission: ProposalExecutionAdmission, graph: ProposalGraphBasis,
  resultingPolicyRevision: string): Promise<GraphTerminalProof> {
  const receipt = proposalReceiptIri(admission.id);
  const prior = await readProposalExecutionReceipt(env, admission);
  if (prior) return prior;
  if (Date.parse(admission.expiresAt) <= Date.now() && !admission.replayed) {
    throw new ProposalPending(`urn:rezics:operation:${hash(admission.id)}`);
  }
  const basis: ProposalExecutionBasis = admission.basis;
  const execution = executionIri(admission.id);
  const operation = operationIri(admission.id);
  const event = `urn:rezics:event:${hash(operation)}`;
  const batch = `urn:rezics:outbox:${hash(receipt)}`;
  const at = `${lit(new Date().toISOString())}^^<http://www.w3.org/2001/XMLSchema#dateTime>`;
  const validations = await profileValidations(env.fuseki, 'proposal-v1', [
    { shape: 'https://rezics.com/definition/proposal-v1/proposal-shape',
      focus: [basis.proposal], graphs: [GRAPHS.current, GRAPHS.revisions] },
    { shape: 'https://rezics.com/definition/proposal-v1/execution-shape',
      focus: [execution], graphs: [GRAPHS.current, GRAPHS.revisions] },
  ]);
  let result: Awaited<ReturnType<typeof env.fuseki.commandWithReceipt>> | null = null;
  try { result = await env.fuseki.commandWithReceipt({ receipt, digest: admission.requestDigest,
    validations, deadlineMs: 10_000, update: `PREFIX rv: <${RV}>
      DELETE {
        GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n }
        GRAPH ${iri(GRAPHS.current)} { ${iri(basis.proposal)} rv:proposalState rv:ProposalAdopted }
      }
      INSERT {
        GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
        GRAPH ${iri(GRAPHS.current)} { ${iri(basis.proposal)} rv:proposalState rv:ProposalExecuted ;
          rv:proposalExecution ${iri(execution)} . }
        GRAPH ${iri(GRAPHS.revisions)} { ${iri(execution)} a rv:ProposalExecution ;
          rv:proposalRevision ${iri(basis.proposalRevision)} ;
          rv:pollResolution ${iri(basis.resolution)} ;
          rv:effectDigest ${lit(basis.effectDigest)} ; rv:effectTarget ${iri(basis.effectTarget)} ;
          rv:expectedTargetState ${lit(basis.expectedTargetState)} ;
          rv:resultingTargetRevision ${iri(targetRevisionIri(basis.effectTarget, resultingPolicyRevision))} ;
          rv:operation ${iri(operation)} ; rv:executedAt ${at} . }
        GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} a rv:OperationReceipt ;
          rv:outcome rv:Succeeded ; rv:requestDigest ${lit(admission.requestDigest)} ;
          rv:admissionId ${lit(admission.id)} ; rv:admittedScope ${lit(admission.scope)} ;
          rv:authorityEpoch ${lit(admission.authorityEpoch)} ; rv:operation ${iri(operation)} ;
          rv:application ${iri(execution)} ; rv:work ${iri(basis.proposal)} ;
          rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
          rv:sequence ?next . }
        GRAPH ${iri(GRAPHS.outbox)} { ${iri(batch)} a rv:OutboxBatch ;
          rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next ;
          rv:eventCount 1 ; rv:event ${iri(event)} .
          ${iri(event)} a rv:ProposalExecutedEvent ; rv:ordinal 0 ;
            rv:action ${lit('governance.proposal.execute')} ; rv:receipt ${iri(receipt)} ;
            rv:operation ${iri(operation)} ; rv:application ${iri(execution)} . }
      }
      WHERE {
        GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
          rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n . }
        GRAPH ${iri(GRAPHS.current)} { ${iri(basis.proposal)} rv:governingBody ${iri(basis.body)} ;
          rv:proposalHead ${iri(basis.proposalRevision)} ; rv:proposalState rv:ProposalAdopted .
          ${iri(graph.poll)} rv:pollState rv:PollFinalized ; rv:pollResolution ${iri(basis.resolution)} . }
        GRAPH ${iri(GRAPHS.revisions)} { ${iri(basis.proposalRevision)}
          rv:effectDigest ${lit(basis.effectDigest)} ; rv:effectTarget ${iri(basis.effectTarget)} ;
          rv:effectCapability ${lit(basis.capability)} ;
          rv:expectedTargetState ${lit(basis.expectedTargetState)} .
          ${iri(basis.resolution)} rv:resolutionOutcome rv:ResolutionAdopted ;
          rv:proposalRevision ${iri(basis.proposalRevision)} ; rv:effectDigest ${lit(basis.effectDigest)} . }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(basis.proposal)} rv:proposalExecution ?old } }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
        BIND(?n + 1 AS ?next)
      }` }); }
  catch {
    // A lost Jena response can follow an accepted command. Resolve its exact
    // receipt before returning a pending operation to the caller.
    try {
      const saved = await readProposalExecutionReceipt(env, admission);
      if (saved) return saved;
    } catch { /* retry with the same operation ID */ }
    throw new ProposalPending(`urn:rezics:operation:${hash(admission.id)}`);
  }
  const saved = await readProposalExecutionReceipt(env, admission);
  if (saved) return saved;
  if (result.status === 'guard-unmatched') throw new ProposalStale('proposal changed before execution');
  throw new ProposalPending(`urn:rezics:operation:${hash(admission.id)}`);
}
