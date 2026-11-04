import * as v from 'valibot';

const id = v.pipe(v.string(), v.uuid());
const text = (max: number) => v.pipe(v.string(), v.maxLength(max));
export const reviewContextSource = v.strictObject({
  openingRevisionId: id,
  sourceVersion: v.pipe(text(128), v.minLength(1)),
});
const cover = v.strictObject({
  media: id,
  width: v.number(),
  height: v.number(),
  placeholder: v.strictObject({ thumbhash: text(256), color: text(64) }),
  variants: v.pipe(
    v.array(v.strictObject({ format: v.picklist(['avif', 'webp']), width: v.number() })),
    v.maxLength(16),
  ),
  focalPoint: v.nullable(v.strictObject({ x: v.number(), y: v.number() })),
  credit: v.strictObject({
    rightsHolder: text(512),
    via: v.strictObject({ name: text(512), url: text(2048) }),
    license: text(512),
    obligations: v.pipe(v.array(text(256)), v.maxLength(16)),
  }),
});
const subject = v.strictObject({
  id,
  type: text(256),
  types: v.pipe(v.array(text(256)), v.maxLength(16)),
  label: v.nullable(v.strictObject({ value: text(1024), language: text(64) })),
  creativeWork: v.boolean(),
  cover: v.nullable(cover),
});
export const searchReviewContext = v.variant('state', [
  v.strictObject({ state: v.literal('unavailable') }),
  v.strictObject({
    state: v.literal('available'),
    openingPostId: id,
    target: v.variant('state', [
      v.strictObject({ state: v.literal('available'), subject }),
      v.strictObject({ state: v.picklist(['withheld', 'unavailable']) }),
    ]),
    citation: v.variant('state', [
      v.strictObject({
        state: v.literal('available'),
        recorded: v.strictObject({
          questionId: id,
          units: v.pipe(v.number(), v.integer()),
          revision: v.pipe(v.number(), v.integer(), v.minValue(1)),
        }),
        historicalQuestion: v.strictObject({ state: v.literal('unavailable') }),
      }),
      v.strictObject({
        state: v.picklist(['absent', 'unsupported', 'unavailable', 'withdrawn', 'erased', 'withheld']),
      }),
    ]),
    language: v.nullable(text(64)),
    spoiler: v.boolean(),
  }),
]);
export type SearchReviewContext = v.InferOutput<typeof searchReviewContext>;
export function validReviewContextBinding(value: {
  source?: v.InferOutput<typeof reviewContextSource>;
  reviewContext?: SearchReviewContext;
  subject?: { id: string; title?: string | null } | null;
}) {
  const context = value.reviewContext;
  if (!context) return true;
  if (!value.source || new TextEncoder().encode(JSON.stringify(context)).byteLength > 8192) return false;
  if (context.state !== 'available') return !value.subject;
  if (context.target.state !== 'available') return !value.subject && context.citation.state !== 'available';
  return !value.subject || value.subject.id === context.target.subject.id;
}
