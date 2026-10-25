import { withHeaders } from '@elysia/openapi';
import { t } from 'elysia';
import type { Pool } from 'pg';
import { withConnection } from '../../database/pool.ts';
import { SubjectInputError, type Item, type Snak } from '../item.ts';
import {
  createSubject,
  readLabels,
  readSubject,
  SubjectAccessDeniedError,
  subjectTarget,
} from '../subject.ts';
import { DATA_TYPES, type DataType } from '@rezics/definitions';
import { GrantDeniedError } from '../../access/grant-commands.ts';
import { activeRelease, GLOBAL_CONTEXT, readRelease } from '../definitions.ts';
import { routeOf } from '../../route/route.ts';
import type { AccountActor } from '../../request/access.ts';
import { AuthenticationError } from '../../request/access.ts';
import { createResourcePublicEligibility } from '../../access/index.ts';
import { createApp } from '../../http/app.ts';
import { ProblemError, problemSchema } from '../../http/problem.ts';
import { IDEMPOTENCY_HEADER, idempotencyKeyOf, requestDigest, SESSION_HEADER } from '../../http/request.ts';
import subjectExists from '../subject-exists.sql';

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

const LabelsSchema = t.Object({ labels: t.Record(t.String(), t.String()) }, { additionalProperties: false });
const itemResponse = t.Object({ subject: ItemSchema }, { additionalProperties: false });
const readResponse = t.Object(
  { subject: ItemSchema, related: t.Record(t.String(), LabelsSchema) },
  { additionalProperties: false },
);
const unauthorized = problemSchema('authentication_required', 'invalid_credentials');
type SubjectRouteDependencies = { pool: Pool; routeKey: Uint8Array };
function invalidSubjectInput(error: SubjectInputError): ProblemError {
  return new ProblemError('invalid_request', { errors: error.violations });
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

function subjectRoutes(app: ReturnType<typeof createApp>, { pool, routeKey }: SubjectRouteDependencies) {
  const publicRead = (resource: { route: number; id: string }) =>
    createResourcePublicEligibility({
      resource,
      action: 'subject:read',
      async prepare() {
        return null;
      },
      async verify({ client }) {
        return (await subjectExists.run(client, { route: resource.route, subject_id: resource.id })) !== null;
      },
    });
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
      async ({ params, authorize, admission, job, session, set }) => {
        const route = routeOf(params.id);
        if (route === null) throw new ProblemError('not_found');
        const resource = { route, id: params.id };
        const check = await authorize({ ...resource, eligibility: publicRead(resource) });
        const result = await admission.run('normal', job, () => readSubject(pool, params.id, check));
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
            const relatedCheck = await authorize({ ...relatedResource, eligibility: publicRead(relatedResource) });
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
    );
}

export { subjectRoutes };
