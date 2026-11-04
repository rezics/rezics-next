import * as v from 'valibot';
const id = v.pipe(v.string(), v.minLength(1));
export const collectionCurator = v.variant('state', [
  v.strictObject({
    state: v.literal('available'),
    id,
    label: v.nullable(v.pipe(v.string(), v.maxLength(160))),
    destination: v.nullable(v.string()),
  }),
  v.strictObject({
    state: v.literal('unavailable'),
    reason: v.picklist(['deidentified', 'withheld', 'native_projection']),
  }),
]);
export const collectionPreview = v.variant('state', [
  v.strictObject({
    state: v.literal('available'),
    members: v.pipe(
      v.array(
        v.strictObject({
          id,
          subject: v.strictObject({
            id,
            type: v.pipe(v.string(), v.maxLength(256)),
            types: v.pipe(v.array(v.pipe(v.string(), v.maxLength(256))), v.maxLength(32)),
            label: v.nullable(v.strictObject({ value: v.pipe(v.string(), v.maxLength(160)), language: v.string() })),
          }),
        }),
      ),
      v.minLength(1),
      v.maxLength(3),
    ),
    partial: v.boolean(),
    truncated: v.boolean(),
  }),
  v.strictObject({ state: v.literal('empty') }),
  v.strictObject({ state: v.literal('withheld') }),
  v.strictObject({ state: v.literal('unavailable') }),
]);
export const collectionFollows = v.variant('state', [
  v.strictObject({ state: v.literal('signed-out') }),
  v.strictObject({ state: v.literal('unavailable'), reason: v.picklist(['identity', 'scope', 'changed', 'native']) }),
  v.strictObject({
    state: v.literal('current'),
    accountId: id,
    partition: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(4095)),
    rows: v.pipe(
      v.array(
        v.strictObject({
          targetId: id,
          targetType: v.picklist(['collection', 'space']),
          source: v.pipe(v.string(), v.maxLength(1024)),
          following: v.boolean(),
          actions: v.strictObject({ follow: v.boolean(), unfollow: v.boolean() }),
        }),
      ),
      v.maxLength(100),
    ),
  }),
]);
export function collectionFollowSource(
  card: { id: string; revision: number; sourceGeneration: string } & (
    | { membershipKind: 'curated'; orderEpoch: number }
    | { membershipKind: 'dynamic'; outputGeneration: string }
  ),
): string {
  return JSON.stringify([
    card.id,
    card.sourceGeneration,
    card.revision,
    card.membershipKind,
    card.membershipKind === 'curated' ? card.orderEpoch : card.outputGeneration,
  ]);
}
