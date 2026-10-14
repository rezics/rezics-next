import { measureStatements } from '../../infrastructure/statement-cost.ts';
import type { VerifiedPrincipal } from '../access/admission.ts';
import type { MainWorkDependencies } from '../../routes/dependencies.ts';
import type { DisclosureTarget } from '../disclosure/read.ts';
import type { Viewer } from '../suitability/policy.ts';
import { GRAPHS, RV, iri, type WorkActivationEnvironment } from '../work/activate.ts';
import { readResourceSummaries, type SummaryReader } from './summary.ts';
import { DEFAULT_MEDIA_CONTEXT, MediaUnavailable } from './store.ts';

// These proofs come from Account verification, never from serialized viewer preferences.
const audiences = new WeakMap<Viewer, { principal: VerifiedPrincipal; actor?: string; nativeAsset?: string }>();
export function bindMediaAudience(
  viewer: Viewer,
  principal: VerifiedPrincipal,
  actor?: string,
): Viewer {
  audiences.set(viewer, { principal, actor });
  return viewer;
}
/** Native owner operations select owner access only after Access binds
 * Account to the acting owner. Disclosure repeats that live owner proof. */
export function bindNativeAssetAudience(viewer: Viewer, asset: string): Viewer {
  const audience = audiences.get(viewer);
  if (audience) audience.nativeAsset = `https://rezics.com/id/${asset}`;
  return viewer;
}
export function isNativeAssetOwner(viewer: Viewer, reference: string, owner: string): boolean {
  const audience = audiences.get(viewer);
  return audience?.nativeAsset === reference && audience.actor === owner;
}
interface MediaVisibilityProbe { reference: string; exactUse: boolean }
type Gate = (targets: readonly DisclosureTarget[], viewer: Viewer,
  probes: readonly MediaVisibilityProbe[]) => Promise<boolean[]>;
// An enumerable symbol survives composed environments with a wrapped graph client.
const gateOwner = Symbol('mediaVisibility');
type MediaEnvironment = WorkActivationEnvironment & { [gateOwner]?: Gate };

/** Exact Uses resolve their own attachment; bare bytes need a readable current
 * attachment and fail closed when their owner inventory exceeds one page. */
