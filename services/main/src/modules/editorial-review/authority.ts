import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { FusekiClient } from '../../infrastructure/fuseki.ts';
import { AdmissionDenied, type VerifiedPrincipal } from '../access/admission.ts';
import { publicCatalogueWork } from '../access/role-proof.ts';
import { mandateFor, requirePrincipal } from '../access/topology-control.ts';
import { currentMembershipDependency } from '../access/memberships.ts';
import { EditorialBlocked, type EditorialTarget, type Proposal, type ProposalReview } from './contract.ts';
import type { CurrentReviewer, Viewer } from './lifecycle.ts';

export const independenceKey = (proposal: string, principal: string) =>
  createHash('sha256').update(`${proposal}\0${principal}`).digest('hex');

export async function editorialPrincipal(client: PoolClient, principal: VerifiedPrincipal): Promise<string> {
  const fresh = principal.currentAssertion ? await principal.currentAssertion() : principal;
  if (fresh.issuer !== principal.issuer || fresh.subject !== principal.subject) throw new AdmissionDenied('Account identity changed');
  return (await requirePrincipal(client, fresh)).id;
}
export async function editorialController(client: PoolClient, principalId: string, agent: string): Promise<void> {
  if (!await mandateFor(client, principalId, agent, 'agent.control')) throw new AdmissionDenied('Current Agent control is required');
}

/** Current maintainer, appointed catalogue reviewer, or exact contextual review
 * grant. All source rows remain locked through the caller's decision commit.
 * Membership and Account/controller revocation are checked again at admission. */
