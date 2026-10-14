import type { Viewer } from '../suitability/policy.ts';
import type { WorkActivationEnvironment } from '../work/activate.ts';
import { discloseInventory, type DisclosureChannel } from './read.ts';

/** A retained occurrence's Realm is an additional audience gate. Checking its
 * Work alone can admit an independent original while leaking the closed place.
 * Call again after hydration; these decisions are never cached on a Work. */
export async function discloseRealmOccurrences<T extends { realm: string | null }>(
  env: WorkActivationEnvironment, occurrences: readonly T[], viewer: Viewer, channel: DisclosureChannel,
): Promise<T[]> {
  const realms = [...new Set(occurrences.flatMap(item => item.realm ? [item.realm] : []))];
  const decisions = await discloseInventory(env, realms.map(resource => ({
    owner: 'graph' as const, resource, component: 'record' as const,
  })), viewer, channel);
  const visible = new Set(realms.filter((_, index) => decisions[index] === 'visible'));
  return occurrences.filter(item => !item.realm || visible.has(item.realm));
}
