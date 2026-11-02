import { t } from 'elysia';
import type { Static } from 'typebox';
import { BULK_MAX_SELECTION_IDS } from './bulk-limits.ts';

// HTTP shapes stand alone so routes need not load the unfinished bulk runtime.
const closed = { additionalProperties: false } as const;
const id = t.String({ format: 'uuid' });
const nullableId = t.Union([id, t.Null()]);
const nullableString = t.Union([t.String(), t.Null()]);
const count = t.Integer({ minimum: 0 });
const entryState = t.Union([
  t.Literal('planned'),
  t.Literal('in_progress'),
  t.Literal('completed'),
  t.Literal('paused'),
  t.Literal('dropped'),
]);
const action = t.Union([
  t.Literal('set_status'),
  t.Literal('add_to_collection'),
  t.Literal('remove_from_collection'),
  t.Literal('remove_from_library'),
]);
const selectionKind = t.Union([t.Literal('explicit'), t.Literal('query'), t.Literal('occurrences')]);
const subjectSelection = t.Union([
  t.Object(
    {
      kind: t.Literal('explicit'),
      targets: t.Array(t.Object({ subjectId: id }, closed), { minItems: 1, maxItems: BULK_MAX_SELECTION_IDS }),
    },
    closed,
  ),
  t.Object(
    {
      kind: t.Literal('query'),
      // Full type identifiers have no per-identifier cap; admission bounds the whole body.
      filter: t.Object({ state: t.Optional(entryState), primaryType: t.Optional(t.String()) }, closed),
    },
    closed,
  ),
]);
const occurrenceSelection = t.Object(
  {
    kind: t.Literal('occurrences'),
    memberIds: t.Array(id, { minItems: 1, maxItems: BULK_MAX_SELECTION_IDS }),
  },
  closed,
);

export const bulkAdmissionSchema = t.Union([
  t.Object({ action: t.Literal('set_status'), state: entryState, selection: subjectSelection }, closed),
  t.Object({ action: t.Literal('add_to_collection'), collectionId: id, selection: subjectSelection }, closed),
  t.Object(
    {
      action: t.Literal('remove_from_collection'),
      collectionId: id,
      selection: t.Union([subjectSelection, occurrenceSelection]),
    },
    closed,
  ),
  t.Object({ action: t.Literal('remove_from_library'), selection: subjectSelection }, closed),
]);

const phase = t.Union([
  t.Literal('queued'),
  t.Literal('discovering'),
  t.Literal('expanding'),
  t.Literal('applying'),
  t.Literal('reconciling'),
  t.Literal('completed'),
  t.Literal('completed_with_errors'),
  t.Literal('cancelled'),
  t.Literal('stopped'),
  t.Literal('expired'),
]);
const targetState = t.Union([
  t.Literal('applied'),
  t.Literal('no_effect'),
  t.Literal('conflict'),
  t.Literal('denied'),
  t.Literal('failed'),
  t.Literal('cancelled'),
  t.Literal('pending'),
  t.Literal('reconciling'),
]);
const reason = t.Union([
  t.Literal('revision_mismatch'),
  t.Literal('incarnation_mismatch'),
  t.Literal('missing_target'),
  t.Literal('authority_lost'),
  t.Literal('target_denied'),
  t.Literal('collection_full'),
  t.Literal('invalid_subject'),
  t.Literal('dependency_unavailable'),
  t.Literal('deadline'),
  t.Literal('cancel_requested'),
  t.Literal('evidence_missing'),
  t.Literal('execution_expired'),
]);
const nullableReason = t.Union([reason, t.Null()]);
const counters = t.Object(
  {
    scannedCandidates: count,
    selectedSubjects: count,
    scannedOccurrences: count,
    capturedOccurrences: count,
    targets: count,
    pending: count,
    reconciling: count,
    applied: count,
    no_effect: count,
    conflict: count,
    denied: count,
    failed: count,
    cancelled: count,
  },
  closed,
);
const summary = t.Object({ changed: count, unchanged: count, failed: count }, closed);
const operation = t.Object(
  {
    id,
    action,
    selectionKind,
    state: t.Union([entryState, t.Null()]),
    collectionId: nullableId,
    phase,
    selectionComplete: t.Boolean(),
    occurrencesComplete: t.Boolean(),
    cancelRequested: t.Boolean(),
    counts: counters,
    summary: t.Union([summary, t.Null()]),
    admittedAt: t.String(),
    targetBoundAt: nullableString,
    expiresAt: t.String(),
    resultsExpireAt: t.String(),
    finishedAt: nullableString,
    reason: nullableReason,
  },
  closed,
);

export const bulkOperationResultSchema = t.Object({ operation }, closed);

const outcome = t.Object(
  {
    ordinal: t.String({ pattern: '^(0|[1-9][0-9]*)$' }),
    subjectId: id,
    memberId: nullableId,
    state: targetState,
    reason: nullableReason,
    resultingMemberId: nullableId,
  },
  closed,
);
export const bulkOutcomePageSchema = t.Object(
  { outcomes: t.Array(outcome, { maxItems: 20 }), next: nullableString },
  closed,
);
export const bulkOutcomeQuerySchema = t.Object(
  {
    limit: t.Optional(t.Integer({ minimum: 1, maximum: 20, default: 20 })),
    cursor: t.Optional(t.String({ maxLength: 4096 })),
    state: t.Optional(targetState),
  },
  closed,
);
export const bulkCancelSchema = t.Object({}, closed);

export type BulkAdmission = Static<typeof bulkAdmissionSchema>;
export type BulkOperationResult = Static<typeof bulkOperationResultSchema>;
export type BulkOutcomePage = Static<typeof bulkOutcomePageSchema>;
export type BulkOutcomeQuery = Static<typeof bulkOutcomeQuerySchema>;
export type BulkCancel = Static<typeof bulkCancelSchema>;
