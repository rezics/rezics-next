import * as v from 'valibot';
const id = v.pipe(v.string(), v.uuid());
const advice = v.picklist(['allowed', 'disabled', 'unavailable', 'sign-in']);
export const spaceEntryPresentation = v.strictObject({
  identity: v.strictObject({
    kind: v.picklist(['space', 'realm']),
    id,
    name: v.pipe(v.string(), v.minLength(1), v.maxLength(1024)),
  }),
  avatar: v.variant('state', [
    v.strictObject({
      state: v.literal('available'),
      mediaId: id,
      realmId: id,
      format: v.picklist(['avif', 'webp']),
      width: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(2560)),
    }),
    v.strictObject({ state: v.picklist(['none', 'withheld', 'unavailable']) }),
  ]),
});
const follow = v.variant('state', [
  v.strictObject({ state: v.literal('current'), following: v.boolean(), action: advice }),
  v.strictObject({ state: v.picklist(['sign-in', 'unavailable']) }),
]);
export const spaceEntryRow = v.strictObject({
  id,
  entry: advice,
  admission: advice,
  follow,
  destination: v.variant('kind', [
    v.strictObject({
      kind: v.literal('space'),
      spaceId: id,
      address: v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
    }),
    v.strictObject({ kind: v.literal('realm'), realmId: id }),
    v.strictObject({ kind: v.literal('unavailable') }),
  ]),
});
export const spaceEntryPage = v.strictObject({
  reader: v.nullable(id),
  rows: v.pipe(v.array(spaceEntryRow), v.maxLength(100)),
});
export type SpaceEntryRow = v.InferOutput<typeof spaceEntryRow>;
export type SpaceEntryPresentation = v.InferOutput<typeof spaceEntryPresentation>;
