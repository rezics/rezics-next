import { realmMemberProof } from '../realm-reply/member-policy.ts';
import type { PoolClient } from 'pg';
import type { FusekiClient } from '../../infrastructure/fuseki.ts';
import { GRAPHS, iri } from '../work/activate.ts';
import { publicWork, unerased } from '../work/public-patterns.ts';
import { globalContextPattern } from '../rating/global.ts';
import type { AdmissionRequest } from './admission.ts';
import { maintainerControllerProof, maintainerGeneration } from '../work/maintainer-proof.ts';
import { publicReplyRoot } from '../realm-reply/root.ts';

export const BASELINE_MEMBER_POLICY = 'baseline-member-v1';
const native = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;

// The completed Person provision and live control mandate form the role
// binding. Recording one pinned proof per admission keeps storage proportional
// to writes; materializing a grant for every Person/target pair would require
// corpus-sized fan-out and revocation cleanup. Account state is checked again
// at claim, while the existing principal/scope/recovery fences remain in force.
// Graph response bounds below are logical ceilings; native Jena plan costs
// are not qualified by the PostgreSQL lookup-plan regression.

export interface BaselineProof {
  policy_generation: string;
  provision_id: string;
  representation_id: string;
  representation_generation: string;
  subject_generation: string;
  principal_epoch: string;
  collection_create: boolean;
  related_work: string | null;
  source_revision: string | null;
  maintainer_generation: string | null;
  realm_membership?: string | null;
}

export type BaselineTarget = { kind: 'root' }
  | { kind: 'work' | 'collection' | 'contribution' | 'rating' | 'personal' | 'comment'
    | 'maintainer' | 'reply' | 'reply-draft' | 'realm-reply'; id: string };

/** Closed permission vocabulary. In particular, a public Realm does not gain
 * a baseline policy, and translation authorization is not translation proposal. */
export function baselineTarget(action: string, scope: string): BaselineTarget | null {
  if ((action === 'work.create' && scope === 'work:create:root')
    || (action === 'space.create' && scope === 'space:create:root')) return { kind: 'root' };
  const prefixes: Record<string, { prefix: string; kind: Exclude<BaselineTarget['kind'], 'root'> }> = {
    'contribution.create': { prefix: 'contribution:create:', kind: 'work' },
    'translation.link': { prefix: 'translation:link:', kind: 'work' },
    'content.comment': { prefix: 'content:comment:', kind: 'comment' },
    'publication.select': { prefix: 'publication:select:', kind: 'maintainer' },
    'reply.place': { prefix: 'reply:place:', kind: 'realm-reply' },
    'reply.create': { prefix: 'reply:create:', kind: 'reply' },
    'content.draft': { prefix: 'content:draft:', kind: 'reply-draft' },
    'collection.edit': { prefix: 'collection:edit:', kind: 'collection' },
    'contribution.edit': { prefix: 'contribution:edit:', kind: 'contribution' },
    'contribution.publish': { prefix: 'contribution:publish:', kind: 'contribution' },
    'rating.observation.set': { prefix: 'rating:observe:', kind: 'rating' },
    'statement.record': { prefix: 'statement:speak:', kind: 'personal' },
    'statement.withdraw': { prefix: 'statement:speak:', kind: 'personal' },
  };
  const definition = Object.hasOwn(prefixes, action) ? prefixes[action] : null;
  if (!definition || !scope.startsWith(definition.prefix)) return null;
  const id = scope.slice(definition.prefix.length);
  return native.test(id) ? { kind: definition.kind, id } : null;
}

/** The exact provision key and its original control mandate are the binding.
 * Merely representing somebody else's Agent cannot acquire their baseline.
 * Cost: five indexed single-row reads, independent of all other accounts. */
export async function baselineMemberProof(client: PoolClient, principalId: string,
  actingSubject: string): Promise<BaselineProof | null> {
  const result = await client.query<BaselineProof>(`SELECT b.generation AS policy_generation,
      a.id AS provision_id, r.id AS representation_id, r.generation AS representation_generation,
      s.generation AS subject_generation, p.enforcement_epoch AS principal_epoch,
      false AS collection_create, NULL::text AS related_work, NULL::text AS source_revision,
      NULL::text AS maintainer_generation
    FROM access.agent_provision a
    JOIN access.principal p ON p.id = a.principal_id
    JOIN access.representation r ON r.id = a.representation_id
    JOIN access.authority_subject s ON s.id = a.agent_id
    JOIN access.baseline_member_policy b ON b.id = $3
    WHERE a.agent_id = $2 AND a.principal_id = $1 AND a.agent_kind = 'person' AND a.state = 'active'
      AND p.active AND b.active AND s.active AND s.kind = 'agent'
      AND r.principal_id = p.id AND r.subject_id = s.id AND r.action = 'agent.control'
      AND r.active AND r.valid_until > clock_timestamp()
    FOR SHARE OF p, r, s, b`, [principalId, actingSubject, BASELINE_MEMBER_POLICY]);
  return result.rows[0] ?? null;
}

