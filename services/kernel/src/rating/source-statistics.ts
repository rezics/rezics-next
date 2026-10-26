import canonicalize from 'canonicalize';
import { createHash } from 'node:crypto';
import { t } from 'elysia';
import type { Pool } from 'pg';
import { GrantDeniedError } from '../access/grant-commands.ts';
import type { CommandAuthorization } from '../command/command.ts';
import { runCommand } from '../command/command.ts';
import { ProblemError, problemSchema } from '../http/problem.ts';
import { defineRateLimit } from '../http/rate-limit.ts';
import { IDEMPOTENCY_HEADER, idempotencyKeyOf } from '../http/request.ts';
import { withConnection } from '../database/pool.ts';
import { AuthenticationError, type Access, type Actor } from '../request/access.ts';
import { resolveSubject } from '../library/subject-anchor.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { GLOBAL_CONTEXT } from '../semantic/definitions.ts';
import type { definitionRoutes } from '../semantic/http/definitions.ts';
import type { KernelClock } from '../clock.ts';
import { VOTE_SCOPE } from './votes.ts';
import sourceStatisticList from './source-statistic-list.sql';
import sourceStatisticUpsert from './source-statistic-upsert.sql';
import {
  SourceStatisticInputSchema,
  SourceStatisticListResponseSchema,
  SourceStatisticResponseSchema,
} from './schemas.ts';

export const SOURCE_STATISTIC_WRITE_ACTION = 'source_statistic:write';
const SOURCE_STATISTIC_EVENT = 'com.rezics.rating.source_statistic.changed.v1';
const SOURCE_STATISTIC_OPERATION = 'rating.source_statistic.write';
const root = Object.freeze({ route: 0, id: GLOBAL_CONTEXT });

type SourceStatistic = {
  source: 'vndb';
  sourceRecordId: string;
  scale: { min: number; max: number };
  mean: number;
  count: number;
  asOf: string;
  licence: string;
  attribution: string;
};

type Input = Omit<SourceStatistic, 'source'>;
type Row = {
  source: 'vndb';
  sourceRecordId: string;
  scaleMin: number;
  scaleMax: number;
  mean: string | number;
  count: number;
  asOf: string;
  licence: string;
  attribution: string;
};
type Dependencies = { pool: Pool; access: () => Access; clock?: KernelClock };
type WriteInput = {
  actor: Actor;
  subjectId: string;
  source: string;
  value: Input;
  idempotencyKey: string;
  authorization: CommandAuthorization;
  deadline: number;
};

export class SourceStatisticInvalidError extends Error {
  constructor(readonly field: string) {
    super(`Invalid source statistic field: ${field}`);
    this.name = 'SourceStatisticInvalidError';
  }
}

export class SourceStatisticNotFoundError extends Error {
  constructor() {
    super('Source statistic subject not found');
    this.name = 'SourceStatisticNotFoundError';
  }
}

function statistic(row: Row): SourceStatistic {
  return {
    source: row.source,
    sourceRecordId: row.sourceRecordId,
    scale: { min: Number(row.scaleMin), max: Number(row.scaleMax) },
    mean: Number(row.mean),
    count: Number(row.count),
    asOf: row.asOf,
    licence: row.licence,
    attribution: row.attribution,
  };
}

