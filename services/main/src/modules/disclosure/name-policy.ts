import type { PersonPreferencesStore } from '../preferences/store.ts';
import type { Viewer } from '../suitability/policy.ts';
import type { DisclosureChannel } from './read.ts';
import { namePolicyPrincipal } from './viewer.ts';

export type NamePolicyDecision = 'visible' | 'withheld';
export const NAME_POLICY_COST = {
  owners: 64,
  preferenceStatements: 1,
  complexity: 'O(distinct requested owners); one indexed preference probe per owner; no dependents',
} as const;
const native = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;

export const namePolicyViewerPrincipal = (viewer: Viewer, channel: DisclosureChannel) =>
  ['search', 'typeahead', 'count', 'sitemap', 'seo', 'preview'].includes(channel)
    ? null
    : namePolicyPrincipal(viewer);

/** The name's owner is independent of the resource carrying the occurrence.
 * Public inventories always use public policy, even for an authenticated reader.
 * Unknown owners, malformed results and unavailable policy all withhold names.
 * Each call rechecks current Access; no decision survives a preference change. */
export async function checkNamePolicy(
  preferences: Pick<PersonPreferencesStore, 'visibleNameOwners'>,
  owners: readonly string[],
  viewer: Viewer,
  channel: DisclosureChannel = 'read',
): Promise<NamePolicyDecision[]> {
  if (owners.length > NAME_POLICY_COST.owners)
    throw new RangeError('Name policy batch exceeds its bound');
  const distinct = [...new Set(owners.filter((owner) => native.test(owner)))];
  if (!distinct.length) return owners.map(() => 'withheld');
  const principal = namePolicyViewerPrincipal(viewer, channel);
  try {
    const visible = await preferences.visibleNameOwners(distinct, principal);
    return owners.map((owner) => (visible.has(owner) ? 'visible' : 'withheld'));
  } catch {
    return owners.map(() => 'withheld');
  }
}

/** One preference read for each block of at most 64 distinct owners. A page
 * inside that bound is one read. A missing store withholds every name;
 * callers do not keep a second copy of the decision. */
export async function visibleNames(
  preferences: Pick<PersonPreferencesStore, 'visibleNameOwners'> | undefined,
  owners: readonly string[],
  viewer: Viewer,
  channel: DisclosureChannel = 'read',
): Promise<Set<string>> {
  const visible = new Set<string>();
  if (!preferences || !owners.length) return visible;
  const distinct = [...new Set(owners)];
  for (let offset = 0; offset < distinct.length; offset += NAME_POLICY_COST.owners) {
    const batch = distinct.slice(offset, offset + NAME_POLICY_COST.owners);
    const decisions = await checkNamePolicy(preferences, batch, viewer, channel);
    batch.forEach((owner, index) => {
      if (decisions[index] === 'visible') visible.add(owner);
    });
  }
  return visible;
}