/** Each target read is bounded to one ASK, plus at most two Work creation
 * receipts and one indexed admission lookup for a member's unpublished Work.
 * Nothing enumerates a member's Works, Collections, history or peer accounts. */
export async function baselineTargetAllowed(client: PoolClient, graph: Pick<FusekiClient, 'query'> | undefined,
  principalId: string, actingSubject: string, target: BaselineTarget,
  collectionCreate: boolean, relatedWork: string | null = null,
  sourceRevision: string | null = null): Promise<boolean> {
  if (target.kind === 'root') return true;
  if (target.kind === 'personal') return target.id === actingSubject;
  if (!graph) return false;
  if (target.kind === 'realm-reply') {
    if (!await realmMemberProof(client, target.id, principalId, actingSubject)) return false;
    return (await graph.query(`PREFIX rv: <https://rezics.com/vocab/> ASK {
      GRAPH ${iri(GRAPHS.current)} { ${iri(target.id)} a rv:Realm ; rv:realmState rv:Active ;
        rv:space ?space . ?space rv:realmCapability ${iri(target.id)} ; rv:disclosure rv:Public }
    }`, 1024)).boolean === true;
  }
  if (target.kind === 'maintainer') {
    if (!relatedWork || !native.test(relatedWork)
      || await maintainerGeneration(client, target.id, relatedWork, actingSubject) === null) return false;
    return (await graph.query(`PREFIX rv: <https://rezics.com/vocab/>
      PREFIX schema: <https://schema.org/> ASK { GRAPH ${iri(GRAPHS.current)} {
        ${iri(relatedWork)} a schema:CreativeWork ; rv:mainVersion ${iri(target.id)} .
        ${iri(target.id)} a rv:MainVersion ; rv:work ${iri(relatedWork)} }
        ${unerased(iri(relatedWork))} }`, 1024)).boolean === true;
  }
  if (target.kind === 'reply' || target.kind === 'reply-draft') {
    const work = target.kind === 'reply' ? target.id : relatedWork;
    return !!work && !!sourceRevision && await publicReplyRoot(graph, work, sourceRevision);
  }
  if (relatedWork && (!native.test(relatedWork)
    || !await baselineTargetAllowed(client, graph, principalId, actingSubject,
      { kind: 'work', id: relatedWork }, false))) return false;
  const resource = iri(target.id);
  const current = iri(GRAPHS.current);
  let pattern: string;
  if (target.kind === 'work') pattern = publicWork(resource, '?baselineMain');
  else if (target.kind === 'comment') {
    if (!sourceRevision || !/^[0-9a-f-]{36}$/.test(sourceRevision)) return false;
    // A public Work does not expose its private Content drafts. Comment only
    // on the exact currently published and publicly eligible revision.
    pattern = `${publicWork(resource, '?baselineMain')}
      GRAPH ${current} { ?variant rv:resource ${resource} ;
        rv:contentPublicationHead ?publication ; rv:publicSearchEligibilityHead ?eligibility }
      GRAPH ${iri(GRAPHS.revisions)} {
        ?publication a rv:ContentPublicationDecision ; rv:resource ${resource} ;
          rv:contentRevision <urn:rezics:content:revision:${sourceRevision}> .
        ?eligibility rv:publicationDecision ?publication ; rv:disclosure rv:Public .
        FILTER NOT EXISTS { <urn:rezics:content:revision:${sourceRevision}> a rv:ErasedRevision }
      }`;
  }
  else if (target.kind === 'rating') pattern = `GRAPH ${current} { ${globalContextPattern(target.id)} }`;
  else if (target.kind === 'contribution') pattern = `GRAPH ${current} {
    ${resource} a rv:TextContribution ; rv:author ${iri(actingSubject)} ; rv:work ?work .
    } ${unerased('?work')}`;
  else pattern = `{ GRAPH ${current} {
      ${resource} a ?kind ; rv:curator ${iri(actingSubject)} ; rv:collectionState rv:Active .
      VALUES ?kind { rv:Collection rv:DynamicCollection }
    } } ${collectionCreate ? `UNION { FILTER NOT EXISTS { GRAPH ${current} { ${resource} ?p ?o } } }` : ''}`;
  const allowed = await graph.query(`PREFIX rv: <https://rezics.com/vocab/>
    PREFIX schema: <https://schema.org/> ASK { ${pattern} }`, 1024);
  if (allowed.boolean === true) return true;
  if (target.kind !== 'work') return false;
  // Creation authority covers an account's own still-unpublished Work. This
  // avoids a circular prerequisite (a contribution is needed to publish it).
  // The graph receipt identifies the Access admission; attribution alone does
  // not establish ownership, and no client-supplied receipt is accepted.
  const receipts = (await graph.query(`PREFIX rv: <https://rezics.com/vocab/>
    PREFIX schema: <https://schema.org/> SELECT ?admission WHERE {
      GRAPH ${current} { ${resource} a schema:CreativeWork ; rv:head ?head }
      ${unerased(resource)}
      GRAPH ${iri(GRAPHS.receipts)} { ?receipt rv:work ${resource} ;
        rv:workRevision ?revision ; rv:admittedScope "work:create:root" ;
        rv:outcome rv:Succeeded ; rv:admissionId ?admission }
    } LIMIT 2`, 2048)).results?.bindings ?? [];
  const id = receipts.length === 1 ? receipts[0]?.admission?.value : null;
  if (!id || !/^[0-9a-f-]{36}$/.test(id)) return false;
  return (await client.query(`SELECT id FROM access.admission WHERE id = $1 AND principal_id = $2
    AND action = 'work.create' AND state = 'sealed' AND graph_outcome = 'succeeded'`, [id, principalId])).rowCount === 1;
}

