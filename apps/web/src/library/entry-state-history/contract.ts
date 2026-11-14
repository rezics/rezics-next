import * as v from 'valibot';

const revision = v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(2_147_483_646));
const incarnation = v.pipe(v.string(), v.uuid());
const state = v.pipe(v.string(), v.minLength(1));
const releaseDigest = v.pipe(v.string(), v.regex(/^sha256:[0-9a-f]{64}$/));
const nonempty = v.pipe(v.string(), v.minLength(1));
const profilePin = v.union([
  v.object({ provenance: v.literal('profile'), releaseDigest, acceptingType: nonempty, profileId: nonempty }),
  v.object({
    provenance: v.literal('legacy'),
    releaseDigest,
    acceptingType: v.nullable(nonempty),
    profileId: v.literal('legacy-fixed-v1'),
  }),
]);

export const changeSchema = v.object({
  revision,
  priorRevision: v.nullable(revision),
  beforeState: v.nullable(state),
  beforeProfilePin: v.nullable(profilePin),
  afterState: state,
  afterProfilePin: profilePin,
  commandId: v.pipe(v.string(), v.uuid()),
  commandKind: v.union([v.literal('library.entry.put'), v.literal('library.entry.state.restore')]),
  changedAt: v.pipe(v.string(), v.minLength(1)),
});
export const pageSchema = v.object({
  incarnationId: v.nullable(incarnation),
  currentRevision: revision,
  changes: v.array(changeSchema),
  coverage: v.union([v.literal('complete'), v.literal('partial'), v.literal('unknown')]),
  next: v.nullable(v.pipe(v.string(), v.minLength(1), v.maxLength(4096))),
});
export const reviewSchema = v.object({
  change: changeSchema,
  current: v.object({ incarnationId: v.nullable(incarnation), revision, state }),
  availability: v.union([
    v.literal('available'),
    v.literal('no_prior_state'),
    v.literal('state_unavailable'),
  ]),
});
export const entrySchema = v.object({
  subjectId: v.pipe(v.string(), v.minLength(1)),
  incarnationId: v.optional(v.nullable(incarnation)),
  revision,
  state,
  createdAt: v.pipe(v.string(), v.minLength(1)),
  updatedAt: v.pipe(v.string(), v.minLength(1)),
});

export type EntryStateChange = v.InferOutput<typeof changeSchema>;
export type EntryStatePage = v.InferOutput<typeof pageSchema>;
export type EntryStateReview = v.InferOutput<typeof reviewSchema>;
export type CurrentEntry = v.InferOutput<typeof entrySchema>;

/** Inspect each untrusted native response once, before any private value reaches the component. */
export function receivePage(value: unknown): EntryStatePage | null {
  const parsed = v.safeParse(pageSchema, value);
  if (!parsed.success) return null;
  const page = parsed.output;
  if (page.changes.length > 50 || (page.changes.length > 0 && !page.incarnationId)) return null;
  if (page.changes.some((change, index) =>
    change.revision > page.currentRevision ||
    (index > 0 && change.revision >= page.changes[index - 1]!.revision),
  )) return null;
  return page;
}

export function receiveReview(value: unknown): EntryStateReview | null {
  const parsed = v.safeParse(reviewSchema, value);
  if (!parsed.success) return null;
  const review = parsed.output;
  if (
    !review.current.incarnationId ||
    review.change.revision > review.current.revision ||
    (review.change.beforeState === null) !== (review.availability === 'no_prior_state')
  ) return null;
  return review;
}

export function receiveEntry(value: unknown, subjectId: string): CurrentEntry | null {
  const parsed = v.safeParse(entrySchema, value);
  return parsed.success && parsed.output.subjectId === subjectId ? parsed.output : null;
}
