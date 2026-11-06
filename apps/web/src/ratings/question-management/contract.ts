import * as v from 'valibot';
import type { QuestionLabelHistory } from '@rezics/client';
import type { QuestionManagementPageData } from './types';

// Browser-safe projection of the generated Client DTOs. Validation supplies no Kernel engine or SQL.
const id = v.pipe(v.string(), v.uuid());
const href = v.pipe(v.string(), v.minLength(1), v.maxLength(128));
const revision = v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(2_147_483_647));
const grain = v.picklist(['work', 'release', 'episode', 'character']);
const question = v.strictObject({
  id,
  revision,
  realmId: id,
  meaning: v.pipe(v.string(), v.minLength(1), v.maxLength(2000)),
  canonicalLabel: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  label: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  labelRevision: revision,
  grain,
  scale: v.strictObject({
    min: v.pipe(v.number(), v.integer()),
    max: v.pipe(v.number(), v.integer()),
    displayStep: v.pipe(v.number(), v.integer(), v.minValue(1)),
  }),
  lifecycle: v.strictObject({ state: v.picklist(['active', 'retired']), revision }),
});
const pageSchema = v.strictObject({
  viewer: v.strictObject({ accountId: id }),
  realmId: id,
  directory: v.strictObject({
    ratingQuestions: v.pipe(v.array(question), v.maxLength(20)),
    next: v.nullable(v.pipe(v.string(), v.minLength(1), v.maxLength(4096))),
  }),
  actions: v.strictObject({
    create: v.nullable(v.strictObject({ method: v.literal('POST'), href })),
  }),
  selected: v.nullable(
    v.strictObject({
      question,
      readback: href,
      history: href,
      actions: v.strictObject({
        caption: v.nullable(v.strictObject({ method: v.literal('PUT'), href, expectedLabelRevision: revision })),
        lifecycle: v.nullable(v.strictObject({ method: v.literal('POST'), href, expectedLifecycleRevision: revision })),
      }),
    }),
  ),
});
const labelAuthor = v.nullable(
  v.variant('state', [
    v.strictObject({
      id,
      kind: v.picklist(['actor', 'organization']),
      state: v.literal('deleted'),
    }),
    v.strictObject({
      id,
      kind: v.picklist(['actor', 'organization']),
      state: v.literal('active'),
      handle: v.nullable(v.string()),
      displayName: v.nullable(v.string()),
      automated: v.boolean(),
      operatorId: v.nullable(id),
    }),
  ]),
);
const historySchema = v.strictObject({
  labels: v.pipe(
    v.array(
      v.strictObject({
        questionId: id,
        labelRevision: revision,
        label: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
        at: v.nullable(v.pipe(v.string(), v.isoTimestamp())),
        author: labelAuthor,
      }),
    ),
    v.maxLength(20),
  ),
  next: v.nullable(v.string()),
});

/** Reject the entire page before any private context reaches presentation; never repair hostile input. */
export function parseQuestionManagementPage(value: unknown): QuestionManagementPageData | null {
  return v.is(pageSchema, value) ? value : null;
}

export function parseQuestionLabelHistory(value: unknown): QuestionLabelHistory | null {
  return v.is(historySchema, value) ? value : null;
}
