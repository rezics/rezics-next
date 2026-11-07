import { Type as t } from 'typebox';

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

const attributionSchema = t.Union([
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
]);

export function ContributionAttributionSchema() {
  return attributionSchema;
}
