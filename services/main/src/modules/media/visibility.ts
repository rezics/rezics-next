import type { VerifiedPrincipal } from '../access/admission.ts';
import type { MainWorkDependencies } from '../../routes/dependencies.ts';
import type { DisclosureTarget } from '../disclosure/read.ts';
import type { Viewer } from '../suitability/policy.ts';
import type { WorkActivationEnvironment } from '../work/activate.ts';
import { readResourceSummaries, type SummaryReader } from './summary.ts';
import { DEFAULT_MEDIA_CONTEXT, MediaUnavailable } from './store.ts';

// These proofs come from Account verification, never from serialized viewer preferences.
const audiences = new WeakMap<Viewer, { principal: VerifiedPrincipal; actor?: string }>();
export function bindMediaAudience(
  viewer: Viewer,
  principal: VerifiedPrincipal,
  actor?: string,
): Viewer {
  audiences.set(viewer, { principal, actor });
  return viewer;
}
type Gate = (targets: readonly DisclosureTarget[], viewer: Viewer) => Promise<boolean[]>;
// An enumerable symbol survives composed environments with a wrapped graph client.
const gateOwner = Symbol('mediaVisibility');
type MediaEnvironment = WorkActivationEnvironment & { [gateOwner]?: Gate };

/** Every media disclosure, including bare representations and exports, resolves
 * the asset's current attachments. A public occurrence cannot widen a draft's audience. */
export function configureMediaVisibility(deps: MainWorkDependencies): void {
  if (!deps.media) return;
  const store = deps.media.store;
  (deps.environment as MediaEnvironment)[gateOwner] = async (targets, viewer) => {
    const references = [
      ...new Set(
        targets.filter((target) => target.owner === 'media').map((target) => target.resource),
      ),
    ];
    if (!references.length) return targets.map(() => true);
    const facts = new Map<string, MediaVisibilityFact>();
    for (let offset = 0; offset < references.length; offset += 64)
      for (const [reference, fact] of await store.visibilityFacts(
        references.slice(offset, offset + 64),
      ))
        facts.set(reference, fact);
    const audience = audiences.get(viewer);
    const principal = audience?.principal,
      actor = audience?.actor;
    const canManage = !!(
      [...facts.values()].some((fact) => fact.pending || fact.disclosure !== 'public') &&
      principal &&
      actor &&
      ((await deps.access.canManageMedia?.(principal, actor)) ||
        (await deps.access.canReadAsBaselineMember?.(principal, actor)))
    );
    const reader: SummaryReader = {
      viewer,
      canReadWorks:
        principal && actor && deps.mediaAccess
          ? (resources) => deps.mediaAccess!.canReadWorks(principal, actor, resources)
          : undefined,
      canReadWork:
        principal && actor
          ? (resource) => deps.access.canReadWork(principal, actor, resource)
          : undefined,
      realmReadProof:
        principal && actor
          ? async (realm) => (await deps.access.realmReadProof?.(principal, actor, realm)) ?? null
          : undefined,
      canReadSemantic:
        principal && actor && deps.access.canReadSemanticResource
          ? (resource) =>
              deps.access.canReadSemanticResource!(
                principal,
                actor,
                resource,
                undefined,
                deps.environment.fuseki,
              )
          : undefined,
      canReadSemantics: deps.mediaAccess
        ? (resources) =>
            deps.mediaAccess!.canReadSemantics(
              principal ?? null,
              actor ?? null,
              resources,
              deps.environment.fuseki,
            )
        : undefined,
      canReadPrivateContexts:
        principal && actor && deps.mediaAccess
          ? (contexts) => deps.mediaAccess!.canReadPrivateContexts(principal, actor, contexts)
          : undefined,
      canReadPrivateContext:
        principal && actor && deps.contextSelections
          ? (context) => deps.contextSelections!.canReadPrivate(principal, actor, context)
          : undefined,
    };
    const byContext = new Map<string, Set<string>>();
    for (const fact of facts.values())
      for (const attachment of fact.attachments) {
        const resources = byContext.get(attachment.context) ?? new Set<string>();
        resources.add(attachment.target);
        byContext.set(attachment.context, resources);
      }
    const readable = new Set<string>();
    for (const [context, resources] of byContext) {
      const references = [...resources];
      for (let offset = 0; offset < references.length; offset += 64) {
        const result = await readResourceSummaries(deps.environment, undefined, reader, {
          resources: references.slice(offset, offset + 64),
          context,
          language: null,
          channel: 'media',
        });
        for (const summary of result.summaries)
          if (summary.status === 'available') readable.add(`${context}\0${summary.reference}`);
      }
    }
    return targets.map((target) => {
      if (target.owner !== 'media') return true;
      const fact = facts.get(target.resource);
      // A media target may name a Work for governance rather than an Asset or Use.
      if (!fact) return true;
      if (fact.blocked) return false;
      if ((fact.disclosure !== 'public' || fact.pending) && !(canManage && actor === fact.owner))
        return false;
      return fact.attachments.every((attachment) =>
        readable.has(`${attachment.context}\0${attachment.target}`),
      );
    });
  };
}

export async function mediaVisibility(
  env: WorkActivationEnvironment,
  targets: readonly DisclosureTarget[],
  viewer: Viewer,
) {
  const gate = (env as MediaEnvironment)[gateOwner];
  if (!gate) return targets.map(() => true);
  try {
    return await gate(targets, viewer);
  } catch (cause) {
    throw new MediaUnavailable('Media visibility owner is unavailable', { cause });
  }
}

export interface MediaVisibilityFact {
  owner: string;
  disclosure: string;
  pending: boolean;
  blocked: boolean;
  attachments: { target: string; context: string }[];
}
export const MEDIA_VISIBILITY_COST = {
  batch: 64,
  ownerStatements: 1,
  attachmentComplexity:
    'O(requested Asset/Use probes + those assets retained Uses and matching jobs); current target policy pages of 64',
  defaultContext: DEFAULT_MEDIA_CONTEXT,
} as const;
