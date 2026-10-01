import { Value } from 'typebox/value';
import { canonicalCandidate } from '../editorial-review/contract.ts';
import { targetRef, targetRevision } from '../target/contract.ts';
import { checkedPlan, InvalidMerge, MERGE_COST, MergeUnavailable, type IdentityHeader,
  type IdentityPlan, type MergeHandler, type MergePreview } from './contract.ts';
import { checkedHandlers } from './handlers.ts';

export interface MergePreflightOwner {
  /** Current, disclosed owner snapshot. Hidden and absent return the same null. */
  read(resource: string): Promise<{ header: IdentityHeader; accountControlled: boolean } | null>;
  redirectOf(resource: string): Promise<string | null>;
}

/** Share the address resolver's depth rule. Exact old revisions remain caller
 * data; following an identity never substitutes the requested revision. */
export async function resolveMergedIdentity(resource: string,
  redirectOf: (resource: string) => string | null | Promise<string | null>,
  maxHops: number = MERGE_COST.redirectHops):
  Promise<{ state: 'identity'; resource: string } | { state: 'merged'; source: string; survivor: string; hops: number }> {
  if (!Value.Check(targetRef, resource)) throw new InvalidMerge('Invalid Resource reference');
  if (!Number.isInteger(maxHops) || maxHops < 0 || maxHops > MERGE_COST.redirectHops) throw new InvalidMerge('Invalid hop budget');
  const source = resource, seen = new Set<string>();
  for (let hops = 0; hops <= maxHops; hops++) {
    if (seen.has(resource)) throw new MergeUnavailable('Identity merge cycle');
    seen.add(resource);
    const next = await redirectOf(resource);
    if (next === null) return hops ? { state: 'merged', source, survivor: resource, hops }
      : { state: 'identity', resource };
    if (!Value.Check(targetRef, next)) throw new MergeUnavailable('Invalid identity merge target');
    resource = next;
  }
  throw new MergeUnavailable('Identity merge exceeds the address hop limit');
}

function checkedHeader(header: IdentityHeader, resource: string): void {
  canonicalCandidate(header, { bytes: MERGE_COST.headerBytes, depth: 32 });
  const strings = (values: Array<{ language: string; value: string }>) => Array.isArray(values)
    && values.length <= MERGE_COST.headerValues && values.every(value => value
      && typeof value.language === 'string' && value.language.length > 0 && value.language.length <= 35
      && typeof value.value === 'string' && value.value.length <= 4000);
  if (header.resource !== resource || !Value.Check(targetRevision, header.revision)
    || typeof header.grain !== 'string' || !header.grain.length || header.grain.length > 512
    || !strings(header.titles) || !Array.isArray(header.creators) || header.creators.length > MERGE_COST.headerValues
    || header.creators.some(creator => !Value.Check(targetRef, creator.resource) || !strings(creator.names))
    || !Array.isArray(header.dates) || header.dates.length > MERGE_COST.headerValues
    || !Array.isArray(header.identifiers) || header.identifiers.length > MERGE_COST.headerValues) {
    throw new MergeUnavailable('Merge header is incomplete or exceeds its bound');
  }
}

export async function previewMerge<Dependencies>(raw: unknown, owner: MergePreflightOwner,
  handlers: readonly MergeHandler<Dependencies>[], dependencies: Dependencies): Promise<MergePreview> {
  const plan = checkedPlan(raw), installed = checkedHandlers(handlers);
  const [source, survivor] = await Promise.all([owner.read(plan.source.resource), owner.read(plan.survivor.resource)]);
  if (!source || !survivor) throw new MergeUnavailable('Resource is unavailable');
  checkedHeader(source.header, plan.source.resource); checkedHeader(survivor.header, plan.survivor.resource);
  if (source.accountControlled || survivor.accountControlled) throw new InvalidMerge('Account-controlled Agents require their recovery authority');
  if (source.header.revision !== plan.source.revision || survivor.header.revision !== plan.survivor.revision) {
    throw new MergeConflictWithHeads(plan, source.header.revision, survivor.header.revision);
  }
  if (source.header.grain !== survivor.header.grain) throw new InvalidMerge('Different grains require an assignment decision');
  if (plan.operation === 'merge') {
    const currentSource = await resolveMergedIdentity(plan.source.resource, resource => owner.redirectOf(resource));
    const currentSurvivor = await resolveMergedIdentity(plan.survivor.resource, resource => owner.redirectOf(resource));
    if (currentSource.state !== 'identity' || currentSurvivor.state !== 'identity') {
      throw new InvalidMerge('A merge names current terminal identities');
    }
  } else {
    const current = await resolveMergedIdentity(plan.source.resource, resource => owner.redirectOf(resource));
    if (current.state !== 'merged' || current.survivor !== plan.survivor.resource || current.hops !== 1) {
      throw new InvalidMerge('Unmerge names the exact direct merge to compensate');
    }
  }
  const owners = await Promise.all(installed.map(handler => handler.preview(plan, dependencies)));
  if (owners.some((count, index) => count.owner !== installed[index]!.owner || !Number.isSafeInteger(count.count)
    || count.count < 0 || typeof count.complete !== 'boolean')) throw new MergeUnavailable('Invalid owner preview count');
  return { source: source.header, survivor: survivor.header, owners };
}

export class MergeConflictWithHeads extends InvalidMerge {
  readonly code = 'stale_base';
  constructor(readonly plan: IdentityPlan, readonly sourceHead: string, readonly survivorHead: string) {
    super('Merge identity heads have moved');
  }
}