export async function canReview(client: PoolClient, principalId: string, agent: string,
  target: EditorialTarget, graph: Pick<FusekiClient,'query'> | undefined): Promise<boolean> {
  const active = (await client.query(`SELECT p.id FROM access.principal p
    JOIN access.representation r ON r.principal_id = p.id
    JOIN access.authority_subject s ON s.id = r.subject_id
    WHERE p.id = $1 AND p.active AND r.subject_id = $2 AND r.action = 'agent.control'
      AND r.active AND r.valid_until > clock_timestamp() AND s.active AND s.kind = 'agent'
    LIMIT 1 FOR SHARE OF p,r,s`, [principalId, agent])).rowCount;
  if (!active) return false;
  // Catalogue review is not an edit delegation for a private Work. A reader's
  // global role/context grant cannot authorize the owner command there.
  if (target.work && !await publicCatalogueWork(graph,target.work)) {
    const edit = (await client.query<{ membership_id: string | null; membership_generation: string | null }>(`
      SELECT g.membership_id,g.membership_generation FROM access.permission_grant g
      JOIN access.scope_gate gate ON gate.id = g.scope_id
      WHERE g.recipient_subject = $1 AND g.scope_id = $2 AND g.action = 'work.edit'
        AND g.active AND g.valid_until > clock_timestamp() AND gate.open AND gate.dispatch_open
        AND (g.membership_id IS NULL OR EXISTS (SELECT 1 FROM access.membership m
          WHERE m.id = g.membership_id AND m.member_subject = g.recipient_subject
            AND m.state = 'joined' AND m.generation = g.membership_generation))
      ORDER BY g.id LIMIT 1 FOR SHARE OF g`,[agent,`work:edit:${target.work}`])).rows[0];
    // The native owner registration/claim locks the edit gate itself; holding
    // that gate here would deadlock delivery through a second Access connection.
    if (!edit || edit.membership_id && !await currentMembershipDependency(client,
      { membershipId: edit.membership_id,generation: edit.membership_generation! },agent)) return false;
  }
  if (target.work && (await client.query(`SELECT s.work FROM access.work_maintainer_set s
    JOIN access.work_maintainer m ON m.work = s.work WHERE s.work = $1 AND m.agent = $2
    FOR SHARE OF s`, [target.work, agent])).rowCount) return true;
  const scopes = [`editorial:review:${target.context}`, ...(target.work ? [`work:review:${target.work}`] : [])];
  const grant = (await client.query<{ membership_id: string | null; membership_generation: string | null }>(`SELECT g.membership_id,g.membership_generation FROM access.permission_grant g
    JOIN access.scope_gate gate ON gate.id = g.scope_id
    WHERE g.recipient_subject = $1 AND g.scope_id = ANY($2::text[]) AND g.action = 'work.review'
      AND g.active AND g.valid_until > clock_timestamp() AND gate.open AND gate.dispatch_open
      AND (g.membership_id IS NULL OR EXISTS (SELECT 1 FROM access.membership m WHERE m.id = g.membership_id
        AND m.state = 'joined' AND m.generation = g.membership_generation))
    ORDER BY g.id LIMIT 1 FOR SHARE OF g,gate`, [agent, scopes])).rows[0];
  if (grant && (!grant.membership_id || await currentMembershipDependency(client,
    { membershipId: grant.membership_id,generation: grant.membership_generation! },agent))) return true;
  const role = (await client.query<{ membership_id: string | null; membership_generation: string | null }>(`SELECT b.membership_id,b.membership_generation FROM access.role_binding b
    JOIN access.role_revision r ON r.family_id = b.family_id AND r.revision = b.role_revision
    JOIN access.scope_gate gate ON gate.id = 'work:create:root'
    WHERE b.recipient_subject = $1 AND b.active AND b.valid_until > clock_timestamp()
      AND r.permissions @> ARRAY['work.review']::text[] AND gate.open AND gate.dispatch_open
      AND (b.membership_id IS NULL OR EXISTS (SELECT 1 FROM access.membership m WHERE m.id = b.membership_id
        AND m.state = 'joined' AND m.generation = b.membership_generation))
    ORDER BY b.id LIMIT 1 FOR SHARE OF b,gate`, [agent])).rows[0];
  return !!role && (!role.membership_id || await currentMembershipDependency(client,
    { membershipId: role.membership_id,generation: role.membership_generation! },agent));
}
export async function independent(client: PoolClient, proposal: Proposal, principalId: string,
  agent: string): Promise<boolean> {
  if (agent === proposal.proposer || independenceKey(proposal.id, principalId) === proposal.proposerKey) return false;
  return !(await client.query(`SELECT 1 FROM access.editorial_proposal p WHERE p.id = $1
    AND ($2::uuid = ANY(p.proposer_controllers) OR EXISTS (
      SELECT 1 FROM access.representation r WHERE r.subject_id = p.proposer_agent AND r.principal_id = $2
        AND r.action = 'agent.control' AND r.active AND r.valid_until > clock_timestamp()))`,
  [proposal.id, principalId])).rowCount;
}
export async function viewerFor(client: PoolClient, proposal: Proposal, principal: string,
  agent: string, graph: Pick<FusekiClient,'query'> | undefined): Promise<Viewer> {
  const own = independenceKey(proposal.id, principal) === proposal.proposerKey;
  const eligible = await canReview(client, principal, agent, proposal.target,graph);
  const separate = await independent(client, proposal, principal, agent);
  return { agent, principalKey: !own && !separate ? proposal.proposerKey : independenceKey(proposal.id, principal),
    eligibleReviewer: eligible, ownsProposal: own };
}
export async function requireReview(client: PoolClient, proposal: Proposal, principal: string, agent: string,
  graph: Pick<FusekiClient,'query'> | undefined) {
  if (!await independent(client, proposal, principal, agent)) throw new EditorialBlocked({ code: 'self_review' });
  if (!await canReview(client, principal, agent, proposal.target,graph)) {
    throw new EditorialBlocked({ code: 'review_authority_required' });
  }
}

/** Output is at most the required approvals plus one changes-requested stance.
 * The anti-join probes the indexed later stance for that exact operator/revision;
 * comments never supersede a stance. Engine work is scoped to this proposal,
 * not unrelated catalogue history. Positive authority is rechecked under locks. */
