import type { PoolClient } from 'pg';
import { captureDisclosure, fenceDisclosure, resolveDisclosureSelections, DISCLOSURE_COST,
  DisclosureUnavailable, type DisclosureChannel, type DisclosureDecision,
  type DisclosureReadCut, type DisclosureTarget } from '../disclosure/read.ts';
import type { Viewer } from '../suitability/policy.ts';
import type { WorkActivationEnvironment } from '../work/activate.ts';

export interface HomeDisclosureEntry {
  resource: string;
  zone: string;
  targets: readonly DisclosureTarget[];
  /** Optional trailing assets can fall back without suppressing the document. */
  optionalTargets?: number;
}

/** Capture before hydration; call the returned fence as the last awaited step.
 * Capture Zone/Realm authority alongside the owner cuts. Final authority is
 * reread after ancestry and policy, so those awaits cannot outlive a grant. */
export async function captureHomeDisclosureFence(env: WorkActivationEnvironment,
  entries: readonly HomeDisclosureEntry[], viewer: Viewer, channel: DisclosureChannel,
  readZones: () => Promise<ReadonlySet<string>>, client?: PoolClient,
  cost?: { graphQueries: number; accessQueries: number }): Promise<() => Promise<ReadonlySet<string>>> {
  if (entries.length > 256 || entries.some(entry => !entry.targets.length || entry.targets.length > 33
    || !Number.isInteger(entry.optionalTargets ?? 0) || (entry.optionalTargets ?? 0) < 0
    || (entry.optionalTargets ?? 0) >= entry.targets.length)
    || entries.reduce((count, entry) => count + entry.targets.length, 0) > 256 * 33
    || new Set(entries.map(entry => entry.resource)).size !== entries.length) {
    throw new DisclosureUnavailable('Home disclosure batch is invalid');
  }
  const capturedZones = new Set(await readZones());
  const targets = entries.flatMap(entry => entry.targets);
  const batches: (readonly DisclosureReadCut[])[] = [];
  const noteCut = (cuts: readonly DisclosureReadCut[]) => {
    if (!cost || !cuts.length) return;
    cost.accessQueries += DISCLOSURE_COST.ownerStatements;
    const heads = new Set(cuts.flatMap(({ selection }) => [
      ...selection.ancestry.parents.map(parent => parent.resource),
      ...(selection.ancestry.resourceKind !== 'other' || selection.target.owner === 'graph'
        && selection.ancestry.relationshipBasis.owner === 'graph'
        && selection.ancestry.relationshipBasis.kind === 'identity'
        && selection.ancestry.relationshipBasis.resource === selection.target.resource ? [selection.target.resource] : []),
    ]));
    cost.graphQueries += Math.ceil(heads.size / DISCLOSURE_COST.parentHeadBatch);
  };
  for (let offset = 0; offset < targets.length; offset += DISCLOSURE_COST.batch) {
    const selections = await resolveDisclosureSelections(env, targets.slice(offset, offset + DISCLOSURE_COST.batch));
    const cuts = await captureDisclosure(env, selections, viewer, channel, client);
    batches.push(cuts);
    noteCut(cuts);
  }
  return async () => {
    const decisions: DisclosureDecision[] = [];
    for (const cuts of batches) {
      decisions.push(...await fenceDisclosure(env, cuts, viewer, channel, client));
      noteCut(cuts);
    }
    const zones = await readZones();
    if (decisions.length !== targets.length) throw new DisclosureUnavailable('Disclosure final fence is incomplete');
    const readable = new Set<string>();
    let ordinal = 0;
    for (const entry of entries) {
      const required = entry.targets.length - (entry.optionalTargets ?? 0);
      if (capturedZones.has(entry.zone) && zones.has(entry.zone) && decisions.slice(ordinal, ordinal + required).every(value => value === 'visible')) {
        readable.add(entry.resource);
        for (let index = required; index < entry.targets.length; index++) {
          if (decisions[ordinal + index] === 'visible') readable.add(entry.targets[index]!.resource);
        }
      }
      ordinal += entry.targets.length;
    }
    return readable;
  };
}