export function configureMediaVisibility(deps: MainWorkDependencies): void {
  if (!deps.media) return;
  const store = deps.media.store;
  (deps.environment as MediaEnvironment)[gateOwner] = async (targets, viewer, probes) => {
    if (probes.length !== targets.length) throw new MediaUnavailable('Media visibility probes are incomplete');
    const references = [
      ...new Set(
        targets.flatMap((target, index) => target.owner === 'media' ? [probes[index]!.reference] : []),
      ),
    ];
    if (!references.length) return targets.map(() => true);
    const exactUses = new Set(probes.filter(probe => probe.exactUse).map(probe => probe.reference));
    const facts = new Map<string, MediaVisibilityFact>();
    for (let offset = 0; offset < references.length; offset += 64)
      for (const [reference, fact] of await store.visibilityFacts(
        references.slice(offset, offset + 64),
      ))
        facts.set(reference, fact);
    const audience = audiences.get(viewer);
    const principal = audience?.principal,
      actor = audience?.actor;
    const nativeOwner = (reference: string, fact: MediaVisibilityFact) =>
      isNativeAssetOwner(viewer, reference, fact.owner) && !fact.exactUse;
    const canManage = !!(
      [...facts].some(([reference, fact]) => fact.pending || fact.disclosure !== 'public'
        || nativeOwner(reference, fact)) &&
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
    for (const [reference, fact] of facts) {
      // Owning an Asset is independent of its Uses. Exact Use and bare
      // representation reads never receive this native-download audience.
      if (nativeOwner(reference, fact)) continue;
      // A truncated Asset inventory cannot prove readability. Do not probe it.
      if (fact.attachmentOverflow || exactUses.has(reference) && fact.attachments.length !== 1) continue;
      for (const attachment of fact.attachments) {
        const resources = byContext.get(attachment.context) ?? new Set<string>();
        resources.add(attachment.target);
        byContext.set(attachment.context, resources);
      }
    }
    // Context identity is owner data, not permission. Ask the existing Realm
    // reader for its live disclosure; a public Work cannot grant a private or
    // closed Realm's Use an independent audience.
    const realmContexts = new Set<string>();
    const contexts = [...byContext.keys()].filter(context => context !== DEFAULT_MEDIA_CONTEXT);
    for (let offset = 0; offset < contexts.length; offset += 64) {
      const batch = contexts.slice(offset, offset + 64);
      const rows = (await deps.environment.fuseki.query(`PREFIX rv: <${RV}>
        SELECT ?realm WHERE { VALUES ?realm { ${batch.map(iri).join(' ')} }
          GRAPH ${iri(GRAPHS.current)} { ?realm a rv:Realm } } LIMIT 65`)).results?.bindings ?? [];
      if (rows.length > 64) throw new MediaUnavailable('Realm context identity batch is incomplete');
      for (const row of rows) {
        const realm = row.realm?.value;
        if (!realm || !batch.includes(realm)) throw new MediaUnavailable('Realm context identity is invalid');
        realmContexts.add(realm);
      }
    }
    const readableRealms = new Set<string>();
    const realms = [...realmContexts];
    for (let offset = 0; offset < realms.length; offset += 64) {
      const result = await readResourceSummaries(deps.environment, undefined, reader, {
        resources: realms.slice(offset, offset + 64), context: DEFAULT_MEDIA_CONTEXT,
        language: null, channel: 'media',
      });
      for (const summary of result.summaries)
        if (summary.status === 'available' && summary.type === 'realm') readableRealms.add(summary.reference);
    }
    const readable = new Set<string>();
    for (const [context, resources] of byContext) {
      if (realmContexts.has(context) && !readableRealms.has(context)) continue;
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
    return targets.map((target, index) => {
      if (target.owner !== 'media') return true;
      const probe = probes[index]!;
      const fact = facts.get(probe.reference);
      // A media target may name a Work for governance rather than an Asset or Use.
      if (!fact) return !probe.exactUse;
      // An exact Use must still be attached, including mutable selection slots.
      if ((probe.exactUse || fact.exactUse) && fact.attachments.length !== 1) return false;
      if (fact.blocked) return false;
      if (!probe.exactUse && nativeOwner(probe.reference, fact)) return canManage;
      if (fact.attachmentOverflow) return false;
      if ((fact.disclosure !== 'public' || fact.pending) && !(canManage && actor === fact.owner))
        return false;
      return fact.attachments.length === 0 || fact.attachments.some((attachment) =>
        readable.has(`${attachment.context}\0${attachment.target}`));
    });
  };
}

export async function mediaVisibility(
  env: WorkActivationEnvironment,
  targets: readonly DisclosureTarget[],
  viewer: Viewer,
  probes: readonly MediaVisibilityProbe[] = targets.map(target => ({ reference: target.resource, exactUse: false })),
) {
  const gate = (env as MediaEnvironment)[gateOwner];
  if (!gate) return Object.assign(targets.map(() => true), { cost: { mediaStatements: 0 } });
  try {
    const { result, statements } = await measureStatements(() => gate(targets, viewer, probes));
    return Object.assign(result, { cost: { mediaStatements: statements } });
  } catch (cause) {
    throw new MediaUnavailable('Media visibility owner is unavailable', { cause });
  }
}

export interface MediaVisibilityFact {
  owner: string;
  /** Actual owner lookup distinguished a Use from its Asset inventory. */
  exactUse?: boolean;
  disclosure: string;
  pending: boolean;
  blocked: boolean;
  attachmentOverflow: boolean;
  attachments: { target: string; context: string }[];
}
export const MEDIA_VISIBILITY_COST = {
  batch: 64,
  ownerStatements: 1,
  attachmentComplexity:
    'one exact attachment per Use; at most 64 current attachments per Asset, with overflow unavailable',
  defaultContext: DEFAULT_MEDIA_CONTEXT,
} as const;
