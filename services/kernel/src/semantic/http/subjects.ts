import { withHeaders } from '@elysia/openapi';
import { t } from 'elysia';
import type { KeyRing } from '../../tokens/seal.ts';
import {
  adoptCandidates,
  decideCandidate,
  EditorialConflictError,
  listCandidates,
  listRevisions,
  proposeStatement,
  SubjectNotFoundError,
} from '../candidates.ts';
import { PageCursorError } from '../page.ts';
import type { Pool } from 'pg';
import { withConnection } from '../../database/pool.ts';
import { SubjectInputError, type Item, type Snak } from '../item.ts';
import { createSubject, readLabels, readSubject, SubjectAccessDeniedError, subjectTarget } from '../subject.ts';
import { DATA_TYPES, type DataType } from '@rezics/definitions';
import { GrantDeniedError } from '../../access/grant-commands.ts';
import { activeRelease, GLOBAL_CONTEXT, readRelease, StaleEditorialHeadError } from '../definitions.ts';
import { routeOf } from '../../route/route.ts';
import type { AccountActor } from '../../request/access.ts';
import { AuthenticationError } from '../../request/access.ts';
import { createApp } from '../../http/app.ts';
import { defineRateLimit } from '../../http/rate-limit.ts';
import { ProblemError, problemSchema } from '../../http/problem.ts';
import { IDEMPOTENCY_HEADER, idempotencyKeyOf, requestDigest, SESSION_HEADER } from '../../http/request.ts';
import { subjectReadEligibility } from '../eligibility.ts';
import { listSubjectLinks } from '../links.ts';
import { customMethod } from '../../http/custom-method.ts';
import {
  moderateSubject,
  ModerationConflictError,
  ModerationSubjectNotFoundError,
  readSubjectVisibility,
} from '../moderation.ts';

const DataTypeSchema = t.Unsafe<DataType>(t.Union(DATA_TYPES.map((dataType) => t.Literal(dataType))));
const ValueSchema = t.Union([
  t.Object({ type: t.Literal('value'), content: t.Any() }, { additionalProperties: false }),
  t.Object({ type: t.Literal('somevalue') }, { additionalProperties: false }),
  t.Object({ type: t.Literal('novalue') }, { additionalProperties: false }),
]);
const SnakSchema = t.Object(
  {
    property: t.Object({ id: t.String(), data_type: DataTypeSchema }, { additionalProperties: false }),
    value: ValueSchema,
  },
  { additionalProperties: false },
);
const ReferenceSchema = t.Object({ parts: t.Array(SnakSchema), hash: t.String() }, { additionalProperties: false });
const StatementSchema = t.Object(
  {
    id: t.String({ format: 'uuid' }),
    rank: t.Union([t.Literal('normal'), t.Literal('preferred'), t.Literal('deprecated')]),
    property: t.Object({ id: t.String(), data_type: DataTypeSchema }, { additionalProperties: false }),
    value: ValueSchema,
    qualifiers: t.Array(SnakSchema),
    references: t.Array(ReferenceSchema),
    rezics: t.Object({ release: t.String(), revision: t.Integer({ minimum: 1 }) }, { additionalProperties: false }),
  },
  { additionalProperties: false },
);

export const ItemSchema = t.Object(
  {
    id: t.String({ format: 'uuid' }),
    type: t.String(),
    revision: t.Integer({ minimum: 1 }),
    release: t.String(),
    context: t.String({ format: 'uuid' }),
    resolution: t.Record(t.String(), t.Any()),
    labels: t.Record(t.String(), t.String()),
    descriptions: t.Record(t.String(), t.String()),
    aliases: t.Record(t.String(), t.Array(t.String())),
    statements: t.Record(t.String(), t.Array(StatementSchema)),
  },
  { additionalProperties: false },
);

export const ItemInputSchema = t.Object(
  {
    type: t.String(),
    labels: t.Record(t.String(), t.Any()),
    descriptions: t.Optional(t.Record(t.String(), t.Any())),
    aliases: t.Optional(t.Record(t.String(), t.Any())),
    statements: t.Optional(t.Record(t.String(), t.Any())),
  },
  { additionalProperties: false },
);