export async function newBaselineProof(client: PoolClient, graph: Pick<FusekiClient, 'query'> | undefined,
  request: AdmissionRequest, principalId: string): Promise<BaselineProof | null> {
  if (request.principal.emailVerified !== true || request.authorityPath === 'direct-principal') return null;
  const target = baselineTarget(request.action, request.scope);
  if (!target) return null;
  const needsWork = target.kind === 'rating' || request.action === 'translation.link';
  if (needsWork && (!request.baselineRelatedWork || !native.test(request.baselineRelatedWork))) return null;
  if (target.kind === 'comment' && (!request.baselineSourceRevision
    || !/^[0-9a-f-]{36}$/.test(request.baselineSourceRevision))) return null;
  // An installed resource policy owns its stricter decision. Baseline never
  // overrides it, including when that resource happens to be publicly readable.
  if ((await client.query('SELECT id FROM access.policy WHERE scope_id = $1', [request.scope])).rowCount) return null;
  const proof = await (target.kind === 'maintainer' ? maintainerControllerProof : baselineMemberProof)(client, principalId, request.actingSubject);
  if (!proof || !await baselineTargetAllowed(client, graph, principalId, request.actingSubject,
    target, request.baselineCollectionCreate === true, request.baselineRelatedWork ?? null,
    request.baselineSourceRevision ?? null)) return null;
  return { ...proof, realm_membership: target.kind === 'realm-reply'
    ? await realmMemberProof(client, target.id, principalId, request.actingSubject) : null,
    collection_create: request.baselineCollectionCreate === true,
    related_work: request.baselineRelatedWork ?? null, source_revision: request.baselineSourceRevision ?? null,
    maintainer_generation: target.kind === 'maintainer'
      ? await maintainerGeneration(client, target.id, request.baselineRelatedWork!, request.actingSubject) : null };
}

export async function savedBaselineProof(client: PoolClient, admissionId: string): Promise<BaselineProof | null> {
  return (await client.query<BaselineProof>(
    'SELECT * FROM access.baseline_admission WHERE admission_id = $1', [admissionId])).rows[0] ?? null;
}

export async function baselineProofCurrent(client: PoolClient, graph: Pick<FusekiClient, 'query'> | undefined,
  saved: BaselineProof, admission: { principal_id: string; acting_subject: string; scope_id: string;
    action: string }): Promise<boolean> {
  const target = baselineTarget(admission.action, admission.scope_id);
  if (!target) return false;
  if ((await client.query('SELECT id FROM access.policy WHERE scope_id = $1', [admission.scope_id])).rowCount) return false;
  const current = await (target.kind === 'maintainer' ? maintainerControllerProof : baselineMemberProof)(client, admission.principal_id, admission.acting_subject);
  if (!current || current.policy_generation !== saved.policy_generation
    || current.provision_id !== saved.provision_id || current.principal_epoch !== saved.principal_epoch
    || current.representation_id !== saved.representation_id
    || current.representation_generation !== saved.representation_generation
    || current.subject_generation !== saved.subject_generation) return false;
  if (target.kind === 'maintainer' && (!saved.related_work
    || saved.maintainer_generation !== await maintainerGeneration(client, target.id,
      saved.related_work, admission.acting_subject))) return false;
  if (target.kind === 'realm-reply' && (!saved.realm_membership
    || saved.realm_membership !== await realmMemberProof(client, target.id, admission.principal_id,
      admission.acting_subject))) return false;
  return baselineTargetAllowed(client, graph, admission.principal_id, admission.acting_subject,
    target, saved.collection_create, saved.related_work, saved.source_revision);
}

export async function saveBaselineProof(client: PoolClient, admissionId: string, proof: BaselineProof) {
  await client.query(`INSERT INTO access.baseline_admission (admission_id, policy_id, policy_generation,
    provision_id, representation_id, representation_generation, subject_generation, principal_epoch,
    collection_create, related_work, source_revision, maintainer_generation, realm_membership)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`, [admissionId, BASELINE_MEMBER_POLICY,
    proof.policy_generation, proof.provision_id, proof.representation_id, proof.representation_generation,
    proof.subject_generation, proof.principal_epoch, proof.collection_create, proof.related_work,
    proof.source_revision, proof.maintainer_generation, proof.realm_membership ?? null]);
}
