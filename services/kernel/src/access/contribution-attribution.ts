import type { ContributionAttribution, DeletedContributionAttribution } from './contract/index.ts';
export { ContributionAttributionSchema } from './contract/index.ts';
export type {
  ContributionAttribution,
  LiveContributionAttribution,
  DeletedContributionAttribution,
} from './contract/index.ts';

/** Input comes from the owner's current public projection, never a guessed lifecycle state. */
export type ContributionIdentity = {
  readonly id?: string;
  readonly accountId?: string;
  readonly kind?: string;
  readonly state?: string;
  readonly displayName?: string | null;
};

/** Only authoritative deletion can remove the identity in favor of a deletion label.
 * Pending/missing identities and unavailable lookups carry no lifecycle assertion.
 * Suspension remains a live public attribution, as on the account IDs surface.
 */
export function contributionAttribution(identity: ContributionIdentity | null | undefined): ContributionAttribution {
  if (!identity || identity.state === 'pending') return null;
  const kind = identity.kind === 'organization' ? 'organization' : 'actor';
  if (identity.state === 'deleted')
    return { displayName: kind === 'organization' ? 'Deleted organization' : 'Deleted account' };
  const id = identity.id ?? identity.accountId;
  if (!id) return null;
  return { id, kind, displayName: identity.displayName ?? null };
}

/** Observed public identity for Log and Collection views: pending or missing stays unknown. */
export function contributionFromPublicIdentity(
  identity: ContributionIdentity | null | undefined,
): ContributionAttribution {
  if (!identity || identity.state === 'pending') return null;
  return contributionAttribution(identity);
}

/** An absent id alone cannot establish deletion on a partially assembled public view. */
export function contributionDeleted(
  value: Pick<ContributionIdentity, 'id' | 'displayName'> | null | undefined,
): value is DeletedContributionAttribution {
  return (
    value != null &&
    !('id' in value) &&
    (value.displayName === 'Deleted account' || value.displayName === 'Deleted organization')
  );
}