function validate(source: string, subjectId: string, value: Input, authorization: CommandAuthorization): number {
  const route = routeOf(subjectId);
  if (route === null) throw new SourceStatisticNotFoundError();
  if (
    authorization.action !== SOURCE_STATISTIC_WRITE_ACTION ||
    authorization.resource.route !== root.route ||
    authorization.resource.id !== root.id
  )
    throw new GrantDeniedError();
  if (source !== 'vndb') throw new SourceStatisticInvalidError('source');
  if (!value || typeof value !== 'object' || !value.scale || typeof value.scale !== 'object')
    throw new SourceStatisticInvalidError('statistic');
  if (
    !Number.isSafeInteger(value.scale.min) ||
    !Number.isSafeInteger(value.scale.max) ||
    value.scale.min < 0 ||
    value.scale.max <= value.scale.min ||
    value.scale.max > 4096
  )
    throw new SourceStatisticInvalidError('scale');
  if (!Number.isFinite(value.mean) || value.mean < value.scale.min || value.mean > value.scale.max)
    throw new SourceStatisticInvalidError('mean');
  if (!Number.isSafeInteger(value.count) || value.count < 1 || value.count > 2_147_483_647)
    throw new SourceStatisticInvalidError('count');
  const asOfTime = typeof value.asOf === 'string' ? new Date(`${value.asOf}T00:00:00.000Z`) : null;
  if (
    typeof value.asOf !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value.asOf) ||
    !asOfTime ||
    !Number.isFinite(asOfTime.getTime()) ||
    asOfTime.toISOString().slice(0, 10) !== value.asOf
  )
    throw new SourceStatisticInvalidError('asOf');
  if (
    typeof value.sourceRecordId !== 'string' ||
    value.sourceRecordId.length < 1 ||
    Buffer.byteLength(value.sourceRecordId, 'utf8') > 1024 ||
    typeof value.licence !== 'string' ||
    value.licence.length < 1 ||
    Buffer.byteLength(value.licence, 'utf8') > 1024 ||
    typeof value.attribution !== 'string' ||
    value.attribution.length < 1 ||
    Buffer.byteLength(value.attribution, 'utf8') > 2000
  )
    throw new SourceStatisticInvalidError('label');
  return route;
}

function digest(subjectId: string, source: string, value: Input): Buffer {
  const canonical = canonicalize([subjectId, source, value]);
  if (typeof canonical !== 'string') throw new TypeError('Source statistic must be canonical JSON');
  return createHash('sha256').update(canonical, 'utf8').digest();
}

/** Stores source scores by subject and source. The authorization is always on Global Context. */
export function createSourceStatisticCommands(config: { pool: Pool; clock?: KernelClock }) {
  async function write(input: WriteInput): Promise<SourceStatistic> {
    if (input.actor.kind !== 'account') throw new GrantDeniedError();
    const route = validate(input.source, input.subjectId, input.value, input.authorization);
    const outcome = await runCommand(
      config.pool,
      {
        partition: partitionOf(route),
        deadline: input.deadline,
        ...(config.clock === undefined ? {} : { clock: config.clock }),
        authorization: input.authorization,
        receipt: {
          actorAccountId: input.actor.accountId,
          kind: SOURCE_STATISTIC_OPERATION,
          key: input.idempotencyKey,
          digest: digest(input.subjectId, input.source, input.value),
        },
        basis: {
          actorAccountId: input.actor.accountId,
          clientId: input.actor.clientId,
          requestedBy: input.actor.requestedBy,
        },
      },
      async (tx, command) => {
        const rows = await sourceStatisticUpsert.run(tx, {
          route,
          subject_id: input.subjectId,
          source: input.source,
          source_record_id: input.value.sourceRecordId,
          scale_min: input.value.scale.min,
          scale_max: input.value.scale.max,
          mean: String(input.value.mean),
          count: input.value.count,
          as_of: input.value.asOf,
          licence: input.value.licence,
          attribution: input.value.attribution,
          transaction_id: command.transactionId,
        });
        const row = rows[0];
        if (!row) throw new SourceStatisticNotFoundError();
        const value = statistic(row as Row);
        return {
          value,
          events: [
            {
              type: SOURCE_STATISTIC_EVENT,
              subject: input.subjectId,
              data: { subjectId: input.subjectId, source: value.source, sourceRecordId: value.sourceRecordId },
            },
          ],
        };
      },
    );
    return outcome.value;
  }

  async function read(subjectId: string): Promise<SourceStatistic[]> {
    const route = routeOf(subjectId);
    if (route === null) return [];
    const rows = await withConnection(config.pool, (client) =>
      sourceStatisticList.run(client, { route, subject_id: subjectId }),
    );
    return rows.map((row) => statistic(row as Row));
  }

  return { write, read };
}

