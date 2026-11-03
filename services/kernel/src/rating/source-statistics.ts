import canonicalize from 'canonicalize';
import { createHash } from 'node:crypto';
import { withHeaders } from '@elysia/openapi';
import { t } from 'elysia';
import { Compile } from 'typebox/compile';
import type { Pool } from 'pg';
import { GrantDeniedError } from '../access/grant-commands.ts';
import { deadlineClient, within } from '../access/authenticate.ts';
import type { CommandAuthorization, CommandOutcome } from '../command/command.ts';
import { noEffect, principalCommandIdentity, runCommand } from '../command/command.ts';
import { discardConnection, withConnection } from '../database/pool.ts';
import { ProblemError, problemSchema } from '../http/problem.ts';
import { customMethod } from '../http/custom-method.ts';
import { defineRateLimit } from '../http/rate-limit.ts';
import { IDEMPOTENCY_HEADER, idempotencyKeyOf, SESSION_HEADER } from '../http/request.ts';
import { AuthenticationError, type Access, type Actor } from '../request/access.ts';
import { resolveSubject } from '../library/subject-anchor.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { readPartition } from '../partition/partition.ts';
import { GLOBAL_CONTEXT } from '../semantic/definitions.ts';
import type { definitionRoutes } from '../semantic/http/definitions.ts';
import type { KernelClock } from '../clock.ts';
import { SourceFenceQuerySchema } from '../content/schemas.ts';
import { tupleRoute } from '../content/imported-contract.ts';
import { readFences, type SourceFenceTuple } from '../content/source-fences.ts';
import sourceStatisticList from './source-statistic-list.sql';
import sourceStatisticUpsert from './source-statistic-upsert.sql';
import sourceStatisticClear from './source-statistic-clear.sql';
import { SOURCE_PROVIDER_IDS, sourceProvider, type SourceProvider } from './source-provider.ts';
import { admitSourceObservation, lockSourceObservation, saveSourceObservation } from './source-provider-observation.ts';
import {
  SourceStatisticClearInputSchema,
  SourceStatisticInputSchema,
  SourceStatisticListResponseSchema,
  SourceStatisticResponseSchema,
} from './schemas.ts';

export const SOURCE_STATISTIC_WRITE_ACTION = 'source_statistic:write';
const SOURCE_STATISTIC_EVENT = 'com.rezics.rating.source_statistic.changed.v1';
const SOURCE_STATISTIC_OPERATION = 'rating.source_statistic.write';
const SOURCE_STATISTIC_CLEAR_OPERATION = 'rating.source_statistic.clear';
const root = Object.freeze({ route: 0, id: GLOBAL_CONTEXT });
const sourceAliasValidator = Compile(SourceFenceQuerySchema.properties.source);
const sourceRecordControls = /[\u0000-\u001f\u007f-\u009f]/u;

type SourceStatistic = {
  source: SourceProvider;
  sourceAlias?: string;
  sourceRecordId: string;
  scale: { min: number; max: number };
  mean: number;
  count: number;
  asOf: string;
  licence: string;
  attribution: string;
  observation?: { kind: 'unversioned'; digest: string };
};

