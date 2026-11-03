import { t } from 'elysia';
import type { Pool } from 'pg';
import { GrantDeniedError } from '../access/grant-commands.ts';
import type { KernelClock } from '../clock.ts';
import { customMethod } from '../http/custom-method.ts';
import { ProblemError, problemSchema } from '../http/problem.ts';
import { defineRateLimit } from '../http/rate-limit.ts';
import { IDEMPOTENCY_HEADER, idempotencyKeyOf } from '../http/request.ts';
import type { Access } from '../request/access.ts';
import type { definitionRoutes } from '../semantic/http/definitions.ts';
import type { KeyRing } from '../tokens/seal.ts';
import { LibraryNotFoundError } from './command-support.ts';
import { LibraryConflictError } from './entries.ts';
import { createPersonalLabelCommands } from './label-commands.ts';
import { createLabelAssignmentCommands } from './label-assignment-commands.ts';
import { createLabelConsolidationReview, LABEL_CONSOLIDATION_REVIEW_LIMITS } from './label-consolidation-review.ts';
import { createLabelConsolidationCommands } from './label-consolidation.ts';
import { libraryEntryTileSchema } from './library-entry-tiles.ts';
import { fullView, subjectFields, viewQuery } from './views.ts';
import { normalizePersonalLabelName, normalizePersonalLabelPrefix } from './label-store.ts';

const closed = { additionalProperties: false } as const;
const id = t.String({ format: 'uuid' });
const revision = t.Integer({ minimum: 1, maximum: 2147483646 });
const identity = t.Object({ id, revision: t.Integer({ minimum: 1, maximum: 2147483647 }) }, closed);
const labelResult = t.Object({ label: identity }, closed);
const assignmentResult = t.Object({ assignment: identity }, closed);
const deleted = t.Object({ deleted: t.Literal(true) }, closed);
const params = t.Object({ id }, closed);
const headers = t.Object({ [IDEMPOTENCY_HEADER]: t.String({ minLength: 3, maxLength: 1024 }) });
const page = {
  cursor: t.Optional(t.String({ maxLength: 4096 })),
  limit: t.Optional(t.Integer({ minimum: 1, maximum: 100, default: 20 })),
};
const assignmentFields = { id, labelId: id, subjectId: id, revision: identity.properties.revision };
const next = t.Union([t.String(), t.Null()]);
const assignmentPage = t.Union([
  t.Object({ assignments: t.Array(t.Object(assignmentFields, closed)), next }, closed),
  t.Object(
    {
      assignments: t.Array(t.Object({ ...assignmentFields, label: t.Object({ name: t.String() }, closed) }, closed)),
      next,
    },
    closed,
  ),
  t.Object(
    {
      assignments: t.Array(
        t.Object(
          {
            ...assignmentFields,
            ...t.Required(t.Object(subjectFields)).properties,
            libraryEntry: t.Union([libraryEntryTileSchema, t.Null()]),
          },
          closed,
        ),
      ),
      next,
      label: t.Object({ id, name: t.String(), revision: identity.properties.revision }, closed),
    },
    closed,
  ),
]);
const expected = t.Object({ subjectId: id, assignmentId: id, revision }, closed);
const reviewAssignment = t.Union([t.Object({ ...identity.properties, effective: t.Boolean() }, closed), t.Null()]);
const reviewLabel = t.Object({ ...identity.properties, name: t.String() }, closed);
const confirmationEvidence = t.Object(
  {
    selection: t.String({ pattern: '^[0-9a-f]{64}$' }),
    sourceLabel: reviewLabel,
    targetLabel: reviewLabel,
    items: t.Array(
      t.Object(
        {
          selected: expected,
          source: t.Object({ ...identity.properties, effective: t.Boolean() }, closed),
          target: reviewAssignment,
          outcome: t.Union([t.Literal('movable'), t.Literal('already_on_target')]),
        },
        closed,
      ),
      { minItems: 1, maxItems: 16 },
    ),
  },
  closed,
);
const consolidationResult = t.Object(
  {
    confirmationId: id,
    sourceLabelId: id,
    targetLabelId: id,
    status: t.Union([t.Literal('active'), t.Literal('completed'), t.Literal('cancelled')]),
    expiresAt: t.String({ format: 'date-time' }),
    items: t.Array(
      t.Object(
        {
          item: t.Integer({ minimum: 0, maximum: 15 }),
          selected: t.Optional(expected),
          status: t.Union([
            t.Literal('pending'),
            t.Literal('processing'),
            t.Literal('moved'),
            t.Literal('target_applied_source_retained'),
            t.Literal('capacity_limited'),
            t.Literal('changed'),
            t.Literal('inaccessible'),
          ]),
          targetAssignment: t.Optional(identity),
          targetUnchanged: t.Optional(t.Boolean()),
          sourceUnassignRevision: t.Optional(identity.properties.revision),
        },
        closed,
      ),
      { maxItems: 16 },
    ),
  },
  closed,
);
const failures = {
  400: problemSchema('invalid_request', 'invalid_cursor'),
  401: problemSchema('authentication_required', 'invalid_credentials'),
  403: problemSchema('forbidden', 'platform_closed'),
  404: problemSchema('not_found'),
  409: problemSchema(
    'conflict',
    'stale_cursor',
    'library_label_capacity',
    'library_label_restore_stale',
    'library_label_restore_expired',
    'library_label_restore_occupied',
    'library_label_restore_capacity',
  ),
  422: problemSchema('idempotency_conflict'),
  503: problemSchema(
    'index_not_ready',
    'dependency_unavailable',
    'overloaded',
    'partition_unavailable',
    'transaction_retry_exhausted',
    'deadline_exceeded',
    'semantic_not_ready',
  ),
};
function detail(operation: string, action = 'library_entry:update', write = true) {
  return {
    operationId: `library_label.${operation}`,
    'x-action': action,
    'x-exposure': 'gate:personal_library',
    security: [{ bearerAuth: [] }],
    ...(write ? { 'x-rate-limit': defineRateLimit({ family: 'write', units: 1 }) } : {}),
  };
}
function undoHeader(name: string) {
  return {
    200: {
      description: 'Deleted',
      headers: { [name]: { schema: { type: 'string' as const, pattern: '^[1-9][0-9]*$' } } },
    },
  };
}
function queryFields(request: Request, allowed: string[]) {
  for (const key of new URL(request.url).searchParams.keys())
    if (!allowed.includes(key)) throw new ProblemError('invalid_request');
}
// Only the input normalizer's documented errors are client errors, never a command/programming TypeError.
function name(value: unknown, prefix = false) {
  try {
    (prefix ? normalizePersonalLabelPrefix : normalizePersonalLabelName)(value);
  } catch (error) {
    if (error instanceof TypeError || error instanceof RangeError) throw new ProblemError('invalid_request');
    throw error;
  }
}
async function command<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof GrantDeniedError) throw new ProblemError('forbidden');
    if (error instanceof LibraryNotFoundError) throw new ProblemError('not_found');
    if (error instanceof LibraryConflictError) throw new ProblemError('conflict');
    throw error;
  }
}

