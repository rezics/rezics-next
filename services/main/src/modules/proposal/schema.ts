/**
 * Governance proposal owner schema (GOV23). Jena owns proposals, their immutable
 * effect revisions and executions through `model/definitions/proposal-v1.ts`.
 * Access migration 072 owns one immutable execution proof per admission: the
 * executor's mandate for the body plus the body's own capability grant for the
 * exact effect action and target scope. Voters gain no authority from a result.
 */

export const proposalGraphProfile = 'proposal-v1';
export const proposalExecutionAction = 'governance.proposal.execute';

const bodyIri = /^https:\/\/rezics\.com\/id\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/** The Access scope gate that fences execution admissions for one governing body. */
export function governanceBodyScopeId(body: string): string {
  const id = bodyIri.exec(body)?.[1];
  if (!id) throw new Error('governing body must be a canonical REZICS UUID IRI');
  return `governance:body:${id}`;
}

/** PostgreSQL bigint columns are read as decimal strings. */
type Int8 = string;

export interface ProposalExecutionAdmissionRow {
  admission_id: string;
  proposal: string;
  proposal_revision: string;
  resolution: string;
  body_subject: string;
  effect_digest: string;
  effect_target: string;
  expected_target_state: string;
  capability: string;
  capability_scope: string;
  capability_grant_id: string;
  capability_grant_generation: Int8;
  representation_id: string;
  representation_generation: Int8;
  principal_epoch: Int8;
  body_generation: Int8;
  created_at: Date;
}

/** Exact column set; the migration test compares it with the installed DDL. */
export const proposalAccessTables = {
  proposal_execution_admission: {
    admission_id: true, proposal: true, proposal_revision: true, resolution: true, body_subject: true,
    effect_digest: true, effect_target: true, expected_target_state: true, capability: true,
    capability_scope: true, capability_grant_id: true, capability_grant_generation: true,
    representation_id: true, representation_generation: true, principal_epoch: true,
    body_generation: true, created_at: true,
  } satisfies Record<keyof ProposalExecutionAdmissionRow, true>,
} as const;
