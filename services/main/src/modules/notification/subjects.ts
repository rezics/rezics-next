import type { ContentCore, ExactReadResult } from '../../../../content/src/core.ts';
import type { AccessAdmissionRegistry, VerifiedPrincipal } from '../access/admission.ts';
import type { NotificationSubjectReader, SubjectResolution } from './dispatcher.ts';
import type { NotificationActorAudience, NotificationAgentReader, NotificationAgentSummary,
  NotificationStore } from './store.ts';
import type { FusekiClient } from '../../infrastructure/fuseki.ts';
import { agentAddress } from '../agent/handle.ts';
import type { AgentVanityHandles } from '../agent/vanity.ts';
import { GRAPHS, RV, iri, type GraphLineage } from '../work/activate.ts';
import { assertGraphAdmissionOpen } from '../work/restore-lineage.ts';
import { publicAgent } from '../profiles/read.ts';
import { avatarImageEligible, DEFAULT_MEDIA_CONTEXT, type MediaStore } from '../media/store.ts';
import { checkNamePolicy, NAME_POLICY_COST, type NamePolicyDecision } from '../disclosure/name-policy.ts';

/** Recipient-specific disclosure decided by the subject's owner at delivery time. */
export type RecipientDisclosure = (principalId: string, revisionIds: readonly string[]) =>
  Promise<ReadonlySet<string>>;

const workReaderBasis = /^content-work-reader-v1:(https:\/\/rezics\.com\/id\/[0-9a-f-]{36})$/;

function contentDisplayFields(read: Extract<ExactReadResult, { status: 'available' }>) {
  const title = typeof read.body.title === 'string' ? read.body.title.slice(0, 200) : '';
  const excerpt = typeof read.body.body === 'string' ? read.body.body.slice(0, 240) : '';
  const language = read.reference.language.kind === 'tag' ? read.reference.language.tag : null;
  return { revision: read.revisionId, digest: read.reference.byteDigest,
    linkTarget: read.reference.resourceId, ...(title ? { title } : {}),
    ...(excerpt ? { excerpt } : {}), ...(language ? { language } : {}) };
}

/** Stable basis format for producer events that disclose a Content Work to one recipient. */
export function contentWorkDisclosureBasis(actingSubject: string): string {
  if (!/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(actingSubject)) {
    throw new Error('invalid Content disclosure subject');
  }
  return `content-work-reader-v1:${actingSubject}`;
}

/**
 * Content revision subjects: one bounded exact read per delivery. An erased
 * revision resolves to erased, a denied one to undisclosed; the delivery never
 * substitutes the current head or a stored copy for the pinned revision.
 */
export function contentSubjectReader(content: Pick<ContentCore, 'readExactBatch'>,
  disclosure: RecipientDisclosure): NotificationSubjectReader {
  return {
    async resolve(input): Promise<SubjectResolution> {
      if (input.owner !== 'content' || !input.revision) return { status: 'unavailable' };
      const revision = input.revision;
      const [read] = await content.readExactBatch([revision], ids => disclosure(input.principalId, ids));
      if (!read) return { status: 'unavailable' };
      if (read.status === 'erased') return { status: 'erased' };
      if (read.status === 'denied') return { status: 'undisclosed' };
      if (read.status !== 'available') return { status: 'unavailable' };
      return { status: 'available', subject: { private: true,
        fields: contentDisplayFields(read) } };
    },
  };
}

/**
 * Production Content adapter: recover the recipient from Access, re-evaluate
 * current Work read authority there, then resolve only the pinned Content
 * revision. Unsupported bases and cross-owner identities fail closed.
 */