export async function reviewBasis(client: PoolClient, proposal: Proposal, required: 1 | 2, graph: Pick<FusekiClient,'query'> | undefined,
  prospective?: { principal: string; review: ProposalReview }): Promise<{ reviews: ProposalReview[]; authority: CurrentReviewer[] }> {
  const publicWork = !proposal.target.work || await publicCatalogueWork(graph,proposal.target.work);
  const available = `r.reviewer <> p.proposer_agent AND r.principal <> ALL(p.proposer_controllers)
    AND NOT EXISTS (SELECT 1 FROM access.representation self WHERE self.subject_id = p.proposer_agent
      AND self.principal_id = r.principal AND self.action = 'agent.control' AND self.active
      AND self.valid_until > clock_timestamp())
    AND EXISTS (SELECT 1 FROM access.principal who JOIN access.representation ctrl ON ctrl.principal_id = who.id
      JOIN access.authority_subject agent ON agent.id = ctrl.subject_id
      WHERE who.id = r.principal AND who.active AND ctrl.subject_id = r.reviewer AND ctrl.action = 'agent.control'
        AND ctrl.active AND ctrl.valid_until > clock_timestamp() AND agent.active AND agent.kind = 'agent')
    AND (EXISTS (SELECT 1 FROM access.work_maintainer m WHERE m.work = p.work AND m.agent = r.reviewer)
      OR EXISTS (SELECT 1 FROM access.permission_grant g JOIN access.scope_gate gate ON gate.id = g.scope_id
        WHERE g.recipient_subject = r.reviewer AND g.action = 'work.review' AND g.active
          AND g.valid_until > clock_timestamp() AND gate.open AND gate.dispatch_open
          AND g.scope_id IN ('editorial:review:' || p.context, 'work:review:' || p.work)
          AND (g.membership_id IS NULL OR EXISTS (SELECT 1 FROM access.membership dep
            WHERE dep.id = g.membership_id AND dep.state = 'joined' AND dep.generation = g.membership_generation)))
      OR EXISTS (SELECT 1 FROM access.role_binding b JOIN access.role_revision role
          ON role.family_id = b.family_id AND role.revision = b.role_revision
        JOIN access.scope_gate gate ON gate.id = 'work:create:root'
        WHERE b.recipient_subject = r.reviewer AND b.active AND b.valid_until > clock_timestamp()
          AND role.permissions @> ARRAY['work.review']::text[] AND gate.open AND gate.dispatch_open
          AND (b.membership_id IS NULL OR EXISTS (SELECT 1 FROM access.membership dep
            WHERE dep.id = b.membership_id AND dep.state = 'joined' AND dep.generation = b.membership_generation))))
    AND ($6::boolean OR EXISTS (SELECT 1 FROM access.permission_grant edit
      JOIN access.scope_gate gate ON gate.id = edit.scope_id
      WHERE edit.recipient_subject = r.reviewer AND edit.scope_id = 'work:edit:' || p.work
        AND edit.action = 'work.edit' AND edit.active AND edit.valid_until > clock_timestamp()
        AND gate.open AND gate.dispatch_open
        AND (edit.membership_id IS NULL OR EXISTS (SELECT 1 FROM access.membership dep
          WHERE dep.id = edit.membership_id AND dep.member_subject = edit.recipient_subject
            AND dep.state = 'joined' AND dep.generation = edit.membership_generation))))`;
  const selection = async (outcome: 'approve' | 'request_changes', limit: number) => client.query<ProposalReview & { principal: string }>(`
    SELECT r.id,r.proposal,r.revision,r.reviewer,r.reviewer_key AS "reviewerKey",r.outcome,r.message,r.sequence::text,r.principal
    FROM access.editorial_review r JOIN access.editorial_proposal p ON p.id = r.proposal
    WHERE r.proposal = $1 AND r.revision = $2 AND r.outcome = $3
      AND ($4::uuid IS NULL OR r.principal <> $4) AND ${available}
      AND NOT EXISTS (SELECT 1 FROM access.editorial_review later WHERE later.proposal = r.proposal
        AND later.revision = r.revision AND later.principal = r.principal
        AND later.outcome <> 'comment' AND later.sequence > r.sequence)
    ORDER BY r.sequence DESC LIMIT $5`, [proposal.id, proposal.latestRevision, outcome, prospective?.principal ?? null, limit,publicWork]);
  const approvals = await selection('approve', required), changes = await selection('request_changes', 1);
  const reviews: ProposalReview[] = [], authority: CurrentReviewer[] = [];
  for (const row of [...approvals.rows, ...changes.rows]) {
    if (!await canReview(client, row.principal, row.reviewer, proposal.target,graph)) continue;
    reviews.push(row); authority.push({ reviewer: row.reviewer, reviewerKey: row.reviewerKey, eligible: true });
  }
  if (prospective) {
    reviews.push(prospective.review);
    authority.push({ reviewer: prospective.review.reviewer, reviewerKey: prospective.review.reviewerKey, eligible: true });
  }
  return { reviews, authority };
}
