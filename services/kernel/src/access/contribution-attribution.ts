import { memoizedValue } from '../memoized.ts';
import { t } from 'elysia';

/** Public identity tombstones keep `{ id, state, kind }`. Retained contributions do not. */
export type LiveContributionAttribution = {
  readonly id: string;
  readonly displayName: string | null;
};
export type DeletedContributionAttribution = {
  readonly displayName: 'Deleted account' | 'Deleted organization';
};
export type ContributionAttribution = LiveContributionAttribution | DeletedContributionAttribution;

const closed = { additionalProperties: false } as const;

export function ContributionAttributionSchema() {
  return memoizedValue(ContributionAttributionSchema, () =>
    t.Union([
      t.Object({ id: t.String({ format: 'uuid' }), displayName: t.Union([t.String(), t.Null()]) }, closed),
      t.Object(
        { displayName: t.Union([t.Literal('Deleted account'), t.Literal('Deleted organization')]) },
        closed,
      ),
    ]),
  );
}

type Identity = {
  readonly id?: string;
  readonly accountId?: string;
  readonly kind?: string;
  readonly state?: string;
  readonly displayName?: string | null;
};

function organization(identity: Identity | null | undefined): boolean {
  return identity?.kind === 'organization';
}

function deletedLabel(identity: Identity | null | undefined): DeletedContributionAttribution['displayName'] {
  return organization(identity) ? 'Deleted organization' : 'Deleted account';
}

/** Maps a public account or identity to contribution attribution.
 * Missing and deleted owners become a display-name tombstone with no account link.
 */
export function contributionAttribution(identity: Identity | null | undefined): ContributionAttribution {
  if (!identity || identity.state === 'deleted' || identity.state === 'pending')
    return { displayName: deletedLabel(identity) };
  const id = identity.id ?? identity.accountId;
  if (!id) return { displayName: deletedLabel(identity) };
  return { id, displayName: identity.displayName ?? null };
}

export function contributionDeleted(value: ContributionAttribution): value is DeletedContributionAttribution {
  return !('id' in value);
}
