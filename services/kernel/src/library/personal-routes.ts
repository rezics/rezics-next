import { createShelfTitlePreparation } from './shelf-title-maintenance.ts';
import type { ShelfTitleSource } from './shelf-title-source.ts';
import { createShelfScorePreparation } from './shelf-score.ts';
import { createFollowCountReads } from './follow-count-reads.ts';
import { t } from 'elysia';
import type { Static, TSchema } from 'typebox';
import { bundledRelease } from '@rezics/definitions/bundled';
import { customMethod } from '../http/custom-method.ts';
import type { Pool } from 'pg';
import { deadlineClient } from '../access/authenticate.ts';
import { GrantDeniedError } from '../access/grant-commands.ts';
import { systemClock, type KernelClock } from '../clock.ts';
import { withConnection } from '../database/pool.ts';
import { ProblemError, problemSchema } from '../http/problem.ts';
import { defineRateLimit } from '../http/rate-limit.ts';
import { IDEMPOTENCY_HEADER, idempotencyKeyOf } from '../http/request.ts';
import { readPartition } from '../partition/partition.ts';
import { AuthenticationError, type Access, type Actor } from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import type { definitionRoutes } from '../semantic/http/definitions.ts';
import { languageRanges } from '../semantic/language.ts';
import { decodeCursor, encodeCursor } from '../tokens/cursor.ts';
import type { KeyRing } from '../tokens/seal.ts';
import { LibraryNotFoundError } from './command-support.ts';
import { FactSchema } from '../search/http/routes.ts';
import {
  createEntryAnnotationCorrectionCommands,
  ENTRY_ANNOTATION_CORRECTION_LIMITS,
  EntryAnnotationCorrectionConflictError,
  EntryAnnotationCorrectionLimitError,
} from './entry-annotation-correction.ts';
import { CopyConflictError, CopyInvalidError, createCopyCommands } from './copies.ts';
import { createLoanCommands, loanPeopleDisplay } from './loan-commands.ts';
import { loanDueBoundary, type LoanDueBoundary } from './loan-date.ts';
import { withLoanHttpWork, type LoanHttpOperation, type LoanHttpWorkOwner } from './loan-operation-bounds.ts';
import { LoanConflictError, LoanInvalidError, LoanNotFoundError, loanState, type Loan } from './loan-model.ts';
import { COPY_CONDITION_CHOICES } from './copy-condition.ts';
import { attachCopyListContext } from './copy-list-context.ts';
import type { CopyListContext } from './copy-list-context.ts';
import type { CopyInventory } from './copy-inventory.ts';
import type { CopyPresentation } from './copy-model.ts';
import {
  createEntryCommands,
  LibraryConflictError,
  LibraryEntryInvalidError,
  LibraryEntryLifecycleConflictError,
  LibraryEntryStateRestoreConflictError,
} from './entries.ts';
import type { Copy, Entry } from './entry-model.ts';
import {
  MAX_PERSONAL_NOTE_BYTES,
  MAX_PERSONAL_PRIORITY,
  MAX_SOURCE_OBSERVATIONS,
  MAX_SOURCE_PRIVACY_VALUE_BYTES,
  MAX_SOURCE_TIMESTAMP_LENGTH,
} from './entry-personal-model.ts';
import type { Follow, FollowPageCursor } from './follow-model.ts';
import { createFollowCommands } from './follows.ts';
import type { FollowingSpaceProjection } from './following-space-contract.ts';
import { admitShelfRead } from './shelf-admission.ts';
import type { ShelfTypeDigest } from './shelf-type-keys.ts';
import { ShelfContractNotImplementedError, type ShelfEntry, type ShelfReads } from './shelf-contract.ts';
import { libraryStoredVocabularySchema, libraryVocabularyIdSchema } from './profile-schemas.ts';
export type {
  PersonalEntry,
  PersonalEntryAnnotationWrite,
  PersonalEntryFieldChange,
  PersonalEntryGuard,
  PersonalEntryObservation,
  PersonalEntryPrivacy,
  PersonalEntryPrivacyValue,
  PersonalEntrySourceAdmission,
  PersonalEntrySourceCorrection,
  PersonalEntryTimestamp,
  PersonalEntryTimestampInput,
  PersonalEntryTimestampValue,
} from './entry-personal-model.ts';
import {
  shelfScoreQuestionSchema,
  shelfScorePreparationSchema,
  shelfTitlePreparationSchema,
  shelfEntrySchema,
  shelfListQuerySchema,
  shelfSummaryQuerySchema,
  shelfSummarySchema,
  shelfTypesQuerySchema,
  shelfTypesSchema,
} from './shelf-schemas.ts';
import { STANDARD_QUESTION_ID } from '../rating/votes.ts';
import { readViewerFactsPage, viewerFactsResponseSchema } from './viewer-facts.ts';
import { attachCollectionListFacts } from './collection-list-facts.ts';
import { assertShelfPageCurrent } from './shelf-viewer-currentness.ts';

import { followResponse as serializeFollowResponse, withFollowWork } from './follow-operation-bounds.ts';
import { basicQuery, embedded, fullView, subjectFields, targetFields, viewQuery } from './views.ts';