type Input = Omit<SourceStatistic, 'source' | 'observation'> & { expectedObservation?: string | null };
type ClearInput = Readonly<{
  sourceAlias?: string;
  sourceRecordId: string;
  count: 0;
  asOf: string;
  expectedObservation?: string | null;
}>;
type Row = {
  source: SourceProvider;
  sourceAlias: string;
  sourceRecordId: string;
  scaleMin: number;
  scaleMax: number;
  mean: string | number;
  count: number;
  asOf: string;
  licence: string;
  attribution: string;
  observationDigest: string | null;
};
type Dependencies = { pool: Pool; access: () => Access; routeKey: Uint8Array; clock?: KernelClock };
type CommandDependencies = { pool: Pool; routeKey: Uint8Array; clock?: KernelClock };
type WriteInput = {
  actor: Actor;
  subjectId: string;
  source: string;
  value: Input;
  idempotencyKey: string;
  authorization: CommandAuthorization;
  deadline: number;
  subjectAvailable?: boolean;
};
type ClearInputCommand = {
  actor: Actor;
  subjectId: string;
  source: string;
  value: ClearInput;
  idempotencyKey: string;
  authorization: CommandAuthorization;
  deadline: number;
  subjectAvailable?: boolean;
};
type FenceSnapshot = Readonly<{
  fence: Readonly<{ takenDown: boolean; securityRevision: string | null }>;
  partition: number;
  epoch: number;
  position: bigint;
}>;
type ExpectedFenceRevision = Readonly<{
  source: string;
  external_id: string;
  securityRevision: string | null;
}>;
type WriteCommandOutcome = CommandOutcome<SourceStatistic> & Readonly<{ preparedFenceRevision: string | null }>;

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
    ...(row.sourceAlias === row.source ? {} : { sourceAlias: row.sourceAlias }),
    sourceRecordId: row.sourceRecordId,
    scale: { min: Number(row.scaleMin), max: Number(row.scaleMax) },
    mean: Number(row.mean),
    count: Number(row.count),
    asOf: row.asOf,
    licence: row.licence,
    attribution: row.attribution,
    ...(row.observationDigest ? { observation: { kind: 'unversioned' as const, digest: row.observationDigest } } : {}),
  };
}

function validateSourceRecordId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.isWellFormed() &&
    !sourceRecordControls.test(value) &&
    Buffer.byteLength(value, 'utf8') <= 1024
  );
}

function effectiveAlias(source: string, value: { sourceAlias?: string }): string {
  return value.sourceAlias ?? source;
}

function validateAlias(value: { sourceAlias?: string }): void {
  const alias = value.sourceAlias;
  if (alias === undefined) return;
  if (typeof alias !== 'string' || !sourceAliasValidator.Check(alias) || sourceRecordControls.test(alias))
    throw new SourceStatisticInvalidError('sourceAlias');
}

function digestValue<T extends { sourceAlias?: string }>(source: string, value: T): T | Omit<T, 'sourceAlias'> {
  if (value.sourceAlias !== source) return value;
  const { sourceAlias: _alias, ...legacy } = value;
  return legacy;
}