/** Transport maps native outcomes directly; no private point reads precede receipts. */
export function personalLabelRoutes(
  app: ReturnType<typeof definitionRoutes>,
  deps: { routeKey: Uint8Array; pool: Pool; access: () => Access; tokens: KeyRing; clock: KernelClock },
) {
  const labels = createPersonalLabelCommands(deps);
  const assignments = () => createLabelAssignmentCommands({ ...deps, access: deps.access() });
  const consolidations = () => createLabelConsolidationCommands({ ...deps, access: deps.access() });
  return app
    .get(
      '/v1/libraryLabels',
      {
        query: t.Object({ ...page, q: t.Optional(t.String()) }, closed),
        transform: ({ request }) => queryFields(request, ['cursor', 'limit', 'q']),
        response: {
          200: t.Object(
            {
              labels: t.Array(t.Object({ id, name: t.String(), revision: identity.properties.revision }, closed)),
              next: t.Union([t.String(), t.Null()]),
            },
            closed,
          ),
          ...failures,
        },
        detail: detail('list', 'library_entry:list', false),
      },
      async ({ actor, query, admission, job }) => {
        if (query.q !== undefined) name(query.q, true);
        return admission.run('normal', job, () => command(() => labels.listLabels(actor, query)));
      },
    )
    .post(
      '/v1/libraryLabels',
      {
        headers,
        body: t.Object({ name: t.String() }, closed),
        transform: ({ request }) => queryFields(request, []),
        response: { 201: labelResult, ...failures },
        detail: detail('create'),
      },
      async ({ actor, body, headers, admission, job, session, set }) => {
        name(body.name);
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        const result = await admission.run('normal', job, () => command(() => labels.createLabel(actor, body, key)));
        session.record(result);
        set.status = 201;
        return result.value;
      },
    )
    .patch(
      '/v1/libraryLabels/:id',
      {
        params,
        headers,
        body: t.Object({ name: t.String(), revision }, closed),
        transform: ({ request }) => queryFields(request, []),
        response: { 200: labelResult, ...failures },
        detail: detail('rename'),
      },
      async ({ actor, params, body, headers, admission, job, session }) => {
        name(body.name);
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        const result = await admission.run('normal', job, () =>
          command(() => labels.renameLabel(actor, params.id, body, key)),
        );
        session.record(result);
        return result.value;
      },
    )
    .delete(
      '/v1/libraryLabels/:id',
      {
        params,
        headers,
        query: t.Object({ revision }, closed),
        transform: ({ request }) => queryFields(request, ['revision']),
        response: { 200: deleted, ...failures },
        detail: { ...detail('delete'), responses: undoHeader('Library-Label-Revision') },
      },
      async ({ actor, params, query, headers, admission, job, session, set }) => {
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        const result = await admission.run('normal', job, () =>
          command(() => labels.deleteLabel(actor, params.id, query.revision, key)),
        );
        session.record(result);
        set.headers['Library-Label-Revision'] = String(result.value.revision);
        return { deleted: true as const };
      },
    )
    .post(
      customMethod('/v1/libraryLabels/:id', 'restore'),
      {
        params,
        headers,
        body: t.Object({ revision }, closed),
        transform: ({ request }) => queryFields(request, []),
        response: { 200: labelResult, ...failures },
        detail: detail('restore'),
      },
      async ({ actor, params, body, headers, admission, job, session }) => {
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        const result = await admission.run('normal', job, () =>
          command(() => labels.restoreLabel(actor, params.id, body.revision, key)),
        );
        session.record(result);
        return result.value;
      },
    )
    .post(
      customMethod('/v1/libraryLabels/:id', 'assign'),
      {
        params,
        headers,
        body: t.Object({ subjectId: id }, closed),
        transform: ({ request }) => queryFields(request, []),
        response: { 200: assignmentResult, ...failures },
        detail: detail('assign'),
      },
      async ({ actor, params, body, headers, admission, job, session }) => {
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        const result = await admission.run('normal', job, () =>
          command(() => assignments().assignLabel(actor, params.id, body, key)),
        );
        session.record(result);
        return result.value;
      },
    )
    .post(
      customMethod('/v1/libraryLabels/:id', 'unassign'),
      {
        params,
        headers,
        body: expected,
        transform: ({ request }) => queryFields(request, []),
        response: { 200: deleted, ...failures },
        detail: { ...detail('unassign'), responses: undoHeader('Library-Label-Assignment-Revision') },
      },
      async ({ actor, params, body, headers, admission, job, session, set }) => {
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        const result = await admission.run('normal', job, () =>
          command(() => assignments().unassignLabel(actor, params.id, body, key)),
        );
        session.record(result);
        set.headers['Library-Label-Assignment-Revision'] = String(result.value.revision);
        return { deleted: true as const };
      },
    )
    .post(
      customMethod('/v1/libraryLabels/:id', 'restoreAssignment'),
      {
        params,
        headers,
        body: expected,
        transform: ({ request }) => queryFields(request, []),
        response: { 200: assignmentResult, ...failures },
        detail: detail('assignment_restore'),
      },
      async ({ actor, params, body, headers, admission, job, session }) => {
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        const result = await admission.run('normal', job, () =>
          command(() => assignments().restoreAssignment(actor, params.id, body, key)),
        );
        session.record(result);
        return result.value;
      },
    )
    .get(
      '/v1/libraryLabelAssignments',
      {
        query: t.Object({ ...page, ...viewQuery, labelId: t.Optional(id), subjectId: t.Optional(id) }, closed),
        transform: ({ request }) => queryFields(request, ['labelId', 'subjectId', 'cursor', 'limit', 'view']),
        response: {
          200: assignmentPage,
          ...failures,
        },
        detail: {
          ...detail('assignment_list', 'library_entry:read', false),
          description:
            'FULL by label additionally requires library_entry:list, progress_session:list and reading_progress admission. FULL by subject adds current label names only.',
        },
      },
      async ({ actor, query, admission, job }) => {
        const body = await admission.run('normal', job, () =>
          command(() => assignments().listAssignments(actor, query)),
        );
        // The owner RR connection is released before standard per-partition summary readers acquire theirs.
        return fullView({ ...deps, access: deps.access() }, actor, query.labelId ? query.view : 'BASIC', body);
      },
    )
    .post(
      customMethod('/v1/libraryLabels/:id', 'reviewConsolidation'),
      {
        params,
        body: t.Object(
          {
            targetLabelId: id,
            items: t.Array(expected, { minItems: 1, maxItems: LABEL_CONSOLIDATION_REVIEW_LIMITS.selection }),
            limit: t.Optional(t.Integer({ minimum: 1, maximum: LABEL_CONSOLIDATION_REVIEW_LIMITS.page })),
            cursor: t.Optional(t.String({ maxLength: 4096 })),
          },
          closed,
        ),
        transform: ({ request }) => queryFields(request, []),
        response: {
          200: t.Object(
            {
              selection: t.String(),
              sourceLabel: reviewLabel,
              targetLabel: reviewLabel,
              items: t.Array(
                t.Object(
                  {
                    selected: expected,
                    source: reviewAssignment,
                    target: reviewAssignment,
                    outcome: t.Union([
                      t.Literal('movable'),
                      t.Literal('already_on_target'),
                      t.Literal('missing'),
                      t.Literal('changed'),
                      t.Literal('inaccessible'),
                      t.Literal('capacity_limited'),
                    ]),
                  },
                  closed,
                ),
                { maxItems: LABEL_CONSOLIDATION_REVIEW_LIMITS.page },
              ),
              next,
            },
            closed,
          ),
          ...failures,
        },
        detail: {
          ...detail('consolidation_review', 'library_entry:read', false),
          description:
            'Pure review of at most 16 explicit assignments, four per page. Also requires library_entry:update. No confirmation or movement is performed.',
        },
      },
      async ({ actor, params, body, admission, job, set }) => {
        const result = await admission.run('normal', job, () =>
          command(() => createLabelConsolidationReview({ ...deps, access: deps.access() })(actor, params.id, body)),
        );
        set.headers['Cache-Control'] = 'private, no-store';
        return result;
      },
    )
    .post(
      customMethod('/v1/libraryLabels/:id', 'confirmConsolidation'),
      {
        params,
        headers,
        body: confirmationEvidence,
        transform: ({ request }) => queryFields(request, []),
        response: {
          201: t.Object(
            {
              confirmationId: id,
              expiresAt: t.String({ format: 'date-time' }),
              status: t.Literal('active'),
              itemCount: t.Integer({ minimum: 1, maximum: 16 }),
            },
            closed,
          ),
          ...failures,
        },
        detail: detail('consolidation_confirm'),
      },
      async ({ actor, params, body, headers, admission, job, session, set }) => {
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        const confirmed = await admission.run('normal', job, () =>
          command(() => consolidations().confirm(actor, params.id, body, key)),
        );
        session.record(confirmed);
        set.headers['Cache-Control'] = 'private, no-store';
        set.status = 201;
        return confirmed.value;
      },
    )
    .post(
      customMethod('/v1/libraryLabels/:id', 'applyConsolidation'),
      {
        params,
        headers,
        body: t.Object({ confirmationId: id }, closed),
        transform: ({ request }) => queryFields(request, []),
        response: { 200: consolidationResult, ...failures },
        detail: detail('consolidation_apply'),
      },
      async ({ actor, params, body, headers, admission, job, session, set }) => {
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        const applied = await admission.run('normal', job, () =>
          command(() => consolidations().apply(actor, params.id, body.confirmationId, key)),
        );
        session.record(applied.operation);
        set.headers['Cache-Control'] = 'private, no-store';
        return applied.result;
      },
    )
    .post(
      customMethod('/v1/libraryLabels/:id', 'retryConsolidation'),
      {
        params,
        headers,
        body: t.Object({ confirmationId: id, item: t.Integer({ minimum: 0, maximum: 15 }) }, closed),
        transform: ({ request }) => queryFields(request, []),
        response: { 200: consolidationResult, ...failures },
        detail: detail('consolidation_retry'),
      },
      async ({ actor, params, body, headers, admission, job, session, set }) => {
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        const retried = await admission.run('normal', job, () =>
          command(() => consolidations().retry(actor, params.id, body.confirmationId, body.item, key)),
        );
        session.record(retried.operation);
        set.headers['Cache-Control'] = 'private, no-store';
        return retried.result;
      },
    )
    .post(
      customMethod('/v1/libraryLabels/:id', 'cancelConsolidation'),
      {
        params,
        headers,
        body: t.Object({ confirmationId: id }, closed),
        transform: ({ request }) => queryFields(request, []),
        response: { 200: consolidationResult, ...failures },
        detail: detail('consolidation_cancel'),
      },
      async ({ actor, params, body, headers, admission, job, session, set }) => {
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        const cancelled = await admission.run('normal', job, () =>
          command(() => consolidations().cancel(actor, params.id, body.confirmationId, key)),
        );
        session.record(cancelled.operation);
        set.headers['Cache-Control'] = 'private, no-store';
        return cancelled.result;
      },
    )
    .get(
      '/v1/libraryLabels/:id/consolidations/:confirmationId',
      {
        params: t.Object({ id, confirmationId: id }, closed),
        transform: ({ request }) => queryFields(request, []),
        response: { 200: consolidationResult, ...failures },
        detail: detail('consolidation_result', 'library_entry:read', false),
      },
      async ({ actor, params, admission, job, set }) => {
        const result = await admission.run('normal', job, () =>
          command(() => consolidations().result(actor, params.id, params.confirmationId)),
        );
        set.headers['Cache-Control'] = 'private, no-store';
        return result;
      },
    );
}
