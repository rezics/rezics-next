import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';

/** Attributable committed fence fixture; Governance owns every enforcement write. */
export async function recordFixtureDisclosure(client: PoolClient, input: {
  resourceId: string; revisionId: string; effect: 'disclosure' | 'search';
  principalId: string; actingSubject: string;
}): Promise<void> {
  const caseId = randomUUID(), decisionId = randomUUID(), digest = 'b'.repeat(64);
  await client.query(`INSERT INTO access.governance_case
    (id,kind,authority_kind,authority_scope_id,context,target_owner,target_resource,target_component,disclosure)
    VALUES ($1,'content_report','platform','governance:platform','urn:rezics:context:global','content',$2,'body','private')`,
  [caseId, input.resourceId]);
  await client.query(`INSERT INTO access.moderation_decision
    (id,kind,outcome,context,case_id,case_sequence,principal_id,acting_subject,authority_kind,authority_scope_id,
    authority_epoch,authority_proof_digest,idempotency_key,request_digest,rule_ref,rule_revision,rule_digest,
    evidence_digest,disclosure,statement_of_reasons)
    VALUES ($1::uuid,'content_moderation','restrict','urn:rezics:context:global',$2,1,$3,$4,'platform','governance:platform',
    0,$5,$1::text,$5,'urn:rezics:rule:fixture-disclosure','1',$5,$5,'private',$6::jsonb)`,
  [decisionId, caseId, input.principalId, input.actingSubject, digest, {
    facts: 'The exact Content body is withheld.', scope: 'This exact Content revision.',
    duration: 'Until attributable restoration.', automation: false,
    appealRoute: '/v1/public-reports/{caseId}/correspondence', contentLanguage: 'en',
    rule: { ref: 'urn:rezics:rule:fixture-disclosure', revision: '1', digest },
  }]);
  await client.query(`INSERT INTO access.moderation_decision_target
    (decision_id,ordinal,owner,resource,component,scope_kind,revision,expected_head,effect)
    VALUES ($1,1,'content',$2,'body','exact_revision',$3,$3,$4)`,
  [decisionId, input.resourceId, input.revisionId, input.effect]);
  await client.query(`INSERT INTO access.governance_enforcement
    (id,authority_scope_id,context,owner,resource,component,revision,effect,decision_id,decision_ordinal,state,fence_epoch)
    VALUES ($1,'governance:platform','urn:rezics:context:global','content',$2,'body',$3,$4,$5,1,'restricted',1)`,
  [randomUUID(), input.resourceId, input.revisionId, input.effect, decisionId]);
  await client.query('UPDATE access.governance_case SET decision_head=$2,generation=1 WHERE id=$1', [caseId, decisionId]);
}