const pageQuery = {
  limit: t.Optional(t.Numeric({ minimum: 1, maximum: 100, multipleOf: 1, default: 20 })),
  cursor: t.Optional(t.String()),
};
function candidateError(error: unknown): never {
  if (error instanceof SubjectInputError) throw invalidSubjectInput(error);
  if (error instanceof SubjectNotFoundError) throw new ProblemError('not_found');
  if (error instanceof EditorialConflictError) throw new ProblemError('conflict');
  if (error instanceof StaleEditorialHeadError) throw new ProblemError('stale_editorial_head');
  if (error instanceof PageCursorError) throw new ProblemError('invalid_request');
  if (error instanceof SubjectAccessDeniedError || error instanceof GrantDeniedError)
    throw new ProblemError('forbidden');
  throw error;
}
const listingErrors = {
  400: problemSchema('invalid_request'),
  401: problemSchema('authentication_required', 'invalid_credentials'),
  404: problemSchema('not_found'),
  503: problemSchema('semantic_not_ready', 'overloaded', 'deadline_exceeded'),
};
const LabelsSchema = t.Object({ labels: t.Record(t.String(), t.String()) }, { additionalProperties: false });
const itemResponse = t.Object({ subject: ItemSchema }, { additionalProperties: false });
const readResponse = t.Object(
  { subject: ItemSchema, related: t.Record(t.String(), LabelsSchema) },
  { additionalProperties: false },
);
const unauthorized = problemSchema('authentication_required', 'invalid_credentials');
const EditorialBodyContext = t.String({ format: 'uuid' });
const ExpectedHead = t.Union([t.Integer({ minimum: 1 }), t.Null()]);
const DecisionBody = t.Object(
  { context: EditorialBodyContext, expected_head: ExpectedHead },
  { additionalProperties: false },
);
const AdoptionMode = t.Union([t.Literal('inherit'), t.Literal('replace'), t.Literal('suppress')]);
const SelectionRank = t.Union([t.Literal('normal'), t.Literal('preferred'), t.Literal('deprecated')]);
const Selection = t.Array(
  t.Object({ candidate: t.String({ format: 'uuid' }), rank: SelectionRank }, { additionalProperties: false }),
  { maxItems: 32 },
);
const AdoptionBody = t.Object(
  {
    context: EditorialBodyContext,
    property: t.String({ minLength: 1 }),
    mode: AdoptionMode,
    selection: Selection,
    expected_head: ExpectedHead,
  },
  { additionalProperties: false },
);
const acceptanceResponse = t.Object(
  {
    acceptance: t.Object(
      {
        context: EditorialBodyContext,
        candidate: t.String({ format: 'uuid' }),
        decision: t.Union([t.Literal('accept'), t.Literal('reject')]),
        head: t.Integer({ minimum: 1 }),
      },
      { additionalProperties: false },
    ),
    revision: t.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);
const adoptionResponse = t.Object(
  {
    adoption: t.Object(
      {
        context: EditorialBodyContext,
        property: t.String(),
        mode: AdoptionMode,
        selection: t.Array(
          t.Object(
            {
              candidate: t.String({ format: 'uuid' }),
              rank: t.Union([t.Literal('normal'), t.Literal('preferred')]),
            },
            { additionalProperties: false },
          ),
          { maxItems: 32 },
        ),
        head: t.Integer({ minimum: 1 }),
      },
      { additionalProperties: false },
    ),
    revision: t.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);
const ReasonModerationBody = t.Object(
  { reason: t.String({ minLength: 1, maxLength: 500 }) },
  { additionalProperties: false },
);
const Rfc3339 =
  '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\\.[0-9]+)?(Z|[+-]([01][0-9]|2[0-3]):[0-5][0-9])$';
const TakedownModerationBody = t.Object(
  {
    notice: t.Object(
      {
        complaint: t.String({ minLength: 1, maxLength: 2000 }),
        received_at: t.String({ pattern: Rfc3339 }),
        scope: t.Optional(t.String({ maxLength: 500 })),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
const visibilityResponse = t.Object(
  {
    subject: t.String({ format: 'uuid' }),
    visibility: t.Union([t.Literal('visible'), t.Literal('hidden'), t.Literal('taken_down')]),
    security_revision: t.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);
type SubjectRouteDependencies = { pool: Pool; routeKey: Uint8Array; tokens: KeyRing };
function invalidSubjectInput(error: SubjectInputError): ProblemError {
  return new ProblemError('invalid_request', { errors: error.violations });
}

function moderationError(error: unknown): never {
  if (error instanceof SubjectInputError) throw invalidSubjectInput(error);
  if (error instanceof ModerationSubjectNotFoundError) throw new ProblemError('not_found');
  if (error instanceof ModerationConflictError) throw new ProblemError('conflict');
  if (error instanceof SubjectAccessDeniedError || error instanceof GrantDeniedError)
    throw new ProblemError('forbidden');
  throw error;
}

function relatedIds(subject: Item): { propertyIds: Set<string>; subjectIds: Set<string> } {
  const propertyIds = new Set<string>();
  const subjectIds = new Set<string>();
  const visit = (snak: Snak) => {
    propertyIds.add(snak.property.id);
    if (
      snak.property.data_type === 'wikibase-item' &&
      snak.value.type === 'value' &&
      typeof snak.value.content === 'string'
    )
      subjectIds.add(snak.value.content);
  };
  for (const [property, statements] of Object.entries(subject.statements)) {
    propertyIds.add(property);
    for (const statement of statements) {
      statement.qualifiers.forEach(visit);
      statement.references.forEach((reference) => reference.parts.forEach(visit));
      if (
        statement.property.data_type === 'wikibase-item' &&
        statement.value.type === 'value' &&
        typeof statement.value.content === 'string'
      )
        subjectIds.add(statement.value.content);
    }
  }
  return { propertyIds, subjectIds };
}

function subjectRoutes(app: ReturnType<typeof createApp>, { pool, routeKey, tokens }: SubjectRouteDependencies) {
  return app
    .post(
      '/v1/subjects',
      {
        headers: t.Object({ [IDEMPOTENCY_HEADER]: t.String({ minLength: 3, maxLength: 1024 }) }),
        body: ItemInputSchema,
        response: {
          201: withHeaders(itemResponse, { [SESSION_HEADER]: t.String(), location: t.String(), etag: t.String() }),
          400: problemSchema('invalid_request'),
          401: unauthorized,
          403: problemSchema('forbidden'),
          422: problemSchema('idempotency_conflict'),
          503: problemSchema(
            'semantic_not_ready',
            'overloaded',
            'partition_unavailable',
            'transaction_retry_exhausted',
            'deadline_exceeded',
          ),
        },
        detail: {
          operationId: 'subject.create',
          'x-action': 'subject:create',
          'x-rate-limit': defineRateLimit({ family: 'write', units: 1 }),
          security: [{ bearerAuth: [] }],
        },
      },
      async ({ body, headers, actor, authorizeCommand, admission, job, session, set }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        const account: AccountActor = actor;
        const active = await activeRelease(pool);
        if (!active) throw new ProblemError('semantic_not_ready');
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        const target = subjectTarget(routeKey, account.accountId, key);
        const authorization = await authorizeCommand(
          { route: 0, id: GLOBAL_CONTEXT },
          () => new SubjectAccessDeniedError(),
        );
        try {
          const result = await admission.run('normal', job, () =>
            createSubject(pool, {
              actor: account,
              target,
              idempotencyKey: key,
              digest: requestDigest('subject.create', account, body),
              item: body,
              release: { digest: active.digest, release: active.release },
              authorize: authorization.check,
              authorization,
              deadline: job.deadline,
            }),
          );
          session.record(result.component);
          set.status = 201;
          set.headers.location = `/v1/subjects/${result.subject.id}`;
          set.headers.etag = `"${result.subject.revision}"`;
          return { subject: result.subject };
        } catch (error) {
          if (error instanceof SubjectInputError) throw invalidSubjectInput(error);
          if (error instanceof SubjectAccessDeniedError || error instanceof GrantDeniedError)
            throw new ProblemError('forbidden');
          throw error;
        }
      },
    )
    .get(
      '/v1/subjects/:id',
      {
        params: t.Object({ id: t.String() }),
        query: t.Object({ context: t.Optional(EditorialBodyContext) }),
        response: {
          200: withHeaders(readResponse, { [SESSION_HEADER]: t.String(), etag: t.String() }),
          401: unauthorized,
          404: problemSchema('not_found'),
          503: problemSchema('overloaded', 'deadline_exceeded'),
        },
        detail: {
          operationId: 'subject.get',
          'x-action': 'subject:read',
          security: [{ bearerAuth: [] }, {}],
        },
      },
      async ({ params, query, authorize, admission, job, session, set }) => {
        const route = routeOf(params.id);
        if (route === null) throw new ProblemError('not_found');
        const resource = { route, id: params.id };
        const check = await authorize({ ...resource, eligibility: subjectReadEligibility(resource) });
        const result = await admission.run('normal', job, () =>
          readSubject(pool, params.id, check, query.context ?? GLOBAL_CONTEXT),
        );
        if (!result) throw new ProblemError('not_found');

        const release = await readRelease(pool, result.subject.release);
        if (!release) throw new Error('Subject revision release is missing');
        const { propertyIds, subjectIds } = relatedIds(result.subject);
        const related: Record<string, { labels: Record<string, string> }> = {};
        for (const property of propertyIds) {
          const definition = release.properties[property];
          if (definition) related[property] = { labels: definition.labels };
        }
        const readableIds = await Promise.all(
          [...subjectIds].map(async (id) => {
            const relatedRoute = routeOf(id);
            if (relatedRoute === null) return null;
            const relatedResource = { route: relatedRoute, id };
            const relatedCheck = await authorize({
              ...relatedResource,
              eligibility: subjectReadEligibility(relatedResource),
            });
            return admission.run('normal', job, async () => {
              const allowed = await withConnection(pool, (client) => relatedCheck(client));
              return allowed ? id : null;
            });
          }),
        );
        const labels = await admission.run('normal', job, () =>
          readLabels(
            pool,
            readableIds.filter((id): id is string => id !== null),
          ),
        );
        for (const [id, value] of labels) related[id] = { labels: value };

        session.record(result.component);
        set.headers.etag = `"${result.subject.revision}"`;
        return { subject: result.subject, related };
      },
    )
    .post(
      customMethod('/v1/subjects/:id', 'hide'),
      {
        params: t.Object({ id: t.String() }),
        headers: t.Object({ [IDEMPOTENCY_HEADER]: t.String({ minLength: 3, maxLength: 1024 }) }),
        body: ReasonModerationBody,
        response: {
          200: withHeaders(visibilityResponse, { [SESSION_HEADER]: t.String() }),
          400: problemSchema('invalid_request'),
          401: unauthorized,
          403: problemSchema('forbidden'),
          404: problemSchema('not_found'),
          409: problemSchema('conflict'),
          422: problemSchema('idempotency_conflict'),
          503: problemSchema('overloaded', 'partition_unavailable', 'transaction_retry_exhausted', 'deadline_exceeded'),
        },
        detail: {
          operationId: 'subject.hide',
          'x-action': 'moderation:hide',
          'x-rate-limit': defineRateLimit({ family: 'write', units: 1 }),
          security: [{ bearerAuth: [] }],
        },
      },
      async ({ params, body, headers, actor, authorizeCommand, admission, job, session }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        const route = routeOf(params.id);
        if (route === null) throw new ProblemError('not_found');
        const target = await admission.run('normal', job, () => readSubjectVisibility(pool, params.id));
        if (!target) throw new ProblemError('not_found');
        const authorization = await authorizeCommand(
          { route: 0, id: GLOBAL_CONTEXT },
          () => new SubjectAccessDeniedError(),
        );
        try {
          const result = await admission.run('normal', job, () =>
            moderateSubject(pool, {
              actor,
              subject: params.id,
              action: 'hide',
              body,
              idempotencyKey: idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]),
              digest: requestDigest('subject.hide', actor, { subject: params.id, body }),
              authorization,
              deadline: job.deadline,
            }),
          );
          session.record(result.component);
          return {
            subject: result.subject,
            visibility: result.visibility,
            security_revision: result.security_revision,
          };
        } catch (error) {
          return moderationError(error);
        }
      },
    )
    .post(
      customMethod('/v1/subjects/:id', 'takedown'),
      {
        params: t.Object({ id: t.String() }),
        headers: t.Object({ [IDEMPOTENCY_HEADER]: t.String({ minLength: 3, maxLength: 1024 }) }),
        body: TakedownModerationBody,
        response: {
          200: withHeaders(visibilityResponse, { [SESSION_HEADER]: t.String() }),
          400: problemSchema('invalid_request'),
          401: unauthorized,
          403: problemSchema('forbidden'),
          404: problemSchema('not_found'),
          409: problemSchema('conflict'),
          422: problemSchema('idempotency_conflict'),
          503: problemSchema('overloaded', 'partition_unavailable', 'transaction_retry_exhausted', 'deadline_exceeded'),
        },
        detail: {
          operationId: 'subject.take_down',
          'x-action': 'moderation:takedown',
          'x-rate-limit': defineRateLimit({ family: 'write', units: 1 }),
          security: [{ bearerAuth: [] }],
        },
      },
      async ({ params, body, headers, actor, authorizeCommand, admission, job, session }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        const route = routeOf(params.id);
        if (route === null) throw new ProblemError('not_found');
        const target = await admission.run('normal', job, () => readSubjectVisibility(pool, params.id));
        if (!target) throw new ProblemError('not_found');
        const authorization = await authorizeCommand(
          { route: 0, id: GLOBAL_CONTEXT },
          () => new SubjectAccessDeniedError(),
        );
        try {
          const result = await admission.run('normal', job, () =>
            moderateSubject(pool, {
              actor,
              subject: params.id,
              action: 'take_down',
              body,
              idempotencyKey: idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]),
              digest: requestDigest('subject.take_down', actor, { subject: params.id, body }),
              authorization,
              deadline: job.deadline,
            }),
          );
          session.record(result.component);
          return {
            subject: result.subject,
            visibility: result.visibility,
            security_revision: result.security_revision,
          };
        } catch (error) {
          return moderationError(error);
        }
      },
    )
    .post(
      customMethod('/v1/subjects/:id', 'restore'),
      {
        params: t.Object({ id: t.String() }),
        headers: t.Object({ [IDEMPOTENCY_HEADER]: t.String({ minLength: 3, maxLength: 1024 }) }),
        body: ReasonModerationBody,
        response: {
          200: withHeaders(visibilityResponse, { [SESSION_HEADER]: t.String() }),
          400: problemSchema('invalid_request'),
          401: unauthorized,
          403: problemSchema('forbidden'),
          404: problemSchema('not_found'),
          409: problemSchema('conflict'),
          422: problemSchema('idempotency_conflict'),
          503: problemSchema('overloaded', 'partition_unavailable', 'transaction_retry_exhausted', 'deadline_exceeded'),
        },
        detail: {
          operationId: 'subject.restore',
          'x-action': 'moderation:takedown',
          'x-rate-limit': defineRateLimit({ family: 'write', units: 1 }),
          security: [{ bearerAuth: [] }],
        },
      },
      async ({ params, body, headers, actor, authorizeCommand, admission, job, session }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        if (routeOf(params.id) === null) throw new ProblemError('not_found');
        const target = await admission.run('normal', job, () => readSubjectVisibility(pool, params.id));
        if (!target) throw new ProblemError('not_found');
        const authorization = await authorizeCommand(
          { route: 0, id: GLOBAL_CONTEXT },
          () => new SubjectAccessDeniedError(),
        );
        try {
          const result = await admission.run('normal', job, () =>
            moderateSubject(pool, {
              actor,
              subject: params.id,
              action: 'restore',
              body,
              idempotencyKey: idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]),
              digest: requestDigest('subject.restore', actor, { subject: params.id, body }),
              authorization,
              deadline: job.deadline,
            }),
          );
          session.record(result.component);
          return {
            subject: result.subject,
            visibility: result.visibility,
            security_revision: result.security_revision,
          };
        } catch (error) {
          return moderationError(error);
        }
      },
    )
    .post(
      '/v1/subjects/:id/candidates',
      {
        params: t.Object({ id: t.String() }),
        headers: t.Object({ [IDEMPOTENCY_HEADER]: t.String({ minLength: 3, maxLength: 1024 }) }),
        body: t.Object({ statement: t.Any() }, { additionalProperties: false }),
        response: {
          201: withHeaders(t.Object({ candidate: t.String({ format: 'uuid' }), revision: t.Integer({ minimum: 1 }) }), {
            [SESSION_HEADER]: t.String(),
          }),
          400: problemSchema('invalid_request'),
          401: unauthorized,
          403: problemSchema('forbidden'),
          404: problemSchema('not_found'),
          422: problemSchema('idempotency_conflict'),
          503: problemSchema(
            'semantic_not_ready',
            'overloaded',
            'partition_unavailable',
            'transaction_retry_exhausted',
            'deadline_exceeded',
          ),
        },
        detail: {
          operationId: 'subject.propose',
          'x-action': 'statement:propose',
          security: [{ bearerAuth: [] }],
          'x-rate-limit': defineRateLimit({ family: 'write', units: 1 }),
        },
      },
      async ({ params, body, headers, actor, authorizeCommand, admission, job, session, set }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        if (routeOf(params.id) === null) throw new ProblemError('not_found');
        const active = await activeRelease(pool);
        if (!active) throw new ProblemError('semantic_not_ready');
        const authorization = await authorizeCommand(
          { route: 0, id: GLOBAL_CONTEXT },
          () => new SubjectAccessDeniedError(),
        );
        try {
          const result = await admission.run('normal', job, () =>
            proposeStatement(pool, {
              subject: params.id,
              statement: body.statement,
              actor,
              idempotencyKey: idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]),
              digest: requestDigest('subject.propose', actor, { subject: params.id, body }),
              release: active,
              authorization,
              deadline: job.deadline,
            }),
          );
          session.record(result.component);
          set.status = 201;
          return { candidate: result.candidate, revision: result.revision };
        } catch (error) {
          return candidateError(error);
        }
      },
    )
    .post(
      customMethod('/v1/subjects/:id/candidates/:candidate', 'accept'),
      {
        params: t.Object({ id: t.String(), candidate: t.String({ format: 'uuid' }) }),
        headers: t.Object({ [IDEMPOTENCY_HEADER]: t.String({ minLength: 3, maxLength: 1024 }) }),
        body: DecisionBody,
        response: {
          200: withHeaders(acceptanceResponse, { [SESSION_HEADER]: t.String() }),
          400: problemSchema('invalid_request'),
          401: unauthorized,
          403: problemSchema('forbidden'),
          404: problemSchema('not_found'),
          409: problemSchema('conflict', 'stale_editorial_head'),
          422: problemSchema('idempotency_conflict'),
          503: problemSchema(
            'semantic_not_ready',
            'overloaded',
            'partition_unavailable',
            'transaction_retry_exhausted',
            'deadline_exceeded',
          ),
        },
        detail: {
          operationId: 'subject.accept_candidate',
          'x-action': 'context:accept',
          'x-rate-limit': defineRateLimit({ family: 'write', units: 1 }),
          security: [{ bearerAuth: [] }],
        },
      },
      async ({ params, body, headers, actor, authorizeCommand, admission, job, session }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        if (routeOf(params.id) === null) throw new ProblemError('not_found');
        const contextRoute = routeOf(body.context);
        if (contextRoute === null) throw new ProblemError('invalid_request');
        const authorization = await authorizeCommand(
          { route: contextRoute, id: body.context },
          () => new SubjectAccessDeniedError(),
        );
        try {
          const { component, acceptance, revision } = await admission.run('normal', job, () =>
            decideCandidate(pool, {
              subject: params.id,
              candidate: params.candidate,
              decision: 'accept',
              context: body.context,
              expectedHead: body.expected_head,
              actor,
              idempotencyKey: idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]),
              digest: requestDigest('subject.decide', actor, {
                subject: params.id,
                candidate: params.candidate,
                decision: 'accept',
                body,
              }),
              authorization,
              deadline: job.deadline,
            }),
          );
          session.record(component);
          return { acceptance, revision };
        } catch (error) {
          return candidateError(error);
        }
      },
    )
    .post(
      customMethod('/v1/subjects/:id/candidates/:candidate', 'reject'),
      {
        params: t.Object({ id: t.String(), candidate: t.String({ format: 'uuid' }) }),
        headers: t.Object({ [IDEMPOTENCY_HEADER]: t.String({ minLength: 3, maxLength: 1024 }) }),
        body: DecisionBody,
        response: {
          200: withHeaders(acceptanceResponse, { [SESSION_HEADER]: t.String() }),
          400: problemSchema('invalid_request'),
          401: unauthorized,
          403: problemSchema('forbidden'),
          404: problemSchema('not_found'),
          409: problemSchema('conflict', 'stale_editorial_head'),
          422: problemSchema('idempotency_conflict'),
          503: problemSchema(
            'semantic_not_ready',
            'overloaded',
            'partition_unavailable',
            'transaction_retry_exhausted',
            'deadline_exceeded',
          ),
        },
        detail: {
          operationId: 'subject.reject_candidate',
          'x-action': 'context:accept',
          'x-rate-limit': defineRateLimit({ family: 'write', units: 1 }),
          security: [{ bearerAuth: [] }],
        },
      },
      async ({ params, body, headers, actor, authorizeCommand, admission, job, session }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        if (routeOf(params.id) === null) throw new ProblemError('not_found');
        const contextRoute = routeOf(body.context);
        if (contextRoute === null) throw new ProblemError('invalid_request');
        const authorization = await authorizeCommand(
          { route: contextRoute, id: body.context },
          () => new SubjectAccessDeniedError(),
        );
        try {
          const { component, acceptance, revision } = await admission.run('normal', job, () =>
            decideCandidate(pool, {
              subject: params.id,
              candidate: params.candidate,
              decision: 'reject',
              context: body.context,
              expectedHead: body.expected_head,
              actor,
              idempotencyKey: idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]),
              digest: requestDigest('subject.decide', actor, {
                subject: params.id,
                candidate: params.candidate,
                decision: 'reject',
                body,
              }),
              authorization,
              deadline: job.deadline,
            }),
          );
          session.record(component);
          return { acceptance, revision };
        } catch (error) {
          return candidateError(error);
        }
      },
    )
    .post(
      customMethod('/v1/subjects/:id', 'adopt'),
      {
        params: t.Object({ id: t.String() }),
        headers: t.Object({ [IDEMPOTENCY_HEADER]: t.String({ minLength: 3, maxLength: 1024 }) }),
        body: AdoptionBody,
        response: {
          200: withHeaders(adoptionResponse, { [SESSION_HEADER]: t.String() }),
          400: problemSchema('invalid_request'),
          401: unauthorized,
          403: problemSchema('forbidden'),
          404: problemSchema('not_found'),
          409: problemSchema('conflict', 'stale_editorial_head'),
          422: problemSchema('idempotency_conflict'),
          503: problemSchema(
            'semantic_not_ready',
            'overloaded',
            'partition_unavailable',
            'transaction_retry_exhausted',
            'deadline_exceeded',
          ),
        },
        detail: {
          operationId: 'subject.adopt',
          'x-action': 'context:adopt',
          'x-rate-limit': defineRateLimit({ family: 'write', units: 1 }),
          security: [{ bearerAuth: [] }],
        },
      },
      async ({ params, body, headers, actor, authorizeCommand, admission, job, session }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        if (routeOf(params.id) === null) throw new ProblemError('not_found');
        const contextRoute = routeOf(body.context);
        if (contextRoute === null) throw new ProblemError('invalid_request');
        const active = await activeRelease(pool);
        if (!active) throw new ProblemError('semantic_not_ready');
        const authorization = await authorizeCommand(
          { route: contextRoute, id: body.context },
          () => new SubjectAccessDeniedError(),
        );
        try {
          const { component, adoption, revision } = await admission.run('normal', job, () =>
            adoptCandidates(pool, {
              subject: params.id,
              context: body.context,
              property: body.property,
              mode: body.mode,
              selection: body.selection as { candidate: string; rank: 'normal' | 'preferred' | 'deprecated' }[],
              expectedHead: body.expected_head,
              actor,
              idempotencyKey: idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]),
              digest: requestDigest('subject.adopt', actor, { subject: params.id, body }),
              authorization,
              deadline: job.deadline,
              release: active,
            }),
          );
          session.record(component);
          return { adoption, revision };
        } catch (error) {
          return candidateError(error);
        }
      },
    )
    .get(
      '/v1/subjects/:id/candidates',
      {
        params: t.Object({ id: t.String() }),
        query: t.Object({
          ...pageQuery,
          property: t.String({ minLength: 1 }),
          context: t.Optional(EditorialBodyContext),
        }),
        response: {
          200: t.Object({
            candidates: t.Array(
              t.Object({
                id: t.String({ format: 'uuid' }),
                statement: StatementSchema,
                release: t.String(),
                revision: t.Integer(),
                decision: t.Union([t.Literal('accepted'), t.Literal('rejected'), t.Null()]),
                head: t.Union([t.Integer(), t.Null()]),
                rank: t.Union([t.Literal('normal'), t.Literal('preferred'), t.Literal('deprecated'), t.Null()]),
              }),
            ),
            adoption: t.Union([
              t.Object({
                mode: t.Union([t.Literal('inherit'), t.Literal('replace'), t.Literal('suppress')]),
                head: t.Integer(),
              }),
              t.Null(),
            ]),
            next: t.Union([t.String(), t.Null()]),
          }),
          ...listingErrors,
        },
        detail: {
          operationId: 'subject.list_candidates',
          'x-action': 'subject:read',
          security: [{ bearerAuth: [] }, {}],
        },
      },
      async ({ params, query, authorize, admission, job, session }) => {
        const route = routeOf(params.id);
        if (route === null) throw new ProblemError('not_found');
        const resource = { route, id: params.id };
        const check = await authorize({ ...resource, eligibility: subjectReadEligibility(resource) });
        try {
          const { component, ...result } = await admission.run('normal', job, () =>
            listCandidates(pool, tokens, {
              subject: params.id,
              property: query.property,
              context: query.context ?? GLOBAL_CONTEXT,
              limit: query.limit ?? 20,
              ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
              authorize: check,
            }),
          );
          session.record(component);
          return result;
        } catch (error) {
          return candidateError(error);
        }
      },
    )
    .get(
      '/v1/subjects/:id/revisions',
      {
        params: t.Object({ id: t.String() }),
        query: t.Object(pageQuery),
        response: {
          200: t.Object({
            revisions: t.Array(t.Object({ revision: t.Integer(), kind: t.String(), release: t.String() })),
            next: t.Union([t.String(), t.Null()]),
          }),
          ...listingErrors,
        },
        detail: {
          operationId: 'subject.list_revisions',
          'x-action': 'subject:read',
          security: [{ bearerAuth: [] }, {}],
        },
      },
      async ({ params, query, authorize, admission, job, session }) => {
        const route = routeOf(params.id);
        if (route === null) throw new ProblemError('not_found');
        const resource = { route, id: params.id };
        const check = await authorize({ ...resource, eligibility: subjectReadEligibility(resource) });
        try {
          const { component, ...result } = await admission.run('normal', job, () =>
            listRevisions(pool, tokens, {
              subject: params.id,
              limit: query.limit ?? 20,
              ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
              authorize: check,
            }),
          );
          session.record(component);
          return result;
        } catch (error) {
          return candidateError(error);
        }
      },
    )
    .get(
      '/v1/subjects/:id/links',
      {
        params: t.Object({ id: t.String() }),
        query: t.Object({ ...pageQuery, property: t.Optional(t.String({ minLength: 1 })) }),
        response: {
          200: t.Object(
            {
              links: t.Array(
                t.Object(
                  { subject: t.String(), property: t.String(), statement: t.String() },
                  { additionalProperties: false },
                ),
              ),
              freshness: t.Object(
                {
                  consistency: t.Literal('eventual'),
                  target_seconds: t.Literal(10),
                  caught_up: t.Boolean(),
                },
                { additionalProperties: false },
              ),
              next: t.Union([t.String(), t.Null()]),
            },
            { additionalProperties: false },
          ),
          ...listingErrors,
        },
        detail: {
          operationId: 'subject.links',
          'x-action': 'subject:read',
          security: [{ bearerAuth: [] }, {}],
        },
      },
      async ({ params, query, authorize, admission, job, session }) => {
        const route = routeOf(params.id);
        if (route === null) throw new ProblemError('not_found');
        const active = await activeRelease(pool);
        if (!active) throw new ProblemError('semantic_not_ready');
        if (query.property !== undefined && !Object.hasOwn(active.release.properties, query.property))
          throw new ProblemError('invalid_request');
        const resource = { route, id: params.id };
        const check = await authorize({ ...resource, eligibility: subjectReadEligibility(resource) });
        try {
          const { component, ...result } = await admission.run('normal', job, () =>
            listSubjectLinks(pool, tokens, {
              subject: params.id,
              property: query.property ?? null,
              limit: query.limit ?? 20,
              ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
              authorize: check,
              seen: [...session.components],
            }),
          );
          session.record(component);
          return result;
        } catch (error) {
          return candidateError(error);
        }
      },
    );
}

export { subjectRoutes };