type Dependencies = {
  routeKey: Uint8Array;
  pool: Pool;
  tokens: KeyRing;
  access: () => Access;
  clock?: KernelClock;
  shelves?: () => ShelfReads;
  loanHttpWork?: LoanHttpWorkOwner;
  shelfTypeDigest?: ShelfTypeDigest;
  titleSource?: ShelfTitleSource;
  typeSourceObserved?: import('./type-preparation-contract.ts').TypePreparationSourceObserved;
  followingSpaceTargets?: (
    actor: Actor,
    ids: readonly string[],
    deadline: number,
  ) => Promise<ReadonlyMap<string, FollowingSpaceProjection>>;
};
const closed = { additionalProperties: false } as const;
const id = t.String();
const nullable = t.Union([id, t.Null()]);
const listFacts = t.Optional(t.Record(t.String(), t.Array(FactSchema, { maxItems: 3 }), { maxProperties: 4 }));
// Request fields remain optional for exact historical receipts; fresh non-null
// incarnations enforce the guard inside the authorized command after receipt lookup.
const incarnationId = t.String({ format: 'uuid' });
const revision = t.Integer({ minimum: 1, maximum: 2_147_483_646 });
const personalRevision = t.Integer({ minimum: 0, maximum: 2_147_483_646 });
const stateInput = libraryVocabularyIdSchema;
const statusInput = libraryVocabularyIdSchema;
const copyConditionValueSchema = t.Union([
  t.Literal('unknown'),
  t.Literal('mint'),
  t.Literal('near_mint'),
  t.Literal('very_good_plus'),
  t.Literal('very_good'),
  t.Literal('good'),
  t.Literal('fair'),
  t.Literal('poor'),
]);
const pageQuery = {
  ...viewQuery,
  cursor: t.Optional(t.String({ maxLength: 4096 })),
  limit: t.Optional(t.Integer({ minimum: 1, maximum: 100, default: 20 })),
};
const copyInventoryChoiceSchema = t.Object(
  {
    id: libraryVocabularyIdSchema,
    label: t.String({ maxLength: 256 }),
    labelLanguage: t.Optional(t.String()),
    meaning: t.Union([t.Literal('available'), t.Literal('unsupported'), t.Literal('unavailable')]),
  },
  closed,
);
const copyInventoryFacetSchema = t.Object(
  {
    state: t.Union([t.Literal('available'), t.Literal('unavailable')]),
    choices: t.Array(copyInventoryChoiceSchema, { maxItems: 64 }),
  },
  closed,
);
const copyInventorySchema = t.Object({ kinds: copyInventoryFacetSchema, statuses: copyInventoryFacetSchema }, closed);
const entrySchema = t.Object(
  {
    subjectId: id,
    incarnationId: t.Optional(t.Union([incarnationId, t.Null()])),
    state: libraryStoredVocabularySchema,
    revision,
    createdAt: id,
    updatedAt: id,
  },
  closed,
);
const entryStateChangeSchema = t.Object(
  {
    revision,
    priorRevision: t.Union([revision, t.Null()]),
    beforeState: t.Union([libraryStoredVocabularySchema, t.Null()]),
    afterState: libraryStoredVocabularySchema,
    commandId: t.String({ format: 'uuid' }),
    commandKind: t.Union([t.Literal('library.entry.put'), t.Literal('library.entry.state.restore')]),
    changedAt: id,
  },
  closed,
);
const entryStateHistorySchema = t.Object(
  {
    incarnationId: t.Union([incarnationId, t.Null()]),
    currentRevision: revision,
    changes: t.Array(entryStateChangeSchema),
    coverage: t.Union([t.Literal('complete'), t.Literal('partial'), t.Literal('unknown')]),
    next: t.Union([t.String({ maxLength: 4096 }), t.Null()]),
  },
  closed,
);
const entryStateReviewSchema = t.Object(
  {
    change: entryStateChangeSchema,
    current: t.Object(
      { incarnationId: t.Union([incarnationId, t.Null()]), revision, state: libraryStoredVocabularySchema },
      closed,
    ),
    availability: t.Union([t.Literal('available'), t.Literal('no_prior_state'), t.Literal('state_unavailable')]),
  },
  closed,
);
const copyFields = {
  status: t.Optional(statusInput),
  location: t.Optional(t.Union([t.String({ maxLength: 200 }), t.Null()])),
  source: t.Optional(t.Union([t.String({ maxLength: 200 }), t.Null()])),
  acquiredOn: t.Optional(nullable),
  disposedOn: t.Optional(nullable),
  note: t.Optional(t.Union([t.String({ maxLength: 1000 }), t.Null()])),
  mediaCondition: t.Optional(t.Union([copyConditionValueSchema, t.Null()])),
  packagingCondition: t.Optional(t.Union([copyConditionValueSchema, t.Null()])),
};
const copyConditionDisplaySchema = t.Union([
  t.Object({ state: t.Literal('not_recorded') }, closed),
  t.Object({ state: t.Literal('unavailable') }, closed),
  t.Object({ state: t.Literal('cleared') }, closed),
  t.Object({ state: t.Literal('recorded'), id: copyConditionValueSchema, label: t.String() }, closed),
]);
const copyConditionChoiceSchema = t.Object(
  { id: copyConditionValueSchema, label: t.String(), description: t.String() },
  closed,
);
const copyConditionEditingSchema = t.Union([
  t.Object(
    {
      state: t.Literal('supported'),
      currentness: t.Literal('current'),
      choices: t.Array(copyConditionChoiceSchema, { minItems: COPY_CONDITION_CHOICES.length }),
    },
    closed,
  ),
  t.Object(
    {
      state: t.Literal('unavailable'),
      currentness: t.Union([t.Literal('current'), t.Literal('retired'), t.Literal('unavailable')]),
      reason: t.Union([
        t.Literal('unsupported'),
        t.Literal('unrecognized_vocabulary'),
        t.Literal('retired'),
        t.Literal('current_source_unavailable'),
      ]),
    },
    closed,
  ),
]);
const copySchema = t.Object(
  {
    id,
    subjectId: id,
    kind: t.Optional(t.Union([libraryStoredVocabularySchema, t.Null()])),
    status: libraryStoredVocabularySchema,
    revision,
    location: nullable,
    source: nullable,
    acquiredOn: nullable,
    disposedOn: nullable,
    note: nullable,
  },
  closed,
);
const copyPresentationSchema = t.Object(
  {
    meaning: t.Union([t.Literal('known'), t.Literal('unknown'), t.Literal('unavailable')]),
    kindLabel: t.Optional(t.String()),
    kindLabelLanguage: t.Optional(t.String()),
    statusLabel: t.Optional(t.String()),
    statusLabelLanguage: t.Optional(t.String()),
    statusEditing: t.Union([
      t.Object(
        {
          state: t.Literal('supported'),
          statuses: t.Array(t.Object({ id: t.String(), label: t.String(), labelLanguage: t.String() }, closed), {
            minItems: 1,
          }),
        },
        closed,
      ),
      t.Object({ state: t.Union([t.Literal('unsupported'), t.Literal('unavailable')]) }, closed),
    ]),
    mediaCondition: copyConditionDisplaySchema,
    packagingCondition: copyConditionDisplaySchema,
    conditionEditing: copyConditionEditingSchema,
  },
  closed,
);
const copyListContextIdentitySchema = t.Object({ id, labels: t.Record(t.String(), t.String()) }, closed);
const copyListContextSchema = t.Union([
  t.Object(
    {
      state: t.Literal('available'),
      work: t.Array(copyListContextIdentitySchema, { maxItems: 3 }),
      facts: t.Record(t.String(), t.Array(FactSchema, { maxItems: 3 }), { maxProperties: 4 }),
    },
    closed,
  ),
  t.Object(
    {
      state: t.Literal('unsupported'),
      facts: t.Record(t.String(), t.Array(FactSchema, { maxItems: 3 }), { maxProperties: 4 }),
    },
    closed,
  ),
  t.Object({ state: t.Literal('scope') }, closed),
  t.Object({ state: t.Literal('withheld') }, closed),
  t.Object({ state: t.Literal('missing') }, closed),
  t.Object({ state: t.Literal('unavailable') }, closed),
]);
const followSchema = t.Object(
  {
    targetId: id,
    targetType: t.Union([t.Literal('subject'), t.Literal('collection'), t.Literal('space')]),
    state: t.Union([t.Literal('following'), t.Literal('unfollowed')]),
    reason: t.Union([t.Literal('explicit'), t.Literal('library'), t.Literal('membership')]),
    updatedAt: id,
  },
  closed,
);
const entryResponse = t.Object({ libraryEntry: entrySchema }, closed);
const personalPrivacyValue = t.Union([
  t.Object({ status: t.Literal('absent') }, closed),
  t.Object(
    {
      status: t.Literal('unknown'),
      sourceValue: t.Optional(t.String({ minLength: 1, maxLength: MAX_SOURCE_PRIVACY_VALUE_BYTES })),
    },
    closed,
  ),
  t.Object(
    { status: t.Literal('known'), meaning: t.Union([t.Literal('private'), t.Literal('source_visible')]) },
    closed,
  ),
]);
const personalTimestampPrecision = t.Union([
  t.Literal('year'),
  t.Literal('month'),
  t.Literal('day'),
  t.Literal('minute'),
  t.Literal('second'),
  t.Literal('fraction'),
]);
const personalTimestampValue = t.Union([
  t.Object({ status: t.Literal('absent') }, closed),
  t.Object(
    {
      status: t.Literal('unknown'),
      sourceValue: t.Optional(t.String({ minLength: 1, maxLength: MAX_SOURCE_TIMESTAMP_LENGTH })),
    },
    closed,
  ),
  t.Object(
    { status: t.Literal('known'), value: t.String({ minLength: 4, maxLength: MAX_SOURCE_TIMESTAMP_LENGTH }) },
    closed,
  ),
]);
function personalChange(value: TSchema) {
  return t.Union([
    t.Object({ op: t.Literal('unchanged') }, closed),
    t.Object({ op: t.Literal('clear') }, closed),
    t.Object({ op: t.Literal('set'), value }, closed),
  ]);
}
const personalObservationSchema = t.Object(
  {
    provider: t.String({ minLength: 1, maxLength: 64 }),
    recordId: t.String({ minLength: 1, maxLength: 192 }),
    revision,
    privacy: t.Union([
      t.Object({ status: t.Literal('absent') }, closed),
      t.Object(
        {
          status: t.Literal('unknown'),
          sourceValue: t.Optional(t.String({ minLength: 1, maxLength: MAX_SOURCE_PRIVACY_VALUE_BYTES })),
        },
        closed,
      ),
      t.Object({ status: t.Literal('cleared') }, closed),
      t.Object(
        { status: t.Literal('known'), meaning: t.Union([t.Literal('private'), t.Literal('source_visible')]) },
        closed,
      ),
    ]),
    sourceCreated: t.Union([
      t.Object({ status: t.Literal('absent') }, closed),
      t.Object(
        {
          status: t.Literal('unknown'),
          sourceValue: t.Optional(t.String({ minLength: 1, maxLength: MAX_SOURCE_TIMESTAMP_LENGTH })),
        },
        closed,
      ),
      t.Object({ status: t.Literal('cleared') }, closed),
      t.Object(
        {
          status: t.Literal('known'),
          value: t.String({ minLength: 4, maxLength: MAX_SOURCE_TIMESTAMP_LENGTH }),
          precision: personalTimestampPrecision,
          zone: t.Union([t.Literal('utc'), t.Literal('offset'), t.Literal('unknown')]),
        },
        closed,
      ),
    ]),
    sourceUpdated: t.Union([
      t.Object({ status: t.Literal('absent') }, closed),
      t.Object(
        {
          status: t.Literal('unknown'),
          sourceValue: t.Optional(t.String({ minLength: 1, maxLength: MAX_SOURCE_TIMESTAMP_LENGTH })),
        },
        closed,
      ),
      t.Object({ status: t.Literal('cleared') }, closed),
      t.Object(
        {
          status: t.Literal('known'),
          value: t.String({ minLength: 4, maxLength: MAX_SOURCE_TIMESTAMP_LENGTH }),
          precision: personalTimestampPrecision,
          zone: t.Union([t.Literal('utc'), t.Literal('offset'), t.Literal('unknown')]),
        },
        closed,
      ),
    ]),
    recordedAt: id,
  },
  closed,
);
const personalEntrySchema = t.Object(
  {
    subjectId: id,
    annotationRevision: personalRevision,
    note: t.Union([t.String({ maxLength: MAX_PERSONAL_NOTE_BYTES }), t.Null()]),
    priority: t.Union([t.Integer({ minimum: 1, maximum: MAX_PERSONAL_PRIORITY }), t.Null()]),
    annotationUpdatedAt: nullable,
    sourceObservations: t.Array(personalObservationSchema, { maxItems: MAX_SOURCE_OBSERVATIONS }),
  },
  closed,
);
const personalEntryResponse = t.Object({ personalEntry: personalEntrySchema }, closed);
const personalObservationResponse = t.Object({ sourceObservation: personalObservationSchema }, closed);
const correctionNoteOperation = t.Union([
  t.Object({ op: t.Literal('preserve') }, closed),
  t.Object({ op: t.Literal('clear') }, closed),
  t.Object({ op: t.Literal('set'), value: t.String({ minLength: 1, maxLength: MAX_PERSONAL_NOTE_BYTES }) }, closed),
]);
const correctionPriorityOperation = t.Union([
  t.Object({ op: t.Literal('preserve') }, closed),
  t.Object({ op: t.Literal('clear') }, closed),
  t.Object({ op: t.Literal('set'), value: t.Integer({ minimum: 1, maximum: MAX_PERSONAL_PRIORITY }) }, closed),
]);
const correctionSelectionSchema = t.Object(
  {
    subjectId: id,
    incarnationId,
    currentRevision: revision,
    note: correctionNoteOperation,
    priority: correctionPriorityOperation,
  },
  closed,
);
const correctionCurrentSchema = t.Union([
  t.Object(
    {
      annotationRevision: personalRevision,
      note: t.Union([t.String({ maxLength: MAX_PERSONAL_NOTE_BYTES }), t.Null()]),
      priority: t.Union([t.Integer({ minimum: 1, maximum: MAX_PERSONAL_PRIORITY }), t.Null()]),
    },
    closed,
  ),
  t.Null(),
]);
const correctionItemSchema = t.Object(
  {
    selected: t.Object({ subjectId: id, incarnationId, currentRevision: revision }, closed),
    eligibility: t.Union([t.Literal('ready'), t.Literal('stale'), t.Literal('unavailable')]),
    current: correctionCurrentSchema,
    operation: t.Union([
      t.Object({ note: correctionNoteOperation, priority: correctionPriorityOperation }, closed),
      t.Null(),
    ]),
    outcome: t.Union([
      t.Literal('accepted'),
      t.Literal('unchanged'),
      t.Literal('stale'),
      t.Literal('unavailable'),
      t.Literal('not-started'),
    ]),
  },
  closed,
);
const correctionPageSchema = t.Object(
  {
    reviewId: id,
    epoch: id,
    state: t.Union([t.Literal('open'), t.Literal('confirmed'), t.Literal('cancelled'), t.Literal('expired')]),
    createdAt: id,
    expiresAt: id,
    total: t.Integer({ minimum: 1, maximum: ENTRY_ANNOTATION_CORRECTION_LIMITS.selection }),
    page: t.Integer({ minimum: 0, maximum: 3 }),
    pageCount: t.Integer({ minimum: 1, maximum: 4 }),
    nextPage: t.Union([t.Integer({ minimum: 1, maximum: 3 }), t.Null()]),
    items: t.Unsafe<readonly Static<typeof correctionItemSchema>[]>(
      t.Array(correctionItemSchema, { maxItems: ENTRY_ANNOTATION_CORRECTION_LIMITS.page }),
    ),
  },
  closed,
);
const correctionPageResponse = t.Object({ review: correctionPageSchema }, closed);
const copyResponse = t.Object({ copy: copySchema }, closed);
const loanPartyResponse = t.Union([
  t.Object({ kind: t.Literal('name'), name: t.String({ maxLength: 600 }) }, closed),
  t.Object({ kind: t.Literal('person'), state: t.Literal('available'), personId: id, displayName: t.String() }, closed),
  t.Object({ kind: t.Literal('person'), state: t.Literal('concealed') }, closed),
]);
const loanActionResponse = t.Object(
  { allowed: t.Boolean(), reason: t.Union([t.Literal('returned'), t.Literal('copy_unavailable'), t.Null()]) },
  closed,
);
const loanRevision = t.Integer({ minimum: 1, maximum: 2_147_483_647 });
const loanResponse = t.Object(
  {
    id,
    copyId: id,
    direction: t.Union([t.Literal('lent'), t.Literal('borrowed')]),
    counterparty: loanPartyResponse,
    startedOn: t.String(),
    dueOn: nullable,
    returnedOn: nullable,
    revision: loanRevision,
    state: t.Union([t.Literal('overdue'), t.Literal('due'), t.Literal('undated'), t.Literal('returned')]),
    viewer: t.Object({ state: t.Literal('owner') }, closed),
    actions: t.Object({ extend: loanActionResponse, return: loanActionResponse }, closed),
  },
  closed,
);
type LoanResponse = Static<typeof loanResponse>;
const loanCopyResponse = t.Object(
  {
    state: t.Union([t.Literal('available'), t.Literal('deleted'), t.Literal('missing')]),
    id,
    revision: t.Union([revision, t.Null()]),
    kind: nullable,
    status: nullable,
    context: copyListContextSchema,
  },
  closed,
);
const loanBoundaryResponse = t.Object(
  { calendar: t.Literal('gregorian'), zone: t.Literal('UTC'), today: t.String() },
  closed,
);
const loanListResponse = t.Object(
  {
    filter: t.Union([t.Literal('open'), t.Literal('history')]),
    boundary: loanBoundaryResponse,
    generation: t.Integer({ minimum: 1, maximum: 2_147_483_647 }),
    items: t.Array(t.Object({ loan: loanResponse, copy: loanCopyResponse }, closed), { maxItems: 100 }),
    nextCursor: nullable,
  },
  closed,
);
const loanWriteBody = t.Object(
  {
    copyId: id,
    copyRevision: revision,
    direction: t.Union([t.Literal('lent'), t.Literal('borrowed')]),
    counterparty: t.Union([
      t.Object({ kind: t.Literal('name'), name: t.String({ maxLength: 600 }) }, closed),
      t.Object({ kind: t.Literal('person'), personId: id }, closed),
    ]),
    startedOn: t.String(),
    dueOn: t.Optional(nullable),
  },
  closed,
);
const loanExtendBody = t.Object({ revision: loanRevision, dueOn: t.String() }, closed);
const loanReturnBody = t.Object({ revision: loanRevision, returnedOn: t.String() }, closed);
const followResponse = t.Object({ follow: followSchema }, closed);
const followDestinationSchema = t.Union([
  t.Object({ kind: t.Literal('space'), spaceId: id, address: t.String() }, closed),
  t.Object({ kind: t.Literal('realm'), realmId: id }, closed),
  t.Object({ kind: t.Literal('unavailable') }, closed),
]);
const followActionsSchema = t.Union([
  t.Object(
    {
      status: t.Literal('available'),
      resourceType: t.Union([t.Literal('community.space'), t.Literal('community.realm')]),
      resourceId: id,
      viewerActions: t.Array(t.Object({ action: t.String(), operations: t.Array(t.String()) }, closed)),
    },
    closed,
  ),
  t.Object({ status: t.Literal('unavailable') }, closed),
]);
const fullFollowFields = {
  ...targetFields,
  destination: t.Optional(followDestinationSchema),
  actions: t.Optional(followActionsSchema),
};
const headers = t.Object({ [IDEMPOTENCY_HEADER]: t.String({ minLength: 3, maxLength: 1024 }) });
const failures = {
  400: problemSchema('invalid_request', 'invalid_cursor'),
  401: problemSchema('authentication_required', 'invalid_credentials'),
  403: problemSchema('forbidden'),
  404: problemSchema('not_found'),
  409: problemSchema('conflict', 'stale_cursor'),
  422: problemSchema('idempotency_conflict'),
  503: problemSchema('overloaded', 'partition_unavailable', 'transaction_retry_exhausted', 'deadline_exceeded'),
};
const loanWriteFailures = {
  ...failures,
  400: problemSchema('invalid_request', 'invalid_cursor'),
  409: problemSchema('conflict', 'stale_cursor'),
  422: problemSchema('idempotency_conflict', 'unsupported_library_profile'),
  503: problemSchema(
    'dependency_unavailable',
    'overloaded',
    'partition_unavailable',
    'transaction_retry_exhausted',
    'deadline_exceeded',
  ),
};
const shelfFailures = {
  ...failures,
  400: problemSchema('invalid_request', 'invalid_cursor', 'invalid_argument'),
  503: problemSchema(
    'dependency_unavailable',
    'overloaded',
    'partition_unavailable',
    'transaction_retry_exhausted',
    'deadline_exceeded',
  ),
};
function detail(operationId: string, action: string, write = false) {
  return {
    operationId,
    'x-action': action,
    'x-exposure': 'gate:personal_library',
    security: [{ bearerAuth: [] }],
    ...(['library_entry:list', 'library_entry:read', 'copy:list'].includes(action)
      ? { 'x-authority-anchor': 'own-account', 'x-authority-resource-types': Object.keys(bundledRelease.types) }
      : {}),
    ...(write ? { 'x-rate-limit': defineRateLimit({ family: 'write', units: 1 }) } : {}),
  };
}
function personalDetail(operationId: string, action: string) {
  return {
    ...detail(operationId, action, true),
    'x-authority-anchor': 'own-account',
    'x-authority-resource-types': Object.keys(bundledRelease.types),
  };
}
async function personalCommand<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await command(run);
  } catch (error) {
    if (error instanceof TypeError) throw new ProblemError('invalid_request');
    throw error;
  }
}
async function correctionCommand<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await personalCommand(run);
  } catch (error) {
    if (error instanceof EntryAnnotationCorrectionLimitError)
      throw new ProblemError('library_entry_annotation_correction_limit');
    if (error instanceof EntryAnnotationCorrectionConflictError)
      throw new ProblemError(
        error.reason === 'epoch'
          ? 'library_entry_annotation_correction_epoch'
          : 'library_entry_annotation_correction_expired',
      );
    throw error;
  }
}
function account(actor: Actor) {
  if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
  return actor;
}
function point(actor: Actor, value: string, action: string) {
  if (actor.kind !== 'account' || !actor.scopes.includes(action) || routeOf(value) === null)
    throw new ProblemError('not_found');
}
async function command<T>(run: () => Promise<T>, denied: 'forbidden' | 'not_found' = 'forbidden'): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof GrantDeniedError) throw new ProblemError(denied);
    if (error instanceof LibraryNotFoundError) throw new ProblemError('not_found');
    if (error instanceof LibraryConflictError || error instanceof CopyConflictError) throw new ProblemError('conflict');
    if (error instanceof LoanNotFoundError) throw new ProblemError('not_found');
    if (error instanceof LoanConflictError) throw new ProblemError('conflict');
    if (error instanceof LibraryEntryInvalidError) throw new ProblemError('invalid_request');
    if (error instanceof CopyInvalidError) throw new ProblemError('invalid_request');
    if (error instanceof LoanInvalidError) throw new ProblemError('invalid_request');
    throw error;
  }
}
function entryView({
  subjectId,
  incarnationId,
  state,
  revision,
  createdAt,
  updatedAt,
}: Pick<Entry, 'subjectId' | 'incarnationId' | 'state' | 'revision' | 'createdAt' | 'updatedAt'>) {
  return {
    subjectId,
    ...(incarnationId === undefined ? {} : { incarnationId }),
    state,
    revision,
    createdAt,
    updatedAt,
  };
}
function shelfEntryView(entry: ShelfEntry) {
  const { lastActivityAt, finishedAt, activeProgressSession: session } = entry;
  return {
    ...entryView(entry),
    ...(entry.personalScore === undefined ? {} : { personalScore: entry.personalScore }),
    ...(entry.titleCoverage === undefined ? {} : { titleCoverage: entry.titleCoverage }),
    lastActivityAt,
    finishedAt,
    activeProgressSession:
      session === null
        ? null
        : {
            id: session.id,
            subjectId: session.subjectId,
            versionSubjectId: session.versionSubjectId,
            mode: session.mode,
            unit: session.unit,
            total: session.total,
            amount: session.amount,
            locator: session.locator,
            position: session.position,
            completedUnitCount: session.completedUnitCount,
            state: session.state,
            revision: session.revision,
            startedAt: session.startedAt,
            completedAt: session.completedAt,
          },
  };
}
function copyView({ id, subjectId, kind, status, revision, location, source, acquiredOn, disposedOn, note }: Copy) {
  return {
    id,
    subjectId,
    ...(kind === undefined ? {} : { kind }),
    status,
    revision,
    location,
    source,
    acquiredOn,
    disposedOn,
    note,
  };
}
function copyInventoryView(filterOptions: CopyInventory) {
  return {
    kinds: { ...filterOptions.kinds, choices: [...filterOptions.kinds.choices] },
    statuses: { ...filterOptions.statuses, choices: [...filterOptions.statuses.choices] },
  };
}
function copyListContextView(context: CopyListContext): Static<typeof copyListContextSchema> {
  switch (context.state) {
    case 'available':
      return {
        state: 'available',
        work: context.work.map((item) => ({ ...item, labels: { ...item.labels } })),
        facts: { ...context.facts },
      };
    case 'unsupported':
      return { state: 'unsupported', facts: { ...context.facts } };
    case 'scope':
      return { state: 'scope' };
    case 'withheld':
      return { state: 'withheld' };
    case 'missing':
      return { state: 'missing' };
    case 'unavailable':
      return { state: 'unavailable' };
  }
}
function copyPresentationView(presentation: CopyPresentation): Static<typeof copyPresentationSchema> {
  return {
    ...presentation,
    statusEditing:
      presentation.statusEditing.state === 'supported'
        ? { ...presentation.statusEditing, statuses: [...presentation.statusEditing.statuses] }
        : presentation.statusEditing,
    conditionEditing:
      presentation.conditionEditing.state === 'supported'
        ? {
            state: 'supported',
            currentness: 'current',
            choices: COPY_CONDITION_CHOICES.map((choice) => ({ ...choice })),
          }
        : presentation.conditionEditing,
  };
}
function loanView(
  loan: Loan,
  boundary: LoanDueBoundary,
  people: ReadonlyMap<string, string | null>,
  copyAvailable = true,
): LoanResponse {
  const state = loanState(loan, boundary);
  const reason: LoanResponse['actions']['extend']['reason'] =
    state === 'returned' ? 'returned' : copyAvailable ? null : 'copy_unavailable';
  const action: LoanResponse['actions']['extend'] = { allowed: reason === null, reason };
  const counterparty =
    loan.counterparty.kind === 'name'
      ? { kind: 'name' as const, name: loan.counterparty.name }
      : people.get(loan.counterparty.personId)
        ? {
            kind: 'person' as const,
            state: 'available' as const,
            personId: loan.counterparty.personId,
            displayName: people.get(loan.counterparty.personId)!,
          }
        : { kind: 'person' as const, state: 'concealed' as const };
  return {
    id: loan.id,
    copyId: loan.copyId,
    direction: loan.direction,
    counterparty,
    startedOn: loan.startedOn,
    dueOn: loan.dueOn,
    returnedOn: loan.returnedOn,
    revision: loan.revision,
    state,
    viewer: { state: 'owner' as const },
    actions: { extend: action, return: action },
  };
}
function followView({ targetId, targetType, state, reason, updatedAt }: Follow) {
  return { targetId, targetType, state, reason, updatedAt };
}

