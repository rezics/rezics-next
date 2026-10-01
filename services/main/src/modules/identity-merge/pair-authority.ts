import type { PoolClient } from 'pg';
import type { FusekiClient } from '../../infrastructure/fuseki.ts';
import { baselineMemberProof, baselineTargetAllowed } from '../access/baseline.ts';
import { currentMembershipDependency } from '../access/memberships.ts';
import { representedWorkProof } from '../access/represented-work-proof.ts';
import { publicCatalogueWork, roleWorkProof } from '../access/role-proof.ts';
import { EditorialBlocked, EditorialInvalid, type EditorialTarget, type Proposal } from '../editorial-review/contract.ts';
import { checkedPlan, type IdentityPlan } from './contract.ts';
import { iri } from '../work/activate.ts';
import { publicWork } from '../work/public-patterns.ts';
import { ensureBaselineScopeGate } from '../access/scope-gates.ts';

/** Exactly two immutable candidate pins, never a client-supplied authority list.
 * Cost is independent of reference inventory and review history. */
export function mergeTargets(target: EditorialTarget, raw: unknown): EditorialTarget[] {
  const plan = checkedPlan(raw);
  if (target.resource !== plan.source.resource || target.work !== target.resource) {
    throw new EditorialInvalid('Merge targets its original Work');
  }
  return [plan.source,plan.survivor].map(pin => ({ ...target,resource: pin.resource,work: pin.resource,revision: pin.revision }));
}

export async function proposalTargets(client: PoolClient, proposal: Proposal): Promise<EditorialTarget[]> {
  if (proposal.kind !== 'merge') return [proposal.target];
  const row = (await client.query<{ candidate: string }>(
    'SELECT candidate FROM access.editorial_revision WHERE proposal=$1 AND n=$2',
    [proposal.id,proposal.latestRevision])).rows[0];
  if (!row) throw new EditorialBlocked({ code: 'owner_unavailable' });
  return mergeTargets(proposal.target,JSON.parse(row.candidate) as unknown);
}

/** Publication is Work-owned. A readable private survivor cannot absorb a
 * public identity, even when both owners have delegated editing. Unmerge uses
 * the same pair policy: changing disclosure never revives old authority. */
export async function requireMergeDisclosure(plan: Pick<IdentityPlan,'source'|'survivor'>,
  graph: Pick<FusekiClient,'query'> | undefined): Promise<void> {
  if (!graph) throw new EditorialBlocked({ code: 'owner_unavailable' });
  if ((await graph.query(`PREFIX rv: <https://rezics.com/vocab/> PREFIX schema: <https://schema.org/>
    ASK { ${mergeDisclosureGuard(plan)} }`,1024)).boolean !== true) {
    throw new EditorialInvalid('Merge survivor disclosure must match or exceed the source');
  }
}
/** Reused in the native Jena effect so a publication change after preflight
 * cannot race the redirect. The two EXISTS use the shared public Work policy. */
export const mergeDisclosureGuard = (plan: Pick<IdentityPlan,'source'|'survivor'>) =>
  `FILTER (!EXISTS { ${publicWork(iri(plan.source.resource),'?mergeSourceMain')} }
    || EXISTS { ${publicWork(iri(plan.survivor.resource),'?mergeSurvivorMain')} })`;
export const mergePublicAuthorityGuard = (works: readonly string[]) => [...new Set(works)]
  .map((work,index) => `FILTER EXISTS { ${publicWork(iri(work),`?mergeAuthorityMain${index}`)} }`).join('\n');

/** Revalidate retained participants with Access's ordinary Work proof sources,
 * on the caller's transaction. Their locks live through the native owner effect;
 * no new connection, admission, synthetic grant or transferred authority.
 * Writes also probe ordinary admission using the caller's fresh Account assertion.
 * At most two gates, two grant/role proofs (16 bindings each), and two exact
 * author-receipt probes; no owner inventory or review-history scan. */
export async function requireMergeEdit(client: PoolClient, principal: string, agent: string,
  targets: readonly EditorialTarget[], graph: Pick<FusekiClient,'query'> | undefined): Promise<string[]> {
  const publicWorks: string[] = [];
  for (const target of targets) {
    const scope = `work:edit:${target.resource}`;
    const gate = (await client.query<{ open: boolean; dispatch_open: boolean }>(
      'SELECT open,dispatch_open FROM access.scope_gate WHERE id=$1',[scope])).rows[0];
    // Ordinary Work scopes may be lazily installed. An existing closed gate
    // always wins; the authoritative write probe derives a missing gate.
    let allowed = !gate || gate.open && gate.dispatch_open;
    if (allowed) {
      const proof = await representedWorkProof(client,principal,agent,'work.edit',scope);
      allowed = false;
      if (proof?.grantId) {
        const grant = (await client.query<{ membership_id: string | null; membership_generation: string | null }>(
          'SELECT membership_id,membership_generation FROM access.permission_grant WHERE id=$1 FOR SHARE',[proof.grantId])).rows[0];
        allowed = !!grant && (!grant.membership_id || await currentMembershipDependency(client,
          { membershipId: grant.membership_id,generation: grant.membership_generation! },agent));
      } else if (proof && await roleWorkProof(client,agent,'work.edit')) {
        allowed = await publicCatalogueWork(graph,target.resource);
        if (allowed) publicWorks.push(target.resource);
      }
      if (!allowed && !(await client.query('SELECT id FROM access.policy WHERE scope_id=$1',[scope])).rowCount
        && await baselineMemberProof(client,principal,agent)) {
        allowed = await baselineTargetAllowed(client,graph,principal,agent,{ kind: 'author-work',id: target.resource },false);
        // canReview requires an explicit edit grant on a private Work. A
        // maintainer relying on public review eligibility must keep it public.
        if (allowed) publicWorks.push(target.resource);
      }
    }
    if (!allowed) throw new EditorialBlocked({ code: 'owner_authority_required',action: 'work.edit',scope });
  }
  return publicWorks;
}

/** Ordinary authority probes use a second Access connection. Hold these gates
 * only at native dispatch, after those probes, to avoid self-deadlocking their
 * ordinary registration lock. Native grants/controllers are locked by the
 * shared current-review check on this same effect transaction. */
export async function lockMergeEditGates(client: PoolClient, plan: Pick<IdentityPlan,'source'|'survivor'>): Promise<void> {
  for (const work of [plan.source.resource,plan.survivor.resource].sort()) {
    const scope = `work:edit:${work}`;
    await ensureBaselineScopeGate(client,scope);
    const gate = (await client.query<{ open: boolean; dispatch_open: boolean }>(
      'SELECT open,dispatch_open FROM access.scope_gate WHERE id=$1 FOR SHARE',[scope])).rows[0];
    if (!gate?.open || !gate.dispatch_open) throw new EditorialBlocked({ code: 'owner_authority_required',action: 'work.edit',scope });
  }
}