export function currentContentSubjectReader(content: Pick<ContentCore,
  'owningResourceForRevision' | 'readExactBatch'>,
  notifications: Pick<NotificationStore, 'readRecipientIdentity'>,
  access: Pick<AccessAdmissionRegistry, 'canReadWork'>): NotificationSubjectReader {
  return {
    async resolve(input): Promise<SubjectResolution> {
      if (input.owner !== 'content' || !input.revision) return { status: 'unavailable' };
      const basis = workReaderBasis.exec(input.disclosureBasis);
      if (!basis) return { status: 'undisclosed' };
      const recipient: VerifiedPrincipal | null = await notifications.readRecipientIdentity(input.principalId);
      if (!recipient) return { status: 'undisclosed' };
      const resource = await content.owningResourceForRevision(input.revision);
      if (!resource) return { status: 'unavailable' };
      const allowed = await access.canReadWork(recipient, basis[1]!, resource);
      const [read] = await content.readExactBatch([input.revision], async ids =>
        allowed ? new Set(ids) : new Set<string>());
      if (!read) return { status: 'unavailable' };
      if (read.status === 'erased') return { status: 'erased' };
      if (read.status === 'denied') return { status: 'undisclosed' };
      if (read.status !== 'available') return { status: 'unavailable' };
      return { status: 'available', subject: { private: true,
        fields: contentDisplayFields(read) } };
    },
  };
}

/** One name-policy statement for the distinct actors of a page or delivery. */
export const NOTIFICATION_ACTOR_NAME_COST = {
  namePolicyStatements: 1,
  owners: NAME_POLICY_COST.owners,
  complexity: 'O(distinct actors); one indexed name-policy probe; no dependents',
} as const;

const namedAgent = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;

/** Keep the actor. A withheld name is absent so the unnamed rendering applies,
 * rather than a substitute that would assert a different identity. */
function disclosedActor(actor: NotificationAgentSummary & { name: string },
  decision: NamePolicyDecision): NotificationAgentSummary {
  if (decision === 'visible') return actor;
  const { name: _omitted, ...rest } = actor;
  return rest;
}

/** Current Agent description. Missing, protected or erased Agents stay anonymous.
 * A profile name is included only when this recipient may see it on this channel,
 * and the decision is read again for every page and delivery. */
export function currentNotificationAgentReader(fuseki: FusekiClient,
  lineage: GraphLineage, media: Pick<MediaStore, 'avatarRows'>,
  handles?: Pick<AgentVanityHandles, 'current'>): NotificationAgentReader {
  const load = async (agent: string): Promise<(NotificationAgentSummary & { name: string }) | null> => {
    if (!namedAgent.test(agent)) return null;
    await assertGraphAdmissionOpen(fuseki, lineage);
    const rows = (await fuseki.query(`PREFIX rv: <${RV}>
      PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
      SELECT ?displayName ?handle ?avatarSelection WHERE { ${publicAgent(iri(agent))}
        OPTIONAL { GRAPH ${iri(GRAPHS.current)} {
          ${iri(agent)} rv:profileAvatarSelection ?avatarSelection } }
      } LIMIT 2`, 8_192))
      .results?.bindings ?? [];
    await assertGraphAdmissionOpen(fuseki, lineage);
    if (rows.length !== 1) return null;
    const name = rows[0]?.displayName?.value;
    if (!name || name.length > 200 || /[\u0000-\u001f\u007f]/.test(name)) return null;
    const handle = await handles?.current(agent) ?? null;
    const selected = rows[0]?.avatarSelection?.value ?? null;
    const avatar = selected ? await media.avatarRows([agent], DEFAULT_MEDIA_CONTEXT).then(result => {
      const row = result.rows.get(agent);
      return row?.selection === selected && avatarImageEligible(row)
        ? `/v1/media/avatars/${selected}` : null;
    }).catch(() => null) : null;
    return { id: agent, name, handle, address: agentAddress(agent, handle), avatar };
  };
  const gate = async (agents: readonly string[], audience?: NotificationActorAudience) => {
    const distinct = [...new Set(agents)];
    const loaded = (await Promise.all(distinct.map(load)))
      .filter((actor): actor is NotificationAgentSummary & { name: string } => actor !== null);
    const visible = new Map<string, NotificationAgentSummary>(loaded.map(actor => [actor.id, actor]));
    if (!audience || !loaded.length) return visible;
    const decisions = await checkNamePolicy(audience.preferences, loaded.map(actor => actor.id),
      audience.viewer, audience.channel);
    loaded.forEach((actor, index) => visible.set(actor.id, disclosedActor(actor, decisions[index]!)));
    return visible;
  };
  const read: NotificationAgentReader = async (agent, audience) =>
    (await gate([agent], audience)).get(agent) ?? null;
  read.readBatch = (agents, audience) => gate(agents, audience);
  return read;
}