/** Private account-owned library transport. Domain commands retain authorization and receipts. */
export function personalLibraryRoutes(app: ReturnType<typeof definitionRoutes>, dependencies: Dependencies) {
  const config = () => ({ ...dependencies, access: dependencies.access() });
  const entries = () => createEntryCommands(config());
  const corrections = () =>
    createEntryAnnotationCorrectionCommands({
      pool: dependencies.pool,
      ...(dependencies.clock === undefined ? {} : { clock: dependencies.clock }),
      entries: () => entries(),
    });
  const copies = () => createCopyCommands(config());
  const loans = () => createLoanCommands(config());
  const loanRequest = <T>(
    operation: LoanHttpOperation,
    actor: Actor,
    request: Request,
    deadline: number,
    input: unknown,
    dispatch: () => Promise<T>,
  ) =>
    withLoanHttpWork(
      dependencies.loanHttpWork,
      Object.freeze({ operation, actor, request, deadline, input, workerAllowance: 0 as const }),
      dispatch,
    );
  const follows = () => createFollowCommands(config());
  const shelves = (operation: keyof ShelfReads) => {
    if (!dependencies.shelves) throw new ShelfContractNotImplementedError(operation);
    return dependencies.shelves();
  };
  const shelfOwner = (actor: Actor) => {
    const owner = account(actor);
    if (!owner.scopes.includes('library_entry:list')) throw new ProblemError('forbidden');
  };
  async function withLibraryViewerFacts<T extends { libraryEntries: readonly { subjectId: string }[] }>(
    viewer: Actor,
    result: T,
    deadline: number,
    revalidate?: () => Promise<void>,
  ) {
    if (viewer.kind !== 'account' || result.libraryEntries.length === 0) return result;
    const rows = result.libraryEntries.map((entry, index) => ({ rowKey: String(index), subjectId: entry.subjectId }));
    const facts = await readViewerFactsPage(config(), viewer, rows, STANDARD_QUESTION_ID, deadline);
    await revalidate?.();
    return { ...result, viewerFacts: facts };
  }
  async function attachLibraryListFacts<T extends { subjectId: string }>(
    actor: Actor,
    rows: readonly T[],
    deadline: number,
    languages: readonly string[] | undefined,
    revalidate: () => Promise<void>,
  ) {
    return attachCollectionListFacts({ ...config(), actor, deadline }, rows, {
      ...(languages === undefined ? {} : { languages }),
      revalidate,
    });
  }
  return app
    .post(
      '/v1/libraryEntryAnnotationCorrections',
      {
        body: t.Object({ items: t.Array(correctionSelectionSchema, { minItems: 1, maxItems: 16 }) }, closed),
        response: {
          201: correctionPageResponse,
          ...failures,
          409: problemSchema('library_entry_annotation_correction_limit'),
        },
        detail: personalDetail('library_entry_annotation_correction.create', 'library_entry:update'),
      },
      async ({ actor, body, admission, job, set }) => {
        set.headers['cache-control'] = 'private, no-store';
        account(actor);
        for (const selected of body.items) point(actor, selected.subjectId, 'library_entry:update');
        const review = await admission.run('normal', job, () =>
          correctionCommand(() => corrections().create(actor, body)),
        );
        set.status = 201;
        return { review: { ...review, items: [...review.items] } } satisfies Static<typeof correctionPageResponse>;
      },
    )
    .get(
      '/v1/libraryEntryAnnotationCorrections/:reviewId',
      {
        params: t.Object({ reviewId: id }, closed),
        query: t.Object({ page: t.Optional(t.Integer({ minimum: 0, maximum: 3, default: 0 })) }, closed),
        response: { 200: correctionPageResponse, ...failures },
        detail: detail('library_entry_annotation_correction.read', 'library_entry:read'),
      },
      async ({ actor, params, query, admission, job, set }) => {
        set.headers['cache-control'] = 'private, no-store';
        account(actor);
        point(actor, params.reviewId, 'library_entry:read');
        const review = await admission.run('normal', job, () =>
          correctionCommand(() => corrections().readPage(actor, params.reviewId, query.page)),
        );
        return { review: { ...review, items: [...review.items] } } satisfies Static<typeof correctionPageResponse>;
      },
    )
    .post(
      '/v1/libraryEntryAnnotationCorrections/:reviewId/confirm',
      {
        params: t.Object({ reviewId: id }, closed),
        body: t.Object({ epoch: incarnationId, position: t.Integer({ minimum: 0, maximum: 15 }) }, closed),
        response: {
          200: correctionPageResponse,
          ...failures,
          409: problemSchema(
            'conflict',
            'library_entry_annotation_correction_epoch',
            'library_entry_annotation_correction_expired',
          ),
        },
        detail: personalDetail('library_entry_annotation_correction.confirm_item', 'library_entry:update'),
      },
      async ({ actor, params, body, admission, job, session, set }) => {
        set.headers['cache-control'] = 'private, no-store';
        account(actor);
        point(actor, params.reviewId, 'library_entry:update');
        const result = await admission.run('normal', job, () =>
          correctionCommand(() => corrections().confirmItem(actor, params.reviewId, body.epoch, body.position)),
        );
        if (result.commandOutcome) session.record(result.commandOutcome);
        return { review: { ...result.page, items: [...result.page.items] } } satisfies Static<
          typeof correctionPageResponse
        >;
      },
    )
    .post(
      '/v1/libraryEntryAnnotationCorrections/:reviewId/cancel',
      {
        params: t.Object({ reviewId: id }, closed),
        body: t.Object({ epoch: incarnationId }, closed),
        response: {
          200: t.Object(
            {
              reviewId: id,
              epoch: id,
              state: t.Union([t.Literal('open'), t.Literal('confirmed'), t.Literal('cancelled'), t.Literal('expired')]),
              expiresAt: id,
            },
            closed,
          ),
          ...failures,
          409: problemSchema(
            'library_entry_annotation_correction_epoch',
            'library_entry_annotation_correction_expired',
          ),
        },
        detail: personalDetail('library_entry_annotation_correction.cancel', 'library_entry:update'),
      },
      async ({ actor, params, body, admission, job, set }) => {
        set.headers['cache-control'] = 'private, no-store';
        account(actor);
        point(actor, params.reviewId, 'library_entry:update');
        const review = await admission.run('normal', job, () =>
          correctionCommand(() => corrections().cancel(actor, params.reviewId, body.epoch)),
        );
        return review;
      },
    )
    .post(
      '/v1/libraryShelfTitlePreparation',
      {
        headers,
        response: { 200: shelfTitlePreparationSchema, ...shelfFailures },
        detail: detail('library_shelf_title.prepare', 'library_entry:list', true),
      },
      async ({ actor, headers: requestHeaders, admission, job, set, request }) => {
        shelfOwner(actor);
        set.headers['cache-control'] = 'private, no-store';
        return admission.run('normal', job, () =>
          command(() =>
            createShelfTitlePreparation(config())(
              actor,
              idempotencyKeyOf(requestHeaders['idempotency-key']),
              languageRanges(request.headers.get('accept-language')),
            ),
          ),
        );
      },
    )
    .post(
      '/v1/libraryShelfScorePreparation',
      {
        headers,
        response: { 200: shelfScorePreparationSchema, ...shelfFailures },
        detail: detail('library_shelf_score.prepare', 'library_entry:list', true),
      },
      async ({ actor, headers: requestHeaders, admission, job, set }) => {
        shelfOwner(actor);
        set.headers['cache-control'] = 'private, no-store';
        return admission.run('normal', job, () =>
          command(() =>
            createShelfScorePreparation(config())(actor, idempotencyKeyOf(requestHeaders[IDEMPOTENCY_HEADER])),
          ),
        );
      },
    )
    .get(
      '/v1/libraryEntries',
      {
        query: t.Object(
          {
            ...shelfListQuerySchema.properties,
            state: t.Optional(stateInput),
            orderBy: t.Optional(shelfListQuerySchema.properties.orderBy),
          },
          closed,
        ),
        response: {
          200: t.Object(
            {
              libraryEntries: t.Array(
                t.Union([shelfEntrySchema, embedded(entrySchema, { ...subjectFields, facts: listFacts })]),
              ),
              scoreQuestion: t.Optional(shelfScoreQuestionSchema),
              next: nullable,
              viewerFacts: t.Optional(viewerFactsResponseSchema),
            },
            closed,
          ),
          ...shelfFailures,
        },
        detail: detail('library_entry.list', 'library_entry:list'),
      },
      async ({ actor, query, admission, job, set, request }) => {
        set.headers['cache-control'] = 'private, no-store';
        account(actor);
        const languages = languageRanges(request.headers.get('accept-language'));
        if (query.orderBy !== undefined) {
          shelfOwner(actor);
          const pageQuery = basicQuery(query);
          const readPage = () =>
            admission.run('normal', job, async () => {
              await admitShelfRead({ ...config(), clock: dependencies.clock ?? systemClock }, actor, job.deadline);
              return command(() =>
                shelves('listShelf').listShelf(actor, {
                  ...pageQuery,
                  ...(query.orderBy === 'title' ? { languages } : {}),
                }),
              );
            });
          const result = await readPage();
          const revalidate = async () => assertShelfPageCurrent(result, await readPage());
          const libraryEntries =
            query.view === 'FULL'
              ? await attachLibraryListFacts(
                  actor,
                  result.entries.map(shelfEntryView),
                  job.deadline,
                  languages,
                  revalidate,
                )
              : result.entries.map(shelfEntryView);
          const response = {
            libraryEntries,
            ...(result.scoreQuestion ? { scoreQuestion: result.scoreQuestion } : {}),
            next: result.next,
          };
          return withLibraryViewerFacts(actor, response, job.deadline, revalidate);
        }
        if (query.direction !== undefined || query.type !== undefined) throw new ProblemError('invalid_request');
        const { orderBy: _orderBy, direction: _direction, type: _type, ...oldQuery } = query;
        const pageQuery = basicQuery(oldQuery);
        const readPage = () =>
          admission.run('normal', job, () => command(() => entries().listEntries(actor, pageQuery)));
        const result = await readPage();
        const revalidate = async () => assertShelfPageCurrent(result, await readPage());
        const libraryEntries =
          query.view === 'FULL'
            ? await attachLibraryListFacts(actor, result.entries.map(entryView), job.deadline, languages, revalidate)
            : result.entries.map(entryView);
        const response = { libraryEntries, next: result.next };
        return withLibraryViewerFacts(actor, response, job.deadline, revalidate);
      },
    )
    .get(
      '/v1/libraryShelfSummary',
      {
        query: shelfSummaryQuerySchema,
        response: { 200: shelfSummarySchema, ...shelfFailures },
        detail: detail('library_shelf.summary', 'library_entry:list'),
      },
      async ({ actor, query, admission, job }) => {
        shelfOwner(actor);
        return admission.run('normal', job, () => command(() => shelves('summary').summary(actor, query)));
      },
    )
    .get(
      '/v1/libraryShelfTypes',
      {
        query: shelfTypesQuerySchema,
        response: { 200: shelfTypesSchema, ...shelfFailures },
        detail: detail('library_shelf.types', 'library_entry:list'),
      },
      async ({ actor, query, admission, job }) => {
        shelfOwner(actor);
        return admission.run('normal', job, () => command(() => shelves('listTypes').listTypes(actor, query)));
      },
    )
    .get(
      '/v1/libraryEntries/:subjectId',
      {
        query: t.Object(viewQuery, closed),
        params: t.Object({ subjectId: id }),
        response: { 200: t.Object({ libraryEntry: embedded(entrySchema, subjectFields) }, closed), ...failures },
        detail: detail('library_entry.get', 'library_entry:read'),
      },
      async ({ actor, params, query, admission, job }) => {
        point(actor, params.subjectId, 'library_entry:read');
        return fullView(config(), actor, query.view, {
          libraryEntry: entryView(
            await admission.run('normal', job, () =>
              command(() => entries().readEntry(actor, params.subjectId), 'not_found'),
            ),
          ),
        });
      },
    )
    .get(
      '/v1/libraryEntries/:subjectId/state-history',
      {
        params: t.Object({ subjectId: id }),
        query: t.Object(
          {
            cursor: t.Optional(t.String({ maxLength: 4096 })),
            limit: t.Optional(t.Integer({ minimum: 1, maximum: 50, default: 20 })),
          },
          closed,
        ),
        response: { 200: entryStateHistorySchema, ...failures },
        detail: detail('library_entry_state_history.list', 'library_entry:read'),
      },
      async ({ actor, params, query, admission, job }) => {
        point(actor, params.subjectId, 'library_entry:read');
        return admission.run('normal', job, () =>
          command(() => entries().listEntryStateHistory(actor, params.subjectId, query), 'not_found'),
        );
      },
    )
    .get(
      '/v1/libraryEntries/:subjectId/state-history/:changeRevision',
      {
        params: t.Object({ subjectId: id, changeRevision: t.Numeric({ minimum: 1, maximum: 2_147_483_646 }) }),
        response: { 200: entryStateReviewSchema, ...failures },
        detail: detail('library_entry_state_history.review', 'library_entry:read'),
      },
      async ({ actor, params, admission, job }) => {
        point(actor, params.subjectId, 'library_entry:read');
        return admission.run('normal', job, () =>
          command(() => entries().reviewEntryStateChange(actor, params.subjectId, params.changeRevision), 'not_found'),
        );
      },
    )
    .post(
      customMethod('/v1/libraryEntries/:subjectId/state-history/:changeRevision', 'restore'),
      {
        params: t.Object({ subjectId: id, changeRevision: t.Numeric({ minimum: 1, maximum: 2_147_483_646 }) }),
        headers,
        body: t.Object({ incarnationId, currentRevision: revision }, closed),
        response: {
          200: entryResponse,
          ...failures,
          409: problemSchema(
            'library_entry_state_restore_stale',
            'library_entry_state_restore_unavailable',
            'library_entry_state_restore_unchanged',
          ),
          422: problemSchema('idempotency_conflict'),
        },
        detail: personalDetail('library_entry_state_history.restore', 'library_entry:update'),
      },
      async ({ actor, params, body, headers, admission, job, session }) => {
        account(actor);
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        const result = await admission.run('normal', job, () =>
          command(async () => {
            try {
              return await entries().restoreEntryState(actor, params.subjectId, params.changeRevision, body, key);
            } catch (error) {
              if (error instanceof LibraryEntryStateRestoreConflictError) {
                const codes = {
                  stale: 'library_entry_state_restore_stale',
                  unavailable: 'library_entry_state_restore_unavailable',
                  unchanged: 'library_entry_state_restore_unchanged',
                } as const;
                throw new ProblemError(codes[error.reason]);
              }
              throw error;
            }
          }),
        );
        session.record(result);
        return { libraryEntry: entryView(result.value.entry) };
      },
    )
    .get(
      '/v1/libraryEntries/:subjectId/personal',
      {
        params: t.Object({ subjectId: id }, closed),
        response: { 200: personalEntryResponse, ...failures },
        detail: detail('library_entry_personal.get', 'library_entry:read'),
      },
      async ({ actor, params, admission, job, set }) => {
        point(actor, params.subjectId, 'library_entry:read');
        const personalEntry = await admission.run('normal', job, () =>
          personalCommand(() => entries().readPersonalEntry(actor, params.subjectId)),
        );
        set.headers['cache-control'] = 'private, no-store';
        return {
          personalEntry: {
            ...personalEntry,
            sourceObservations: personalEntry.sourceObservations.map((observation) => ({ ...observation })),
          },
        } satisfies Static<typeof personalEntryResponse>;
      },
    )
    .put(
      '/v1/libraryEntries/:subjectId/annotations',
      {
        params: t.Object({ subjectId: id }, closed),
        headers,
        body: t.Object(
          {
            revision: personalRevision,
            note: personalChange(t.String({ minLength: 1, maxLength: MAX_PERSONAL_NOTE_BYTES })),
            priority: personalChange(t.Integer({ minimum: 1, maximum: MAX_PERSONAL_PRIORITY })),
            entryGuard: t.Optional(t.Object({ incarnationId, currentRevision: revision }, closed)),
          },
          closed,
        ),
        response: {
          200: personalEntryResponse,
          ...failures,
          409: problemSchema('conflict'),
          422: problemSchema('idempotency_conflict'),
        },
        detail: personalDetail('library_entry_annotation.put', 'library_entry:update'),
      },
      async ({ actor, params, body, headers, admission, job, session, set }) => {
        account(actor);
        const result = await admission.run('normal', job, () =>
          personalCommand(() =>
            entries().saveAnnotations(actor, params.subjectId, body, idempotencyKeyOf(headers[IDEMPOTENCY_HEADER])),
          ),
        );
        session.record(result);
        set.headers['cache-control'] = 'private, no-store';
        return {
          personalEntry: {
            ...result.value,
            sourceObservations: result.value.sourceObservations.map((observation) => ({ ...observation })),
          },
        } satisfies Static<typeof personalEntryResponse>;
      },
    )
    .post(
      '/v1/libraryEntries/:subjectId/sourceObservations',
      {
        params: t.Object({ subjectId: id }, closed),
        headers,
        body: t.Object(
          {
            provider: t.String({ minLength: 1, maxLength: 64 }),
            recordId: t.String({ minLength: 1, maxLength: 192 }),
            confirmReviewed: t.Literal(true),
            privacy: personalPrivacyValue,
            sourceCreated: personalTimestampValue,
            sourceUpdated: personalTimestampValue,
          },
          closed,
        ),
        response: {
          201: personalObservationResponse,
          ...failures,
          409: problemSchema('conflict'),
          422: problemSchema('idempotency_conflict'),
        },
        detail: personalDetail('library_entry_source_observation.post', 'library_entry:update'),
      },
      async ({ actor, params, body, headers, admission, job, session, set }) => {
        account(actor);
        const result = await admission.run('normal', job, () =>
          personalCommand(() =>
            entries().admitSourceObservation(
              actor,
              params.subjectId,
              body,
              idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]),
            ),
          ),
        );
        session.record(result);
        set.status = 201;
        set.headers['cache-control'] = 'private, no-store';
        return {
          sourceObservation: { ...result.value.sourceObservation },
        } satisfies Static<typeof personalObservationResponse>;
      },
    )
    .patch(
      '/v1/libraryEntries/:subjectId/sourceObservations',
      {
        params: t.Object({ subjectId: id }, closed),
        headers,
        body: t.Object(
          {
            provider: t.String({ minLength: 1, maxLength: 64 }),
            recordId: t.String({ minLength: 1, maxLength: 192 }),
            revision,
            confirmReviewed: t.Literal(true),
            privacy: personalChange(personalPrivacyValue),
            sourceCreated: personalChange(personalTimestampValue),
            sourceUpdated: personalChange(personalTimestampValue),
          },
          closed,
        ),
        response: {
          200: personalObservationResponse,
          ...failures,
          409: problemSchema('conflict'),
          422: problemSchema('idempotency_conflict'),
        },
        detail: personalDetail('library_entry_source_observation.patch', 'library_entry:update'),
      },
      async ({ actor, params, body, headers, admission, job, session, set }) => {
        account(actor);
        const result = await admission.run('normal', job, () =>
          personalCommand(() =>
            entries().correctSourceObservation(
              actor,
              params.subjectId,
              body,
              idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]),
            ),
          ),
        );
        session.record(result);
        set.headers['cache-control'] = 'private, no-store';
        return {
          sourceObservation: { ...result.value.sourceObservation },
        } satisfies Static<typeof personalObservationResponse>;
      },
    )
    .put(
      '/v1/libraryEntries/:subjectId',
      {
        params: t.Object({ subjectId: id }),
        headers,
        body: t.Object(
          { state: stateInput, revision: t.Optional(revision), incarnationId: t.Optional(incarnationId) },
          closed,
        ),
        response: {
          200: entryResponse,
          201: entryResponse,
          ...failures,
          422: problemSchema('idempotency_conflict', 'unsupported_library_profile'),
          503: problemSchema(
            'semantic_not_ready',
            'overloaded',
            'partition_unavailable',
            'transaction_retry_exhausted',
            'deadline_exceeded',
          ),
        },
        detail: personalDetail('library_entry.put', 'library_entry:update'),
      },
      async ({ actor, params, body, headers, admission, job, session, set }) => {
        account(actor);
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        const result = await admission.run('normal', job, () =>
          command(() => entries().putEntry(actor, params.subjectId, body, key)),
        );
        session.record(result);
        // The receipt stores created. A replay answers that status and does not recompute it.
        if (result.value.created) set.status = 201;
        return { libraryEntry: entryView(result.value.entry) };
      },
    )
    .delete(
      '/v1/libraryEntries/:subjectId',
      {
        params: t.Object({ subjectId: id }),
        headers,
        query: t.Object({ revision: t.Optional(revision), incarnationId: t.Optional(incarnationId) }, closed),
        response: { 204: t.Void(), ...failures },
        detail: {
          ...personalDetail('library_entry.delete', 'library_entry:delete'),
          responses: {
            204: {
              description: 'Entry cleared',
              headers: {
                'Library-Entry-Deletion-Id': { schema: { type: 'string', format: 'uuid' } },
                'Library-Entry-Deletion-Revision': { schema: { type: 'string', pattern: '^[1-9][0-9]*$' } },
              },
            },
          },
        },
      },
      async ({ actor, params, query, headers, admission, job, session, set }) => {
        account(actor);
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        const result = await admission.run('normal', job, () =>
          command(async () => {
            if (query.revision === undefined) throw new ProblemError('conflict');
            return entries().deleteEntry(actor, params.subjectId, query.revision, key, query.incarnationId);
          }),
        );
        session.record(result);
        if ('deletionId' in result.value) {
          set.headers['Library-Entry-Deletion-Id'] = result.value.deletionId;
          set.headers['Library-Entry-Deletion-Revision'] = String(result.value.revision);
        }
        set.status = 204;
      },
    )
    .post(
      customMethod('/v1/libraryEntries/:subjectId', 'restore'),
      {
        params: t.Object({ subjectId: id }),
        headers,
        body: t.Object({ deletionId: t.String({ format: 'uuid' }), revision }, closed),
        response: {
          200: entryResponse,
          ...failures,
          409: problemSchema(
            'library_entry_restore_occupied',
            'library_entry_restore_stale',
            'library_entry_restore_expired',
          ),
        },
        detail: detail('library_entry.restore', 'library_entry:update', true),
      },
      async ({ actor, params, body, headers, admission, job, session }) => {
        account(actor);
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        const result = await admission.run('normal', job, () =>
          command(async () => {
            try {
              return await entries().restoreEntry(actor, params.subjectId, body, key);
            } catch (error) {
              if (error instanceof LibraryEntryLifecycleConflictError) {
                const codes = {
                  occupied: 'library_entry_restore_occupied',
                  stale: 'library_entry_restore_stale',
                  expired: 'library_entry_restore_expired',
                } as const;
                throw new ProblemError(codes[error.reason]);
              }
              throw error;
            }
          }),
        );
        session.record(result);
        return { libraryEntry: entryView(result.value.entry) };
      },
    )
    .post(
      '/v1/copies',
      {
        headers,
        body: t.Object(
          {
            ...copyFields,
            subjectId: id,
            kind: t.Optional(
              t.String({
                ...libraryVocabularyIdSchema,
                description: 'Declared kind required for a fresh create; optional only for replay of an old receipt.',
              }),
            ),
            status: t.Optional(
              t.String({
                ...statusInput,
                description: 'Declared status required for a fresh create; optional only for replay of an old receipt.',
              }),
            ),
          },
          closed,
        ),
        response: { 201: copyResponse, ...failures },
        detail: detail('copy.create', 'copy:create', true),
      },
      async ({ actor, body, headers, admission, job, session, set }) => {
        account(actor);
        if (routeOf(body.subjectId) === null) throw new ProblemError('not_found');
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        const result = await admission.run('normal', job, () => command(() => copies().createCopy(actor, body, key)));
        session.record(result);
        set.status = 201;
        return { copy: copyView(result.value) };
      },
    )
    .get(
      '/v1/copies',
      {
        query: t.Object(
          {
            ...pageQuery,
            subjectId: t.Optional(t.String({ format: 'uuid' })),
            kind: t.Optional(libraryVocabularyIdSchema),
            status: t.Optional(libraryVocabularyIdSchema),
          },
          closed,
        ),
        response: {
          200: t.Object(
            {
              copies: t.Array(embedded(copySchema, { ...subjectFields, context: t.Optional(copyListContextSchema) })),
              next: nullable,
              filterOptions: copyInventorySchema,
            },
            closed,
          ),
          413: problemSchema('content_too_large'),
          ...failures,
        },
        detail: detail('copy.list', 'copy:list'),
      },
      async ({ actor, query, admission, job, request }) => {
        account(actor);
        const pageQuery = basicQuery(query);
        const languages = languageRanges(request.headers.get('accept-language'));
        const readPage = () =>
          admission.run('normal', job, () =>
            command(() => copies().listCopiesWithObservation(actor, pageQuery, languages)),
          );
        const result = await readPage();
        if (query.view !== 'FULL' || result.copies.length === 0)
          return fullView(config(), actor, query.view, {
            copies: result.copies.map(copyView),
            next: result.next,
            filterOptions: copyInventoryView(result.filterOptions),
          });

        const copiesPage = await attachCopyListContext(
          { ...config(), actor, deadline: job.deadline },
          result.copies.map(copyView),
          {
            languages: languageRanges(request.headers.get('accept-language')),
            async revalidate() {
              const current = await readPage();
              if (
                JSON.stringify(current.copies) !== JSON.stringify(result.copies) ||
                Boolean(current.next) !== Boolean(result.next) ||
                JSON.stringify(current.filterOptions) !== JSON.stringify(result.filterOptions) ||
                current.accountEpoch !== result.accountEpoch
              )
                throw new ProblemError('semantic_not_ready');
            },
          },
        );
        return {
          copies: copiesPage.map((copy) => ({ ...copy, context: copyListContextView(copy.context) })),
          next: result.next,
          filterOptions: copyInventoryView(result.filterOptions),
        };
      },
    )
    .get(
      '/v1/copies/:copyId',
      {
        query: t.Object({ ...viewQuery, presentation: t.Optional(t.Literal('FULL')) }, closed),
        params: t.Object({ copyId: id }),
        response: {
          200: t.Object(
            { copy: embedded(copySchema, { ...subjectFields, presentation: t.Optional(copyPresentationSchema) }) },
            closed,
          ),
          ...failures,
          503: problemSchema(
            'semantic_not_ready',
            'dependency_unavailable',
            'overloaded',
            'partition_unavailable',
            'transaction_retry_exhausted',
            'deadline_exceeded',
          ),
        },
        detail: {
          ...detail('copy.get', 'copy:read'),
          'x-authority-anchor': 'own-account',
          'x-authority-resource-types': Object.keys(bundledRelease.types),
        },
      },
      async ({ actor, params, query, admission, job, request, set }) => {
        point(actor, params.copyId, 'copy:read');
        set.headers['cache-control'] = 'private, no-store';
        if (query.presentation === 'FULL') {
          return admission.run('normal', job, () =>
            command(
              () =>
                copies().readPresentedCopy(
                  actor,
                  params.copyId,
                  languageRanges(request.headers.get('accept-language')),
                  async (copy, presentation, disclosure) => {
                    const editing = presentation.statusEditing;
                    const value = {
                      ...copyView(copy),
                      presentation: copyPresentationView(presentation),
                    };
                    if (query.view !== 'FULL') return { copy: value };
                    const subject = disclosure.subject
                      ? ((await fullView(config(), actor, 'FULL', { reference: { subjectId: copy.subjectId } }))
                          .reference.subject ?? null)
                      : null;
                    return { copy: { ...value, subject } };
                  },
                ),
              'not_found',
            ),
          );
        }
        return fullView(config(), actor, query.view, {
          copy: copyView(
            await admission.run('normal', job, () =>
              command(() => copies().readCopy(actor, params.copyId), 'not_found'),
            ),
          ),
        });
      },
    )
    .patch(
      '/v1/copies/:copyId',
      {
        params: t.Object({ copyId: id }),
        headers,
        body: t.Object({ ...copyFields, revision: t.Optional(revision) }, closed),
        response: { 200: copyResponse, ...failures },
        detail: detail('copy.update', 'copy:update', true),
      },
      async ({ actor, params, body, headers, admission, job, session }) => {
        account(actor);
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        const result = await admission.run('normal', job, () =>
          command(async () => {
            if (body.revision === undefined) {
              await copies().readCopy(actor, params.copyId);
              throw new ProblemError('conflict');
            }
            return copies().updateCopy(actor, params.copyId, body, key);
          }),
        );
        session.record(result);
        return { copy: copyView(result.value) };
      },
    )
    .delete(
      '/v1/copies/:copyId',
      {
        params: t.Object({ copyId: id }),
        query: t.Object({ revision: t.Optional(revision) }, closed),
        headers,
        response: { 204: t.Void(), ...failures },
        detail: {
          ...detail('copy.delete', 'copy:delete', true),
          responses: {
            204: {
              description: 'Copy cleared',
              headers: {
                'Library-Copy-Deletion-Id': { schema: { type: 'string', format: 'uuid' } },
                'Library-Copy-Deletion-Revision': { schema: { type: 'string', pattern: '^[1-9][0-9]*$' } },
              },
            },
          },
        },
      },
      async ({ actor, params, query, headers, admission, job, session, set }) => {
        account(actor);
        point(actor, params.copyId, 'copy:delete');
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        const result = await admission.run('normal', job, () =>
          command(() => copies().deleteCopy(actor, params.copyId, query.revision, key), 'not_found'),
        );
        session.record(result);
        set.headers['Library-Copy-Deletion-Id'] = result.transactionId;
        set.headers['Library-Copy-Deletion-Revision'] = String(result.value.revision + 1);
        set.status = 204;
      },
    )
    .post(
      customMethod('/v1/copies/:copyId', 'restore'),
      {
        params: t.Object({ copyId: id }),
        headers,
        body: t.Object({ deletionId: incarnationId, revision }, closed),
        response: {
          200: copyResponse,
          ...failures,
          409: problemSchema('copy_restore_stale', 'copy_restore_occupied', 'copy_restore_expired'),
        },
        detail: detail('copy.restore', 'copy:update', true),
      },
      async ({ actor, params, body, headers, admission, job, session }) => {
        account(actor);
        point(actor, params.copyId, 'copy:update');
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        const result = await admission.run('normal', job, () =>
          command(() => copies().restoreCopy(actor, params.copyId, body, key), 'not_found'),
        );
        session.record(result);
        return { copy: copyView(result.value) };
      },
    )
    .get(
      '/v1/copy-loans',
      {
        query: t.Object(
          {
            filter: t.Optional(t.Union([t.Literal('open'), t.Literal('history')])),
            cursor: t.Optional(t.String({ maxLength: 4096 })),
            limit: t.Optional(t.Integer({ minimum: 1, maximum: 100 })),
          },
          closed,
        ),
        response: { 200: loanListResponse, ...loanWriteFailures },
        detail: detail('copy_loan.list', 'copy:list'),
      },
      async ({ actor, query, admission, job, request, set }) => {
        const owner = account(actor);
        if (!owner.scopes.includes('copy:list')) throw new ProblemError('forbidden');
        set.headers['cache-control'] = 'private, no-store';
        const filter = query.filter ?? 'open';
        const requestInput = {
          filter,
          limit: query.limit ?? 20,
          ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
        };
        return loanRequest('list', actor, request, job.deadline, requestInput, async () => {
          const readPage = () =>
            admission.run('normal', job, () => command(() => loans().listLoans(actor, requestInput, job.deadline)));
          const page = await readPage();
          const membership = (value: typeof page) =>
            JSON.stringify(
              value.items.map((item) => [item.loan.id, item.loan.revision, item.copy.revision, item.copy.state]),
            );
          const revalidate = async () => {
            const current = await readPage();
            if (
              current.generation !== page.generation ||
              current.nextCursor !== page.nextCursor ||
              membership(current) !== membership(page)
            )
              throw new ProblemError('stale_cursor');
          };
          const languages = languageRanges(request.headers.get('accept-language'));
          const personIds = page.items.flatMap((item) =>
            item.loan.counterparty.kind === 'person' ? [item.loan.counterparty.personId] : [],
          );
          const people = await loanPeopleDisplay(config(), actor, personIds, job.deadline, languages);
          const selectedCopies = page.items.flatMap((item) =>
            item.copy.subjectId === null ? [] : [{ id: item.loan.id, subjectId: item.copy.subjectId }],
          );
          const contexts = await attachCopyListContext({ ...config(), actor, deadline: job.deadline }, selectedCopies, {
            languages,
            revalidate,
          });
          if (!selectedCopies.length) await revalidate();
          const contextByLoan = new Map(contexts.map((context) => [context.id, context]));
          return {
            filter: page.filter,
            boundary: page.boundary,
            generation: page.generation,
            nextCursor: page.nextCursor,
            items: page.items.map((item) => {
              const context = contextByLoan.get(item.loan.id);
              const copy = {
                state: item.copy.state,
                id: item.copy.id,
                revision: item.copy.revision,
                kind: item.copy.kind,
                status: item.copy.status,
                context: context
                  ? copyListContextView(context.context)
                  : {
                      state: item.copy.subjectId === null ? ('missing' as const) : ('unavailable' as const),
                    },
              };
              return {
                loan: loanView(item.loan, page.boundary, people, item.actions.extend.allowed),
                copy,
              };
            }),
          };
        });
      },
    )
    .post(
      '/v1/copy-loans',
      {
        headers,
        body: loanWriteBody,
        response: {
          201: t.Object({ loan: loanResponse, boundary: loanBoundaryResponse }, closed),
          ...loanWriteFailures,
        },
        detail: detail('copy_loan.create', 'copy:create', true),
      },
      async ({ actor, body, headers, admission, job, request, set, session }) => {
        account(actor);
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        return loanRequest('create', actor, request, job.deadline, body, async () => {
          const result = await admission.run('normal', job, () =>
            command(() => loans().createLoan(actor, body, key, job.deadline)),
          );
          session.record(result);
          set.status = 201;
          set.headers['cache-control'] = 'private, no-store';
          const boundary = loanDueBoundary((dependencies.clock ?? systemClock)());
          const people =
            result.value.counterparty.kind === 'person'
              ? await loanPeopleDisplay(
                  config(),
                  actor,
                  [result.value.counterparty.personId],
                  job.deadline,
                  languageRanges(request.headers.get('accept-language')),
                )
              : new Map<string, string | null>();
          return { loan: loanView(result.value, boundary, people), boundary };
        });
      },
    )
    .patch(
      '/v1/copy-loans/:loanId',
      {
        params: t.Object({ loanId: id }),
        headers,
        body: loanExtendBody,
        response: {
          200: t.Object({ loan: loanResponse, boundary: loanBoundaryResponse }, closed),
          ...loanWriteFailures,
        },
        detail: detail('copy_loan.extend', 'copy:update', true),
      },
      async ({ actor, params, body, headers, admission, job, request, set, session }) => {
        account(actor);
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        return loanRequest('extend', actor, request, job.deadline, { loanId: params.loanId, body }, async () => {
          const result = await admission.run('normal', job, () =>
            command(() => loans().extendLoan(actor, params.loanId, body, key, job.deadline)),
          );
          session.record(result);
          set.headers['cache-control'] = 'private, no-store';
          const boundary = loanDueBoundary((dependencies.clock ?? systemClock)());
          const people =
            result.value.counterparty.kind === 'person'
              ? await loanPeopleDisplay(
                  config(),
                  actor,
                  [result.value.counterparty.personId],
                  job.deadline,
                  languageRanges(request.headers.get('accept-language')),
                )
              : new Map<string, string | null>();
          return { loan: loanView(result.value, boundary, people), boundary };
        });
      },
    )
    .post(
      '/v1/copy-loans/:loanId/return',
      {
        params: t.Object({ loanId: id }),
        headers,
        body: loanReturnBody,
        response: {
          200: t.Object({ loan: loanResponse, boundary: loanBoundaryResponse }, closed),
          ...loanWriteFailures,
        },
        detail: detail('copy_loan.return', 'copy:update', true),
      },
      async ({ actor, params, body, headers, admission, job, request, set, session }) => {
        account(actor);
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        return loanRequest('return', actor, request, job.deadline, { loanId: params.loanId, body }, async () => {
          const result = await admission.run('normal', job, () =>
            command(() => loans().returnLoan(actor, params.loanId, body, key, job.deadline)),
          );
          session.record(result);
          set.headers['cache-control'] = 'private, no-store';
          const boundary = loanDueBoundary((dependencies.clock ?? systemClock)());
          const people =
            result.value.counterparty.kind === 'person'
              ? await loanPeopleDisplay(
                  config(),
                  actor,
                  [result.value.counterparty.personId],
                  job.deadline,
                  languageRanges(request.headers.get('accept-language')),
                )
              : new Map<string, string | null>();
          return { loan: loanView(result.value, boundary, people), boundary };
        });
      },
    )
    .get(
      '/v1/followCounts/outgoing',
      {
        query: t.Object({}, closed),
        response: {
          200: t.Object({ followingCount: t.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }) }, closed),
          ...failures,
          503: problemSchema('dependency_unavailable'),
        },
        detail: detail('follow_count.outgoing', 'follow:list'),
      },
      async ({ actor, admission, job, set }) => {
        const result = await admission.run('normal', job, () =>
          createFollowCountReads(config()).outgoing(actor, job.deadline),
        );
        set.headers['Cache-Control'] = 'private, no-store';
        return result;
      },
    )
    .get(
      '/v1/followCounts/:targetType/:targetId',
      {
        query: t.Object({}, closed),
        params: t.Object(
          { targetType: t.Union([t.Literal('subject'), t.Literal('collection'), t.Literal('space')]), targetId: id },
          closed,
        ),
        response: {
          200: t.Object(
            {
              targetType: t.Union([t.Literal('subject'), t.Literal('collection'), t.Literal('space')]),
              targetId: id,
              followerCount: t.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
            },
            closed,
          ),
          ...failures,
          503: problemSchema('dependency_unavailable'),
        },
        detail: detail('follow_count.target', 'follow:list'),
      },
      async ({ actor, params, admission, job, set }) => {
        const result = await admission.run('normal', job, () =>
          createFollowCountReads(config()).target(actor, params, job.deadline),
        );
        set.headers['Cache-Control'] = 'private, no-store';
        return result;
      },
    )
    .put(
      '/v1/follows/:targetId',
      {
        params: t.Object({ targetId: id }),
        headers,
        body: t.Optional(t.Never()),
        response: { 200: followResponse, ...failures },
        detail: personalDetail('follow.put', 'follow:create'),
      },
      async ({ actor, params, headers, admission, job, session, set }) => {
        set.headers['Cache-Control'] = 'private, no-store';
        account(actor);
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        return withFollowWork(job.deadline, async () => {
          const result = await admission.run('normal', job, () =>
            command(() => follows().follow(actor, params.targetId, key, job.deadline)),
          );
          if (result.command) session.record(result.command);
          return serializeFollowResponse({ follow: followView(result.follow) });
        });
      },
    )
    .delete(
      '/v1/follows/:targetId',
      {
        params: t.Object({ targetId: id }),
        headers,
        response: { 200: followResponse, ...failures },
        detail: personalDetail('follow.delete', 'follow:delete'),
      },
      async ({ actor, params, headers, admission, job, session, set }) => {
        set.headers['Cache-Control'] = 'private, no-store';
        account(actor);
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        return withFollowWork(job.deadline, async () => {
          const result = await admission.run('normal', job, () =>
            command(() => follows().unfollow(actor, params.targetId, key, job.deadline)),
          );
          if (result.command) session.record(result.command);
          return serializeFollowResponse({ follow: followView(result.follow) });
        });
      },
    )
    .get(
      '/v1/follows/:targetId',
      {
        query: t.Object(viewQuery, closed),
        params: t.Object({ targetId: id }),
        response: { 200: t.Object({ follow: embedded(followSchema, fullFollowFields) }, closed), ...failures },
        detail: detail('follow.get', 'follow:read'),
      },
      async ({ actor, params, query, admission, job, set }) => {
        set.headers['Cache-Control'] = 'private, no-store';
        point(actor, params.targetId, 'follow:read');
        return withFollowWork(job.deadline, () =>
          admission.run('normal', job, async () => {
            const follow = await command(() => follows().readFollow(actor, params.targetId, job.deadline), 'not_found');
            if (!follow) throw new ProblemError('not_found');
            return serializeFollowResponse(
              await fullView(
                config(),
                actor,
                query.view,
                { follow: followView(follow) },
                {
                  deadline: job.deadline,
                  ...(dependencies.followingSpaceTargets
                    ? { followingSpaces: dependencies.followingSpaceTargets }
                    : {}),
                  follow: true,
                },
              ),
            );
          }),
        );
      },
    )
    .get(
      '/v1/follows',
      {
        query: t.Object(
          {
            ...pageQuery,
            targetType: t.Optional(t.Enum({ subject: 'subject', collection: 'collection', space: 'space' } as const)),
          },
          closed,
        ),
        response: {
          200: t.Object({ follows: t.Array(embedded(followSchema, fullFollowFields)), next: nullable }, closed),
          ...failures,
        },
        detail: detail('follow.list', 'follow:list'),
      },
      async ({ actor, query, admission, job, set }) => {
        set.headers['Cache-Control'] = 'private, no-store';
        const owner = account(actor);
        if (!owner.scopes.includes('follow:list')) throw new ProblemError('forbidden');
        return withFollowWork(job.deadline, () =>
          admission.run('normal', job, () =>
            command(async () => {
              const route = routeOf(owner.accountId)!;
              const binding = {
                operation: 'follow.list',
                parameters: { accountId: owner.accountId, targetType: query.targetType ?? 'all', state: 'following' },
              };
              let after: FollowPageCursor | null = null;
              let cursorEpoch: number | null = null;
              if (query.cursor !== undefined) {
                const cursor = decodeCursor(dependencies.tokens, binding, query.cursor);
                if (
                  !cursor.ok ||
                  cursor.after.length !== 2 ||
                  typeof cursor.after[0] !== 'string' ||
                  !Number.isFinite(Date.parse(cursor.after[0])) ||
                  typeof cursor.after[1] !== 'string' ||
                  routeOf(cursor.after[1]) === null
                )
                  throw new ProblemError('invalid_cursor');
                cursorEpoch = cursor.epoch;
                after = { updatedAt: cursor.after[0], targetId: cursor.after[1] };
              }
              const partition = await withConnection(dependencies.pool, (client) =>
                readPartition(deadlineClient(client, job.deadline), partitionOf(route)),
              );
              if (query.cursor !== undefined && cursorEpoch !== partition?.epoch)
                throw new ProblemError('stale_cursor');
              const size = query.limit ?? 20;
              const targetType = query.targetType;
              const rows = await follows().listFollows(
                actor,
                {
                  cursor: after,
                  limit: Math.min(100, size + 1),
                  ...(targetType === undefined ? {} : { targetType }),
                },
                job.deadline,
              );
              const shown = rows.slice(0, size),
                last = shown.at(-1);
              let more = rows.length > size;
              if (!more && size === 100 && last)
                more =
                  (
                    await follows().listFollows(
                      actor,
                      {
                        cursor: last,
                        limit: 1,
                        ...(targetType === undefined ? {} : { targetType }),
                      },
                      job.deadline,
                    )
                  ).length > 0;
              return serializeFollowResponse(
                await fullView(
                  config(),
                  actor,
                  query.view,
                  {
                    follows: shown.map(followView),
                    next:
                      more && last && partition
                        ? encodeCursor(dependencies.tokens, binding, {
                            epoch: partition.epoch,
                            after: [last.updatedAt, last.targetId],
                          })
                        : null,
                  },
                  {
                    deadline: job.deadline,
                    follow: true,
                    ...(dependencies.followingSpaceTargets
                      ? { followingSpaces: dependencies.followingSpaceTargets }
                      : {}),
                  },
                ),
              );
            }),
          ),
        );
      },
    );
}