function sourceStatisticProblem(error: unknown): never {
  if (error instanceof GrantDeniedError) throw new ProblemError('forbidden');
  if (error instanceof SourceStatisticNotFoundError) throw new ProblemError('not_found');
  if (error instanceof SourceStatisticInvalidError)
    throw new ProblemError('invalid_request', {
      errors: [{ pointer: `/${error.field}`, code: 'out_of_range' }],
    });
  throw error;
}

function requireRatingRead(actor: Actor, ...ids: string[]): asserts actor is Extract<Actor, { kind: 'account' }> {
  if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
  if (!actor.scopes.includes(VOTE_SCOPE)) throw new ProblemError('forbidden');
  if (ids.some((value) => routeOf(value) === null)) throw new ProblemError('not_found');
}

function detail(operationId: string, action: string, write = false) {
  return {
    operationId,
    'x-action': action,
    'x-exposure': 'gate:personal_library',
    security: [{ bearerAuth: [] }],
    ...(write ? { 'x-rate-limit': defineRateLimit({ family: 'write', units: 1 }) } : {}),
  };
}

const headers = t.Object({ [IDEMPOTENCY_HEADER]: t.String({ minLength: 3, maxLength: 1024 }) });
const id = t.String({ format: 'uuid' });
const source = t.Literal('vndb');
const closed = { additionalProperties: false } as const;
const failures = {
  400: problemSchema('invalid_request'),
  401: problemSchema('authentication_required', 'invalid_credentials'),
  403: problemSchema('forbidden'),
  404: problemSchema('not_found'),
  409: problemSchema('conflict'),
  422: problemSchema('idempotency_conflict'),
  503: problemSchema('overloaded', 'partition_unavailable', 'transaction_retry_exhausted', 'deadline_exceeded'),
};

/** Source statistics have their own read/write routes and never enter native vote storage. */
export function sourceStatisticRoutes(app: ReturnType<typeof definitionRoutes>, dependencies: Dependencies) {
  const config = () => ({ ...dependencies, access: dependencies.access() });
  const commands = () => createSourceStatisticCommands(config());

  return app
    .get(
      '/v1/subjects/:id/source-statistics',
      {
        params: t.Object({ id }, closed),
        response: { 200: SourceStatisticListResponseSchema, ...failures },
        detail: detail('rating.source_statistics_get', VOTE_SCOPE),
      },
      async ({ actor, params, admission, job }) => {
        requireRatingRead(actor, params.id);
        return admission.run('normal', job, async () => {
          const readable = await resolveSubject(
            {
              pool: dependencies.pool,
              access: dependencies.access(),
              ...(dependencies.clock ? { clock: dependencies.clock } : {}),
            },
            actor,
            params.id,
          );
          if (!readable) throw new ProblemError('not_found');
          return commands().read(readable.subjectId);
        });
      },
    )
    .put(
      '/v1/subjects/:id/source-statistics/:source',
      {
        params: t.Object({ id, source }, closed),
        headers,
        body: SourceStatisticInputSchema,
        response: { 200: SourceStatisticResponseSchema, ...failures },
        detail: detail('rating.source_statistic_put', SOURCE_STATISTIC_WRITE_ACTION, true),
      },
      async ({ actor, params, body, headers: requestHeaders, authorizeCommand, admission, job }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        const key = idempotencyKeyOf(requestHeaders[IDEMPOTENCY_HEADER]);
        const authorization = await authorizeCommand(root, () => new GrantDeniedError());
        try {
          return await admission.run('normal', job, () =>
            commands().write({
              actor,
              subjectId: params.id,
              source: params.source,
              value: body,
              idempotencyKey: key,
              authorization,
              deadline: job.deadline,
            }),
          );
        } catch (error) {
          return sourceStatisticProblem(error);
        }
      },
    );
}
