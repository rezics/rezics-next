import { t } from 'elysia';
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
import { decodeCursor, encodeCursor } from '../tokens/cursor.ts';
import type { KeyRing } from '../tokens/seal.ts';
import { LibraryNotFoundError } from './command-support.ts';
import { CopyConflictError, CopyInvalidError, createCopyCommands } from './copies.ts';
import { createEntryCommands, LibraryConflictError, LibraryEntryInvalidError } from './entries.ts';
import type { Copy, Entry } from './entry-model.ts';
import type { Follow, FollowPageCursor } from './follow-model.ts';
import { createFollowCommands } from './follows.ts';
import { admitShelfRead } from './shelf-admission.ts';
import { ShelfContractNotImplementedError, type ShelfEntry, type ShelfReads } from './shelf-contract.ts';
import { libraryStoredVocabularySchema, libraryVocabularyIdSchema } from './profile-schemas.ts';
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
  pool: Pool;
  tokens: KeyRing;
  access: () => Access;
  clock?: KernelClock;
  shelves?: () => ShelfReads;
};
const closed = { additionalProperties: false } as const;
const id = t.String();
const nullable = t.Union([id, t.Null()]);
const revision = t.Integer({ minimum: 1, maximum: 2_147_483_646 });
const stateInput = libraryVocabularyIdSchema;
const statusInput = libraryVocabularyIdSchema;
const pageQuery = {
  ...viewQuery,
  cursor: t.Optional(t.String({ maxLength: 4096 })),
  limit: t.Optional(t.Integer({ minimum: 1, maximum: 100, default: 20 })),
};
const entrySchema = t.Object(
  { subjectId: id, state: libraryStoredVocabularySchema, revision, createdAt: id, updatedAt: id },
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
const shelfFailures = { ...failures, 400: problemSchema('invalid_request', 'invalid_cursor', 'invalid_argument') };
function detail(operationId: string, action: string, write = false) {
  return {
    operationId,
    'x-action': action,
    'x-exposure': 'gate:personal_library',
    security: [{ bearerAuth: [] }],
    ...(write ? { 'x-rate-limit': defineRateLimit({ family: 'write', units: 1 }) } : {}),
  };
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
  state,
  revision,
  createdAt,
  updatedAt,
}: Pick<Entry, 'subjectId' | 'state' | 'revision' | 'createdAt' | 'updatedAt'>) {
  return { subjectId, state, revision, createdAt, updatedAt };
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
function copyView({ id, subjectId, status, revision, location, source, acquiredOn, disposedOn, note }: Copy) {
  return { id, subjectId, status, revision, location, source, acquiredOn, disposedOn, note };
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
    .put(
      '/v1/libraryEntries/:subjectId',
      {
        params: t.Object({ subjectId: id }),
        headers,
        body: t.Object({ state: stateInput, revision: t.Optional(revision) }, closed),
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
        detail: detail('library_entry.put', 'library_entry:update', true),
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
        query: t.Object({ revision: t.Optional(revision) }, closed),
        response: { 204: t.Void(), ...failures },
        detail: detail('library_entry.delete', 'library_entry:delete', true),
      },
      async ({ actor, params, query, headers, admission, job, session, set }) => {
        account(actor);
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        const result = await admission.run('normal', job, () =>
          command(async () => {
            // Conceal absent rows before reporting a revision conflict.
            await entries().readEntry(actor, params.subjectId);
            if (query.revision === undefined) throw new ProblemError('conflict');
            return entries().deleteEntry(actor, params.subjectId, query.revision, key);
          }),
        );
        session.record(result);
        set.status = 204;
      },
    )
    .post(
      '/v1/copies',
      {
        headers,
        body: t.Object({ ...copyFields, subjectId: id, status: statusInput }, closed),
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
        query: t.Object(viewQuery, closed),
        params: t.Object({ copyId: id }),
        response: { 200: t.Object({ copy: embedded(copySchema, subjectFields) }, closed), ...failures },
        detail: detail('copy.get', 'copy:read'),
      },
      async ({ actor, params, query, admission, job }) => {
        point(actor, params.copyId, 'copy:read');
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
        headers,
        response: { 204: t.Void(), ...failures },
        detail: detail('copy.delete', 'copy:delete', true),
      },
      async ({ actor, params, headers, admission, job, session, set }) => {
        account(actor);
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        const result = await admission.run('normal', job, () =>
          command(async () => {
            const current = await copies().readCopy(actor, params.copyId);
            return copies().deleteCopy(actor, params.copyId, current.revision, key);
          }),
        );
        session.record(result);
        set.status = 204;
      },
    )
    .put(
      '/v1/follows/:targetId',
      {
        params: t.Object({ targetId: id }),
        headers,
        body: t.Optional(t.Never()),
        response: { 200: followResponse, ...failures },
        detail: detail('follow.put', 'follow:create', true),
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
        detail: detail('follow.delete', 'follow:delete', true),
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
