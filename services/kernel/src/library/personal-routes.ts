import { createFollowCountReads } from './follow-count-reads.ts';
import { t } from 'elysia';
import type { TSchema } from 'typebox';
import { bundledRelease } from '@rezics/definitions/bundled';
import { customMethod } from '../http/custom-method.ts';
import type { Pool } from 'pg';
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
import { CopyConflictError, CopyInvalidError, createCopyCommands } from './copies.ts';
import {
  createEntryCommands,
  LibraryConflictError,
  LibraryEntryInvalidError,
  LibraryEntryLifecycleConflictError,
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
import { admitShelfRead } from './shelf-admission.ts';
import type { ShelfTypeDigest } from './shelf-type-keys.ts';
import { ShelfContractNotImplementedError, type ShelfEntry, type ShelfReads } from './shelf-contract.ts';
import { libraryStoredVocabularySchema, libraryVocabularyIdSchema } from './profile-schemas.ts';
export type {
  PersonalEntry,
  PersonalEntryAnnotationWrite,
  PersonalEntryFieldChange,
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
  shelfEntrySchema,
  shelfListQuerySchema,
  shelfSummaryQuerySchema,
  shelfSummarySchema,
  shelfTypesQuerySchema,
  shelfTypesSchema,
} from './shelf-schemas.ts';

import { basicQuery, embedded, fullView, subjectFields, targetFields, viewQuery } from './views.ts';

type Dependencies = {
  routeKey: Uint8Array;
  pool: Pool;
  tokens: KeyRing;
  access: () => Access;
  clock?: KernelClock;
  shelves?: () => ShelfReads;
  shelfTypeDigest?: ShelfTypeDigest;
  typeSourceObserved?: import('./type-preparation-contract.ts').TypePreparationSourceObserved;
};
const closed = { additionalProperties: false } as const;
const id = t.String();
const nullable = t.Union([id, t.Null()]);
// Request fields remain optional for exact historical receipts; fresh non-null
// incarnations enforce the guard inside the authorized command after receipt lookup.
const incarnationId = t.String({ format: 'uuid' });
const revision = t.Integer({ minimum: 1, maximum: 2_147_483_646 });
const personalRevision = t.Integer({ minimum: 0, maximum: 2_147_483_646 });
const stateInput = libraryVocabularyIdSchema;
const statusInput = libraryVocabularyIdSchema;
const pageQuery = {
  ...viewQuery,
  cursor: t.Optional(t.String({ maxLength: 4096 })),
  limit: t.Optional(t.Integer({ minimum: 1, maximum: 100, default: 20 })),
};
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
const copyFields = {
  status: t.Optional(statusInput),
  location: t.Optional(t.Union([t.String({ maxLength: 200 }), t.Null()])),
  source: t.Optional(t.Union([t.String({ maxLength: 200 }), t.Null()])),
  acquiredOn: t.Optional(nullable),
  disposedOn: t.Optional(nullable),
  note: t.Optional(t.Union([t.String({ maxLength: 1000 }), t.Null()])),
};
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
  },
  closed,
);
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
  t.Object({ status: t.Literal('unknown'), sourceValue: t.Optional(t.String({ minLength: 1, maxLength: MAX_SOURCE_PRIVACY_VALUE_BYTES })) }, closed),
  t.Object({ status: t.Literal('known'), meaning: t.Union([t.Literal('private'), t.Literal('source_visible')]) }, closed),
]);
const personalTimestampValue = t.Union([
  t.Object({ status: t.Literal('absent') }, closed),
  t.Object({ status: t.Literal('unknown'), sourceValue: t.Optional(t.String({ minLength: 1, maxLength: MAX_SOURCE_TIMESTAMP_LENGTH })) }, closed),
  t.Object({ status: t.Literal('known'), value: t.String({ minLength: 4, maxLength: MAX_SOURCE_TIMESTAMP_LENGTH }) }, closed),
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
      t.Object({ status: t.Literal('unknown'), sourceValue: t.Optional(t.String({ minLength: 1, maxLength: MAX_SOURCE_PRIVACY_VALUE_BYTES })) }, closed),
      t.Object({ status: t.Literal('cleared') }, closed),
      t.Object({ status: t.Literal('known'), meaning: t.Union([t.Literal('private'), t.Literal('source_visible')]) }, closed),
    ]),
    sourceCreated: t.Union([
      t.Object({ status: t.Literal('absent') }, closed),
      t.Object({ status: t.Literal('unknown'), sourceValue: t.Optional(t.String({ minLength: 1, maxLength: MAX_SOURCE_TIMESTAMP_LENGTH })) }, closed),
      t.Object({ status: t.Literal('cleared') }, closed),
      t.Object({
        status: t.Literal('known'), value: t.String({ minLength: 4, maxLength: MAX_SOURCE_TIMESTAMP_LENGTH }),
        precision: t.Union(['year', 'month', 'day', 'minute', 'second', 'fraction'].map((item) => t.Literal(item))),
        zone: t.Union([t.Literal('utc'), t.Literal('offset'), t.Literal('unknown')]),
      }, closed),
    ]),
    sourceUpdated: t.Union([
      t.Object({ status: t.Literal('absent') }, closed),
      t.Object({ status: t.Literal('unknown'), sourceValue: t.Optional(t.String({ minLength: 1, maxLength: MAX_SOURCE_TIMESTAMP_LENGTH })) }, closed),
      t.Object({ status: t.Literal('cleared') }, closed),
      t.Object({
        status: t.Literal('known'), value: t.String({ minLength: 4, maxLength: MAX_SOURCE_TIMESTAMP_LENGTH }),
        precision: t.Union(['year', 'month', 'day', 'minute', 'second', 'fraction'].map((item) => t.Literal(item))),
        zone: t.Union([t.Literal('utc'), t.Literal('offset'), t.Literal('unknown')]),
      }, closed),
    ]),
    recordedAt: id,
  },
  closed,
);
const personalEntrySchema = t.Object({
  subjectId: id,
  annotationRevision: personalRevision,
  note: t.Union([t.String({ maxLength: MAX_PERSONAL_NOTE_BYTES }), t.Null()]),
  priority: t.Union([t.Integer({ minimum: 1, maximum: MAX_PERSONAL_PRIORITY }), t.Null()]),
  annotationUpdatedAt: nullable,
  sourceObservations: t.Array(personalObservationSchema, { maxItems: MAX_SOURCE_OBSERVATIONS }),
}, closed);
const personalEntryResponse = t.Object({ personalEntry: personalEntrySchema }, closed);
const personalObservationResponse = t.Object({ sourceObservation: personalObservationSchema }, closed);
const copyResponse = t.Object({ copy: copySchema }, closed);
const followResponse = t.Object({ follow: followSchema }, closed);
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
    ...(action === 'library_entry:list'
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
    if (error instanceof LibraryEntryInvalidError) throw new ProblemError('invalid_request');
    if (error instanceof CopyInvalidError) throw new ProblemError('invalid_request');
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
function followView({ targetId, targetType, state, reason, updatedAt }: Follow) {
  return { targetId, targetType, state, reason, updatedAt };
}

/** Private account-owned library transport. Domain commands retain authorization and receipts. */
export function personalLibraryRoutes(app: ReturnType<typeof definitionRoutes>, dependencies: Dependencies) {
  const config = () => ({ ...dependencies, access: dependencies.access() });
  const entries = () => createEntryCommands(config());
  const copies = () => createCopyCommands(config());
  const follows = () => createFollowCommands(config());
  const shelves = (operation: keyof ShelfReads) => {
    if (!dependencies.shelves) throw new ShelfContractNotImplementedError(operation);
    return dependencies.shelves();
  };
  const shelfOwner = (actor: Actor) => {
    const owner = account(actor);
    if (!owner.scopes.includes('library_entry:list')) throw new ProblemError('forbidden');
  };
  return app
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
              libraryEntries: t.Array(t.Union([shelfEntrySchema, embedded(entrySchema, subjectFields)])),
              next: nullable,
            },
            closed,
          ),
          ...shelfFailures,
        },
        detail: detail('library_entry.list', 'library_entry:list'),
      },
      async ({ actor, query, admission, job }) => {
        account(actor);
        if (query.orderBy !== undefined) {
          shelfOwner(actor);
          const result = await admission.run('normal', job, async () => {
            await admitShelfRead({ ...config(), clock: dependencies.clock ?? systemClock }, actor, job.deadline);
            return command(() => shelves('listShelf').listShelf(actor, basicQuery(query)));
          });
          return fullView(config(), actor, query.view, {
            libraryEntries: result.entries.map(shelfEntryView),
            next: result.next,
          });
        }
        if (query.direction !== undefined || query.type !== undefined) throw new ProblemError('invalid_request');
        const { orderBy: _orderBy, direction: _direction, type: _type, ...oldQuery } = query;
        const result = await admission.run('normal', job, () =>
          command(() => entries().listEntries(actor, basicQuery(oldQuery))),
        );
        return fullView(config(), actor, query.view, {
          libraryEntries: result.entries.map(entryView),
          next: result.next,
        });
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
      '/v1/libraryEntries/:subjectId/personal',
      {
        params: t.Object({ subjectId: id }, closed),
        response: { 200: personalEntryResponse, ...failures },
        detail: personalDetail('library_entry.personal.get', 'library_entry:read'),
      },
      async ({ actor, params, admission, job, set }) => {
        point(actor, params.subjectId, 'library_entry:read');
        const personalEntry = await admission.run('normal', job, () =>
          personalCommand(() => entries().readPersonalEntry(actor, params.subjectId)),
        );
        set.headers['cache-control'] = 'private, no-store';
        return { personalEntry };
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
          },
          closed,
        ),
        response: { 200: personalEntryResponse, ...failures, 409: problemSchema('conflict'), 422: problemSchema('idempotency_conflict') },
        detail: personalDetail('library_entry.annotations.put', 'library_entry:update'),
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
        return { personalEntry: result.value };
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
        response: { 201: personalObservationResponse, ...failures, 409: problemSchema('conflict'), 422: problemSchema('idempotency_conflict') },
        detail: personalDetail('library_entry.source-observation.admit', 'library_entry:update'),
      },
      async ({ actor, params, body, headers, admission, job, session, set }) => {
        account(actor);
        const result = await admission.run('normal', job, () =>
          personalCommand(() =>
            entries().admitSourceObservation(actor, params.subjectId, body, idempotencyKeyOf(headers[IDEMPOTENCY_HEADER])),
          ),
        );
        session.record(result);
        set.status = 201;
        set.headers['cache-control'] = 'private, no-store';
        return { sourceObservation: result.value.sourceObservation };
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
        response: { 200: personalObservationResponse, ...failures, 409: problemSchema('conflict'), 422: problemSchema('idempotency_conflict') },
        detail: personalDetail('library_entry.source-observation.correct', 'library_entry:update'),
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
        return { sourceObservation: result.value.sourceObservation };
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
        query: t.Object({ ...pageQuery, subjectId: t.Optional(t.String({ format: 'uuid' })) }, closed),
        response: {
          200: t.Object({ copies: t.Array(embedded(copySchema, subjectFields)), next: nullable }, closed),
          ...failures,
        },
        detail: detail('copy.list', 'copy:list'),
      },
      async ({ actor, query, admission, job }) => {
        account(actor);
        const result = await admission.run('normal', job, () =>
          command(() => copies().listCopies(actor, basicQuery(query))),
        );
        return fullView(config(), actor, query.view, { copies: result.copies.map(copyView), next: result.next });
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
                      presentation: {
                        ...presentation,
                        statusEditing:
                          editing.state === 'supported' ? { ...editing, statuses: [...editing.statuses] } : editing,
                      },
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
      async ({ actor, params, headers, admission, job, session }) => {
        account(actor);
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        const result = await admission.run('normal', job, () =>
          command(() => follows().follow(actor, params.targetId, key)),
        );
        if (result.command) session.record(result.command);
        return { follow: followView(result.follow) };
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
      async ({ actor, params, headers, admission, job, session }) => {
        account(actor);
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        const result = await admission.run('normal', job, () =>
          command(() => follows().unfollow(actor, params.targetId, key)),
        );
        if (result.command) session.record(result.command);
        return { follow: followView(result.follow) };
      },
    )
    .get(
      '/v1/follows/:targetId',
      {
        query: t.Object(viewQuery, closed),
        params: t.Object({ targetId: id }),
        response: { 200: t.Object({ follow: embedded(followSchema, targetFields) }, closed), ...failures },
        detail: detail('follow.get', 'follow:read'),
      },
      async ({ actor, params, query, admission, job }) => {
        point(actor, params.targetId, 'follow:read');
        const follow = await admission.run('normal', job, () =>
          command(() => follows().readFollow(actor, params.targetId), 'not_found'),
        );
        if (!follow) throw new ProblemError('not_found');
        return fullView(config(), actor, query.view, { follow: followView(follow) });
      },
    )
    .get(
      '/v1/follows',
      {
        query: t.Object(pageQuery, closed),
        response: {
          200: t.Object({ follows: t.Array(embedded(followSchema, targetFields)), next: nullable }, closed),
          ...failures,
        },
        detail: detail('follow.list', 'follow:list'),
      },
      async ({ actor, query, admission, job }) => {
        const owner = account(actor);
        if (!owner.scopes.includes('follow:list')) throw new ProblemError('forbidden');
        return admission.run('normal', job, () =>
          command(async () => {
            const route = routeOf(owner.accountId)!;
            const binding = {
              operation: 'follow.list',
              parameters: { accountId: owner.accountId, state: 'following' },
            };
            const partition = await withConnection(dependencies.pool, (client) =>
              readPartition(client, partitionOf(route)),
            );
            let after: FollowPageCursor | null = null;
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
              if (cursor.epoch !== partition?.epoch) throw new ProblemError('stale_cursor');
              after = { updatedAt: cursor.after[0], targetId: cursor.after[1] };
            }
            const size = query.limit ?? 20;
            const rows = await follows().listFollows(actor, { cursor: after, limit: Math.min(100, size + 1) });
            const shown = rows.slice(0, size),
              last = shown.at(-1);
            let more = rows.length > size;
            if (!more && size === 100 && last)
              more = (await follows().listFollows(actor, { cursor: last, limit: 1 })).length > 0;
            return fullView(config(), actor, query.view, {
              follows: shown.map(followView),
              next:
                more && last && partition
                  ? encodeCursor(dependencies.tokens, binding, {
                      epoch: partition.epoch,
                      after: [last.updatedAt, last.targetId],
                    })
                  : null,
            });
          }),
        );
      },
    );
}
