import * as v from 'valibot';
const id = v.pipe(v.string(), v.regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/));
export const accountContext = v.strictObject({
  biography: v.variant('state', [
    v.strictObject({
      state: v.literal('available'),
      text: v.pipe(v.string(), v.maxLength(1024)),
      truncated: v.boolean(),
    }),
    v.strictObject({ state: v.literal('absent') }),
    v.strictObject({ state: v.literal('withheld') }),
    v.strictObject({ state: v.literal('unavailable') }),
  ]),
  followTarget: v.variant('state', [
    v.strictObject({ state: v.literal('unavailable') }),
    v.strictObject({
      state: v.literal('available'),
      id,
      label: v.pipe(v.string(), v.maxLength(160)),
      type: v.pipe(v.string(), v.maxLength(256)),
      source: v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/)),
    }),
  ]),
});
