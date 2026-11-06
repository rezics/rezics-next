import { memoizedValue } from '../memoized.ts';
import { t } from 'elysia';

/** Retained contributions disclose a current identity, a deletion label, or no available identity. */
export type LiveContributionAttribution = {
  readonly id: string;
  readonly kind: 'actor' | 'organization';
  readonly displayName: string | null;
};
export type DeletedContributionAttribution = {
  readonly displayName: 'Deleted account' | 'Deleted organization';
};
/** Null is unavailable/absent attribution. It never attests account deletion. */
export type ContributionAttribution = LiveContributionAttribution | DeletedContributionAttribution | null;

const closed = { additionalProperties: false } as const;

export function ContributionAttributionSchema() {
  return memoizedValue(ContributionAttributionSchema, () =>
    t.Union([
      t.Object(
        {
          id: t.String({ format: 'uuid' }),
          kind: t.Union([t.Literal('actor'), t.Literal('organization')]),
          displayName: t.Union([t.String(), t.Null()]),
        },
        closed,
      ),
      t.Object({ displayName: t.Union([t.Literal('Deleted account'), t.Literal('Deleted organization')]) }, closed),
      t.Null(),
    ]),
  );
}

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
