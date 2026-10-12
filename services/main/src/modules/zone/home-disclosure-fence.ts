import type { PoolClient } from 'pg';
import * as disclosure from '../disclosure/read.ts';
import { DisclosureUnavailable, type DisclosureChannel, type DisclosureDecision,
  type DisclosureTarget } from '../disclosure/read.ts';
import type { Viewer } from '../suitability/policy.ts';
import type { WorkActivationEnvironment } from '../work/activate.ts';

export interface HomeDisclosureEntry {
  resource: string;
  zone: string;
  targets: readonly DisclosureTarget[];
}

// This adapter uses the disclosure owner's published cut contract. The
// compatibility type lets it be staged before that owner lands; absent APIs
// refuse the read, rather than constructing an adapter-owned policy snapshot.
interface DisclosureCutOwner {
  resolveDisclosureSelections(env: WorkActivationEnvironment, targets: readonly DisclosureTarget[]): Promise<readonly unknown[]>;
  captureDisclosure(env: WorkActivationEnvironment, selections: readonly unknown[], viewer: Viewer,
    channel: DisclosureChannel, client?: PoolClient): Promise<readonly unknown[]>;
  fenceDisclosure(env: WorkActivationEnvironment, cuts: readonly unknown[], viewer: Viewer,
    channel: DisclosureChannel, client?: PoolClient): Promise<DisclosureDecision[]>;
}

/** Capture before hydration; call the returned fence as the last awaited step.
 * Zone authority is read afresh, while disclosure revalidates the original
 * owner-issued cuts in a fresh Access statement snapshot. */
export async function captureHomeDisclosureFence(env: WorkActivationEnvironment,
  entries: readonly HomeDisclosureEntry[], viewer: Viewer, channel: DisclosureChannel,
  client?: PoolClient): Promise<(readZones: () => Promise<ReadonlySet<string>>) => Promise<ReadonlySet<string>>> {
  if (entries.length > 256 || entries.some(entry => !entry.targets.length || entry.targets.length > 2)
    || new Set(entries.map(entry => entry.resource)).size !== entries.length) {
    throw new DisclosureUnavailable('Home disclosure batch is invalid');
  }
  const owner = disclosure as unknown as Partial<DisclosureCutOwner>;
  if (!owner.resolveDisclosureSelections || !owner.captureDisclosure || !owner.fenceDisclosure) {
    throw new DisclosureUnavailable('Disclosure final fence is unavailable');
  }
  const targets = entries.flatMap(entry => entry.targets);
  const batches: (readonly unknown[])[] = [];
  for (let offset = 0; offset < targets.length; offset += 64) {
    const selections = await owner.resolveDisclosureSelections(env, targets.slice(offset, offset + 64));
    batches.push(await owner.captureDisclosure(env, selections, viewer, channel, client));
  }
  return async readZones => {
    const zones = await readZones();
    const decisions: DisclosureDecision[] = [];
    for (const cuts of batches) decisions.push(...await owner.fenceDisclosure!(env, cuts, viewer, channel, client));
    if (decisions.length !== targets.length) throw new DisclosureUnavailable('Disclosure final fence is incomplete');
    const readable = new Set<string>();
    let ordinal = 0;
    for (const entry of entries) {
      if (zones.has(entry.zone) && decisions.slice(ordinal, ordinal + entry.targets.length).every(value => value === 'visible')) {
        readable.add(entry.resource);
      }
      ordinal += entry.targets.length;
    }
    return readable;
  };
}