function validateAsOf(value: unknown): value is string {
  const date =
    typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00.000Z`) : null;
  return Boolean(date && Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value);
}

function authorizeWrite(source: string, subjectId: string, authorization: CommandAuthorization): number {
  const route = routeOf(subjectId);
  if (route === null) throw new SourceStatisticNotFoundError();
  if (
    authorization.action !== SOURCE_STATISTIC_WRITE_ACTION ||
    authorization.resource.route !== root.route ||
    authorization.resource.id !== root.id
  )
    throw new GrantDeniedError();
  if (!sourceProvider(source)) throw new SourceStatisticInvalidError('source');
  return route;
}

function validate(source: string, subjectId: string, value: Input, authorization: CommandAuthorization): number {
  const route = authorizeWrite(source, subjectId, authorization);
  if (!value || typeof value !== 'object' || !value.scale || typeof value.scale !== 'object')
    throw new SourceStatisticInvalidError('statistic');
  validateAlias(value);
  if (
    value.expectedObservation !== undefined &&
    value.expectedObservation !== null &&
    (typeof value.expectedObservation !== 'string' || !/^[0-9a-f]{64}$/.test(value.expectedObservation))
  )
    throw new SourceStatisticInvalidError('expectedObservation');
  if (
    !Number.isSafeInteger(value.scale.min) ||
    !Number.isSafeInteger(value.scale.max) ||
    value.scale.min < 0 ||
    value.scale.max <= value.scale.min ||
    !sourceProvider(source)!.scale(value.scale.min, value.scale.max)
  )
    throw new SourceStatisticInvalidError('scale');
  if (!Number.isFinite(value.mean) || value.mean < value.scale.min || value.mean > value.scale.max)
    throw new SourceStatisticInvalidError('mean');
  if (!Number.isSafeInteger(value.count) || value.count < 1 || value.count > 2_147_483_647)
    throw new SourceStatisticInvalidError('count');
  if (!validateAsOf(value.asOf)) throw new SourceStatisticInvalidError('asOf');
  if (
    !validateSourceRecordId(value.sourceRecordId) ||
    !sourceProvider(source)!.record(value.sourceRecordId) ||
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

function validateClear(
  source: string,
  subjectId: string,
  value: ClearInput,
  authorization: CommandAuthorization,
): number {
  const route = authorizeWrite(source, subjectId, authorization);
  if (!value || typeof value !== 'object') throw new SourceStatisticInvalidError('clear');
  validateAlias(value);
  if (
    value.expectedObservation !== undefined &&
    value.expectedObservation !== null &&
    (typeof value.expectedObservation !== 'string' || !/^[0-9a-f]{64}$/.test(value.expectedObservation))
  )
    throw new SourceStatisticInvalidError('expectedObservation');
  if (!validateSourceRecordId(value.sourceRecordId) || !sourceProvider(source)!.record(value.sourceRecordId))
    throw new SourceStatisticInvalidError('sourceRecordId');
  if (value.count !== 0) throw new SourceStatisticInvalidError('count');
  if (!validateAsOf(value.asOf)) throw new SourceStatisticInvalidError('asOf');
  return route;
}

function digest(subjectId: string, source: string, value: Input): Buffer {
  const canonical = canonicalize([subjectId, source, digestValue(source, value)]);
  if (typeof canonical !== 'string') throw new TypeError('Source statistic must be canonical JSON');
  return createHash('sha256').update(canonical, 'utf8').digest();
}

function clearDigest(subjectId: string, source: string, value: ClearInput): Buffer {
  const canonical = canonicalize([subjectId, source, digestValue(source, value)]);
  if (typeof canonical !== 'string') throw new TypeError('Source statistic clear must be canonical JSON');
  return createHash('sha256').update(canonical, 'utf8').digest();
}

function tupleFor(routeKey: Uint8Array, source: string, sourceRecordId: string): SourceFenceTuple {
  return {
    route: tupleRoute(routeKey, source, sourceRecordId),
    source,
    external_id: sourceRecordId,
    field_group: 'facts',
  };
}

/** Each tuple-fact read owns its correctly anchored repeatable-read connection. */
async function readFenceSnapshot(
  dependencies: CommandDependencies,
  tuple: SourceFenceTuple,
  deadline: number,
): Promise<FenceSnapshot> {
  return within(deadline, () =>
    withConnection(dependencies.pool, async (connection) => {
      const client = deadlineClient(connection, deadline);
      try {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        const partition = await readPartition(client, partitionOf(tuple.route));
        if (!partition || partition.writeState === 'moved') throw new ProblemError('partition_unavailable');
        const [fence] = await readFences(client, [tuple]);
        if (!fence) throw new ProblemError('partition_unavailable');
        await client.query('COMMIT');
        return { fence, partition: partition.partitionNo, epoch: partition.epoch, position: partition.position };
      } catch (error) {
        try {
          await connection.query('ROLLBACK');
        } catch (rollbackError) {
          discardConnection(connection, rollbackError as Error);
        }
        throw error;
      }
    }),
  );
}

/** Stores source scores by subject and source. The authorization is always on Global Context. */
export function createSourceStatisticCommands(config: CommandDependencies) {
  async function writeCommand(input: WriteInput): Promise<WriteCommandOutcome> {
    if (input.actor.kind !== 'account') throw new GrantDeniedError();
    const route = validate(input.source, input.subjectId, input.value, input.authorization);
    const tuple = tupleFor(config.routeKey, effectiveAlias(input.source, input.value), input.value.sourceRecordId);
    const preparedFence = await readFenceSnapshot(config, tuple, input.deadline);
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
        if (input.subjectAvailable === false) throw new SourceStatisticNotFoundError();
        if (preparedFence.fence.takenDown) throw new GrantDeniedError();
        const binding = { route, subjectId: input.subjectId, source: input.source, value: input.value };
        const locked = await lockSourceObservation(tx, binding);
        if (!locked.exists) throw new SourceStatisticNotFoundError();
        const next = admitSourceObservation(binding, locked.current);
        if (next.identical && !('legacy' in (locked.current ?? {}))) {
          const current = (await sourceStatisticList.run(tx, { route, subject_id: input.subjectId })).find(
            (row) => row.source === input.source,
          );
          if (!current) throw new ProblemError('conflict');
          return noEffect(statistic(current as Row));
        }
        if (locked.current && 'legacy' in locked.current)
          await saveSourceObservation(tx, binding, locked.current, command.transactionId);
        await saveSourceObservation(tx, binding, next, command.transactionId);
        const rows = await sourceStatisticUpsert.run(tx, {
          route,
          subject_id: input.subjectId,
          source: input.source,
          source_alias: effectiveAlias(input.source, input.value),
          source_record_id: input.value.sourceRecordId,
          scale_min: input.value.scale.min,
          scale_max: input.value.scale.max,
          mean: String(input.value.mean),
          count: input.value.count,
          as_of: input.value.asOf,
          licence: input.value.licence,
          attribution: input.value.attribution,
          transaction_id: command.transactionId,
          observation_digest:
            input.source === 'bangumi' || input.value.expectedObservation !== undefined ? next.digest : null,
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
              data: {
                subjectId: input.subjectId,
                source: value.source,
                sourceRecordId: value.sourceRecordId,
                observationDigest: next.digest,
              },
            },
          ],
        };
      },
    );
    // Receipt lookup precedes a publication denial so a committed replay never claims no effect.
    if (preparedFence.fence.takenDown) throw new ProblemError('forbidden', { effectStatus: 'not_applicable' });
    return { ...outcome, preparedFenceRevision: preparedFence.fence.securityRevision };
  }

  async function write(input: WriteInput): Promise<SourceStatistic> {
    return (await writeCommand(input)).value;
  }

  async function clear(input: ClearInputCommand): Promise<CommandOutcome<{ removed: boolean }>> {
    if (input.actor.kind !== 'account') throw new GrantDeniedError();
    const route = validateClear(input.source, input.subjectId, input.value, input.authorization);
    const identity = principalCommandIdentity(input.actor);
    return runCommand(
      config.pool,
      {
        ...identity,
        partition: partitionOf(route),
        deadline: input.deadline,
        ...(config.clock === undefined ? {} : { clock: config.clock }),
        authorization: input.authorization,
        receipt: {
          kind: SOURCE_STATISTIC_CLEAR_OPERATION,
          key: input.idempotencyKey,
          digest: clearDigest(input.subjectId, input.source, input.value),
        },
      },
      async (tx, command) => {
        if (input.subjectAvailable === false) throw new SourceStatisticNotFoundError();
        const binding = { route, subjectId: input.subjectId, source: input.source, value: input.value };
        const locked = await lockSourceObservation(tx, binding);
        if (!locked.exists) throw new SourceStatisticNotFoundError();
        // An empty refresh for a different tuple has no authority over this slot.
        if (
          locked.current &&
          (locked.current.sourceAlias !== effectiveAlias(input.source, input.value) ||
            locked.current.sourceRecordId !== input.value.sourceRecordId)
        )
          return noEffect({ removed: false });
        const next = admitSourceObservation(binding, locked.current);
        if (next.identical) return noEffect({ removed: false });
        if (locked.current && 'legacy' in locked.current)
          await saveSourceObservation(tx, binding, locked.current, command.transactionId);
        await saveSourceObservation(tx, binding, next, command.transactionId);
        const result = await sourceStatisticClear.run(tx, {
          route,
          subject_id: input.subjectId,
          source: input.source,
          source_alias: effectiveAlias(input.source, input.value),
          source_record_id: input.value.sourceRecordId,
        });
        return {
          value: { removed: result.removed },
          events: [
            {
              type: SOURCE_STATISTIC_EVENT,
              subject: input.subjectId,
              data: {
                subjectId: input.subjectId,
                source: input.source,
                sourceRecordId: input.value.sourceRecordId,
                observationDigest: next.digest,
              },
            },
          ],
        };
      },
    );
  }

  async function readRaw(subjectId: string, deadline: number): Promise<SourceStatistic[]> {
    const route = routeOf(subjectId);
    if (route === null) return [];
    const rows = await within(deadline, () =>
      withConnection(config.pool, (connection) =>
        sourceStatisticList.run(deadlineClient(connection, deadline), { route, subject_id: subjectId }),
      ),
    );
    return rows.map((row) => statistic(row as Row));
  }

  async function read(
    subjectId: string,
    deadline = Date.now() + 2_000,
    expectedFence?: ExpectedFenceRevision,
  ): Promise<SourceStatistic[]> {
    const initial = await readRaw(subjectId, deadline);
    if (initial.length === 0) return initial;
    const tuples = initial.map((row) => tupleFor(config.routeKey, effectiveAlias(row.source, row), row.sourceRecordId));
    const first = await Promise.all(tuples.map((tuple) => readFenceSnapshot(config, tuple, deadline)));
    const final = await Promise.all(tuples.map((tuple) => readFenceSnapshot(config, tuple, deadline)));
    const current = await readRaw(subjectId, deadline);
    if (JSON.stringify(initial) !== JSON.stringify(current)) throw new SourceStatisticNotFoundError();
    return current.filter((_, index) => {
      const before = first[index]!.fence;
      const after = final[index]!.fence;
      const matchesExpected =
        expectedFence === undefined ||
        effectiveAlias(initial[index]!.source, initial[index]!) !== expectedFence.source ||
        initial[index]!.sourceRecordId !== expectedFence.external_id ||
        after.securityRevision === expectedFence.securityRevision;
      return (
        !before.takenDown && !after.takenDown && before.securityRevision === after.securityRevision && matchesExpected
      );
    });
  }

  return { write, writeCommand, clear, read };
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

function committedDisclosureProblem(error: unknown): ProblemError {
  if (error instanceof SourceStatisticNotFoundError || error instanceof GrantDeniedError)
    return new ProblemError('not_found', { effectStatus: 'not_applicable' });
  if (error instanceof ProblemError) {
    const problem = new ProblemError(error.code, {
      ...(error.detail === undefined ? {} : { detail: error.detail }),
      ...(error.errors === undefined ? {} : { errors: error.errors }),
      ...(error.headers === undefined ? {} : { headers: error.headers }),
      ...(error.extensions === undefined ? {} : { extensions: error.extensions }),
      effectStatus: 'not_applicable',
    });
    Object.defineProperty(problem, 'cause', { value: error });
    return problem;
  }
  const problem = new ProblemError('internal_error', { effectStatus: 'not_applicable' });
  Object.defineProperty(problem, 'cause', { value: error });
  return problem;
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

function publicReadDetail(operationId: string, action: string) {
  return {
    operationId,
    'x-action': action,
    'x-exposure': 'public',
    security: [{ bearerAuth: [] }, {}],
  };
}

const headers = t.Object({ [IDEMPOTENCY_HEADER]: t.String({ minLength: 3, maxLength: 1024 }) });
const id = t.String({ format: 'uuid' });
const source = t.Union(SOURCE_PROVIDER_IDS.map((id) => t.Literal(id)));
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
  const config = () => ({
    pool: dependencies.pool,
    routeKey: dependencies.routeKey,
    ...(dependencies.clock ? { clock: dependencies.clock } : {}),
  });
  const commands = () => createSourceStatisticCommands(config());
  const currentSubject = async (actor: Actor, id: string) => {
    const current = await resolveSubject(
      {
        pool: dependencies.pool,
        access: dependencies.access(),
        ...(dependencies.clock ? { clock: dependencies.clock } : {}),
      },
      actor,
      id,
    );
    return current?.subjectId === id;
  };

  return app
    .get(
      '/v1/subjects/:id/source-statistics',
      {
        params: t.Object({ id }, closed),
        response: { 200: SourceStatisticListResponseSchema, ...failures },
        detail: publicReadDetail('rating.source_statistics_get', 'subject:read'),
      },
      async ({ actor, params, admission, job }) => {
        if (routeOf(params.id) === null) throw new ProblemError('not_found');
        return admission.run('normal', job, async () => {
          try {
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
            const rows = await commands().read(readable.subjectId, job.deadline);
            const current = await resolveSubject(
              {
                pool: dependencies.pool,
                access: dependencies.access(),
                ...(dependencies.clock ? { clock: dependencies.clock } : {}),
              },
              actor,
              params.id,
            );
            if (!current || current.subjectId !== readable.subjectId) throw new ProblemError('not_found');
            return rows;
          } catch (error) {
            return sourceStatisticProblem(error);
          }
        });
      },
    )
    .put(
      '/v1/subjects/:id/source-statistics/:source',
      {
        params: t.Object({ id, source }, closed),
        headers,
        body: SourceStatisticInputSchema,
        response: {
          200: withHeaders(SourceStatisticResponseSchema, { [SESSION_HEADER]: t.Optional(t.String()) }),
          ...failures,
        },
        detail: detail('rating.source_statistic_put', SOURCE_STATISTIC_WRITE_ACTION, true),
      },
      async ({ actor, params, body, headers: requestHeaders, authorizeCommand, admission, job, session }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        const key = idempotencyKeyOf(requestHeaders[IDEMPOTENCY_HEADER]);
        const authorization = await authorizeCommand(root, () => new GrantDeniedError());
        let committed = false;
        try {
          const subjectAvailable = await currentSubject(actor, params.id);
          const result = await admission.run('normal', job, () =>
            commands().writeCommand({
              subjectAvailable,
              actor,
              subjectId: params.id,
              source: params.source,
              value: body,
              idempotencyKey: key,
              authorization,
              deadline: job.deadline,
            }),
          );
          committed = true;
          session.record({ partition: result.partition, epoch: result.epoch, position: result.position });
          const current = await resolveSubject(
            {
              pool: dependencies.pool,
              access: dependencies.access(),
              ...(dependencies.clock ? { clock: dependencies.clock } : {}),
            },
            actor,
            params.id,
          );
          if (!current || current.subjectId !== params.id) throw new ProblemError('not_found');
          const rows = await commands().read(current.subjectId, job.deadline, {
            source: effectiveAlias(result.value.source, result.value),
            external_id: result.value.sourceRecordId,
            securityRevision: result.preparedFenceRevision,
          });
          if (!rows.some((row) => canonicalize(row) === canonicalize(result.value)))
            throw new SourceStatisticNotFoundError();
          const finalSubject = await resolveSubject(
            {
              pool: dependencies.pool,
              access: dependencies.access(),
              ...(dependencies.clock ? { clock: dependencies.clock } : {}),
            },
            actor,
            params.id,
          );
          if (!finalSubject || finalSubject.subjectId !== current.subjectId) throw new SourceStatisticNotFoundError();
          return result.value;
        } catch (error) {
          if (committed) throw committedDisclosureProblem(error);
          return sourceStatisticProblem(error);
        }
      },
    )
    .post(
      customMethod('/v1/subjects/:id/source-statistics/:source', 'clear'),
      {
        params: t.Object({ id, source }, closed),
        headers,
        body: SourceStatisticClearInputSchema,
        response: { 204: withHeaders(t.Void(), { [SESSION_HEADER]: t.String() }), ...failures },
        detail: detail('rating.source_statistic_clear', SOURCE_STATISTIC_WRITE_ACTION, true),
      },
      async ({ actor, params, body, headers: requestHeaders, authorizeCommand, admission, job, session, set }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        const key = idempotencyKeyOf(requestHeaders[IDEMPOTENCY_HEADER]);
        const authorization = await authorizeCommand(root, () => new GrantDeniedError());
        let committed = false;
        try {
          const subjectAvailable = await currentSubject(actor, params.id);
          const tuple = tupleFor(dependencies.routeKey, effectiveAlias(params.source, body), body.sourceRecordId);
          await readFenceSnapshot(config(), tuple, job.deadline);
          const result = await admission.run('normal', job, () =>
            commands().clear({
              subjectAvailable,
              actor,
              subjectId: params.id,
              source: params.source,
              value: body,
              idempotencyKey: key,
              authorization,
              deadline: job.deadline,
            }),
          );
          session.record({ partition: result.partition, epoch: result.epoch, position: result.position });
          committed = true;
          await readFenceSnapshot(config(), tuple, job.deadline);
          if (!(await currentSubject(actor, params.id))) throw new SourceStatisticNotFoundError();
          set.status = 204;
        } catch (error) {
          if (committed) throw committedDisclosureProblem(error);
          return sourceStatisticProblem(error);
        }
      },
    );
}
